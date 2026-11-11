/* Motion Boxing: small WebSocket game server (no dependencies, Node 18+).
   Room logic lives in rooms.js and is the authority. Run:  PORT=8080 node server.js
   Clients connect to wss://<your-host>/  (put it behind HTTPS/WSS: GitHub Pages is HTTPS, so browsers require wss://). */
'use strict';
const http = require('http'), crypto = require('crypto');
const RoomManager = require('./rooms.js');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', MAX_PAYLOAD = 64 * 1024, MAX_PER_IP = 8;

function createServer(opts) {
  opts = opts || {};
  const rooms = new RoomManager({ staleMs: opts.staleMs || 20000 });
  const allowed = (opts.origins || process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);   // e.g. https://zr1t99-lang.github.io
  const perIp = new Map();
  let nextId = 1;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Motion Boxing server ok. rooms=' + Object.keys(rooms.rooms).length + ' clients=' + Object.keys(rooms.clients).length + ' pose=' + ((rooms.stats || {}).pose || 0) + ' punch=' + ((rooms.stats || {}).punch || 0) + ' v3\n');
  });

  function frame(op, buf) {
    const n = buf.length; let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    return Buffer.concat([head, buf]);
  }

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'], ip = req.socket.remoteAddress || '?';
    if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
    if (allowed.length && !allowed.includes(req.headers.origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    if ((perIp.get(ip) || 0) >= MAX_PER_IP) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return; }
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true);
    const id = 'c' + (nextId++); let buf = Buffer.alloc(0), closed = false, msgCount = 0, windowStart = Date.now();
    const send = m => { if (!closed) socket.write(frame(0x1, Buffer.from(JSON.stringify(m)))); };
    rooms.connect(id, send);
    function close() { if (closed) return; closed = true; perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1)); rooms.disconnect(id); try { socket.destroy(); } catch (e) { } }
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f, masked = !!(buf[1] & 0x80); let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(MAX_PAYLOAD)) return close(); len = Number(big); off = 10; }
        if (len > MAX_PAYLOAD || !masked) return close();                       // clients must mask; refuse oversized frames
        if (buf.length < off + 4 + len) return;
        const mask = buf.slice(off, off + 4), data = Buffer.from(buf.slice(off + 4, off + 4 + len));
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
        buf = buf.slice(off + 4 + len);
        if (op === 0x8) { try { socket.write(frame(0x8, Buffer.alloc(0))); } catch (e) { } return close(); }
        if (op === 0x9) { socket.write(frame(0xA, data)); continue; }
        if (op === 0xA) continue;
        if (op !== 0x1) continue;
        const now = Date.now(); if (now - windowStart > 1000) { windowStart = now; msgCount = 0; }
        if (++msgCount > 100) return close();                                 // flood protection: 100 messages per second (pose 20/s + punches + heartbeat stay far below)
        let msg; try { msg = JSON.parse(data.toString('utf8')); } catch (e) { msg = null; }
        rooms.handle(id, msg);
      }
    });
    socket.on('close', close); socket.on('error', close);
  });
  const timer = setInterval(() => rooms.sweep(), 5000); timer.unref();
  const ticker = setInterval(() => rooms.tick(), 50); ticker.unref();          // the match clock: turns, stamina, punch resolution
  server.rooms = rooms; server.stop = () => { clearInterval(timer); clearInterval(ticker); server.close(); };
  return server;
}
module.exports = { createServer };
if (require.main === module) {
  const port = +process.env.PORT || 8080;
  createServer().listen(port, () => console.log('Motion Boxing server listening on :' + port));
}
