# 照會小幫手（技術骨架版）

保險照會 AI 助手：夥伴用 LINE 傳照會（照片／PDF 檔／下載連結），
AI 對照你的「照會百科」判讀，回一份五段式處理包，並附上需要補的空白表單下載按鈕。
信心不足的難案自動轉給你（Telegram），你修正後系統會把它學成案例，越用越準。

> ⚠️ 這是**骨架版**：只含程式與架構，不含任何照會知識、案例或表單。
> 判讀品質取決於你自己填的 `knowledge.md`。

---

## 一、你需要準備的東西
| 項目 | 用途 | 費用 |
|---|---|---|
| LINE 官方帳號 + Messaging API | bot 的門面 | 免費方案每月 200 則推播 |
| Anthropic API Key | AI 判讀大腦（Claude） | 用多少付多少（按 token 計費）|
| Vercel 帳號 | 部署 webhook（免費方案即可）| 免費 |
| Telegram Bot（選用）| 收難案通知＋學習閉環 | 免費 |

## 二、環境變數（設在 Vercel 專案）
```
LINE_CHANNEL_SECRET=          # LINE Developers → Messaging API
LINE_CHANNEL_ACCESS_TOKEN=    # 同上，發一組長期 token
ANTHROPIC_API_KEY=            # console.anthropic.com
CLAUDE_MODEL=claude-sonnet-4-6   # 選用，預設 sonnet
TG_BOT_TOKEN=                 # 選用：難案通知
TG_CHAT_ID=                   # 選用：你的 Telegram chat id
FORMS_BASE_URL=               # 選用：表單下載網域，預設用你的 Vercel 網址
```

## 三、部署步驟
1. `npm i -g vercel`，在專案目錄 `vercel` 連結專案、`vercel deploy --prod` 部署。
2. 到 Vercel 專案設定填上面的環境變數，重新部署一次。
3. 把 `https://<你的專案>.vercel.app/api/webhook` 填進 LINE Developers 的 Webhook URL。
4. LINE Official Account Manager → 回應設定：**回應模式 = Bot、Webhook = 開、自動回應 = 關**。
   （這步很關鍵，設錯會「收得到訊息卻不回覆」。）

## 四、建立你的大腦（最重要）
1. 打開 `knowledge.md`，把你自己的照會處理知識填進去（結構模板已附）。
2. 跑 `node tools/sync_knowledge.js` 打包成 `api/_knowledge.js`。
3. `vercel deploy --prod` 重新部署。
4. 本機測試 AI（不碰 LINE）：`ANTHROPIC_API_KEY=xxx node tools/test_local.js 某張照會.jpg`

## 五、加入可下載的空白表單（選用）
1. 建資料夾 `~/Desktop/照會文件庫/`，每家公司一個子夾，把空白表單 PDF 丟進去（檔名用正式表名）。
2. `node tools/sync_forms.js` → 複製到 `public/forms/` 並產生清單。
3. `vercel deploy --prod`。判到某家、且需要的表單庫裡有，就會自動附下載按鈕。

## 六、學習閉環（選用）
難案會推到你的 Telegram；你「回覆」那則訊息打上修正，接一支監聽程式呼叫
`tools/learn_from_reply.js`，把修正整理成最佳案例寫進 `cases/`，重新部署後即生效。
（監聽端需自行架設，可參考 `tools/learn_from_reply.js` 的介面。）

---

## 檔案結構
- `api/webhook.js`：主程式（收 LINE → 判讀 → 回覆＋表單）
- `api/_prompt.js`：system prompt（五段式輸出規則、誠信紅線、防注入）
- `api/_knowledge.js`：由 `knowledge.md` 打包產生，**勿手改**
- `api/_forms.js`：由表單資料夾打包產生，**勿手改**
- `tools/`：打包與測試工具
- `knowledge.md`：你的照會百科（填這個）
- `cases/index.jsonl`：學習累積的案例

祝上線順利 🙌
