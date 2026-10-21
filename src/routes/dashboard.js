const express = require('express');
const router = express.Router();
const db = require('../db');
const config = require('../config');
const events = require('../events');

// ダッシュボード用認証チェックミドルウェア
function checkDashboardAuth(req, res, next) {
  if (!config.dashboardToken) {
    return next();
  }
  const token = req.query.token || req.headers['x-dashboard-token'];
  if (token !== config.dashboardToken) {
    return res.status(401).json({ error: 'ダッシュボードの閲覧権限がありません。' });
  }
  next();
}

/**
 * ダッシュボード統計データの取得
 */
router.get('/stats', checkDashboardAuth, (req, res) => {
  // 対象セッションの決定（クエリ指定または最新オープン中）
  let session = null;
  if (req.query.sessionId) {
    session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.query.sessionId);
  } else {
    session = db.prepare(`SELECT * FROM sessions WHERE status = 'open' ORDER BY created_at DESC LIMIT 1`).get();
  }

  if (!session) {
    session = db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1`).get();
  }

  if (!session) {
    return res.json({ session: null, summary: null, departments: [] });
  }

  // 全体集計
  const totalSummary = db.prepare(`
    SELECT COUNT(*) as total
    FROM attendance_records
    WHERE session_id = ?
  `).get(session.id);

  // 部門別集計
  const deptStats = db.prepare(`
    SELECT
      d.id,
      d.name,
      d.display_order,
      COUNT(a.id) as total
    FROM departments d
    LEFT JOIN attendance_records a ON d.id = a.department_id AND a.session_id = ?
    GROUP BY d.id
    ORDER BY d.display_order ASC, d.name ASC
  `).all(session.id);

  // 最新の提出レコード (直近20件)
  const recentRecords = db.prepare(`
    SELECT
      a.id,
      a.student_id,
      d.name as department_name,
      a.submitted_at
    FROM attendance_records a
    JOIN departments d ON a.department_id = d.id
    WHERE a.session_id = ?
    ORDER BY a.submitted_at DESC
    LIMIT 20
  `).all(session.id);

  // 利用可能な全セッション一覧
  const allSessions = db.prepare('SELECT id, name, status, created_at FROM sessions ORDER BY created_at DESC').all();

  res.json({
    session,
    allSessions,
    totalSummary: {
      total: totalSummary.total || 0,
      present: totalSummary.total || 0
    },
    deptStats,
    recentRecords
  });
});

/**
 * SSE リアルタイムストリーム
 */
router.get('/stream', checkDashboardAuth, (req, res) => {
  events.handleSseConnection(req, res);
});

module.exports = router;
