// 本機測試 AI 大腦：node tools/test_local.js <照會圖片路徑>
// 用和 webhook 相同的 system prompt，直接印出五段式處理包
import fs from 'node:fs';
import { SYSTEM_PROMPT } from '../api/_prompt.js';

const imgPath = process.argv[2];
if (!imgPath) { console.error('用法: node tools/test_local.js <圖片路徑>'); process.exit(1); }
const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.error('缺 ANTHROPIC_API_KEY'); process.exit(1); }

const b64 = fs.readFileSync(imgPath).toString('base64');
const mediaType = imgPath.endsWith('.png') ? 'image/png' : 'image/jpeg';

const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
      { type: 'text', text: '這是夥伴拍的照會單，請產出處理包 JSON。' },
    ] }],
  }),
});
if (!res.ok) { console.error(`API ${res.status}:`, (await res.text()).slice(0, 500)); process.exit(1); }
const data = await res.json();
const text = data.content.map((b) => b.text || '').join('');
const out = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
console.log(`信心：${out.confidence}｜公司：${out.company}｜類型：${out.type}`);
console.log(`tags：${(out.tags || []).join(' ')}`);
console.log(`docs：${(out.docs || []).join('、') || '（無）'}`);
console.log('─'.repeat(40));
console.log(out.reply);
console.log('─'.repeat(40));
console.log(`tokens: in ${data.usage.input_tokens} / out ${data.usage.output_tokens}`);
