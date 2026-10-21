const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const path = require('path');
const fs = require('fs');

// テスト用DB設定
const testDbPath = path.resolve(__dirname, 'barcode_tenko.sqlite');
process.env.DB_PATH = 'test/barcode_tenko.sqlite';
process.env.IP_FILTER_ENABLED = 'false';
process.env.BARCODE_TENKO_BASE_URL = 'http://127.0.0.1:8097';
process.env.BARCODE_TENKO_CLIENT_TOKEN = 'test-token';
process.env.BARCODE_TENKO_CLIENT_ID = 'bumon-tenko3';
process.env.BARCODE_TENKO_LOCATION_ID = '3';

const config = require('../src/config');
const db = require('../src/db');
const barcodeTenko = require('../src/barcodeTenko');
const formRouter = require('../src/routes/form');

const requests = [];
let server;
let appServer;
let appPort;

function waitForRequests(count) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (requests.length >= count) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > 3000) {
        clearInterval(timer);
        reject(new Error('BarcodeTenko5 への送信がタイムアウトしました。'));
      }
    }, 10);
  });
}

describe('BarcodeTenko5 連携', () => {
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body ? JSON.parse(body) : null
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, created: true }));
      });
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        config.barcodeTenkoBaseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    const app = express();
    app.use(express.json());
    app.use('/api/form', formRouter);
    await new Promise((resolve) => {
      appServer = app.listen(0, '127.0.0.1', () => {
        appPort = appServer.address().port;
        resolve();
      });
    });

    const session = db.prepare("SELECT id FROM sessions WHERE status = 'open' LIMIT 1").get();
    db.prepare(`
      INSERT INTO attendance_records (id, session_id, student_id, department_id, client_ip)
      VALUES (?, ?, ?, ?, ?)
    `).run('rec-barcode-1', session.id, '21420', 'honbu', '127.0.0.1');
  });

  after(() => {
    if (server) server.close();
    if (appServer) appServer.close();

    try {
      db.close();
      for (const suffix of ['', '-wal', '-shm']) {
        const file = testDbPath + suffix;
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    } catch (e) {}
  });

  test('出席レコードが /api/scan へ正しい形式で送信されること', async () => {
    barcodeTenko.enqueueAttendance('rec-barcode-1');
    await waitForRequests(1);

    const sent = requests[0];
    assert.strictEqual(sent.method, 'POST');
    assert.strictEqual(sent.url, '/api/scan');
    assert.strictEqual(sent.headers['x-client-token'], 'test-token');
    assert.strictEqual(sent.headers['x-client-id'], 'bumon-tenko3');
    assert.strictEqual(sent.body.clientScanId, 'rec-barcode-1');
    assert.strictEqual(sent.body.code, '21420');
    assert.match(sent.body.clientTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.strictEqual(sent.body.locationId, 3);

    // 送信完了（status='sent'）の書き込みを待つ
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test('同じレコードを再送信しても2回目は送信されないこと', async () => {
    barcodeTenko.enqueueAttendance('rec-barcode-1');
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(requests.length, 1);

    const row = db.prepare('SELECT * FROM barcode_sync_queue WHERE record_id = ?').get('rec-barcode-1');
    assert.strictEqual(row.status, 'sent');
  });

  test('同じ学生の再送信は初回のレコードIDで1回だけ送信されること', async () => {
    const studentId = '21500';
    const beforeCount = requests.length;

    async function submit(departmentId) {
      const sendRes = await fetch(`http://127.0.0.1:${appPort}/api/form/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId })
      });
      assert.strictEqual(sendRes.status, 200);

      const otpRow = db.prepare('SELECT code FROM otp_codes WHERE student_id = ?').get(studentId);
      const submitRes = await fetch(`http://127.0.0.1:${appPort}/api/form/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId, code: otpRow.code, departmentId })
      });
      assert.strictEqual(submitRes.status, 200);
    }

    await submit('honbu');
    await waitForRequests(beforeCount + 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const session = db.prepare("SELECT id FROM sessions WHERE status = 'open' LIMIT 1").get();
    const saved = db.prepare(
      'SELECT id, department_id FROM attendance_records WHERE session_id = ? AND student_id = ?'
    ).get(session.id, studentId);
    const firstRequest = requests[beforeCount];
    assert.strictEqual(firstRequest.body.clientScanId, saved.id);
    assert.strictEqual(firstRequest.body.code, studentId);

    await submit('kikaku');
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.strictEqual(requests.length, beforeCount + 1);
    const updated = db.prepare(
      'SELECT department_id FROM attendance_records WHERE session_id = ? AND student_id = ?'
    ).get(session.id, studentId);
    assert.strictEqual(updated.department_id, 'kikaku');
  });
});
