const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// テスト用DBパス
const testDbPath = path.resolve(__dirname, 'test_tenko.sqlite');
process.env.DB_PATH = 'test/test_tenko.sqlite';
process.env.IP_FILTER_ENABLED = 'true';
process.env.ALLOWED_IPS = '133.0.0.0/8,127.0.0.1,::1,192.168.1.0/24';

const db = require('../src/db');
const otp = require('../src/otp');
const { isIpAllowed } = require('../src/ipFilter');
const config = require('../src/config');

describe('文化祭点呼システム ユニット・結合テスト', () => {

  after(() => {
    // テスト後の一時DBクリーンアップ
    try {
      db.close();
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
      const wal = testDbPath + '-wal';
      const shm = testDbPath + '-shm';
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
    } catch (e) {}
  });

  describe('1. OTP（二段階認証）テスト', () => {
    test('6桁のOTPコードが正常に発行されること', () => {
      const result = otp.createOtp('21420');
      assert.strictEqual(result.studentId, '21420');
      assert.match(result.code, /^\d{6}$/);
      assert.strictEqual(result.expiresMinutes, 5);
    });

    test('誤ったコードを入力すると失敗し、残り回数が返ること', () => {
      const generated = otp.createOtp('TEST01');
      const verifyFail = otp.verifyOtp('TEST01', '000000');
      assert.strictEqual(verifyFail.valid, false);
      assert.match(verifyFail.error, /認証コードが一致しません/);
    });

    test('正しいコードを入力すると成功し、コードが破棄されること', () => {
      const generated = otp.createOtp('TEST02');
      const verifySuccess = otp.verifyOtp('TEST02', generated.code);
      assert.strictEqual(verifySuccess.valid, true);

      // 再度同じコードで検証すると破棄されているため失敗する
      const reVerify = otp.verifyOtp('TEST02', generated.code);
      assert.strictEqual(reVerify.valid, false);
    });
  });

  describe('2. 学内IP制限 (ipFilter) テスト', () => {
    const allowed = ['133.0.0.0/8', '127.0.0.1', '::1', '192.168.1.0/24'];

    test('学内IP (133.x.x.x) が許可されること', () => {
      assert.strictEqual(isIpAllowed('133.100.1.5', allowed), true);
      assert.strictEqual(isIpAllowed('133.250.20.100', allowed), true);
    });

    test('ローカルホストが許可されること', () => {
      assert.strictEqual(isIpAllowed('127.0.0.1', allowed), true);
      assert.strictEqual(isIpAllowed('::1', allowed), true);
    });

    test('サブネット範囲内のプライベートIPが許可されること', () => {
      assert.strictEqual(isIpAllowed('192.168.1.50', allowed), true);
      assert.strictEqual(isIpAllowed('192.168.2.50', allowed), false);
    });

    test('学外の一般的なモバイル回線/自宅IPが遮断されること', () => {
      assert.strictEqual(isIpAllowed('203.0.113.1', allowed), false);
      assert.strictEqual(isIpAllowed('118.238.10.20', allowed), false);
      assert.strictEqual(isIpAllowed('49.98.150.10', allowed), false);
    });
  });

  describe('3. データベース & 出席登録ロジック テスト', () => {
    test('初期部門データとセッションが存在すること', () => {
      const depts = db.prepare('SELECT * FROM departments').all();
      assert.ok(depts.length > 0);

      const session = db.prepare(`SELECT * FROM sessions WHERE status = 'open' LIMIT 1`).get();
      assert.ok(session);
      assert.strictEqual(session.status, 'open');
    });

    test('出席レコードが正常に登録され、同一セッションでの再送信時は上書き更新されること', () => {
      const session = db.prepare(`SELECT id FROM sessions WHERE status = 'open' LIMIT 1`).get();
      const insertStmt = db.prepare(`
        INSERT INTO attendance_records (
          id, session_id, student_id, department_id, client_ip, user_agent
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, student_id) DO UPDATE SET
          department_id = excluded.department_id
      `);

      // 1回目の登録
      insertStmt.run('rec-1', session.id, '21420', 'honbu', '133.1.2.3', 'ua');
      let rec = db.prepare('SELECT * FROM attendance_records WHERE session_id = ? AND student_id = ?').get(session.id, '21420');
      assert.strictEqual(rec.department_id, 'honbu');
      assert.strictEqual(rec.status, undefined);
      assert.strictEqual(rec.location, undefined);
      assert.strictEqual(rec.note, undefined);

      // 2回目の登録（所属部門を変更）
      insertStmt.run('rec-2', session.id, '21420', 'kikaku', '133.1.2.3', 'ua');
      rec = db.prepare('SELECT * FROM attendance_records WHERE session_id = ? AND student_id = ?').get(session.id, '21420');
      assert.strictEqual(rec.department_id, 'kikaku');

      // レコード総数は重複せず1件のままであること
      const count = db.prepare('SELECT COUNT(*) as c FROM attendance_records WHERE session_id = ? AND student_id = ?').get(session.id, '21420').c;
      assert.strictEqual(count, 1);
    });
  });

});
