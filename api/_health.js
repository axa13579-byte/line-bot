// 健康紀錄核心邏輯與 Session 狀態機
// 支援收縮壓、舒張壓、體重之驗證、解析、多步驟問答、最近紀錄與本月摘要
// 基於 Upstash Redis 進行 Session 持久化儲存

import { createHealthRecord, queryHealthRecords, queryMonthlyHealthRecords } from './_notion.js';
import { getRedisSession, setRedisSession, deleteRedisSession, acquireLock, releaseLock } from './_redis.js';
import crypto from 'node:crypto';
// 欄位驗證邊界值
const LIMITS = {
  systolic: { min: 50, max: 300, name: '收縮壓' },
  diastolic: { min: 30, max: 200, name: '舒張壓' },
  weight: { min: 20, max: 300, name: '體重' }
};

// 狀態定義
const STEPS = {
  SELECT_DATE: 'SELECT_DATE',
  INPUT_CUSTOM_DATE: 'INPUT_CUSTOM_DATE',
  SELECT_PERIOD: 'SELECT_PERIOD',
  INPUT_SYSTOLIC: 'INPUT_SYSTOLIC',
  INPUT_DIASTOLIC: 'INPUT_DIASTOLIC',
  INPUT_WEIGHT: 'INPUT_WEIGHT',
  INPUT_NOTE: 'INPUT_NOTE',
  CONFIRM_RECORD: 'CONFIRM_RECORD'
};

/**
 * 取得 Asia/Taipei 時區當前時間的各項指標
 */
export function getTaipeiInfo(offsetDays = 0) {
  const date = new Date();
  if (offsetDays !== 0) {
    date.setDate(date.getDate() + offsetDays);
  }

  // 取得台北日期 YYYY-MM-DD
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false
  });
  const parts = dateFormatter.formatToParts(date);
  const partMap = Object.fromEntries(parts.map(p => [p.type, p.value]));
  
  const yyyyMmDd = `${partMap.year}-${partMap.month}-${partMap.day}`;
  const hour = parseInt(partMap.hour, 10);
  
  // 台北時區 ISO 時間
  const tzOffset = 8 * 60; // Asia/Taipei = UTC+8
  const localTime = new Date(new Date().getTime() + tzOffset * 60 * 1000);
  const isoWithTimezone = localTime.toISOString().slice(0, 19) + '+08:00';

  // 判斷時段
  // 早上：05:00 ~ 11:59
  // 下午：12:00 ~ 17:59
  // 晚上：18:00 ~ 04:59
  let period = '晚上';
  if (hour >= 5 && hour < 12) {
    period = '早上';
  } else if (hour >= 12 && hour < 18) {
    period = '下午';
  }

  return { date: yyyyMmDd, hour, period, isoString: isoWithTimezone };
}

/**
 * 數值驗證
 */
function validateNumber(value, limitConfig) {
  const num = parseFloat(value);
  if (Number.isNaN(num)) {
    return { ok: false, msg: `請輸入正確的數字（${limitConfig.name}）` };
  }
  if (num < limitConfig.min || num > limitConfig.max) {
    return { ok: false, msg: `❌ 輸入的${limitConfig.name}超出合理範圍 (${limitConfig.min} ~ ${limitConfig.max})，請重新輸入：` };
  }
  return { ok: true, value: num };
}

/**
 * 解析快速輸入指令，例：健康 120 80 95.6
 */
