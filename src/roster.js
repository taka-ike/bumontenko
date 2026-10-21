const fs = require('fs');
const config = require('./config');

function normalizeId(id) {
  return String(id).trim().toUpperCase();
}

let ids = new Set();
let loaded = false;

/**
 * 名簿を読み込む（起動時に一度だけ実行）
 * @param {string} [filePath] テスト用にパスを差し替え可能
 */
function load(filePath = config.rosterPath) {
  ids = new Set();
  loaded = false;

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error('名簿はJSON配列で記述してください。');
    }

    const set = new Set(parsed.map(normalizeId).filter(Boolean));
    if (set.size === 0) {
      throw new Error('名簿が空です。');
    }

    ids = set;
    loaded = true;
  } catch (err) {
    console.error(`[Roster] 名簿の読み込みに失敗しました (${filePath}): ${err.message}`);
    console.error('[Roster] 名簿が設定されていないため、学籍番号の受け付けは全て拒否されます。');
  }
}

function isRegistered(studentId) {
  return loaded && ids.has(normalizeId(studentId));
}

function getStatus() {
  return { loaded, count: ids.size, path: config.rosterPath };
}

load();

module.exports = {
  normalizeId,
  isRegistered,
  getStatus,
  load
};
