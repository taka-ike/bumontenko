const db = require('./db');
const config = require('./config');

const MAX_ATTEMPTS = 5;
const RETRY_INTERVAL_MS = 30 * 1000;
const RETRY_BASE_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;

let flushing = false;
let warnedDisabled = false;
let timer = null;

function isEnabled() {
  return Boolean(config.barcodeTenkoBaseUrl && config.barcodeTenkoClientToken);
}

function toIsoTimestamp(value) {
  if (!value) return new Date().toISOString();

  let text = String(value).trim();
  if (text.includes('T')) {
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text)) text += 'Z';
  } else {
    // SQLite の CURRENT_TIMESTAMP は UTC の "YYYY-MM-DD HH:MM:SS"
    text = text.replace(' ', 'T') + 'Z';
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function buildPayload(record) {
  const payload = {
    clientScanId: record.id,
    code: record.student_id,
    clientTime: toIsoTimestamp(record.submitted_at)
  };

  if (Number.isInteger(config.barcodeTenkoLocationId)) {
    payload.locationId = config.barcodeTenkoLocationId;
  }

  return payload;
}

async function postScan(payload) {
  const baseUrl = config.barcodeTenkoBaseUrl.replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/api/scan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Token': config.barcodeTenkoClientToken,
      'X-Client-Id': config.barcodeTenkoClientId
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  return res.json().catch(() => ({}));
}

function markSent(rowId) {
  db.prepare(`
    UPDATE barcode_sync_queue
    SET status = 'sent', last_error = NULL, next_attempt_at = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(rowId);
}

function markFailure(row, err) {
  const attempts = row.attempts + 1;
  const clientError = Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
  const permanent = clientError || attempts >= MAX_ATTEMPTS;
  const nextAttemptAt = permanent ? 0 : Date.now() + Math.min(attempts, MAX_ATTEMPTS) * RETRY_BASE_MS;

  db.prepare(`
    UPDATE barcode_sync_queue
    SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    permanent ? 'failed' : 'pending',
    attempts,
    String(err.message || err).slice(0, 500),
    nextAttemptAt,
    row.id
  );
}

async function sendQueueRow(row) {
  const record = db.prepare('SELECT * FROM attendance_records WHERE id = ?').get(row.record_id);
  if (!record) {
    db.prepare('DELETE FROM barcode_sync_queue WHERE id = ?').run(row.id);
    return;
  }

  try {
    await postScan(buildPayload(record));
    markSent(row.id);
  } catch (err) {
    console.error(`[BarcodeTenko] 送信失敗 (recordId=${row.record_id}):`, err.message);
    markFailure(row, err);
  }
}

async function flushPending() {
  if (!isEnabled() || flushing) return;

  flushing = true;
  try {
    const rows = db.prepare(`
      SELECT * FROM barcode_sync_queue
      WHERE status = 'pending' AND attempts < ? AND next_attempt_at <= ?
      ORDER BY id ASC
      LIMIT 20
    `).all(MAX_ATTEMPTS, Date.now());

    for (const row of rows) {
      await sendQueueRow(row);
    }
  } finally {
    flushing = false;
  }
}

/**
 * 出席レコードを送信キューへ登録し、即時送信を試みる。
 * 同じ recordId は UNIQUE 制約により1件だけ保持される（初回のみ有効）。
 */
function enqueueAttendance(recordId) {
  if (!isEnabled()) {
    if (!warnedDisabled) {
      console.warn('[BarcodeTenko] BARCODE_TENKO_CLIENT_TOKEN が未設定のため、出席データは送信しません。');
      warnedDisabled = true;
    }
    return;
  }

  db.prepare('INSERT OR IGNORE INTO barcode_sync_queue (record_id) VALUES (?)').run(recordId);

  setImmediate(() => {
    flushPending().catch((err) => console.error('[BarcodeTenko] 送信エラー:', err.message));
  });
}

/**
 * 未送信・再試行待ちのキューを定期的に処理する。
 */
function start() {
  if (timer) return;

  timer = setInterval(() => {
    flushPending().catch((err) => console.error('[BarcodeTenko] 再送エラー:', err.message));
  }, RETRY_INTERVAL_MS);

  timer.unref();
}

module.exports = {
  buildPayload,
  enqueueAttendance,
  flushPending,
  isEnabled,
  start
};
