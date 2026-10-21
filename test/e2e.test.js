const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// 一時テストDB設定
process.env.DB_PATH = 'test/e2e_tenko.sqlite';
process.env.IP_FILTER_ENABLED = 'false'; // E2Eテスト中は全IP許可
process.env.ADMIN_PASSWORD = 'test_password_123';
process.env.PORT = '8099';
process.env.BARCODE_TENKO_CLIENT_TOKEN = ''; // テスト中は外部送信しない
process.env.STUDENT_ROSTER_PATH = 'test/roster.fixture.json';

const config = require('../src/config');
const db = require('../src/db');
let server;

describe('E2E HTTP API 総合テスト', () => {
  const baseUrl = 'http://127.0.0.1:8099';

  before(async () => {
    // サーバーを8099ポートで起動
    await new Promise((resolve) => {
      const express = require('express');
      const cookieParser = require('cookie-parser');
      const app = express();
      app.use(express.json());
      app.use(cookieParser());
      app.use('/api/form', require('../src/routes/form'));
      app.use('/api/dashboard', require('../src/routes/dashboard'));
      app.use('/admin/api', require('../src/routes/admin'));

      server = app.listen(8099, '127.0.0.1', () => {
        resolve();
      });
    });
  });

  after(() => {
    if (server) server.close();
    try {
      db.close();
      const p = path.resolve(__dirname, 'e2e_tenko.sqlite');
      if (fs.existsSync(p)) fs.unlinkSync(p);
      if (fs.existsSync(p + '-wal')) fs.unlinkSync(p + '-wal');
      if (fs.existsSync(p + '-shm')) fs.unlinkSync(p + '-shm');
    } catch (e) {}
  });

  test('GET /api/form/initial で現在のセッションと部門一覧が返ること', async () => {
    const res = await fetch(`${baseUrl}/api/form/initial`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.session);
    assert.strictEqual(data.session.status, 'open');
    assert.ok(Array.isArray(data.departments));
    assert.ok(data.departments.length > 0);
  });

  test('POST /api/form/send-code で学籍番号宛にOTPが生成されること', async () => {
    const res = await fetch(`${baseUrl}/api/form/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: '21420' })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
  });

  test('名簿に無い学籍番号では /send-code が拒否されること', async () => {
    const res = await fetch(`${baseUrl}/api/form/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: '99999' })
    });
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.strictEqual(data.error, '学籍番号を確認してください');
  });

  test('有効なコードがある間は再送が429で制限されること', async () => {
    const res = await fetch(`${baseUrl}/api/form/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: '21420' })
    });
    assert.strictEqual(res.status, 429);
    const data = await res.json();
    assert.ok(data.retryAfterSeconds > 0);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
  });

  test('コードの有効期限が切れると再送できること', async () => {
    db.prepare('UPDATE otp_codes SET expires_at = 1 WHERE student_id = ?').run('21420');

    const res = await fetch(`${baseUrl}/api/form/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: '21420' })
    });
    assert.strictEqual(res.status, 200);
  });

  test('名簿に無い学籍番号では /submit が拒否されること', async () => {
    const res = await fetch(`${baseUrl}/api/form/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: '99999', code: '000000', departmentId: 'honbu' })
    });
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.strictEqual(data.error, '学籍番号を確認してください');
  });

  test('POST /api/form/submit で正しいコードを入力して点呼が完了すること', async () => {
    // DBから生成されたOTPコードを取得（テスト用）
    const otpRecord = db.prepare('SELECT code FROM otp_codes WHERE student_id = ?').get('21420');
    assert.ok(otpRecord);

    const res = await fetch(`${baseUrl}/api/form/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: '21420',
        code: otpRecord.code,
        departmentId: 'honbu'
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.record.studentId, '21420');
  });

  test('GET /api/dashboard/stats で提出データが集計に反映されていること', async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/stats`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.totalSummary.total, 1);
    assert.strictEqual(data.totalSummary.present, 1);
    assert.strictEqual(data.recentRecords.length, 1);
    assert.strictEqual(data.recentRecords[0].student_id, '21420');
  });

  test('管理者ログインとCSVエクスポートが動作すること', async () => {
    // ログイン
    const loginRes = await fetch(`${baseUrl}/admin/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test_password_123' })
    });
    assert.strictEqual(loginRes.status, 200);
    const loginData = await loginRes.json();
    const token = loginData.token;

    // CSVエクスポート
    const csvRes = await fetch(`${baseUrl}/admin/api/export-csv`, {
      headers: { 'x-admin-token': token }
    });
    assert.strictEqual(csvRes.status, 200);
    const buffer = Buffer.from(await csvRes.arrayBuffer());
    // BOM (EF BB BF) チェック
    assert.strictEqual(buffer[0], 0xef);
    assert.strictEqual(buffer[1], 0xbb);
    assert.strictEqual(buffer[2], 0xbf);

    const csvText = buffer.toString('utf8');
    assert.match(csvText, /21420/);
    assert.doesNotMatch(csvText, /出欠/);
  });
});
