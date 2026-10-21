const ipaddr = require('ipaddr.js');
const path = require('path');
const config = require('./config');

/**
 * リクエストからクライアントのIPアドレスを抽出する
 */
function getClientIp(req) {
  // X-Forwarded-For の最左端（クライアントの実IP）
  const forwarded = req.headers['x-forwarded-for'];
  let rawIp = '';
  if (forwarded) {
    rawIp = forwarded.split(',')[0].trim();
  } else {
    rawIp = req.socket.remoteAddress || req.ip || '';
  }

  // IPv6-mapped IPv4 (::ffff:192.168.1.1) を標準IPv4に変換
  try {
    const parsed = ipaddr.parse(rawIp);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
      return parsed.toIPv4Address().toString();
    }
    return parsed.toString();
  } catch (err) {
    return rawIp;
  }
}

/**
 * 指定されたIPが許可リスト（CIDRまたは単一IP）に含まれているか判定
 */
function isIpAllowed(clientIpStr, allowedList) {
  if (!clientIpStr) return false;

  let clientIp;
  try {
    clientIp = ipaddr.parse(clientIpStr);
    if (clientIp.kind() === 'ipv6' && clientIp.isIPv4MappedAddress()) {
      clientIp = clientIp.toIPv4Address();
    }
  } catch (e) {
    return false;
  }

  for (const item of allowedList) {
    try {
      if (item.includes('/')) {
        // CIDR表記
        const parsedCidr = ipaddr.parseCIDR(item);
        if (clientIp.kind() === parsedCidr[0].kind() && clientIp.match(parsedCidr)) {
          return true;
        }
      } else {
        // 単一IP
        let parsedTarget = ipaddr.parse(item);
        if (parsedTarget.kind() === 'ipv6' && parsedTarget.isIPv4MappedAddress()) {
          parsedTarget = parsedTarget.toIPv4Address();
        }
        if (clientIp.toString() === parsedTarget.toString()) {
          return true;
        }
      }
    } catch (e) {
      console.warn(`[ipFilter] 無効なIPルールをスキップ: ${item}`);
    }
  }

  return false;
}

/**
 * Expressミドルウェア
 */
function ipFilterMiddleware(req, res, next) {
  // IP制限が無効化されている場合は素通し
  if (!config.ipFilterEnabled) {
    req.clientIp = getClientIp(req);
    return next();
  }

  const clientIp = getClientIp(req);
  req.clientIp = clientIp;

  // 管理者画面やエラー画面、静的アセットは制限対象外（管理者が学外から見ることも考慮）
  // ※もし管理画面も学内に閉じたい場合は設定で調整可能
  const pathname = req.path;
  if (
    pathname.startsWith('/tadmin') ||
    pathname === '/healthz' ||
    pathname === '/error-denied.html' ||
    pathname.startsWith('/css/') ||
    pathname.startsWith('/js/') ||
    pathname === '/favicon.ico'
  ) {
    return next();
  }

  // IPチェック
  if (isIpAllowed(clientIp, config.allowedIps)) {
    return next();
  }

  // 許可されていない場合
  console.log(`[ipFilter] 拒否されたアクセス: IP=${clientIp}, Path=${pathname}`);

  // APIリクエストなら403 JSON
  if (pathname.startsWith('/api/')) {
    return res.status(403).json({
      error: 'Access Denied',
      message: '学内ネットワーク（校内Wi-Fi）からのみアクセス可能です。',
      clientIp
    });
  }

  // HTMLブラウザアクセスなら専用エラー案内ページを表示
  return res.status(403).sendFile(path.resolve(__dirname, '..', 'public', 'error-denied.html'));
}

module.exports = {
  getClientIp,
  isIpAllowed,
  ipFilterMiddleware
};
