'use strict';
// Tiny RFC6455 client for local Stream Dock host; no npm dependencies.
const net = require('node:net');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
class LocalWS extends EventEmitter {
  constructor(port) {
    super(); this.port = port; this.socket = null; this.open = false;
    this.pending = Buffer.alloc(0); this.fragment = null; this.fragmentOpcode = null;
  }
  connect() {
    const key = crypto.randomBytes(16).toString('base64');
    const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    this.socket = net.connect({ host: '127.0.0.1', port: this.port }, () => {
      this.socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:' + this.port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + key + '\r\n\r\n');
    });
    this.socket.setNoDelay(true);
    let upgraded = false;
    this.socket.on('data', chunk => {
      this.pending = Buffer.concat([this.pending, chunk]);
      if (!upgraded) {
        if (this.pending.length > 32 * 1024) { this.socket.destroy(); return; }
        const cut = this.pending.indexOf('\r\n\r\n');
        if (cut < 0) return;
        const response = this.pending.subarray(0, cut).toString('latin1');
        if (!/^HTTP\/1\.1 101\b/.test(response) || !/^sec-websocket-accept:\s*(.+)$/im.test(response) || response.match(/^sec-websocket-accept:\s*(.+)$/im)[1].trim() !== expected) {
          this.socket.destroy(new Error('Invalid websocket handshake')); return;
        }
        upgraded = true; this.open = true;
        this.pending = this.pending.subarray(cut + 4);
        this.emit('open');
      }
      this.drain();
    });
    this.socket.on('error', err => this.emit('error', err));
    this.socket.on('close', () => { this.open = false; this.emit('close'); });
  }
  frame(op, bytes) {
    if (!this.socket || !this.open) return;
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
    const length = data.length;
    let header;
    if (length < 126) header = Buffer.from([0x80 | op, 0x80 | length]);
    else if (length < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 0xfe; header.writeUInt16BE(length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 0xff; header.writeBigUInt64BE(BigInt(length), 2); }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; ++i) masked[i] = data[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  send(obj) { this.frame(1, JSON.stringify(obj)); }
  drain() {
    while (this.pending.length >= 2) {
      const a = this.pending[0], b = this.pending[1];
      const masked = !!(b & 0x80);
      let len = b & 127, offset = 2;
      if (len === 126) { if (this.pending.length < 4) return; len = this.pending.readUInt16BE(2); offset = 4; }
      if (len === 127) { if (this.pending.length < 10) return; const n = this.pending.readBigUInt64BE(2); if (n > 5_000_000n) { this.socket.destroy(); return; } len = Number(n); offset = 10; }
      if (len > 5_000_000) { this.socket.destroy(); return; }
      if (masked) offset += 4;
      if (this.pending.length < offset + len) return;
      let data = Buffer.from(this.pending.subarray(offset, offset + len));
      if (masked) for (let i = 0; i < len; i++) data[i] ^= this.pending[offset - 4 + (i & 3)];
      this.pending = this.pending.subarray(offset + len);
      const op = a & 0x0f, fin = !!(a & 0x80);
      if (op === 8) { this.socket.end(); return; }
      if (op === 9) { this.frame(10, data); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) { this.fragment = data; this.fragmentOpcode = op; }
      else if (op === 0 && this.fragment) this.fragment = Buffer.concat([this.fragment, data]);
      else continue;
      if (this.fragment.length > 5_000_000) { this.socket.destroy(); return; }
      if (fin) {
        if (this.fragmentOpcode === 1) this.emit('message', this.fragment.toString('utf8'));
        this.fragment = null; this.fragmentOpcode = null;
      }
    }
  }
  close() { this.socket?.end(); }
}
module.exports = { LocalWS };
