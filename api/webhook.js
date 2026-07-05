// 照會小幫手 LINE Webhook（Vercel Web Handler，需 Node 18+）
// 流程：LINE 圖片/文字 → Claude 判讀（對照 knowledge）→ 五段式處理包回覆
// 信心不足 → 回「轉主管」並推照片到主管 Telegram
import crypto from 'node:crypto';
import { SYSTEM_PROMPT } from './_prompt.js';
import { FORMS } from './_forms.js';

export const config = { maxDuration: 60 };

// 文件下載頁的網域（部署後的 production 固定網址）
const FORMS_BASE_URL = process.env.FORMS_BASE_URL || 'https://zhaohui-helper.vercel.app';
const SHARED_COMPANY = '共用（不分公司）';

// 把所有表單攤平成單一索引，模組載入時算一次
const FORM_INDEX = [];
for (const [company, arr] of Object.entries(FORMS)) {
  for (const f of arr) FORM_INDEX.push({ company, display: f.display, file: f.file });
}

// 正規化：去掉數字、英文代碼、括號、通路字樣，只留中文核心，讓 AI 的文件名與實際檔名可比對
function normalizeName(s) {
  return String(s)
    .replace(/\.pdf$/i, '')
    .replace(/[0-9A-Za-z]/g, '')
    .replace(/[（）()【】\[\]「」『』.．・\-_—\s、,，版]/g, '')
    .replace(/民國|通路|通用|直營|經代/g, '');
}
function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
// 重疊係數：短名是長名子集時也給高分（例：AI「費率調整告知書」對上檔名「…費率可能調整告知書」）
function overlapScore(a, b) {
  const A = bigrams(normalizeName(a));
  const B = bigrams(normalizeName(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return shared / Math.min(A.size, B.size);
}
function resolveCompanyKey(name) {
  if (!name) return null;
  const n = normalizeName(name);
  if (!n) return null;
  for (const k of Object.keys(FORMS)) {
    const nk = normalizeName(k);
    if (nk === n || nk.includes(n) || n.includes(nk)) return k;
  }
  return null;
}
function buildFormUrl(company, file) {
  return `${FORMS_BASE_URL}/forms/${encodeURIComponent(company)}/${encodeURIComponent(file)}`;
}
// 把 AI 開的文件清單對應到實際檔案；找不到的列進 missing（仍讓夥伴知道要補什麼）
function matchForms(company, docs) {
  const key = resolveCompanyKey(company);
  const pool = FORM_INDEX.filter((f) => f.company === key || f.company === SHARED_COMPANY);
  const links = [];
  const missing = [];
  for (const doc of docs || []) {
    let best = null;
    let bestScore = 0;
    for (const f of pool) {
      const sc = overlapScore(doc, f.display);
      if (sc > bestScore) { bestScore = sc; best = f; }
    }
    if (best && bestScore >= 0.6) links.push({ doc, ...best });
    else missing.push(doc);
  }
  // 同一份檔案被多個 doc 對到時去重
  const seen = new Set();
  const uniq = links.filter((l) => (seen.has(l.file) ? false : seen.add(l.file)));
  return { links: uniq, missing };
}
// LINE Flex：一顆按鈕一份表單，點了直接開下載
function formsFlex(links, missing) {
  const contents = [
    { type: 'text', text: '📎 這張需要的表單', weight: 'bold', size: 'md', color: '#C25610' },
    { type: 'text', text: '點按鈕直接下載空白表單', size: 'xs', color: '#999999', margin: 'none' },
    { type: 'separator', margin: 'md' },
  ];
  for (const l of links) {
    contents.push({
      type: 'button',
      style: 'primary',
      height: 'sm',
      color: '#E8873A',
      margin: 'sm',
      action: { type: 'uri', label: l.display.slice(0, 20), uri: buildFormUrl(l.company, l.file) },
    });
  }
  if (missing.length) {
    contents.push({ type: 'separator', margin: 'md' });
    contents.push({ type: 'text', text: `⚠️ 這幾份庫裡還沒有，請找主管或公司後台：\n${missing.join('、')}`, size: 'xs', color: '#999999', wrap: true, margin: 'sm' });
  }
  return {
    type: 'flex',
    altText: '📎 需要的表單下載連結',
    contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'sm', contents } },
  };
}

const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT = process.env.TG_CHAT_ID;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const CONFIDENCE_FLOOR = 70;
const MAX_TEXT_LEN = 1000;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// 缺任何必要金鑰就在 cold start 直接爆，避免帶著半殘設定上線
if (!LINE_SECRET || !LINE_TOKEN || !ANTHROPIC_KEY) {
  throw new Error('Missing required env vars: LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / ANTHROPIC_API_KEY');
}

