const clients = new Set();

/**
 * SSE接続ハンドラ
 */
function handleSseConnection(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', time: Date.now() })}\n\n`);

  clients.add(res);

  // 25秒ごとのキープアライブコメント（プロキシやNATでの切断防止）
  const keepAliveTimer = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAliveTimer);
    clients.delete(res);
  });
}

/**
 * 全SSE接続クライアントにイベントをブロードキャスト
 */
function broadcast(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch (e) {
      clients.delete(client);
    }
  }
}

module.exports = {
  handleSseConnection,
  broadcast
};
