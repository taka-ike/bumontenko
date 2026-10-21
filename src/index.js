const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const config = require('./config');
const { ipFilterMiddleware } = require('./ipFilter');
const barcodeTenko = require('./barcodeTenko');
const roster = require('./roster');

const formRouter = require('./routes/form');
const dashboardRouter = require('./routes/dashboard');
const adminRouter = require('./routes/admin');

const app = express();

// リバースプロキシ（Caddy等）の背後で正しくIPを取得
app.set('trust proxy', true);

// 基本ミドルウェア
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// 学内IP制限ミドルウェア（/tadmin や静的アセット以外に適用）
app.use(ipFilterMiddleware);

// 静的ファイルの提供
app.use(express.static(path.resolve(__dirname, '..', 'public')));

// ヘルスチェック
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// APIルーティング
app.use('/api/form', formRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/tadmin/api', adminRouter);

// 画面ルーティング
app.get('/complete', (req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'complete.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'dashboard.html'));
});

app.get('/tadmin', (req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'tadmin.html'));
});

// 404 ハンドラ
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// エラーハンドラ
app.use((err, req, res, next) => {
  console.error('[ServerError]', err);
  res.status(500).json({ error: 'サーバー内部エラーが発生しました。' });
});

app.listen(config.port, config.host, () => {
  console.log(`====================================================`);
  console.log(` 文化祭 部門点呼システム サーバー起動完了`);
  console.log(` バインド: ${config.host}:${config.port}`);
  console.log(` 動作モード: ${config.nodeEnv}`);
  console.log(` IP制限: ${config.ipFilterEnabled ? '有効 (学内限定)' : '無効 (全アクセス許可)'}`);
  if (config.ipFilterEnabled) {
    console.log(` 許可IP: ${config.allowedIps.join(', ')}`);
  }
  const rosterStatus = roster.getStatus();
  if (rosterStatus.loaded) {
    console.log(` 名簿: ${rosterStatus.count}件 (${rosterStatus.path})`);
  } else {
    console.log(` ⚠ 名簿: 未設定 (${rosterStatus.path}) — 学籍番号の受け付けは全て拒否されます`);
  }
  console.log(` 点呼フォーム: http://localhost:${config.port}/`);
  console.log(` 本部ダッシュボード: http://localhost:${config.port}/dashboard`);
  console.log(` 管理者画面: http://localhost:${config.port}/tadmin`);
  if (barcodeTenko.isEnabled()) {
    console.log(` BarcodeTenko5: ${config.barcodeTenkoBaseUrl} (locationId=${config.barcodeTenkoLocationId ?? '未設定'})`);
  } else {
    console.log(` BarcodeTenko5: 無効 (BARCODE_TENKO_CLIENT_TOKEN 未設定)`);
  }
  console.log(`====================================================`);
});

barcodeTenko.start();
