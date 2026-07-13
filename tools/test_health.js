// 測試數值驗證、快速輸入解析、台北時區與時段判定等
// 整合 Mock Redis 狀態與 Mock Notion 分頁，驗證部署前修正的所有核心指標

import assert from 'node:assert';
import crypto from 'node:crypto';

// 設定測試環境變數
process.env.LINE_CHANNEL_SECRET = 'test_channel_secret_32_chars_long!';
process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock_token';
process.env.NOTION_API_KEY = 'mock_notion_key';
process.env.NOTION_HEALTH_DATABASE_ID = 'mock_database_id';

// 虛擬 In-Memory Redis 伺服器
const redisStore = new Map();
const redisTtlStore = new Map();
let redisOnline = true; // 模擬 Redis 連線狀態

// 模擬 Notion API 狀態
let notionQueryCount = 0;
let notionWriteShouldFail = false;
let notionWritePayload = null;

// Mock global.fetch
global.fetch = async (url, options = {}) => {
  // Mock Redis REST API
  if (url.startsWith('https://mock-redis.upstash.io')) {
    if (!redisOnline) {
      throw new Error('TypeError: fetch failed (Redis server unreachable)');
    }
    const body = JSON.parse(options.body);
    const cmd = body[0];
    const key = body[1];

    if (cmd === 'GET') {
      return new Response(JSON.stringify({ result: redisStore.get(key) || null }), { status: 200 });
    }
    if (cmd === 'SET') {
      // 支援 NX 條件 (如果包含 NX 且 key 已經存在，應回傳 null)
      const hasNx = body.includes('NX');
      if (hasNx && redisStore.has(key)) {
        return new Response(JSON.stringify({ result: null }), { status: 200 });
      }
      const val = body[2];
      redisStore.set(key, val);
      if (body[3] === 'EX') {
        redisTtlStore.set(key, parseInt(body[4], 10));
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (cmd === 'DEL') {
      redisStore.delete(key);
      redisTtlStore.delete(key);
      return new Response(JSON.stringify({ result: 1 }), { status: 200 });
    }
    if (cmd === 'EXPIRE') {
      if (redisStore.has(key)) {
        redisTtlStore.set(key, parseInt(body[2], 10));
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: 0 }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: null }), { status: 200 });
  }

  // Mock Notion API
  if (url.startsWith('https://api.notion.com/v1')) {
    const method = options.method || 'GET';
    
    // query database
    if (url.includes('/query')) {
      const body = JSON.parse(options.body || '{}');
      
      // 等冪性檢查 Mock：紀錄識別碼查詢，預設回傳不存在以讓寫入流程正常進行
      if (body.filter && body.filter.property === '紀錄識別碼') {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }

      // 模擬 Notion 多頁資料分頁
      if (body.start_cursor === 'page_2_cursor') {
        return new Response(JSON.stringify({
          results: [
            {
              properties: {
                '收縮壓': { number: 120 },
                '舒張壓': { number: 80 },
                '體重': { number: 95.0 },
                '日期': { date: { start: '2026-07-02' } },
                '時段': { select: { name: '晚上' } },
                '測量時間': { date: { start: '2026-07-02T20:00:00+08:00' } },
                '備註': { rich_text: [] },
                'LINE User ID': { rich_text: [{ text: { content: 'U_TEST_USER' } }] }
              }
            }
          ],
          has_more: false,
          next_cursor: null
        }), { status: 200 });
      } else {
        notionQueryCount++;
        return new Response(JSON.stringify({
          results: [
            {
              properties: {
                '收縮壓': { number: 110 },
                '舒張壓': { number: 70 },
                '體重': { number: 96.0 },
                '日期': { date: { start: '2026-07-01' } },
                '時段': { select: { name: '早上' } },
                '測量時間': { date: { start: '2026-07-01T08:00:00+08:00' } },
                '備註': { rich_text: [] },
                'LINE User ID': { rich_text: [{ text: { content: 'U_TEST_USER' } }] }
              }
            }
          ],
          has_more: true,
          next_cursor: 'page_2_cursor'
        }), { status: 200 });
      }
    }

    // create page (Notion 寫入)
    if (url.endsWith('/pages') && method === 'POST') {
      if (notionWriteShouldFail) {
        return new Response(JSON.stringify({ message: 'Mock Notion Write Error' }), { status: 500 });
      }
      notionWritePayload = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: 'page_new_id' }), { status: 200 });
    }
  }

  return new Response(JSON.stringify({}), { status: 200 });
};

