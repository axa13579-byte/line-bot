// 把 knowledge.md ＋ cases/ 的最佳案例打包成 api/_knowledge.js（部署前執行）
// 用法：node tools/sync_knowledge.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const knowledge = fs.readFileSync(path.join(root, 'knowledge.md'), 'utf8');

let caseDigest = '';
const indexPath = path.join(root, 'cases', 'index.jsonl');
if (fs.existsSync(indexPath)) {
  const lines = fs.readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean);
  const cases = lines
    .map((l, i) => {
      try { return JSON.parse(l); }
      catch { console.warn(`跳過 index.jsonl 第 ${i + 1} 行（JSON 格式錯誤）`); return null; }
    })
    .filter((c) => c && c['best-answer']);
  if (cases.length) {
    caseDigest = '\n\n---\n\n## 十、歷史案例精選（差異學習成果，優先引用）\n';
    for (const c of cases.slice(-80)) {
      caseDigest += `\n### 案例 ${c['case-id']}（${c['insurance-company']}／${c['zhaohui-type'] || ''}）\n`;
      caseDigest += `Tags: ${(c.keywords || []).join(' ')}\n照會原因：${c.question || ''}\n最佳回答要點：${c['best-answer']}\n`;
      if (c.lessons) caseDigest += `教訓：${c.lessons}\n`;
      if (c['applicable-when']) caseDigest += `適用條件：${c['applicable-when']}\n`;
    }
  }
}

const out = `// 自動產生，勿手改。來源：knowledge.md + cases/index.jsonl（node tools/sync_knowledge.js）\nexport const KNOWLEDGE = ${JSON.stringify(knowledge + caseDigest)};\n`;
fs.writeFileSync(path.join(root, 'api', '_knowledge.js'), out);
console.log(`_knowledge.js 已更新（百科 ${knowledge.length} 字＋案例摘要 ${caseDigest.length} 字）`);
