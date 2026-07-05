import fs from 'node:fs';
import express from 'express';

// 本地開發時，手動載入 .env 檔案中的環境變數
if (fs.existsSync('.env')) {
  const env = fs.readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    // 去掉引號
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

// 動態導入 Webhook，確保環境變數載入完成後才執行其初始化檢查
const { POST, GET } = await import('./api/webhook.js');

const app = express();
const PORT = process.env.PORT || 3000;

// 解析 Raw Text Body，因為 LINE Signature 驗證需要完整的原始 Request Body
app.use(express.text({ type: '*/*' }));

// 驗證 API 路由 (GET)
app.get('/api/webhook', async (req, res) => {
  try {
    const webRes = await GET();
    res.status(webRes.status).send(await webRes.text());
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Webhook 事件接收路由 (POST)
app.post('/api/webhook', async (req, res) => {
  try {
    // 將 Express 的 Request 轉換成 Web API 標準的 Request
    const headers = new Headers();
    for (const [key, val] of Object.entries(req.headers)) {
      if (val) {
        headers.append(key, Array.isArray(val) ? val.join(', ') : val);
      }
    }

    const bodyText = typeof req.body === 'string' ? req.body : '';

    const webReq = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
      method: 'POST',
      headers,
      body: bodyText,
    });

    const webRes = await POST(webReq);
    res.status(webRes.status).send(await webRes.text());
  } catch (err) {
    console.error('Express Webhook Wrapper Error:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Webhook URL is ready at: http://localhost:${PORT}/api/webhook`);
});