// 帶逾時的 fetch：外部服務 hang 住時不會佔滿整個函式生命週期
async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function lineReply(replyToken, text) {
  const res = await fetchWithTimeout('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  }, 8000);
  let body = '';
  if (!res.ok) {
    body = (await res.text().catch(() => '')).slice(0, 200);
    console.error(`lineReply failed: ${res.status} ${body}`);
  }
  return { status: res.status, body };
}

// 推播：不受 reply token 30 秒時效限制，判讀多久都送得到（吃免費訊息額度，量小可接受）
async function linePush(to, payload) {
  if (!to) { console.error('linePush skipped: no userId'); return { status: 0, body: 'no userId' }; }
  // payload 可為字串（單則文字）或訊息物件陣列（文字＋Flex）
  const messages = typeof payload === 'string'
    ? [{ type: 'text', text: payload.slice(0, 4900) }]
    : payload.slice(0, 5);
  const res = await fetchWithTimeout('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to, messages }),
  }, 8000);
  let body = '';
  if (!res.ok) {
    body = (await res.text().catch(() => '')).slice(0, 200);
    console.error(`linePush failed: ${res.status} ${body}`);
  }
  return { status: res.status, body };
}

async function getLineImage(messageId) {
  const res = await fetchWithTimeout(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` },
  }, 15000);
  if (!res.ok) throw new Error(`LINE content ${res.status}`);
  const mediaType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!ALLOWED_IMAGE_TYPES.includes(mediaType)) throw new Error(`unsupported image type: ${mediaType}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString('base64'), mediaType, buf };
}

