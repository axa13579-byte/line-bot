// Upstash Redis REST 整合模組
// 支援 AES-256-GCM 加密 Session 儲存、原子分散式鎖、與 Webhook 兩階段去重

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const SESSION_TTL = 900; // 15 分鐘
const COMPLETED_TTL = 86400; // 24 小時
const PROCESSING_TTL = 60; // 60 秒

const SALT = Buffer.from('line-health-session-salt-v1');
const INFO = Buffer.from('line-health-session-v1');

/**
 * 使用 HKDF 從 LINE_CHANNEL_SECRET 安全衍生 32-byte AES 金鑰
 */
function getCryptoKey() {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) {
    throw new Error('缺少 LINE_CHANNEL_SECRET，無法安全衍生加密金鑰。');
  }
  return crypto.hkdfSync('sha256', Buffer.from(secret), SALT, INFO, 32);
}

/**
 * AES-256-GCM 加密 (Authenticated Encryption)
 */
function encrypt(text) {
  const key = getCryptoKey();
  const iv = crypto.randomBytes(12); // GCM 推薦 12 bytes IV
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let ciphertext = cipher.update(text, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  
  const tag = cipher.getAuthTag().toString('hex');
  
  return JSON.stringify({
    v: '2.0',
    iv: iv.toString('hex'),
    ct: ciphertext,
    tag: tag
  });
}

/**
 * AES-256-GCM 解密與驗證
 */
function decrypt(payloadText) {
  const key = getCryptoKey();
  
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new Error('舊格式或不合法的 JSON 結構');
  }

  // 驗證規格版本與必要欄位
  if (payload.v !== '2.0' || !payload.iv || !payload.ct || !payload.tag) {
    throw new Error('Session 格式不相容');
  }

  const iv = Buffer.from(payload.iv, 'hex');
  const ct = Buffer.from(payload.ct, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ct, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * 發送 Redis 指令給 Upstash REST API
 */
async function redisCommand(cmdArray, timeoutMs = 8000) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error('缺少 Upstash Redis 整合環境變數 UPSTASH_REDIS_REST_URL 或 UPSTASH_REDIS_REST_TOKEN。');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(cmdArray),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`Upstash API 回傳錯誤 (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    return data.result;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Redis 連線超時 (${timeoutMs}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取得加密 Session 並自動延長 TTL
 * @param {string} userId LINE User ID
 */
export async function getRedisSession(userId) {
  const key = `line:health:session:${userId}`;
  
  const encrypted = await redisCommand(['GET', key]);
  if (!encrypted) return null;

  try {
    const decryptedJson = decrypt(encrypted);
    const session = JSON.parse(decryptedJson);
    
    // 每次有效互動後，重新延長 TTL 為 900 秒
    await redisCommand(['EXPIRE', key, String(SESSION_TTL)]);
    
    return session;
  } catch (err) {
    console.error(`[Redis] Session 驗證失敗，正在安全清除該 Session. 錯誤:`, err.message);
    // 舊格式或驗證失敗時，安全刪除並拋出錯誤，提示使用者重新開始
    await deleteRedisSession(userId);
    throw new Error('對話狀態已損毀或過期，請重新輸入「健康紀錄」開始。');
  }
}

/**
 * 寫入 Session 並設定 TTL 900 秒
 * @param {string} userId LINE User ID
 * @param {Object} session
 */
export async function setRedisSession(userId, session) {
  const key = `line:health:session:${userId}`;
  const serialized = JSON.stringify(session);
  const encrypted = encrypt(serialized);

  await redisCommand(['SET', key, encrypted, 'EX', String(SESSION_TTL)]);
}

/**
 * 刪除 Session
 * @param {string} userId LINE User ID
 */
export async function deleteRedisSession(userId) {
  const key = `line:health:session:${userId}`;
  await redisCommand(['DEL', key]);
}

/**
 * 獲取使用者寫入鎖 (防重複寫入 Notion)
 * @param {string} userId LINE User ID
 * @returns {Promise<boolean>} 若成功獲取鎖回傳 true，否則為 false
 */
export async function acquireLock(userId) {
  const key = `line:health:lock:${userId}`;
  const result = await redisCommand(['SET', key, '1', 'EX', '30', 'NX']);
  return result === 'OK';
}

/**
 * 釋放使用者寫入鎖
 * @param {string} userId LINE User ID
 */
export async function releaseLock(userId) {
  const key = `line:health:lock:${userId}`;
  await redisCommand(['DEL', key]);
}

/**
 * 兩階段去重：1. 檢查事件是否已處理完成
 * @param {string} eventId
 */
export async function checkCompleted(eventId) {
  const key = `line:webhook:completed:${eventId}`;
  const result = await redisCommand(['GET', key]);
  return result !== null;
}

/**
 * 兩階段去重：2. 嘗試取得處理中鎖 (防止同時並行處理)
 * @param {string} eventId
 */
export async function acquireProcessingLock(eventId) {
  const key = `line:webhook:processing:${eventId}`;
  const result = await redisCommand(['SET', key, '1', 'EX', String(PROCESSING_TTL), 'NX']);
  return result === 'OK';
}

/**
 * 兩階段去重：3. 將事件標記為處理完成
 * @param {string} eventId
 */
export async function setCompleted(eventId) {
  const key = `line:webhook:completed:${eventId}`;
  await redisCommand(['SET', key, '1', 'EX', String(COMPLETED_TTL)]);
}

/**
 * 兩階段去重：4. 釋放處理中鎖
 * @param {string} eventId
 */
export async function releaseProcessingLock(eventId) {
  const key = `line:webhook:processing:${eventId}`;
  await redisCommand(['DEL', key]);
}
