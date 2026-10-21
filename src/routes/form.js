const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const otp = require('../otp');
const webhook = require('../webhook');
const barcodeTenko = require('../barcodeTenko');
const events = require('../events');

/**
 * フォーム初期情報の取得（セッション状態、部門一覧など）
 */
router.get('/initial', (req, res) => {
  // 現在開いているセッションを取得
  const currentSession = db.prepare(`
    SELECT * FROM sessions WHERE status = 'open' ORDER BY created_at DESC LIMIT 1
  `).get();

  const departments = db.prepare(`
    SELECT id, name FROM departments ORDER BY display_order ASC, name ASC
  `).all();

  res.json({
    session: currentSession || null,
    departments,
    clientIp: req.clientIp
  });
});

/**
 * 2FA 認証コード送信リクエスト
 */
router.post('/send-code', (req, res) => {
  const { studentId } = req.body;

  if (!studentId || typeof studentId !== 'string' || !studentId.trim()) {
    return res.status(400).json({ error: '学籍番号を入力してください。' });
  }

  const cleanId = studentId.trim();

  // 現在セッションが開いているか確認
  const currentSession = db.prepare(`
    SELECT * FROM sessions WHERE status = 'open' ORDER BY created_at DESC LIMIT 1
  `).get();
  if (!currentSession) {
    return res.status(400).json({ error: '現在受付中の点呼セッションはありません。' });
  }

  // OTPコードの生成
  const otpData = otp.createOtp(cleanId);

  // Power Automate への Webhook 発行（非同期）
  webhook.sendOtpEvent(otpData);

  res.json({
    success: true,
    message: 'Teamsに認証コードを送信しました。Teamsを開いてコードを確認してください。',
    expiresMinutes: otpData.expiresMinutes
  });
});

/**
 * 点呼回答の送信
 */
router.post('/submit', (req, res) => {
  const { studentId, code, departmentId } = req.body;

  if (!studentId || !code || !departmentId) {
    return res.status(400).json({ error: '必須項目（学籍番号、認証コード、部門）が入力されていません。' });
  }

  const cleanId = String(studentId).trim().toUpperCase();

  // 1. セッションの確認
  const currentSession = db.prepare(`
    SELECT * FROM sessions WHERE status = 'open' ORDER BY created_at DESC LIMIT 1
  `).get();
  if (!currentSession) {
    return res.status(400).json({ error: '点呼セッションは既に終了したか、開始されていません。' });
  }

  // 2. 部門の確認
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(departmentId);
  if (!dept) {
    return res.status(400).json({ error: '選択された部門が存在しません。' });
  }

  // 3. OTPコードの検証
  const verification = otp.verifyOtp(cleanId, code);
  if (!verification.valid) {
    return res.status(400).json({ error: verification.error });
  }

  // 4. DBに保存（同一セッション内での多重送信は上書き更新）
  const recordId = crypto.randomUUID();
  const userAgent = (req.headers['user-agent'] || '').slice(0, 255);
  const clientIp = req.clientIp || 'unknown';

  const stmt = db.prepare(`
    INSERT INTO attendance_records (
      id, session_id, student_id, department_id, client_ip, user_agent, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id, student_id) DO UPDATE SET
      department_id = excluded.department_id,
      client_ip = excluded.client_ip,
      user_agent = excluded.user_agent,
      submitted_at = CURRENT_TIMESTAMP
  `);

  stmt.run(
    recordId,
    currentSession.id,
    cleanId,
    departmentId,
    clientIp,
    userAgent
  );

  // 再送信時は既存レコードの id が残るため、保存済みの id を取得する
  const savedRecord = db.prepare(
    'SELECT id FROM attendance_records WHERE session_id = ? AND student_id = ?'
  ).get(currentSession.id, cleanId);

  const eventPayload = {
    sessionId: currentSession.id,
    sessionName: currentSession.name,
    studentId: cleanId,
    departmentId,
    departmentName: dept.name,
    clientIp
  };

  // 5. ダッシュボードへリアルタイムブロードキャスト (SSE)
  events.broadcast('attendance', eventPayload);

  // 6. BarcodeTenko5 へ出席データを送信
  barcodeTenko.enqueueAttendance(savedRecord.id);

  res.json({
    success: true,
    message: '点呼を受け付けました。ご協力ありがとうございました。',
    record: {
      studentId: cleanId,
      departmentName: dept.name,
      submittedAt: new Date().toISOString()
    }
  });
});

module.exports = router;