// 載入被測試模組
const {
  getTaipeiInfo,
  parseQuickInput,
  handleHealthEvent,
  formatRecentRecords,
  formatMonthlySummary
} = await import('../api/_health.js');

const { queryMonthlyHealthRecords } = await import('../api/_notion.js');

console.log('🧪 開始執行健康紀錄功能單元測試...');

// 1. 測試台北時區日期與時段判定
{
  console.log('  - 測試台北時區日期與時段判定...');
  const info = getTaipeiInfo();
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(info.date), '日期格式應為 YYYY-MM-DD');
  assert.ok(['早上', '下午', '晚上'].includes(info.period), '時段應為早上、下午或晚上');
}

// 2. 測試快速輸入解析
{
  console.log('  - 測試快速輸入解析...');
  const q3 = parseQuickInput('健康 135 85 72.3');
  assert.strictEqual(q3.ok, true);
  assert.strictEqual(q3.record.systolic, 135);
  assert.strictEqual(q3.record.diastolic, 85);
  assert.strictEqual(q3.record.weight, 72.3);

  const q2 = parseQuickInput('健康 120 80');
  assert.strictEqual(q2.ok, true);
  assert.strictEqual(q2.record.systolic, 120);
  assert.strictEqual(q2.record.diastolic, 80);
  assert.strictEqual(q2.record.weight, null); // 應為 null，不得為 0

  const q1 = parseQuickInput('健康 68.5');
  assert.strictEqual(q1.ok, true);
  assert.strictEqual(q1.record.systolic, null); // 應為 null
  assert.strictEqual(q1.record.weight, 68.5);
}

// 3. 測試快速輸入異常值驗證
{
  console.log('  - 測試快速輸入異常值驗證...');
  const err1 = parseQuickInput('健康 350 80 70');
  assert.strictEqual(err1.ok, false);
  assert.ok(err1.error.includes('收縮壓'));

  const err2 = parseQuickInput('健康 120 220 70');
  assert.strictEqual(err2.ok, false);
  assert.ok(err2.error.includes('舒張壓'));

  const err3 = parseQuickInput('健康 120 120 70');
  assert.strictEqual(err3.ok, false);
  assert.ok(err3.error.includes('不可高於或等於'));

  const err4 = parseQuickInput('健康 120 80 400');
  assert.strictEqual(err4.ok, false);
  assert.ok(err4.error.includes('體重'));
}

