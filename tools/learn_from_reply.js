// 學習引擎：吃「難案原文 + 主管修正」→ Claude 整理成最佳案例 → 存案例庫 → 重新部署
// 由本機 CRM listener 在主管回覆難案時 subprocess 呼叫；stdin 傳 JSON {original, correction}
// 用法（測試）：echo '{"original":"...","correction":"..."}' | node tools/learn_from_reply.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const VERCEL = path.join(path.dirname(NODE), 'vercel');
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

function readKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return fs.readFileSync(path.join(os.homedir(), '.anthropic_key'), 'utf8').trim();
}

// 從 Telegram 難案訊息解析公司／類型
function parseMeta(original) {
  let company = '?';
  let type = '?';
  const m1 = original.match(/初步判讀[:：]\s*(.+?)｜(.+?)(?:\n|$)/);
  const m2 = original.match(/已回覆\s*\n\s*(.+?)｜(.+?)｜/);
  const m = m1 || m2;
  if (m) { company = m[1].trim(); type = m[2].trim(); }
  return { company, type };
}

async function polish(meta, original, correction) {
  const key = readKey();
  const sys = `你把主管（資深保險主管）對一張照會的口語修正，整理成「照會最佳案例」。
只輸出一個 JSON：{"best_answer":"五段式完整處理包","lesson":"一句話教訓","tags":["#..."]}
best_answer 用 LINE 好讀格式，五段：📋這是什麼照會 ✅你該做的事 💬跟客戶怎麼說 ✏️回覆欄可以這樣寫 ⏰時限提醒，最後一行固定「— AI 判讀僅供參考，重大案件請與主管確認」。
誠信紅線：不替客戶美化體況、不暗示怎麼寫容易過件；健告體況相關加註「請確認與客戶實際狀況相符」。
lesson 記錄「這類照會的關鍵重點」，供未來同類引用。tags 用 #公司 #照會類型 #體況關鍵字。`;
  const user = `照會公司／類型：${meta.company}｜${meta.type}
【AI 原始判讀（可能不完整或有誤）】
${original}
【主管的修正／正確做法】
${correction}
請整理成最佳案例 JSON。`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: sys, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const data = await res.json();
  const text = data.content.map((b) => b.text || '').join('');
  return JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const original = String(input.original || '');
  const correction = String(input.correction || '').trim();
  if (!correction) throw new Error('empty correction');

  const meta = parseMeta(original);
  const out = await polish(meta, original, correction);

  const caseId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const casesDir = path.join(root, 'cases');
  fs.mkdirSync(casesDir, { recursive: true });

  // 案例明細 md（含差異學習全文，只加不改）
  const md = `# 案例 ${caseId}

- 保險公司：${meta.company}
- 照會類型：${meta.type}
- tags：${(out.tags || []).join(' ')}
- 建立：${new Date().toISOString()}
- 校正：主管人工修正（Telegram 回覆）

## 差異來源
### AI 原始判讀
${original}

### 主管修正重點
${correction}

## 最佳回答
${out.best_answer}

## 教訓
${out.lesson || ''}
`;
  fs.writeFileSync(path.join(casesDir, `case-${caseId}.md`), md);

  // 結構化索引（sync_knowledge 會讀 best-answer 打包給 webhook）
  const rec = {
    'case-id': caseId,
    'insurance-company': meta.company,
    'zhaohui-type': meta.type,
    keywords: out.tags || [],
    question: `${meta.company}｜${meta.type}`,
    'best-answer': out.best_answer,
    lessons: out.lesson || '',
    'applicable-when': `${meta.company} ${meta.type} 類照會`,
    corrected: true,
    date: new Date().toISOString().slice(0, 10),
  };
  fs.appendFileSync(path.join(casesDir, 'index.jsonl'), JSON.stringify(rec) + '\n');

  // 重新打包 + 部署（讓新案例即刻對 webhook 生效）
  // launchd 環境無 PATH，vercel 的 node shebang 會找不到 node，故補上 node 目錄
  const env = { ...process.env, PATH: `${path.dirname(NODE)}:${process.env.PATH || ''}` };
  execFileSync(NODE, [path.join(root, 'tools', 'sync_knowledge.js')], { cwd: root, stdio: 'pipe', env });
  execFileSync(VERCEL, ['deploy', '--prod', '--yes'], { cwd: root, stdio: 'pipe', env });

  // 回傳給 listener 轉發主管
  process.stdout.write(`✅ 學起來了！\n${meta.company}｜${meta.type}\n教訓：${out.lesson || '(已存最佳回答)'}\n下次同類照會會直接引用你的做法 💪`);
}

main().catch((e) => {
  process.stdout.write(`⚠️ 學習失敗：${String(e).slice(0, 200)}`);
  process.exit(1);
});
