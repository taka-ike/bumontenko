const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

/**
 * 6桁のOTPコードを生成・保存する
 * @returns {object} { studentId, code, expiresMinutes }
 */
function createOtp(studentId) {
  const cleanId = String(studentId).trim().toUpperCase();
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = Date.now() + config.otpExpiresMinutes * 60 * 1000;

  // 既存のレコードがあれば更新、なければ挿入
  const stmt = db.prepare(`
    INSERT INTO otp_codes (student_id, code, expires_at, attempts, created_at)
    VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(student_id) DO UPDATE SET
      code = excluded.code,
      expires_at = excluded.expires_at,
      attempts = 0,
      created_at = CURRENT_TIMESTAMP
  `);
  stmt.run(cleanId, code, expiresAt);

  return {
    studentId: cleanId,
    code,
    expiresMinutes: config.otpExpiresMinutes
  };
}

/**
 * OTPコードを検証する
 * @returns {object} { valid: boolean, error?: string }
 */
function verifyOtp(studentId, inputCode) {
  const cleanId = String(studentId).trim().toUpperCase();
  const cleanCode = String(inputCode).trim();

  const record = db.prepare('SELECT * FROM otp_codes WHERE student_id = ?').get(cleanId);
  if (!record) {
    return { valid: false, error: '認証コードが発行されていないか、有効期限が切れています。再度コードを発行してください。' };
  }

  // 有効期限切れチェック
  if (Date.now() > record.expires_at) {
    db.prepare('DELETE FROM otp_codes WHERE student_id = ?').run(cleanId);
    return { valid: false, error: '認証コードの有効期限（5分）が切れました。再度発行してください。' };
  }

  // 試行回数超過チェック
  if (record.attempts >= config.otpMaxAttempts) {
    // 行は削除しない。削除すると即座に再発行でき、再送制限の抜け穴になる
    return { valid: false, error: '認証コードの入力試行回数が上限を超えました。再度コードを発行してください。' };
  }

  // コード一致チェック
  if (record.code !== cleanCode) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE student_id = ?').run(cleanId);
    const remaining = config.otpMaxAttempts - (record.attempts + 1);
    return {
      valid: false,
      error: `認証コードが一致しません。（残り試行回数: ${remaining}回）`
    };
  }

  // 検証成功: 一度使ったコードは破棄
  db.prepare('DELETE FROM otp_codes WHERE student_id = ?').run(cleanId);
  return { valid: true };
}

/**
 * 指定したコードが一致する場合のみ破棄する（Webhook送信失敗時のクールダウン解除用）
 */
function discardOtp(studentId, code) {
  const cleanId = String(studentId).trim().toUpperCase();
  db.prepare('DELETE FROM otp_codes WHERE student_id = ? AND code = ?').run(cleanId, String(code).trim());
}

module.exports = {
  createOtp,
  verifyOtp,
  discardOtp
};