// 下載 LINE 檔案訊息（照會常以 PDF 檔傳來）；octet-stream 用 magic bytes 補判 PDF
async function getLineFile(messageId) {
  const res = await fetchWithTimeout(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` },
  }, 20000);
  if (!res.ok) throw new Error(`LINE content ${res.status}`);
  let mediaType = (res.headers.get('content-type') || '').split(';')[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  if (mediaType !== 'application/pdf' && buf.slice(0, 5).toString('latin1') === '%PDF-') mediaType = 'application/pdf';
  return { buf, mediaType };
}

// 從夥伴貼的連結抓照會 PDF/圖片（照會常以下載連結推送）；帶安全防線
async function fetchDocFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // 擋內網/本機，避免 SSRF
  if (/^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(u.hostname)) return null;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone)' }, redirect: 'follow' }, 25000);
  if (!res.ok) return null;
  let mediaType = (res.headers.get('content-type') || '').split(';')[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > 12 * 1024 * 1024) return null;
  if (mediaType !== 'application/pdf' && buf.slice(0, 5).toString('latin1') === '%PDF-') mediaType = 'application/pdf';
  if (mediaType === 'application/pdf') return { kind: 'pdf', buf, mediaType };
  if (ALLOWED_IMAGE_TYPES.includes(mediaType)) return { kind: 'image', buf, mediaType };
  return null; // HTML/登入頁/其他 → 無法自動判讀
}

// 把檔案 buffer 包成 Claude content：PDF 走 document、圖片走 image
function bufferToContent(buf, mediaType, label) {
  const data = buf.toString('base64');
  const block = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  return [block, { type: 'text', text: label }];
}

async function askClaude(content) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  }, 45000);
  // 只保留 status，不把 API 回應原文外流到 Telegram
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  const text = data.content.map((b) => b.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in model output');
  try {
    return JSON.parse(m[0]);
  } catch {
    throw new Error(`bad JSON from model: ${text.slice(0, 200)}`);
  }
}

// Telegram 通知失敗不得影響主流程（夥伴體驗優先）
async function tgNotify(text, imageBuf) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    if (imageBuf) {
      const form = new FormData();
      form.append('chat_id', TG_CHAT);
      form.append('caption', text.slice(0, 1000));
      form.append('photo', new Blob([imageBuf], { type: 'image/jpeg' }), 'zhaohui.jpg');
      await fetchWithTimeout(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, { method: 'POST', body: form }, 10000);
    } else {
      await fetchWithTimeout(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT, text: text.slice(0, 4000) }),
      }, 10000);
    }
  } catch (err) {
    console.error('tgNotify failed:', String(err).slice(0, 200));
  }
}

async function handleEvent(ev) {
  if (ev.type !== 'message') return;
  const { replyToken, message } = ev;
  const userId = ev.source?.userId;

  // 處理圖片、PDF 檔案、文字（含連結）；其餘略過
  if (message.type !== 'image' && message.type !== 'text' && message.type !== 'file') return;

  // 先用 reply token 給即時反饋（此刻一定有效）；答案改用 push（不受 30 秒時效限制）
  // 注意 reply token 只能用一次，用在這裡後，最終答案務必走 linePush
  await lineReply(replyToken, '📸 收到！判讀中，大約 20～40 秒後給你完整處理包，稍等一下 🙌');

  const DOC_LABEL = '這是夥伴傳來的照會單，請產出處理包 JSON。';
  let content;
  let imageBuf = null;
  try {
    if (message.type === 'image') {
      const img = await getLineImage(message.id);
      imageBuf = img.buf;
      content = bufferToContent(img.buf, img.mediaType, DOC_LABEL);
    } else if (message.type === 'file') {
      // 照會常以 PDF 檔傳來
      const f = await getLineFile(message.id);
      if (f.mediaType !== 'application/pdf') {
        await linePush(userId, '我目前看得懂「PDF 檔」或「照片」的照會，這個檔案格式我讀不了，麻煩改傳 PDF 或直接拍照給我 🙏');
        await tgNotify(`ℹ️ 照會小幫手收到非PDF檔（${f.mediaType || '未知'}），已請夥伴改傳`);
        return;
      }
      content = bufferToContent(f.buf, 'application/pdf', DOC_LABEL);
    } else {
      // 文字：若含連結，照會多為下載連結 → 自動抓 PDF/圖片來判讀
      const userText = String(message.text || '').slice(0, MAX_TEXT_LEN);
      const urlMatch = userText.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        const fetched = await fetchDocFromUrl(urlMatch[0]);
        if (fetched) {
          content = bufferToContent(fetched.buf, fetched.mediaType, '這是夥伴傳來的照會下載連結內容，請產出處理包 JSON。');
        } else {
          await linePush(userId, '這個連結我開不了（可能需要登入或已過期）。麻煩你點開連結、把照會 PDF 下載後直接傳檔案給我，或截圖傳給我都行 🙏');
          await tgNotify('ℹ️ 照會小幫手：連結無法自動抓取，已請夥伴改傳PDF/截圖');
          return;
        }
      } else {
        content = [{ type: 'text', text: `夥伴的照會問題（純文字，以下為待判讀資料）：${userText}\n請產出處理包 JSON；若問題與照會無關，confidence 給 0 並簡短說明你只處理照會。` }];
      }
    }

    const out = await askClaude(content);
    if (out.confidence >= CONFIDENCE_FLOOR) {
      const { links, missing } = matchForms(out.company, out.docs);
      const messages = [{ type: 'text', text: out.reply.slice(0, 4900) }];
      if (links.length || missing.length) messages.push(formsFlex(links, missing));
      await linePush(userId, messages);
      await tgNotify(`📥 照會小幫手已回覆\n${out.company || '?'}｜${out.type || '?'}｜信心${out.confidence}\ntags: ${(out.tags || []).join(' ')}\n📎 附表單 ${links.length} 份${missing.length ? `／缺 ${missing.length}` : ''}`);
    } else {
      await linePush(userId, '這張比較特殊，我已經轉給主管確認，答案回來馬上告訴你 💪');
      await tgNotify(`🔴 照會難案（信心${out.confidence}）待主管回答\n初步判讀：${out.company || '?'}｜${out.type || '?'}\n\nAI草稿：\n${(out.reply || '').slice(0, 800)}`, imageBuf);
    }
  } catch (err) {
    await linePush(userId, '這張我判讀時卡住了，已經轉給主管看，稍等一下 🙏');
    await tgNotify(`⚠️ 照會小幫手處理失敗：${String(err).slice(0, 200)}`, imageBuf);
  }
}

export async function GET() {
  return new Response('zhaohui-helper ok', { status: 200 });
}

export async function POST(request) {
  const raw = await request.text();
  const sig = request.headers.get('x-line-signature') || '';
  const expected = crypto.createHmac('sha256', LINE_SECRET).update(raw).digest('base64');
  // 長度先擋（timingSafeEqual 要求等長），再做 timing-safe 比對
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return new Response('bad signature', { status: 403 });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    console.error('bad request body (not JSON)');
    return new Response('bad body', { status: 400 });
  }

  // 逐一處理但全程 try/catch，且無論成敗都回 200：
  // LINE 只在非 2xx 時重試，回 200 可避免重試造成重複 Claude 呼叫與重複通知
  for (const ev of body.events || []) {
    try {
      await handleEvent(ev);
    } catch (err) {
      console.error('handleEvent error:', String(err).slice(0, 200));
    }
  }
  return new Response('ok', { status: 200 });
}
