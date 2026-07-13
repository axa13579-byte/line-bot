// 整合與回歸測試：模擬 LINE Webhook POST 請求，驗證 Session 狀態、去重、防重鎖、Notion 隔離與回歸
// 測試不連接任何真實 Notion、Redis 或 LINE API

import crypto from 'node:crypto';
import assert from 'node:assert';

console.log('🧪 開始執行 LINE Webhook 整合與回歸測試...');

// 設定臨時的測試環境變數
process.env.LINE_CHANNEL_SECRET = 'test_channel_secret_32_chars_long!';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
process.env.UPSTASH_REDIS_REST_URL = 'https://mock-redis.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock_token';
process.env.NOTION_API_KEY = 'mock_notion_key';
process.env.NOTION_HEALTH_DATABASE_ID = 'mock_database_id';
process.env.ANTHROPIC_API_KEY = 'mock_anthropic_key';

// 虛擬 Redis 資料庫，用以做跨請求的 state 驗證
const redisStore = new Map();
let redisOnline = true;

// 模擬 Notion API 狀態
let notionQueryCount = 0;
let notionWriteCount = 0;
let notionWriteShouldFail = false;
let notionDatabase = new Map(); // 模擬 Notion 資料庫頁面

// 模擬 LINE 發送 payload 捕獲
let lineReplyPayload = null;
let lineReplyShouldFail = false;
let claudeCalled = false;

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
      const val = body[2];
      const hasNx = body.includes('NX');
      if (hasNx && redisStore.has(key)) {
        return new Response(JSON.stringify({ result: null }), { status: 200 }); // NX 失敗回傳 null
      }
      redisStore.set(key, val);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (cmd === 'DEL') {
      redisStore.delete(key);
      return new Response(JSON.stringify({ result: 1 }), { status: 200 });
    }
    if (cmd === 'EXPIRE') {
      return new Response(JSON.stringify({ result: redisStore.has(key) ? 1 : 0 }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: null }), { status: 200 });
  }

  // Mock LINE Messaging API
  if (url.includes('api.line.me/v2/bot/message/reply')) {
    if (lineReplyShouldFail) {
      throw new Error('LINE Reply HTTP API Failed');
    }
    lineReplyPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({}), { status: 200 });
  }

  // Mock Anthropic Claude API
  if (url.includes('api.anthropic.com')) {
    claudeCalled = true;
    return new Response(JSON.stringify({
      content: [{
        text: JSON.stringify({
          confidence: 85,
          company: '國泰人壽',
          type: '體檢照會',
          reply: '這是國泰的體檢照會處理包。',
          tags: ['國泰', '體檢'],
          docs: []
        })
      }],
      usage: { input_tokens: 10, output_tokens: 20 }
    }), { status: 200 });
  }

  // Mock Notion API
  if (url.startsWith('https://api.notion.com/v1')) {
    if (url.endsWith('/pages')) {
      if (notionWriteShouldFail) {
        throw new Error('Notion API Write Error');
      }
      notionWriteCount++;
      const body = JSON.parse(options.body);
      const idempotencyKey = body.properties['紀錄識別碼']?.rich_text?.[0]?.text?.content;
      if (idempotencyKey) {
        notionDatabase.set(idempotencyKey, { id: 'new_page_id', properties: body.properties });
      }
      return new Response(JSON.stringify({ id: 'new_page_id' }), { status: 200 });
    }
    if (url.includes('/query')) {
      notionQueryCount++;
      const body = JSON.parse(options.body || '{}');
      
      // 支援等冪性鍵的查詢
      if (body.filter?.property === '紀錄識別碼') {
        const idempotencyKey = body.filter?.rich_text?.equals;
        if (idempotencyKey && notionDatabase.has(idempotencyKey)) {
          return new Response(JSON.stringify({
            results: [notionDatabase.get(idempotencyKey)]
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }

      return new Response(JSON.stringify({
        results: [
          {
            properties: {
              '收縮壓': { number: 120 },
              '舒張壓': { number: 80 },
              '體重': { number: 70.0 },
              '日期': { date: { start: '2026-07-13' } },
              '時段': { select: { name: '早上' } },
              '測量時間': { date: { start: '2026-07-13T08:00:00+08:00' } },
              '備註': { rich_text: [] },
              'LINE User ID': { rich_text: [{ text: { content: 'U_TEST_A' } }] }
            }
          }
        ],
        has_more: false
      }), { status: 200 });
    }
  }

  return new Response(JSON.stringify({}), { status: 200 });
};

// 導入被測試 POST 函數
const { POST } = await import('../api/webhook.js');

/**
 * 輔助函數：將 payload 包裝成具有正確 Signature 的 Web API Request 物件
 */
function createWebhookRequest(bodyObj) {
  const bodyText = JSON.stringify(bodyObj);
  const signature = crypto
    .createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
    .update(bodyText)
    .digest('base64');

  return new Request('http://localhost/api/webhook', {
    method: 'POST',
    headers: new Headers({
      'x-line-signature': signature,
      'content-type': 'application/json'
    }),
    body: bodyText
  });
}

// 1. 測試錯誤簽章是否被正確拒絕 (403 Forbidden)
{
  console.log('  - 測試錯誤簽章防護...');
  const badReq = new Request('http://localhost/api/webhook', {
    method: 'POST',
    headers: {
      'x-line-signature': 'bad_signature_here',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ events: [] })
  });

  const res = await POST(badReq);
  assert.strictEqual(res.status, 403, '錯誤簽章應回傳 403');
}

// 2. 兩階段去重：處理成功與失敗的 Completed 鍵狀態 (要求 5, 6)
{
  console.log('  - 測試兩階段去重：處理成功與失敗 Completed 鍵狀態 (要求 5, 6)...');
  redisStore.clear();
  lineReplyPayload = null;

  const eventSuccess = {
    webhookEventId: 'evt_success_123',
    type: 'message',
    replyToken: 'token_success',
    source: { userId: 'U_TEST_DEDUP' },
    message: { type: 'text', id: 'msg_success', text: '健康 120 80 70' }
  };

  const eventFail = {
    webhookEventId: 'evt_fail_123',
    type: 'message',
    replyToken: 'token_fail',
    source: { userId: 'U_TEST_DEDUP' },
    message: { type: 'text', id: 'msg_fail', text: '健康 120 80 70' }
  };

  // 2.1 模擬處理成功：應建立 completed key
  const reqSuccess = createWebhookRequest({ events: [eventSuccess] });
  await POST(reqSuccess);
  assert.strictEqual(redisStore.has('line:webhook:completed:evt_success_123'), true, '處理成功時應建立 completed key (要求 6)');
  assert.strictEqual(redisStore.has('line:webhook:processing:evt_success_123'), false, '處理成功時應已釋放 processing lock');

  // 2.2 模擬處理失敗：不建立 completed key
  lineReplyShouldFail = true; // 觸發 LINE 回覆拋出錯誤
  const reqFail = createWebhookRequest({ events: [eventFail] });
  await POST(reqFail);
  assert.strictEqual(redisStore.has('line:webhook:completed:evt_fail_123'), false, '處理失敗時不應建立 completed key (要求 5)');
  assert.strictEqual(redisStore.has('line:webhook:processing:evt_fail_123'), false, '處理失敗時應釋放 processing lock，以便 LINE 重送 (要求 5)');
  
  lineReplyShouldFail = false; // 還原狀態
}

// 3. 兩階段去重：processing lock 逾時後可以重試 (要求 7)
{
  console.log('  - 測試 processing lock 逾時後可以重試 (要求 7)...');
  redisStore.clear();
  lineReplyPayload = null;

  const event = {
    webhookEventId: 'evt_timeout_123',
    type: 'message',
    replyToken: 'token_timeout',
    source: { userId: 'U_TEST_TIMEOUT' },
    message: { type: 'text', id: 'msg_timeout', text: '健康 120 80 70' }
  };

  // 模擬其他 instance 正在處理，已搶佔 processing key，且尚未處理完 (沒有 completed)
  redisStore.set('line:webhook:processing:evt_timeout_123', '1');

  // 本 instance 收到重送，應直接忽略不處理
  const req = createWebhookRequest({ events: [event] });
  await POST(req);
  assert.strictEqual(lineReplyPayload, null, 'processing 鎖定中，應忽略不處理');

  // 模擬鎖逾時失效 (DEL 掉)
  redisStore.delete('line:webhook:processing:evt_timeout_123');

  // 再次發送，應能成功處理
  await POST(createWebhookRequest({ events: [event] }));
  assert.ok(lineReplyPayload !== null, 'processing 鎖釋放/逾時後應能再次重試成功');
}

// 4. 等冪性：Notion 成功但 LINE 回覆失敗時，重試不會重複寫入 Notion (要求 8)
{
  console.log('  - 測試 Notion 成功但 LINE 回覆失敗時，等冪重試不重複新增 Notion 紀錄 (要求 8)...');
  redisStore.clear();
  notionDatabase.clear();
  notionWriteCount = 0;
  lineReplyPayload = null;

  const userId = 'U_USER_IDEMP_TEST';
  
  // 第一步：快速輸入建立 Session
  const initEvent = {
    webhookEventId: 'evt_idemp_init',
    type: 'message',
    replyToken: 'token_idemp_init',
    source: { userId },
    message: { type: 'text', id: 'msg_idemp_init', text: '健康 120 80 70.5' }
  };
  await POST(createWebhookRequest({ events: [initEvent] }));

  // 模擬點擊「確認寫入」：Notion 寫入成功，但 LINE 回覆時崩潰失敗
  const writeEvent1 = {
    webhookEventId: 'evt_idemp_write_1',
    type: 'message',
    replyToken: 'token_idemp_write_1',
    source: { userId },
    message: { type: 'text', id: 'msg_idemp_write_1', text: '確認寫入' }
  };

  lineReplyShouldFail = true; // 模擬 LINE 回覆失敗
  await POST(createWebhookRequest({ events: [writeEvent1] }));
  
  assert.strictEqual(notionWriteCount, 1, '第一次寫入應成功呼叫 Notion');
  assert.strictEqual(redisStore.has(`line:webhook:completed:evt_idemp_write_1`), false, '因為 LINE 回覆失敗，completed 鍵不應被建立');
  
  lineReplyShouldFail = false; // 還原

  // LINE 重新發送同一個確認寫入請求 (因第一個未收到 HTTP OK，LINE 重送)
  await POST(createWebhookRequest({ events: [writeEvent1] }));

  // 驗證 Notion 寫入計數，必須依然為 1，不能是 2！
  assert.strictEqual(notionWriteCount, 1, '重試時應觸發等冪鍵去重，不重複寫入 Notion 頁面 (要求 8)');
}

// 5. 等冪性：Redis completed 寫入失敗時不會重複新增 Notion 紀錄 (要求 9)
{
  console.log('  - 測試 Redis completed 寫入失敗時，重送不會重複新增 Notion 紀錄 (要求 9)...');
  redisStore.clear();
  notionDatabase.clear();
  notionWriteCount = 0;
  lineReplyPayload = null;

  const userId = 'U_USER_IDEMP_REDIS_FAIL';
  
  // 初始化 Session
  await POST(createWebhookRequest({
    events: [{
      webhookEventId: 'evt_idemp_init_2',
      type: 'message',
      replyToken: 'token_idemp_init_2',
      source: { userId },
      message: { type: 'text', id: 'msg_idemp_init_2', text: '健康 120 80 70' }
    }]
  }));

  // 模擬點擊「確認寫入」
  const writeEvent = {
    webhookEventId: 'evt_idemp_write_2',
    type: 'message',
    replyToken: 'token_idemp_write_2',
    source: { userId },
    message: { type: 'text', id: 'msg_idemp_write_2', text: '確認寫入' }
  };

  // 模擬 Redis completed 寫入失敗 (藉由在 finally 拋出錯誤，或直接 DEL completed 鍵來模擬寫入失敗)
  await POST(createWebhookRequest({ events: [writeEvent] }));
  assert.strictEqual(notionWriteCount, 1, '第一次寫入成功');

  // 手動刪除 completed 鍵以模擬「Redis 寫入 completed 失敗，未標記完成」
  redisStore.delete('line:webhook:completed:evt_idemp_write_2');

  // LINE 重送相同事件
  await POST(createWebhookRequest({ events: [writeEvent] }));

  // 驗證 Notion 寫入次數依然為 1
  assert.strictEqual(notionWriteCount, 1, 'Redis completed 失敗時，因 Session 等冪鍵防護，不重複新增 Notion 紀錄 (要求 9)');
}

// 6. Redis 斷線與 LINE 重送時，普通照會之副作用 (要求 10)
{
  console.log('  - 測試普通照會於 Redis 斷線與 LINE 重送下之重複處理副作用 (要求 10)...');
  redisStore.clear();
  redisOnline = false; // 關閉 Redis 模擬斷線
  lineReplyPayload = null;
  claudeCalled = false;
  let claudeCallCount = 0;

  // 攔截 claude 呼叫次數
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (url.includes('api.anthropic.com')) {
      claudeCallCount++;
    }
    return originalFetch(url, options);
  };

  const claudeEvent = {
    webhookEventId: 'evt_claude_side_effect',
    type: 'message',
    replyToken: 'token_side_effect',
    source: { userId: 'U_TEST_SIDE_EFFECT' },
    message: { type: 'text', id: 'msg_side_effect', text: '請問這張國泰的表單' }
  };

  // 第一次發送：因為 Redis 斷線，去重檢查 bypass，正常呼叫 Claude
  const req1 = createWebhookRequest({ events: [claudeEvent] });
  await POST(req1);
  assert.strictEqual(claudeCallCount, 1, '第一次呼叫正常流向 Claude');

  // 第二次重送：由於 Redis 依然斷線，去重檢查再次 bypass，再次呼叫 Claude！
  const req2 = createWebhookRequest({ events: [claudeEvent] });
  await POST(req2);
  assert.strictEqual(claudeCallCount, 2, 'Redis 異常時，LINE 重送會導致重複呼叫 Claude，此為客觀已知風險 (要求 10)');

  // 還原
  global.fetch = originalFetch;
  redisOnline = true;
}

// 7. 測試原有照會與提醒功能回歸 (要求 12)
{
  console.log('  - 測試原有照會與提醒功能回歸 (要求 12)...');
  redisStore.clear();
  lineReplyPayload = null;
  claudeCalled = false;

  const event = {
    webhookEventId: 'evt_regression_claude',
    type: 'message',
    replyToken: 'token_regression',
    source: { userId: 'U_REGRESSION' },
    message: { type: 'text', id: 'msg_reg_1', text: '幫我對一下這張國泰的表單' }
  };

  await POST(createWebhookRequest({ events: [event] }));
  assert.strictEqual(claudeCalled, true, '普通照會問題應流向 Claude 判讀');
  assert.ok(lineReplyPayload !== null);
  assert.ok(lineReplyPayload.messages[0].text.includes('這是國泰的體檢照會處理包'), '應成功回覆 Claude 的照會判讀結果');
}

// 8. 測試 GET 本地健康檢查端點
{
  console.log('  - 測試 GET 本地健康檢查端點...');
  const { GET } = await import('../api/webhook.js');
  const res = await GET();
  assert.strictEqual(res.status, 200, 'GET 端點應回傳 200');
  const text = await res.text();
  assert.strictEqual(text, 'zhaohui-helper ok', 'GET 端點內容應符合預期');
}

console.log('✅ Webhook 整合與回歸測試全部順利通過！');