export function parseQuickInput(text) {
  const tokens = text.trim().split(/\s+/);
  if (tokens[0] !== '健康') return null;

  const numbers = [];
  for (let i = 1; i < tokens.length; i++) {
    const num = parseFloat(tokens[i]);
    if (!Number.isNaN(num)) {
      numbers.push(num);
    }
  }

  if (numbers.length === 0) return null;

  const info = getTaipeiInfo();
  const record = {
    userId: null,
    date: info.date,
    period: info.period,
    systolic: null,
    diastolic: null,
    weight: null,
    measureTime: info.isoString,
    note: '快速輸入'
  };

  if (numbers.length >= 3) {
    record.systolic = numbers[0];
    record.diastolic = numbers[1];
    record.weight = numbers[2];
  } else if (numbers.length === 2) {
    record.systolic = numbers[0];
    record.diastolic = numbers[1];
  } else if (numbers.length === 1) {
    record.weight = numbers[0];
  }

  // 驗證
  const errors = [];
  if (record.systolic !== null) {
    const v = validateNumber(record.systolic, LIMITS.systolic);
    if (!v.ok) errors.push(v.msg);
  }
  if (record.diastolic !== null) {
    const v = validateNumber(record.diastolic, LIMITS.diastolic);
    if (!v.ok) errors.push(v.msg);
  }
  if (record.systolic !== null && record.diastolic !== null) {
    if (record.diastolic >= record.systolic) {
      errors.push('❌ 舒張壓（低壓）不可高於或等於收縮壓（高壓），請重新輸入。');
    }
  }
  if (record.weight !== null) {
    const v = validateNumber(record.weight, LIMITS.weight);
    if (!v.ok) errors.push(v.msg);
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('\n') };
  }

  return { ok: true, record };
}

/**
 * 建立 LINE Quick Reply 選擇元件
 */
function buildQuickReply(text, items) {
  return [{
    type: 'text',
    text,
    quickReply: {
      items: items.map(item => ({
        type: 'action',
        action: {
          type: 'message',
          label: item.label,
          text: item.text
        }
      }))
    }
  }];
}

/**
 * 格式化顯示確認畫面
 */
function formatConfirmMessage(record) {
  let msg = '📊 請確認您的健康紀錄：\n';
  msg += `---------------------\n`;
  msg += `📅 日期：${record.date}\n`;
  msg += `⏰ 時段：${record.period}\n`;
  if (record.systolic !== null && record.diastolic !== null) {
    msg += `💓 血壓：${record.systolic} / ${record.diastolic} mmHg\n`;
  }
  if (record.weight !== null) {
    msg += `⚖️ 體重：${record.weight} kg\n`;
  }
  msg += `📝 備註：${record.note || '無'}\n`;
  msg += `---------------------\n`;
  msg += `此功能僅做紀錄與統計，不作疾病診斷。\n\n`;
  msg += `請確認是否寫入 Notion 資料庫？`;

  return buildQuickReply(msg, [
    { label: '確認寫入', text: '確認寫入' },
    { label: '取消', text: '取消' }
  ]);
}

/**
 * 格式化最近紀錄 (純函數，便於單元測試)
 */
export function formatRecentRecords(records) {
  if (records.length === 0) {
    return '📭 目前尚無您的健康紀錄。';
  }

  let msg = '📋 最近健康紀錄\n\n';
  for (const r of records) {
    let mmDd = '';
    if (r.date) {
      const parts = r.date.split('-');
      if (parts.length === 3) mmDd = `${parts[1]}/${parts[2]}`;
    }
    
    const periodStr = r.period ? ` ${r.period}` : '';
    const bpStr = (r.systolic && r.diastolic) ? ` ｜ ${r.systolic}/${r.diastolic} mmHg` : '';
    const wStr = r.weight ? ` ｜ ${r.weight} kg` : '';
    
    msg += `${mmDd}${periodStr}${bpStr}${wStr}\n`;
  }
  return msg.trim();
}

/**
 * 最近紀錄字串生成 (最近 7 筆)
 */
async function getRecentRecordsMessage(userId) {
  try {
    const records = await queryHealthRecords(userId, 7);
    return formatRecentRecords(records);
  } catch (err) {
    console.error('getRecentRecordsMessage failed:', err);
    return '⚠️ 無法讀取最近紀錄，請稍後再試。';
  }
}

/**
 * 格式化月度摘要 (純函數，便於單元測試)
 */