// 4. 測試多步驟對話與 Redis Session 讀寫/防重/TTL 延長
{
  console.log('  - 測試多步驟對話狀態機 (Redis)...');
  const userId = 'U_USER_STATE_TEST';
  redisStore.clear();
  redisTtlStore.clear();

  // 第一步：發起「健康紀錄」
  const step1 = await handleHealthEvent(userId, '健康紀錄');
  assert.strictEqual(step1.handled, true);
  assert.ok(step1.reply[0].text.includes('請選擇要記錄的日期'));

  const sessionKey = `line:health:session:${userId}`;
  assert.ok(redisStore.has(sessionKey), 'Redis 應已寫入對話 Session');
  assert.strictEqual(redisTtlStore.get(sessionKey), 900, 'TTL 應設定為 900 秒');

  // 第二步：輸入「今天」
  const step2 = await handleHealthEvent(userId, '今天');
  assert.strictEqual(step2.handled, true);
  assert.ok(step2.reply[0].text.includes('請選擇時段'));
  assert.strictEqual(redisTtlStore.get(sessionKey), 900, '互動後 TTL 應重新延長為 900 秒');

  // 第三步：選擇「早上」
  const step3 = await handleHealthEvent(userId, '早上');
  assert.ok(step3.reply.includes('收縮壓'));

  // 第四步：輸入高壓 120
  await handleHealthEvent(userId, '120');

  // 第五步：輸入低壓 80
  await handleHealthEvent(userId, '80');

  // 第六步：輸入體重 70.5
  await handleHealthEvent(userId, '70.5');

  // 第七步：輸入備註「略過」-> 進入確認畫面
  const stepConfirm = await handleHealthEvent(userId, '略過');
  assert.ok(stepConfirm.reply[0].text.includes('請確認您的健康紀錄'));

  // 驗證防重鎖
  const lockKey = `line:health:lock:${userId}`;
  redisStore.set(lockKey, '1'); // 模擬鎖已被佔用
  
  const secondWrite = await handleHealthEvent(userId, '確認寫入');
  assert.strictEqual(secondWrite.handled, true);
  assert.strictEqual(secondWrite.reply, undefined, '鎖定期間重複確認寫入應被忽略');
  
  redisStore.delete(lockKey); // 釋放鎖

  const finalRes = await handleHealthEvent(userId, '確認寫入');
  assert.ok(finalRes.reply.includes('成功寫入 Notion'));
  assert.strictEqual(redisStore.has(sessionKey), false, '成功寫入後 Session 應被刪除');
}

// 5. 測試取消刪除 Session
{
  console.log('  - 測試輸入「取消」清除 Session...');
  const userId = 'U_USER_CANCEL_TEST';
  redisStore.clear();

  await handleHealthEvent(userId, '健康紀錄');
  assert.ok(redisStore.has(`line:health:session:${userId}`));

  const res = await handleHealthEvent(userId, '取消');
  assert.strictEqual(res.handled, true);
  assert.ok(res.reply.includes('對話狀態已重置'));
  assert.strictEqual(redisStore.has(`line:health:session:${userId}`), false, '取消後 Session 應被刪除');
}

// 6. 測試 Redis 異常時阻斷且不退回記憶體模式
{
  console.log('  - 測試 Redis 異常阻斷 (不 fallback)...');
  const userId = 'U_REDIS_ERROR_TEST';
  redisStore.clear();
  redisOnline = false;

  try {
    await handleHealthEvent(userId, '健康紀錄');
    assert.fail('Redis 斷線時應拋出錯誤，不可默默放行或退回記憶體');
  } catch (err) {
    assert.ok(err.message.includes('fetch failed') || err.message.includes('Redis'), '應回傳 Redis 連線錯誤');
  } finally {
    redisOnline = true;
  }
}

// 7. 測試 Notion 寫入失敗時保留 Session，允許重新儲存
{
  console.log('  - 測試 Notion 寫入失敗時保留 Session...');
  const userId = 'U_NOTION_FAIL_TEST';
  redisStore.clear();

  await handleHealthEvent(userId, '健康紀錄');
  await handleHealthEvent(userId, '今天');
  await handleHealthEvent(userId, '早上');
  await handleHealthEvent(userId, '120');
  await handleHealthEvent(userId, '80');
  await handleHealthEvent(userId, '70');
  await handleHealthEvent(userId, '略過');
  
  assert.ok(redisStore.has(`line:health:session:${userId}`));

  notionWriteShouldFail = true;
  const resFail = await handleHealthEvent(userId, '確認寫入');
  assert.ok(resFail.reply.includes('寫入 Notion 失敗'));
  assert.ok(redisStore.has(`line:health:session:${userId}`), '失敗時 Session 應被保留');

  notionWriteShouldFail = false;
  const resSuccess = await handleHealthEvent(userId, '確認寫入');
  assert.ok(resSuccess.reply.includes('成功寫入 Notion'));
  assert.strictEqual(redisStore.has(`line:health:session:${userId}`), false, '成功後刪除 Session');
}

