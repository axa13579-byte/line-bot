import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 載入本地 .env 檔案中的環境變數
function loadEnv() {
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8');
    for (const line of env.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

// 取得所有加好友的用戶 ID（僅限 LINE 驗證帳號/特級帳號可用）
async function getAllUserIds(token) {
  let userIds = [];
  let next = null;

  do {
    const url = new URL('https://api.line.me/v2/bot/user/ids');
    if (next) url.searchParams.append('start', next);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      throw new Error(`無法取得用戶列表 (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    userIds = userIds.concat(data.userIds || []);
    next = data.next || null;
  } while (next);

  return userIds;
}

async function main() {
  loadEnv();
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.error('❌ 錯誤：缺少 LINE_CHANNEL_ACCESS_TOKEN');
    process.exit(1);
  }

  // 取得停用名單（排除名單）
  const excludeStr = process.env.LINE_EXCLUDE_USERS || '';
  const excludeUsers = new Set(excludeStr.split(',').map(id => id.trim()).filter(Boolean));

  let activeUsers = [];

  // 優先使用手動設定的目標名單（適用於一般未驗證帳號）
  const targetStr = process.env.LINE_REMINDER_TARGET || '';
  if (targetStr.trim()) {
    console.log('📌 使用手動設定的目標名單 (LINE_REMINDER_TARGET)...');
    const manualTargets = targetStr.split(',').map(t => t.trim()).filter(Boolean);
    activeUsers = manualTargets.filter(id => !excludeUsers.has(id));
  } else {
    // 若沒有設定手動名單，嘗試自動從 API 獲取（需要 LINE 驗證帳號權限）
    console.log('🔍 未偵測到 LINE_REMINDER_TARGET，嘗試從 LINE API 自動獲取好友列表...');
    try {
      const allUsers = await getAllUserIds(token);
      activeUsers = allUsers.filter(id => !excludeUsers.has(id));
    } catch (err) {
      console.error(`❌ 自動獲取失敗 (一般未驗證的個人開發者帳號不支援此 LINE API)：${err.message}`);
      console.error('💡 請直接於 GitHub Secrets 中設定 "LINE_REMINDER_TARGET"（填入多個用逗號分隔的 User ID）。');
      process.exit(1);
    }
  }

  console.log(`實送人數: ${activeUsers.length} 人`);
  if (activeUsers.length === 0) {
    console.log('沒有需要發送的用戶。');
    return;
  }

  const message = {
    type: 'text',
    text: `禮拜日晚上9點到了，請大家記得填寫 競賽本跟整理20% 表唷\nhttps://huanchen-insurance-system-production.up.railway.app/`
  };

  for (const userId of activeUsers) {
    console.log(`正在發送提醒給用戶: ${userId}`);
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        to: userId,
        messages: [message]
      })
    });

    const body = await res.text();
    if (res.ok) {
      console.log(`✅ 發送成功: ${userId}`);
    } else {
      console.warn(`⚠️ 發送失敗 (${res.status}): ${body}`);
    }
  }
}

main().catch(err => {
  console.error('執行發送提醒失敗：', err);
  process.exit(1);
});
