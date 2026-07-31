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

// 驗證 Cron 排程
function verifyCronSchedule() {
  const workflowPath = path.join(root, '.github', 'workflows', 'daily-reminder.yml');
  if (!fs.existsSync(workflowPath)) {
    console.error('❌ 找不到 workflow 檔案');
    return false;
  }
  const content = fs.readFileSync(workflowPath, 'utf8');
  const cronMatch = content.match(/cron:\s*['"](.+?)['"]/);
  if (!cronMatch) {
    console.error('❌ 找不到 cron 設定');
    return false;
  }
  const cron = cronMatch[1];
  console.log(`🔍 檢查到 GitHub Actions 中的排程設定為: cron: "${cron}"`);
  
  if (cron === '0 13 * * 0') {
    console.log('✅ 排程解析正確：');
    console.log('   - 分 (0)：第 0 分鐘');
    console.log('   - 時 (13)：13:00 UTC（即台北時間 21:00 晚上 9 點）');
    console.log('   - 星期 (0)：星期日 (Sunday)');
    console.log('   -> 確定會在每週日晚上 9:00 (台北時間) 觸發。');
    return true;
  } else {
    console.warn(`⚠️ 警告：排程與預期的 "0 13 * * 0" (每週日晚上 9 點) 不符！`);
    return false;
  }
}

// 模擬測試 LINE API 連線
async function verifyLineConnection() {
  loadEnv();
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.error('❌ 錯誤：本地 .env 檔案中缺少 LINE_CHANNEL_ACCESS_TOKEN');
    return;
  }

  const targetStr = process.env.LINE_REMINDER_TARGET || '';
  if (targetStr.trim()) {
    console.log('\n📌 檢查到手動設定名單 LINE_REMINDER_TARGET...');
    const targets = targetStr.split(',').map(t => t.trim()).filter(Boolean);
    console.log(`✅ 已手動設定 ${targets.length} 個目標用戶 ID。這將繞過 LINE API 好友列表權限限制，可直接於一般帳號安全發送！`);
    return;
  }

  console.log('\n🔍 正在驗證 LINE Token 並取得好友列表 (僅驗證 API，不發送訊息)...');
  try {
    const res = await fetch('https://api.line.me/v2/bot/user/ids', {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      console.log(`ℹ️ 提示：自動獲取失敗 (一般未驗證的個人帳號不支援自動取得好友)。`);
      console.log(`💡 請至 GitHub Secrets 中設定 "LINE_REMINDER_TARGET"，填入各人的 LINE User ID (用逗號隔開)，以正常啟動發送！`);
      return;
    }

    const data = await res.json();
    const count = (data.userIds || []).length;
    console.log(`✅ LINE API 連線成功！`);
    console.log(`👥 目前官方帳號的好友總人數: ${count} 人`);
  } catch (err) {
    console.error('❌ 呼叫 LINE API 時發生錯誤：', err.message);
  }
}

async function run() {
  console.log('================ 排程與連線驗證工具 ================');
  verifyCronSchedule();
  await verifyLineConnection();
  console.log('==================================================');
}

run();
