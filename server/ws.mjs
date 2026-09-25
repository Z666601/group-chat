// 极简 RFC6455 WebSocket 服务端实现（零依赖）
// 支持：握手、文本/二进制帧、分片重组、ping/pong、close、掩码校验
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_PAYLOAD = 8 * 1024 * 1024; // 单帧上限 8MB
const MAX_MESSAGE_PAYLOAD = 8 * 1024 * 1024; // 单条消息上限 8MB

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_FRAME_PAYLOAD)) return { error: 1009, reason: 'frame too large' };
    len = Number(big);
    offset = 10;
  }
  if (len > MAX_FRAME_PAYLOAD) return { error: 1009, reason: 'frame too large' };
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (masked) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  }
  return { fin, opcode, payload, total: offset + len, masked };
}

export class WSConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.closed = false;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.fragmentSize = 0;
    this.isAlive = true;
    this.meta = {};

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#finish(1006, 'socket closed'));
    socket.on('error', (err) => {
      this.emit('wserror', err);
      this.#finish(1011, 'socket error');
    });
    socket.setNoDelay(true);
  }

  #onData(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const frame = parseFrame(this.buf);
      if (frame === null) return;
      if (frame.error) {
        this.close(frame.error, frame.reason);
        return;
      }
      this.buf = this.buf.subarray(frame.total);
      if (!frame.masked) {
        // RFC6455: 客户端帧必须掩码
        this.close(1002, 'unmasked client frame');
        return;
      }
      this.#handleFrame(frame);
      if (this.closed) return;
    }
  }

  #handleFrame(frame) {
    const { fin, opcode, payload } = frame;
    switch (opcode) {
      case OP.PING:
        this.#sendRaw(encodeFrame(OP.PONG, payload));
        return;
      case OP.PONG:
        this.isAlive = true;
        this.emit('pong', payload);
        return;
      case OP.CLOSE: {
        let code = 1000;
        let reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString('utf8');
        }
        try {
          this.#sendRaw(encodeFrame(OP.CLOSE, payload.subarray(0, 2)));
        } catch {
          /* ignore */
        }
        this.#finish(code, reason || 'peer close');
        return;
      }
      case OP.TEXT:
      case OP.BIN:
      case OP.CONT: {
        if (opcode === OP.CONT && this.fragmentOpcode === null) {
          this.close(1002, 'unexpected continuation');
          return;
        }
        if (opcode !== OP.CONT) {
          this.fragmentOpcode = opcode;
          this.fragments = [];
          this.fragmentSize = 0;
        }
        this.fragmentSize += payload.length;
        if (this.fragmentSize > MAX_MESSAGE_PAYLOAD) {
          this.close(1009, 'message too large');
          return;
        }
        this.fragments.push(payload);
        if (!fin) return;
        const full = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
        const kind = this.fragmentOpcode;
        this.fragmentOpcode = null;
        this.fragments = [];
        this.fragmentSize = 0;
        if (kind === OP.TEXT) {
          this.emit('message', full.toString('utf8'), false);
        } else {
          this.emit('message', full, true);
        }
        return;
      }
      default:
        this.close(1002, 'unknown opcode');
    }
  }

  #sendRaw(buf) {
    if (this.closed) return false;
    try {
      this.socket.write(buf);
      return true;
    } catch {
      this.#finish(1011, 'write failed');
      return false;
    }
  }

  send(data) {
    if (Buffer.isBuffer(data)) return this.#sendRaw(encodeFrame(OP.BIN, data));
    return this.#sendRaw(encodeFrame(OP.TEXT, String(data)));
  }

  sendJSON(obj) {
    return this.send(JSON.stringify(obj));
  }

  ping() {
    this.isAlive = false;
    this.#sendRaw(encodeFrame(OP.PING, Buffer.alloc(0)));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    try {
      this.#sendRaw(encodeFrame(OP.CLOSE, payload));
    } catch {
      /* ignore */
    }
    this.#finish(code, reason);
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
  }

  #finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.fragments = [];
    this.emit('close', code, reason);
    setTimeout(() => {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
    }, 10).unref?.();
  }
}

/**
 * 在 http server 上挂载 WebSocket。返回 { clients } 便于心跳管理。
 */
export function attachWebSocketServer(httpServer, { onConnection } = {}) {
  const clients = new Set();

  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (upgrade !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    socket.write(headers.join('\r\n') + '\r\n\r\n');

    const conn = new WSConnection(socket, req);
    clients.add(conn);
    conn.on('close', () => clients.delete(conn));
    if (onConnection) onConnection(conn, req);
  });

  // 心跳：定期 ping，未回应的连接断开
  const heartbeat = setInterval(() => {
    for (const conn of clients) {
      if (conn.closed) {
        clients.delete(conn);
        continue;
      }
      if (!conn.isAlive) {
        conn.close(1001, 'heartbeat timeout');
        clients.delete(conn);
        continue;
      }
      conn.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  return { clients, close: () => clearInterval(heartbeat) };
}