// 8. 測試 Notion 查詢多頁資料合併
{
  console.log('  - 測試 Notion 查詢多頁資料合併...');
  notionQueryCount = 0;
  const records = await queryMonthlyHealthRecords('U_TEST_USER', '2026-07');
  assert.strictEqual(records.length, 2, '合併分頁後應包含 2 筆紀錄');
  assert.strictEqual(records[0].systolic, 110);
  assert.strictEqual(records[1].systolic, 120);
  assert.strictEqual(notionQueryCount, 1, '應進行了 API 遞迴查詢');
}

// 9. 測試月度統計摘要格式化
{
  console.log('  - 測試月度統計摘要計算與格式化...');
  const mockMonthly = [
    { date: '2026-07-01', period: '早上', systolic: 110, diastolic: 70, weight: 96.0 },
    { date: '2026-07-02', period: '下午', systolic: 115, diastolic: 75, weight: 95.5 },
    { date: '2026-07-13', period: '晚上', systolic: 120, diastolic: 80, weight: 95.0 }
  ];
  const summaryMsg = formatMonthlySummary(mockMonthly, '2026-07');
  assert.ok(summaryMsg.includes('紀錄次數：3 次'));
  assert.ok(summaryMsg.includes('體重變化：-1.0 kg'), '體重變化應為 -1.0 kg');
  assert.ok(summaryMsg.includes('平均血壓：115/75 mmHg'), '平均血壓應為 115/75');
  assert.ok(summaryMsg.includes('最近血壓：120/80 mmHg'), '最近血壓應為 120/80');
}

// 10. 測試 AES-GCM 加密與解密安全特徵 (要求 1, 2, 3, 4)
{
  console.log('  - 測試 AES-GCM 正常加解密與防篡改 (要求 1, 2, 3, 4)...');
  const { setRedisSession, getRedisSession } = await import('../api/_redis.js');
  
  // 10.1 正常加解密
  const userId = 'U_GCM_TEST';
  const mockSess = { version: '2.0', note: 'test_gcm' };
  redisStore.clear();
  await setRedisSession(userId, mockSess);
  
  const decrypted = await getRedisSession(userId);
  assert.strictEqual(decrypted.note, 'test_gcm', '解密後內容應完全一致');
  
  // 10.2 相同 Session 每次加密密文不同
  const key = `line:health:session:${userId}`;
  const payload1 = redisStore.get(key);
  
  await setRedisSession(userId, mockSess);
  const payload2 = redisStore.get(key);
  assert.notStrictEqual(payload1, payload2, '因 IV 隨機，多次加密之密文應不同');
  
  // 10.3 密文遭修改時解密失敗
  const pObj = JSON.parse(payload1);
  pObj.ct = pObj.ct.replace(/[0-9a-f]/, 'a'); // 改動一個 hex
  redisStore.set(key, JSON.stringify(pObj));
  try {
    await getRedisSession(userId);
    assert.fail('密文遭篡改時應解密失敗');
  } catch (err) {
    assert.ok(err.message.includes('對話狀態'), '應安全刪除並引導重新開始');
  }
  
  // 10.4 authTag 遭修改時解密失敗
  redisStore.clear();
  await setRedisSession(userId, mockSess);
  const payload3 = redisStore.get(key);
  const pObj3 = JSON.parse(payload3);
  pObj3.tag = pObj3.tag.slice(0, -1) + (pObj3.tag.slice(-1) === '0' ? '1' : '0'); // 篡改 tag 結尾
  redisStore.set(key, JSON.stringify(pObj3));
  try {
    await getRedisSession(userId);
    assert.fail('authTag 遭篡改時應解密失敗');
  } catch (err) {
    assert.ok(err.message.includes('對話狀態'), '解密失敗時應安全刪除並引導重新開始');
    assert.strictEqual(redisStore.has(key), false, '驗證失敗時應安全刪除 Session');
  }
}

console.log('✅ 所有健康紀錄功能單元測試均順利通過！');
