const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

// 簡易署名トークン生成・検証
function createAdminToken() {
  const payload = 'admin_' + Date.now();
  const hmac = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, hmac] = parts;
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected));
}

// 管理者認証ミドルウェア
function requireAdmin(req, res, next) {
  if (!config.adminPassword) {
    return res.status(503).json({ error: 'ADMIN_PASSWORD が設定されていません。' });
  }

  const token = req.cookies?.tenko_admin_token || req.headers['x-admin-token'];
  if (verifyAdminToken(token)) {
    return next();
  }
  return res.status(401).json({ error: '管理者ログインが必要です。' });
}

/**
 * ログイン
 */
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (!config.adminPassword) {
    return res.status(503).json({ error: 'ADMIN_PASSWORD が設定されていないためログインできません。' });
  }

  if (password !== config.adminPassword) {
    return res.status(401).json({ error: 'パスワードが正しくありません。' });
  }

  const token = createAdminToken();
  res.cookie('tenko_admin_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7日間
  });

  res.json({ success: true, token });
});

/**
 * ログアウト
 */
router.post('/logout', (req, res) => {
  res.clearCookie('tenko_admin_token');
  res.json({ success: true });
});

/**
 * ログイン状態確認
 */
router.get('/me', (req, res) => {
  const token = req.cookies?.tenko_admin_token || req.headers['x-admin-token'];
  res.json({ authenticated: verifyAdminToken(token) });
});

// 以降は requireAdmin を適用
router.use(requireAdmin);

/**
 * セッション一覧の取得
 */
router.get('/sessions', (req, res) => {
  const sessions = db.prepare(`
    SELECT
      s.*,
      COUNT(a.id) as record_count
    FROM sessions s
    LEFT JOIN attendance_records a ON s.id = a.session_id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `).all();
  res.json(sessions);
});

/**
 * 新規セッション作成
 */
router.post('/sessions', (req, res) => {
  const { name, makeActive } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'セッション名を入力してください。' });
  }

  const id = 'session-' + Date.now();
  const status = makeActive ? 'open' : 'closed';

  const tx = db.transaction(() => {
    if (makeActive) {
      db.prepare(`UPDATE sessions SET status = 'closed' WHERE status = 'open'`).run();
    }
    db.prepare('INSERT INTO sessions (id, name, status) VALUES (?, ?, ?)').run(id, name.trim(), status);
  });
  tx();

  res.json({ success: true, id, name: name.trim(), status });
});

/**
 * セッション状態の更新（開始/締切）
 */
router.patch('/sessions/:id', (req, res) => {
  const { status } = req.body;
  if (!['open', 'closed'].includes(status)) {
    return res.status(400).json({ error: '無効なステータスです。' });
  }

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'セッションが見つかりません。' });
  }

  const tx = db.transaction(() => {
    if (status === 'open') {
      // 既存のオープンセッションを閉じる
      db.prepare(`UPDATE sessions SET status = 'closed' WHERE status = 'open'`).run();
    }
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, req.params.id);
  });
  tx();

  res.json({ success: true, id: req.params.id, status });
});

/**
 * セッションの削除
 */
router.delete('/sessions/:id', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

/**
 * 部門一覧の取得
 */
router.get('/departments', (req, res) => {
  const depts = db.prepare('SELECT * FROM departments ORDER BY display_order ASC, name ASC').all();
  res.json(depts);
});

/**
 * 部門の追加
 */
router.post('/departments', (req, res) => {
  const { id, name, displayOrder } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: 'IDと名前は必須です。' });
  }

  try {
    db.prepare('INSERT INTO departments (id, name, display_order) VALUES (?, ?, ?)').run(
      id.trim(),
      name.trim(),
      parseInt(displayOrder, 10) || 0
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'IDが重複しているか、不正な値です。' });
  }
});

/**
 * 部門の削除
 */
router.delete('/departments/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM departments WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'この部門には既に回答データが存在するため削除できません。' });
  }
});

/**
 * 点呼回答レコード一覧
 */
router.get('/records', (req, res) => {
  const { sessionId } = req.query;
  let query = `
    SELECT
      a.id,
      a.session_id,
      a.student_id,
      a.department_id,
      a.client_ip,
      a.submitted_at,
      d.name as department_name,
      s.name as session_name
    FROM attendance_records a
    JOIN departments d ON a.department_id = d.id
    JOIN sessions s ON a.session_id = s.id
  `;
  const params = [];
  if (sessionId) {
    query += ' WHERE a.session_id = ?';
    params.push(sessionId);
  }
  query += ' ORDER BY a.submitted_at DESC';

  const records = db.prepare(query).all(...params);
  res.json(records);
});

/**
 * CSVエクスポート（BOM付きUTF-8: Excelで文字化けしない形式）
 */
router.get('/export-csv', (req, res) => {
  const { sessionId } = req.query;
  let query = `
    SELECT
      s.name as session_name,
      d.name as department_name,
      a.student_id,
      a.client_ip,
      a.submitted_at
    FROM attendance_records a
    JOIN departments d ON a.department_id = d.id
    JOIN sessions s ON a.session_id = s.id
  `;
  const params = [];
  if (sessionId) {
    query += ' WHERE a.session_id = ?';
    params.push(sessionId);
  }
  query += ' ORDER BY d.display_order ASC, a.student_id ASC';

  const rows = db.prepare(query).all(...params);

  const header = ['セッション名', '部門名', '学籍番号', '送信元IP', '送信日時'];
  const csvLines = [header.join(',')];

  for (const r of rows) {
    const line = [
      `"${(r.session_name || '').replace(/"/g, '""')}"`,
      `"${(r.department_name || '').replace(/"/g, '""')}"`,
      `"${(r.student_id || '').replace(/"/g, '""')}"`,
      `"${(r.client_ip || '').replace(/"/g, '""')}"`,
      `"${(r.submitted_at || '').replace(/"/g, '""')}"`
    ];
    csvLines.push(line.join(','));
  }

  // BOM (0xEF, 0xBB, 0xBF) を先頭に付加して Excel の UTF-8 文字化けを防ぐ
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const csvBuffer = Buffer.concat([bom, Buffer.from(csvLines.join('\r\n'), 'utf8')]);

  const filename = `attendance_${sessionId || 'all'}_${Date.now()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csvBuffer);
});

module.exports = router;
