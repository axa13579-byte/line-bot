// 把 ~/Desktop/照會文件庫 的 PDF 同步到 public/forms/<公司>/，並產生 api/_forms.js 清單
// 部署前執行；主管每次新增/更新表單後跑一次。用法：node tools/sync_forms.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(os.homedir(), 'Desktop', '照會文件庫');
const DEST = path.join(root, 'public', 'forms');

if (!fs.existsSync(SRC)) { console.error(`找不到來源資料夾：${SRC}`); process.exit(1); }

// URL-safe 檔名：去掉空白與各式括號（Vercel 靜態路徑與 LINE 連結才不會出錯），保留中文與版本點號
function safeFile(name) {
  return name.replace(/[（）()【】\[\]「」『』]/g, '').replace(/\s+/g, '').trim();
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

const FORMS = {};
let total = 0;
for (const company of fs.readdirSync(SRC).sort()) {
  const cdir = path.join(SRC, company);
  if (!fs.statSync(cdir).isDirectory()) continue;
  const files = fs.readdirSync(cdir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  if (files.length === 0) continue;
  fs.mkdirSync(path.join(DEST, company), { recursive: true });
  FORMS[company] = [];
  for (const f of files) {
    const safe = safeFile(f);
    fs.copyFileSync(path.join(cdir, f), path.join(DEST, company, safe));
    FORMS[company].push({ display: f.replace(/\.pdf$/i, ''), file: safe });
    total++;
  }
}

const out = `// 自動產生，勿手改。來源 ~/Desktop/照會文件庫（node tools/sync_forms.js 重生）\nexport const FORMS = ${JSON.stringify(FORMS, null, 2)};\n`;
fs.writeFileSync(path.join(root, 'api', '_forms.js'), out);
console.log(`_forms.js 已更新：${Object.keys(FORMS).length} 家公司、${total} 份文件`);
for (const [c, arr] of Object.entries(FORMS)) console.log(`  ${c}: ${arr.length}`);
