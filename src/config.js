const path = require('path');
const dotenv = require('dotenv');

// .env を読み込み
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function parseAllowedIps(str) {
  if (!str) return [];
  return str
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

const barcodeTenkoLocationId = parseInt(process.env.BARCODE_TENKO_LOCATION_ID, 10);

module.exports = {
  port: parseInt(process.env.PORT, 10) || 8080,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',
  dbPath: path.resolve(__dirname, '..', process.env.DB_PATH || 'data/tenko.sqlite'),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || 'bumon_tenko_secret_key',
  dashboardToken: process.env.DASHBOARD_TOKEN || '',

  // IP 制限
  ipFilterEnabled: process.env.IP_FILTER_ENABLED === 'true',
  allowedIps: parseAllowedIps(process.env.ALLOWED_IPS || '127.0.0.1,::1'),

  // OTP 設定
  otpExpiresMinutes: parseInt(process.env.OTP_EXPIRES_MINUTES, 10) || 5,
  otpMaxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS, 10) || 5,

  // 学籍番号名簿（JSON配列）
  rosterPath: path.resolve(__dirname, '..', process.env.STUDENT_ROSTER_PATH || 'data/roster.json'),

  // Power Automate Webhook (OTP送信用)
  teamsWebhookUrl: process.env.TEAMS_WEBHOOK_URL || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',

  // BarcodeTenko5 連携
  barcodeTenkoBaseUrl: process.env.BARCODE_TENKO_BASE_URL || 'http://127.0.0.1:8080',
  barcodeTenkoClientToken: process.env.BARCODE_TENKO_CLIENT_TOKEN || '',
  barcodeTenkoClientId: process.env.BARCODE_TENKO_CLIENT_ID || 'bumon-tenko3',
  barcodeTenkoLocationId: Number.isInteger(barcodeTenkoLocationId) ? barcodeTenkoLocationId : null,
};
