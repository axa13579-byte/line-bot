// Notion API 服務模組
// 串接健康紀錄資料庫，支援寫入、單一使用者查詢、月度統計查詢

const NOTION_KEY = process.env.NOTION_API_KEY;
const DATABASE_ID = process.env.NOTION_HEALTH_DATABASE_ID;

// 冷啟動時警告，但因為是新增功能，不直接中斷主程序（避免影響現有照會功能）
if (!NOTION_KEY || !DATABASE_ID) {
  console.warn('⚠️ [Notion] 缺少環境變數 NOTION_API_KEY 或 NOTION_HEALTH_DATABASE_ID。健康紀錄功能將無法正常運作。');
}

/**
 * 輔助函數：帶有超時與錯誤處理的 Notion fetch
 */
async function fetchNotion(endpoint, options = {}, timeoutMs = 15000) {
  if (!NOTION_KEY) {
    throw new Error('Notion API Key 未設定，無法連線 Notion。');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url = `https://api.notion.com/v1${endpoint}`;
  const defaultHeaders = {
    'Authorization': `Bearer ${NOTION_KEY}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };

  try {
    const res = await fetch(url, {
      ...options,
      headers: { ...defaultHeaders, ...options.headers },
      signal: controller.signal
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '未知錯誤');
      throw new Error(`Notion API 錯誤 (${res.status}): ${errorText}`);
    }

    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Notion API 請求超時 (${timeoutMs}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 將 Notion 回傳的屬性解析成簡單的 JS 物件
 */
function parseProperties(properties) {
  const result = {};
  
  // 收縮壓 (Number)
  result.systolic = properties.收縮壓?.number ?? null;
  // 舒張壓 (Number)
  result.diastolic = properties.舒張壓?.number ?? null;
  // 體重 (Number)
  result.weight = properties.體重?.number ?? null;
  
  // 日期 (Date)
  result.date = properties.日期?.date?.start ?? null;
  // 時段 (Select)
  result.period = properties.時段?.select?.name ?? null;
  // 測量時間 (Date)
  result.measureTime = properties.測量時間?.date?.start ?? null;
  
  // 備註 (Rich text)
  result.note = properties.備註?.rich_text?.map(t => t.text?.content || '').join('') || '';
  // LINE User ID (Rich text)
  result.userId = properties['LINE User ID']?.rich_text?.map(t => t.text?.content || '').join('') || '';
  
  return result;
}

/**
 * 建立一筆健康紀錄到 Notion
 * @param {Object} record
 * @param {string} record.userId LINE 使用者 ID
 * @param {string} record.date 日期 (YYYY-MM-DD)
 * @param {string} record.period 時段 (早上／下午／晚上)
 * @param {number|null} record.systolic 收縮壓
 * @param {number|null} record.diastolic 舒張壓
 * @param {number|null} record.weight 體重
 * @param {string} record.measureTime 測量時間 (ISO 8601，含時間與時區)
 * @param {string} record.note 備註
 */
export async function createHealthRecord(record) {
  if (!DATABASE_ID) {
    throw new Error('Notion Database ID 未設定。');
  }

  // 等冪性檢查：如果已經有相同紀錄識別碼，直接放行 (要求 10)
  if (record.idempotencyKey) {
    const existing = await queryHealthRecordByIdempotencyKey(record.idempotencyKey);
    if (existing) {
      console.log(`[Idempotency] Notion 中已存在相同紀錄識別碼: ${record.idempotencyKey}，直接放行`);
      return existing;
    }
  }

  // 名稱格式：YYYY-MM-DD 時段健康紀錄
  const title = `${record.date} ${record.period}健康紀錄`;
  
  const properties = {
    '名稱': {
      title: [{ text: { content: title } }]
    },
    '日期': {
      date: { start: record.date }
    },
    '時段': {
      select: { name: record.period }
    },
    '測量時間': {
      date: { start: record.measureTime }
    },
    'LINE User ID': {
      rich_text: [{ text: { content: record.userId } }]
    },
    '資料來源': {
      select: { name: 'LINE Bot' }
    },
    '月份': {
      rich_text: [{ text: { content: record.date.slice(0, 7) } }] // 格式 YYYY-MM
    },
    '紀錄識別碼': {
      rich_text: [{ text: { content: record.idempotencyKey || '' } }]
    }
  };

  // 只有在數值存在時才傳送，若是 null 則傳送 null 以防舊值殘留
  properties['收縮壓'] = { number: record.systolic !== undefined ? record.systolic : null };
  properties['舒張壓'] = { number: record.diastolic !== undefined ? record.diastolic : null };
  properties['體重'] = { number: record.weight !== undefined ? record.weight : null };

  if (record.note) {
    properties['備註'] = {
      rich_text: [{ text: { content: record.note } }]
    };
  } else {
    properties['備註'] = {
      rich_text: []
    };
  }

  const payload = {
    parent: { database_id: DATABASE_ID },
    properties
  };

  return await fetchNotion('/pages', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

/**
 * 依紀錄識別碼查詢健康紀錄，用於等冪性去重 (防止重複寫入 Notion)
 * @param {string} idempotencyKey
 */
export async function queryHealthRecordByIdempotencyKey(idempotencyKey) {
  if (!DATABASE_ID || !idempotencyKey) return null;

  const payload = {
    filter: {
      property: '紀錄識別碼',
      rich_text: { equals: idempotencyKey }
    },
    page_size: 1
  };

  const data = await fetchNotion(`/databases/${DATABASE_ID}/query`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  if (data.results && data.results.length > 0) {
    return data.results[0];
  }
  return null;
}

/**
 * 查詢特定使用者的最近紀錄
 * @param {string} userId LINE 使用者 ID
 * @param {number} limit 筆數限制
 */
export async function queryHealthRecords(userId, limit = 7) {
  if (!DATABASE_ID) {
    throw new Error('Notion Database ID 未設定。');
  }

  const payload = {
    filter: {
      property: 'LINE User ID',
      rich_text: { equals: userId }
    },
    sorts: [
      { property: '日期', direction: 'descending' },
      { property: '測量時間', direction: 'descending' }
    ],
    page_size: limit
  };

  const data = await fetchNotion(`/databases/${DATABASE_ID}/query`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  return (data.results || []).map(page => parseProperties(page.properties));
}

export async function queryMonthlyHealthRecords(userId, month) {
  if (!DATABASE_ID) {
    throw new Error('Notion Database ID 未設定。');
  }

  let allResults = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const payload = {
      filter: {
        and: [
          {
            property: 'LINE User ID',
            rich_text: { equals: userId }
          },
          {
            property: '月份',
            rich_text: { equals: month }
          }
        ]
      },
      sorts: [
        { property: '日期', direction: 'ascending' },
        { property: '測量時間', direction: 'ascending' }
      ]
    };

    if (startCursor) {
      payload.start_cursor = startCursor;
    }

    const data = await fetchNotion(`/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (data.results) {
      allResults = allResults.concat(data.results);
    }

    hasMore = data.has_more ?? false;
    startCursor = data.next_cursor ?? undefined;
  }

  return allResults.map(page => parseProperties(page.properties));
}
