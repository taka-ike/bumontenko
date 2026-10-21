const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// data ディレクトリの作成
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// スキーマの初期化
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', -- 'open' or 'closed'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS attendance_records (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    department_id TEXT NOT NULL,
    client_ip TEXT NOT NULL,
    user_agent TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(department_id) REFERENCES departments(id) ON DELETE RESTRICT,
    UNIQUE(session_id, student_id)
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    student_id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS webhook_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'sent', 'failed'
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS barcode_sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'sent', 'failed'
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 初期部門データのシード（存在しない場合のみ）
const deptCount = db.prepare('SELECT COUNT(*) as count FROM departments').get().count;
if (deptCount === 0) {
  const insertDept = db.prepare('INSERT INTO departments (id, name, display_order) VALUES (?, ?, ?)');
  const initialDepts = [
    ['honbu', '本部部門', 1],
    ['kikaku', '企画部門', 2],
    ['soushoku', '装飾部門', 3],
    ['kaijou', '会場部門', 4],
    ['butai', '舞台部門', 5],
    ['enshutsu', '演出部門', 6],
    ['shoumei', '照明部門', 7],
    ['henshuu', '編集部門', 8],
    ['keiri', '経理部門', 9]
  ];
  const tx = db.transaction(() => {
    for (const [id, name, order] of initialDepts) {
      insertDept.run(id, name, order);
    }
  });
  tx();
}

// 初期セッションデータのシード（存在しない場合のみ）
const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
if (sessionCount === 0) {
  const now = new Date();
  const dateStr = `${now.getMonth() + 1}月${now.getDate()}日`;
  db.prepare('INSERT INTO sessions (id, name, status) VALUES (?, ?, ?)').run(
    'session-1',
    `${dateStr} 午前点呼`,
    'open'
  );
}

module.exports = db;
