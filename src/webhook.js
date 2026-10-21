const db = require('./db');
const config = require('./config');

/**
 * Power Automate の Webhook URL に JSON を POST する
 */
async function postToWebhook(url, payload) {
  const headers = {
    'Content-Type': 'application/json'
  };
  if (config.webhookSecret) {
    headers['X-Webhook-Secret'] = config.webhookSecret;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000) // 10秒タイムアウト
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return true;
}

/**
 * イベントをキューイングして非同期送信
 */
function dispatchEvent(eventType, payload) {
  // TEAMS_WEBHOOK_URL が設定されていない場合はコンソールに表示して終了
  if (!config.teamsWebhookUrl) {
    console.log(`\n================== [TEST MODE: Webhook Event] ==================`);
    console.log(`Event: ${eventType}`);
    console.log(`Payload:`, JSON.stringify(payload, null, 2));
    if (eventType === 'otp_requested') {
      console.log(`👉 【テスト用】学籍番号 ${payload.studentId} の認証コード: >>> ${payload.code} <<<`);
    }
    console.log(`=================================================================\n`);
    return;
  }

  // DBキューに記録
  const info = db.prepare(`
    INSERT INTO webhook_queue (event_type, payload, status)
    VALUES (?, ?, 'pending')
  `).run(eventType, JSON.stringify(payload));
  const queueId = info.lastInsertRowid;

  // バックグラウンドで即時送信
  setImmediate(async () => {
    try {
      await postToWebhook(config.teamsWebhookUrl, {
        eventType,
        timestamp: new Date().toISOString(),
        ...payload
      });
      db.prepare(`UPDATE webhook_queue SET status = 'sent', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(queueId);
    } catch (err) {
      console.error(`[Webhook] 送信失敗 (queueId=${queueId}, event=${eventType}):`, err.message);
      db.prepare(`
        UPDATE webhook_queue
        SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(err.message, queueId);
    }
  });
}

/**
 * OTPコード送信イベントを発行
 */
function sendOtpEvent({ studentId, code, expiresMinutes }) {
  dispatchEvent('otp_requested', {
    studentId,
    code,
    expiresMinutes,
    requestedAt: new Date().toISOString()
  });
}

module.exports = {
  dispatchEvent,
  sendOtpEvent
};