export function formatMonthlySummary(records, currentMonth) {
  if (records.length === 0) {
    return `📊 本月 (${currentMonth}) 尚無您的健康紀錄。`;
  }

  // 1. 本月紀錄次數
  const count = records.length;

  // 2. 體重相關統計
  const weightRecords = records.filter(r => r.weight !== null && r.weight !== undefined);
  let firstWeight = null;
  let latestWeight = null;
  let weightDiffStr = '無統計';

  if (weightRecords.length > 0) {
    firstWeight = weightRecords[0].weight;
    latestWeight = weightRecords[weightRecords.length - 1].weight;
    const diff = latestWeight - firstWeight;
    weightDiffStr = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} kg`;
  }

  // 3. 血壓相關統計
  const bpRecords = records.filter(r => r.systolic !== null && r.diastolic !== null);
  let avgSystolic = 0;
  let avgDiastolic = 0;
  let latestBpStr = '無統計';

  if (bpRecords.length > 0) {
    const sumSys = bpRecords.reduce((sum, r) => sum + r.systolic, 0);
    const sumDia = bpRecords.reduce((sum, r) => sum + r.diastolic, 0);
    avgSystolic = Math.round(sumSys / bpRecords.length);
    avgDiastolic = Math.round(sumDia / bpRecords.length);
    
    const lastBp = bpRecords[bpRecords.length - 1];
    latestBpStr = `${lastBp.systolic}/${lastBp.diastolic} mmHg`;
  }

  // 4. 時段分佈統計
  let morningCount = 0;
  let afternoonCount = 0;
  let eveningCount = 0;

  for (const r of records) {
    if (r.period === '早上') morningCount++;
    else if (r.period === '下午') afternoonCount++;
    else if (r.period === '晚上') eveningCount++;
  }

  let msg = `📊 本月健康摘要 (${currentMonth})\n`;
  msg += `---------------------\n`;
  msg += `📝 紀錄次數：${count} 次\n`;
  msg += `⚖️ 體重統計：\n`;
  msg += `  - 起始體重：${firstWeight !== null ? firstWeight + ' kg' : '無'}\n`;
  msg += `  - 最新體重：${latestWeight !== null ? latestWeight + ' kg' : '無'}\n`;
  msg += `  - 體重變化：${weightDiffStr}\n`;
  msg += `💓 血壓統計：\n`;
  msg += `  - 平均血壓：${bpRecords.length > 0 ? `${avgSystolic}/${avgDiastolic} mmHg` : '無'}\n`;
  msg += `  - 最近血壓：${latestBpStr}\n`;
  msg += `🕒 時段分佈：\n`;
  msg += `  - 早上：${morningCount} 次\n`;
  msg += `  - 下午：${afternoonCount} 次\n`;
  msg += `  - 晚上：${eveningCount} 次\n`;
  msg += `---------------------\n`;
  msg += `此統計僅供自我健康管理參考。`;

  return msg;
}

/**
 * 本月摘要字串生成
 */
async function getMonthlySummaryMessage(userId) {
  try {
    const info = getTaipeiInfo();
    const currentMonth = info.date.slice(0, 7); // YYYY-MM
    const records = await queryMonthlyHealthRecords(userId, currentMonth);
    return formatMonthlySummary(records, currentMonth);
  } catch (err) {
    console.error('getMonthlySummaryMessage failed:', err);
    return '⚠️ 無法讀取本月摘要，請稍後再試。';
  }
}

/**
 * 輔助方法：判斷文字是否為潛在的健康紀錄流程輸入特徵
 * 用於在 Session 逾時不存在時給予友善提示，而不誤攔其他照會功能
 */
export function isLikelyHealthResponse(text) {
  const t = text.trim();
  // 1. 純數字（高壓、低壓、體重）
  if (/^\d+(\.\d+)?$/.test(t)) return true;
  // 2. 特定的時段按鈕文字
  if (['早上', '下午', '晚上'].includes(t)) return true;
  // 3. 特定的日期按鈕文字或日期格式
  if (['今天', '昨天', '其他日期'].includes(t)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true;
  // 4. 確認寫入按鈕
  if (t === '確認寫入') return true;
  return false;
}

/**
 * 主入口：處理 LINE Bot 訊息事件的分流與狀態機
 * @param {string} userId LINE User ID
 * @param {string} text 接收到的文字訊息
 * @returns {Promise<Object|null>} 回傳 { handled: boolean, reply: any } 或 null (不處理)
 */
export async function handleHealthEvent(userId, text) {
  const normText = text.trim();
  
  // 1. 全域取消指令
  if (normText === '取消') {
    // 嘗試讀取 Redis Session 看看是否真的在對話中
    const session = await getRedisSession(userId);
    if (session) {
      await deleteRedisSession(userId);
      return { handled: true, reply: '已取消本次記錄，對話狀態已重置。' };
    }
    return null; // 若無 Session，則不攔截非對話中的「取消」
  }

  // 2. 取得現有對話 Session
  let session = await getRedisSession(userId);

  // 3. 如果沒有 Session，判斷是否為「啟動指令」、「快速輸入」或「過期判定」
  if (!session) {
    const isStartFull = ['健康紀錄', '記錄健康'].includes(normText);
    const isStartBp = ['記錄血壓', '血壓'].includes(normText);
    const isStartWeight = ['記錄體重', '體重'].includes(normText);

    if (isStartFull || isStartBp || isStartWeight) {
      // 啟動對話 Session
      const recordType = isStartFull ? 'full' : (isStartBp ? 'bp' : 'weight');
      session = {
        version: '2.0',
        userId,
        recordType,
        currentStep: STEPS.SELECT_DATE,
        date: null,
        period: null,
        systolic: null,
        diastolic: null,
        weight: null,
        note: '',
        idempotencyKey: crypto.randomUUID(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await setRedisSession(userId, session);

      // 第一步：選擇日期
      return {
        handled: true,
        reply: buildQuickReply('📅 請選擇要記錄的日期：', [
          { label: '今天', text: '今天' },
          { label: '昨天', text: '昨天' },
          { label: '其他日期', text: '其他日期' }
        ])
      };
    }

    // 檢查選單
    if (normText === '健康紀錄選單') {
      return {
        handled: true,
        reply: buildQuickReply('📊 您好！請選擇健康紀錄功能：', [
          { label: '新增健康紀錄', text: '新增健康紀錄' },
          { label: '最近紀錄', text: '最近紀錄' },
          { label: '本月摘要', text: '本月摘要' },
          { label: '取消', text: '取消' }
        ])
      };
    }
    
    // 選單文字匹配
    if (normText === '新增健康紀錄') {
      return await handleHealthEvent(userId, '健康紀錄');
    }
    if (normText === '最近紀錄') {
      const recentMsg = await getRecentRecordsMessage(userId);
      return { handled: true, reply: recentMsg };
    }
    if (normText === '本月摘要') {
      const summaryMsg = await getMonthlySummaryMessage(userId);
      return { handled: true, reply: summaryMsg };
    }

    // 檢查快速輸入 (以「健康」開頭，後面接數字)
    if (normText.startsWith('健康')) {
      const quickRes = parseQuickInput(normText);
      if (quickRes) {
        if (!quickRes.ok) {
          return { handled: true, reply: quickRes.error };
        }
        
        // 解析成功，建立 CONFIRM_RECORD 狀態
        session = {
          version: '2.0',
          userId,
          recordType: 'quick',
          currentStep: STEPS.CONFIRM_RECORD,
          date: quickRes.record.date,
          period: quickRes.record.period,
          systolic: quickRes.record.systolic,
          diastolic: quickRes.record.diastolic,
          weight: quickRes.record.weight,
          note: quickRes.record.note,
          idempotencyKey: crypto.randomUUID(),
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        await setRedisSession(userId, session);
        
        return {
          handled: true,
          reply: formatConfirmMessage(session)
        };
      }
    }

    // 逾時判定：如果 Session 不存在/過期，但使用者傳送的文字符合流程特徵，回覆逾時引導
    if (isLikelyHealthResponse(normText)) {
      return {
        handled: true,
        reply: '❌ 對話流程已逾時 (15 分鐘無互動)，請輸入「健康紀錄選單」重新開始紀錄。'
      };
    }

    // 不符合健康紀錄任何指令，交回主程序
    return null;
  }

  // 4. 有 Session，依步驟狀態機前進
  switch (session.currentStep) {
    case STEPS.SELECT_DATE:
      if (normText === '今天') {
        session.date = getTaipeiInfo(0).date;
        session.currentStep = STEPS.SELECT_PERIOD;
        session.updatedAt = Date.now();
        await setRedisSession(userId, session);
        return {
          handled: true,
          reply: buildQuickReply('🕒 請選擇時段：', [
            { label: '早上', text: '早上' },
            { label: '下午', text: '下午' },
            { label: '晚上', text: '晚上' }
          ])
        };
      } else if (normText === '昨天') {
        session.date = getTaipeiInfo(-1).date;
        session.currentStep = STEPS.SELECT_PERIOD;
        session.updatedAt = Date.now();
        await setRedisSession(userId, session);
        return {
          handled: true,
          reply: buildQuickReply('🕒 請選擇時段：', [
            { label: '早上', text: '早上' },
            { label: '下午', text: '下午' },
            { label: '晚上', text: '晚上' }
          ])
        };
      } else if (normText === '其他日期') {
        session.currentStep = STEPS.INPUT_CUSTOM_DATE;
        session.updatedAt = Date.now();
        await setRedisSession(userId, session);
        return {
          handled: true,
          reply: '📅 請輸入日期 (格式：YYYY-MM-DD，例如 2026-07-13)：'
        };
      } else {
        return {
          handled: true,
          reply: buildQuickReply('⚠️ 請直接點選下方按鈕，或輸入「今天」、「昨天」、「其他日期」：', [
            { label: '今天', text: '今天' },
            { label: '昨天', text: '昨天' },
            { label: '其他日期', text: '其他日期' }
          ])
        };
      }

    case STEPS.INPUT_CUSTOM_DATE:
      if (/^\d{4}-\d{2}-\d{2}$/.test(normText)) {
        const parsedDate = new Date(normText);
        if (Number.isNaN(parsedDate.getTime())) {
          return { handled: true, reply: '❌ 日期無效，請重新輸入 (格式：YYYY-MM-DD)：' };
        }
        session.date = normText;
        session.currentStep = STEPS.SELECT_PERIOD;
        session.updatedAt = Date.now();
        await setRedisSession(userId, session);
        return {
          handled: true,
          reply: buildQuickReply('🕒 請選擇時段：', [
            { label: '早上', text: '早上' },
            { label: '下午', text: '下午' },
            { label: '晚上', text: '晚上' }
          ])
        };
      } else {
        return { handled: true, reply: '❌ 格式不符，請重新輸入 (格式：YYYY-MM-DD)：' };
      }

    case STEPS.SELECT_PERIOD:
      if (['早上', '下午', '晚上'].includes(normText)) {
        session.period = normText;
        session.updatedAt = Date.now();

        // 根據 recordType 分流
        if (session.recordType === 'full' || session.recordType === 'bp') {
          session.currentStep = STEPS.INPUT_SYSTOLIC;
          await setRedisSession(userId, session);
          return { handled: true, reply: '💓 請輸入「收縮壓」（高壓，單位 mmHg，範圍 50-300）：' };
        } else {
          session.currentStep = STEPS.INPUT_WEIGHT;
          await setRedisSession(userId, session);
          return { handled: true, reply: '⚖️ 請輸入「體重」（單位 kg，範圍 20-300，可含小數）：' };
        }
      } else {
        return {
          handled: true,
          reply: buildQuickReply('⚠️ 請直接點選下方按鈕，或輸入「早上」、「下午」、「晚上」：', [
            { label: '早上', text: '早上' },
            { label: '下午', text: '下午' },
            { label: '晚上', text: '晚上' }
          ])
        };
      }

    case STEPS.INPUT_SYSTOLIC:
      const vSys = validateNumber(normText, LIMITS.systolic);
      if (!vSys.ok) {
        return { handled: true, reply: vSys.msg };
      }
      session.systolic = vSys.value;
      session.currentStep = STEPS.INPUT_DIASTOLIC;
      session.updatedAt = Date.now();
      await setRedisSession(userId, session);
      return { handled: true, reply: '💓 請輸入「舒張壓」（低壓，單位 mmHg，範圍 30-200）：' };

    case STEPS.INPUT_DIASTOLIC:
      const vDia = validateNumber(normText, LIMITS.diastolic);
      if (!vDia.ok) {
        return { handled: true, reply: vDia.msg };
      }
      if (vDia.value >= session.systolic) {
        return { handled: true, reply: `❌ 舒張壓（低壓）不可高於或等於收縮壓（高壓，目前填寫為 ${session.systolic}），請重新輸入「舒張壓」：` };
      }
      session.diastolic = vDia.value;
      session.updatedAt = Date.now();

      // 根據分流走向下一步
      if (session.recordType === 'full') {
        session.currentStep = STEPS.INPUT_WEIGHT;
        await setRedisSession(userId, session);
        return { handled: true, reply: '⚖️ 請輸入「體重」（單位 kg，範圍 20-300，可含小數）：' };
      } else {
        session.currentStep = STEPS.INPUT_NOTE;
        await setRedisSession(userId, session);
        return { handled: true, reply: '📝 請輸入健康紀錄「備註」，或輸入「略過」：' };
      }

    case STEPS.INPUT_WEIGHT:
      const vWeight = validateNumber(normText, LIMITS.weight);
      if (!vWeight.ok) {
        return { handled: true, reply: vWeight.msg };
      }
      session.weight = vWeight.value;
      session.currentStep = STEPS.INPUT_NOTE;
      session.updatedAt = Date.now();
      await setRedisSession(userId, session);
      return { handled: true, reply: '📝 請輸入健康紀錄「備註」，或輸入「略過」：' };

    case STEPS.INPUT_NOTE:
      session.note = normText === '略過' ? '' : normText;
      session.currentStep = STEPS.CONFIRM_RECORD;
      session.updatedAt = Date.now();
      await setRedisSession(userId, session);
      return {
        handled: true,
        reply: formatConfirmMessage(session)
      };

    case STEPS.CONFIRM_RECORD:
      if (normText === '確認寫入') {
        // 使用 Redis 獲取寫入鎖 (防重複連點，要求 8)
        const gotLock = await acquireLock(userId);
        if (!gotLock) {
          console.log(`[Lock] 使用者 ${userId} 正在寫入 Notion 中，忽略重複確認寫入`);
          return { handled: true }; // 默默忽略，直接返回
        }

        try {
          // 拼裝測量時間 ISO 格式
          const nowInfo = getTaipeiInfo();
          let measureTime = nowInfo.isoString;
          if (session.date !== nowInfo.date || session.period !== nowInfo.period) {
            let timePart = '08:00:00';
            if (session.period === '下午') timePart = '14:00:00';
            else if (session.period === '晚上') timePart = '20:00:00';
            measureTime = `${session.date}T${timePart}+08:00`;
          }

          const notionRecord = {
            userId: session.userId,
            date: session.date,
            period: session.period,
            systolic: session.systolic,
            diastolic: session.diastolic,
            weight: session.weight,
            measureTime,
            note: session.note,
            idempotencyKey: session.idempotencyKey
          };

          // 寫入 Notion
          await createHealthRecord(notionRecord);
          
          // 確認儲存成功後才刪除 Session
          await deleteRedisSession(userId);
          
          let successMsg = '✅ 健康紀錄已成功寫入 Notion 資料庫！\n\n';
          successMsg += `📅 日期：${session.date} (${session.period})\n`;
          if (session.systolic !== null) {
            successMsg += `💓 血壓：${session.systolic}/${session.diastolic} mmHg\n`;
          }
          if (session.weight !== null) {
            successMsg += `⚖️ 體重：${session.weight} kg\n`;
          }
          return {
            handled: true,
            reply: successMsg.trim()
          };
        } catch (err) {
          console.error('寫入 Notion 失敗 (Session 保留允許重試):', err);
          // Notion 寫入失敗時不可回覆儲存成功，且必須保留 Session，允許重新儲存
          return {
            handled: true,
            reply: '❌ 寫入 Notion 失敗。您的填寫狀態已被保留。請排除障礙後再次點選「確認寫入」：'
          };
        } finally {
          // 釋放寫入鎖
          await releaseLock(userId);
        }
      } else {
        return {
          handled: true,
          reply: buildQuickReply('⚠️ 請直接點選下方按鈕確認，或輸入「取消」中止：', [
            { label: '確認寫入', text: '確認寫入' },
            { label: '取消', text: '取消' }
          ])
        };
      }

    default:
      await deleteRedisSession(userId);
      return null;
  }
}
