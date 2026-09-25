// 实时中枢：订阅、广播、断线补齐、在场、限流、发送落库
import * as store from './db.mjs';
import { nowIso } from './util.mjs';

export const DEFAULT_LIMITS = {
  maxTextLength: 2000,
  maxImageBytes: 5 * 1024 * 1024,
  msgRateCapacity: 12, // 令牌桶容量（突发）
  msgRateRefillPerSec: 2, // 每秒补充速率 → 稳态 ~120 条/分钟
  replayLimit: 500,
};

export function createHub({ log, metrics, limits = {} }) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const rooms = new Map(); // groupId -> Set<WSConnection>
  const buckets = new Map(); // userId -> { tokens, ts }

  function room(groupId) {
    let s = rooms.get(groupId);
    if (!s) {
      s = new Set();
      rooms.set(groupId, s);
    }
    return s;
  }

  function broadcast(groupId, payload, { except = null } = {}) {
    const set = rooms.get(groupId);
    if (!set) return 0;
    const data = JSON.stringify(payload);
    let n = 0;
    for (const conn of set) {
      if (conn === except || conn.closed) continue;
      if (conn.send(data)) n++;
    }
    return n;
  }

  function onlineUserIds(groupId) {
    const set = rooms.get(groupId);
    if (!set) return [];
    const ids = new Set();
    for (const c of set) if (c.user) ids.add(c.user.id);
    return [...ids];
  }

  function checkRate(userId) {
    const now = Date.now();
    let b = buckets.get(userId);
    if (!b) {
      b = { tokens: L.msgRateCapacity, ts: now };
      buckets.set(userId, b);
    }
    const elapsed = (now - b.ts) / 1000;
    b.tokens = Math.min(L.msgRateCapacity, b.tokens + elapsed * L.msgRateRefillPerSec);
    b.ts = now;
    if (b.tokens < 1) {
      return { ok: false, retryAfterMs: Math.ceil((1 - b.tokens) / L.msgRateRefillPerSec * 1000) };
    }
    b.tokens -= 1;
    return { ok: true };
  }

  function requireMembership(conn, groupId) {
    if (!conn.user) return { ok: false, code: 'unauthenticated', message: '请先登录' };
    const g = store.groups.byId(groupId);
    if (!g) return { ok: false, code: 'group_not_found', message: '群组不存在' };
    if (g.status !== 'active') return { ok: false, code: 'group_dissolved', message: '该群已解散' };
    if (!store.members.isActive(groupId, conn.user.id)) {
      return { ok: false, code: 'not_a_member', message: '你不是该群成员' };
    }
    return { ok: true, group: g };
  }

  function deny(conn, code, message, meta = {}) {
    metrics.inc('ws.error');
    metrics.inc(`ws.error.${code}`);
    conn.sendJSON({ type: 'error', code, message, ...meta });
  }

  function auditDenied(conn, code, groupId, detail) {
    store.audit.log({
      type: 'authz_denied',
      actorId: conn.user?.id || null,
      groupId: groupId || null,
      detail: { code, ...detail },
      ip: conn.meta.ip || null,
    });
  }

  function handle(conn, raw, isBinary) {
    if (isBinary) {
      deny(conn, 'unsupported_binary', '实时通道不接受二进制帧，请先上传图片再发送引用');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      deny(conn, 'invalid_json', '消息格式错误');
      return;
    }
    const type = msg?.type;
    if (type === 'ping') {
      conn.sendJSON({ type: 'pong', ts: nowIso() });
      return;
    }
    if (type === 'subscribe') return onSubscribe(conn, msg);
    if (type === 'unsubscribe') return onUnsubscribe(conn, msg);
    if (type === 'send') return onSend(conn, msg);
    if (type === 'send-image') return onSendImage(conn, msg);
    if (type === 'read') return onRead(conn, msg);
    if (type === 'typing') return onTyping(conn, msg);
    deny(conn, 'unknown_type', `未知的消息类型：${type}`);
  }

  function onSubscribe(conn, msg) {
    const groupId = String(msg.groupId || '');
    const check = requireMembership(conn, groupId);
    if (!check.ok) {
      deny(conn, check.code, check.message, { groupId });
      auditDenied(conn, check.code, groupId, { op: 'subscribe' });
      return;
    }
    conn.subs.add(groupId);
    room(groupId).add(conn);

    const sinceSeq = Number(msg.sinceSeq) || 0;
    const latestSeq = store.messages.latestSeq(groupId);
    let missed = [];
    if (sinceSeq > 0 && sinceSeq < latestSeq) {
      missed = store.messages.since(groupId, sinceSeq, L.replayLimit);
    }
    for (const m of missed) conn.sendJSON({ type: 'message', groupId, message: view(m) });
    conn.sendJSON({
      type: 'subscribed',
      groupId,
      latestSeq,
      replayed: missed.length,
      online: onlineUserIds(groupId),
      truncated: missed.length >= L.replayLimit,
    });
    broadcast(groupId, { type: 'presence', groupId, online: onlineUserIds(groupId) });
    metrics.inc('ws.subscribe');
  }

  function onUnsubscribe(conn, msg) {
    const groupId = String(msg.groupId || '');
    conn.subs.delete(groupId);
    rooms.get(groupId)?.delete(conn);
    broadcast(groupId, { type: 'presence', groupId, online: onlineUserIds(groupId) });
  }

  function onTyping(conn, msg) {
    const groupId = String(msg.groupId || '');
    if (!conn.user || !store.members.isActive(groupId, conn.user.id)) return;
    broadcast(
      groupId,
      {
        type: 'typing',
        groupId,
        userId: conn.user.id,
        displayName: conn.user.displayName || conn.user.username,
        kind: conn.user.kind || 'human',
        until: Date.now() + 6000,
      },
      { except: conn },
    );
  }

  function onRead(conn, msg) {
    const groupId = String(msg.groupId || '');
    const seq = Number(msg.seq) || 0;
    if (!conn.user || seq <= 0 || !store.members.isActive(groupId, conn.user.id)) return;
    const before = Number(store.members.get(groupId, conn.user.id)?.last_read_seq || 0);
    store.members.setLastRead(groupId, conn.user.id, seq);
    // 只在真正推进时通知他人，避免重复 read 帧刷屏
    if (seq > before) {
      broadcast(
        groupId,
        { type: 'read-receipt', groupId, userId: conn.user.id, seq },
        { except: conn },
      );
    }
  }

  function onSend(conn, msg) {
    const groupId = String(msg.groupId || '');
    const clientMsgId = msg.clientMsgId ? String(msg.clientMsgId).slice(0, 64) : null;
    const text = typeof msg.text === 'string' ? msg.text : '';
    persistAndFanout(conn, { groupId, clientMsgId, type: 'text', body: text, kind: 'text' });
  }

  function onSendImage(conn, msg) {
    const groupId = String(msg.groupId || '');
    const clientMsgId = msg.clientMsgId ? String(msg.clientMsgId).slice(0, 64) : null;
    const attachmentId = String(msg.attachmentId || '');
    const caption = typeof msg.caption === 'string' ? msg.caption : '';
    const att = store.attachments.byId(attachmentId);
    if (!att) {
      deny(conn, 'attachment_not_found', '图片不存在或已失效', { clientMsgId });
      return;
    }
    persistAndFanout(conn, {
      groupId,
      clientMsgId,
      type: 'image',
      body: caption,
      attachmentId,
      kind: 'image',
    });
  }

  function persistAndFanout(conn, { groupId, clientMsgId, type, body, attachmentId = null, kind }) {
    const t0 = Date.now();
    const check = requireMembership(conn, groupId);
    if (!check.ok) {
      deny(conn, check.code, check.message, { groupId, clientMsgId });
      auditDenied(conn, check.code, groupId, { op: 'send' });
      return;
    }
    // 幂等：同 (群, 发送者, 客户端消息号) 直接回放既有消息
    if (clientMsgId) {
      const dup = store.messages.findByClientId(groupId, conn.user.id, clientMsgId);
      if (dup) {
        conn.sendJSON({
          type: 'ack',
          clientMsgId,
          messageId: dup.id,
          seq: Number(dup.seq),
          createdAt: dup.created_at,
          duplicate: true,
        });
        return;
      }
    }
    if (kind === 'text') {
      const trimmed = String(body ?? '');
      if (!trimmed.trim()) {
        deny(conn, 'empty_message', '消息内容不能为空', { clientMsgId });
        return;
      }
      if (trimmed.length > L.maxTextLength) {
        deny(conn, 'text_too_long', `消息长度不能超过 ${L.maxTextLength} 字`, {
          clientMsgId,
          limit: L.maxTextLength,
        });
        store.audit.log({
          type: 'invalid_input',
          actorId: conn.user.id,
          groupId,
          detail: { reason: 'text_too_long', length: trimmed.length },
          ip: conn.meta.ip || null,
        });
        metrics.inc('abuse.text_too_long');
        return;
      }
    }
    const rate = checkRate(conn.user.id);
    if (!rate.ok) {
      deny(conn, 'rate_limited', '发送过于频繁，请稍后再试', {
        clientMsgId,
        retryAfterMs: rate.retryAfterMs,
      });
      store.audit.log({
        type: 'rate_limited',
        actorId: conn.user.id,
        groupId,
        detail: { retryAfterMs: rate.retryAfterMs },
        ip: conn.meta.ip || null,
      });
      metrics.inc('abuse.rate_limited');
      return;
    }

    let created;
    try {
      created = store.tx(() => {
        const seq = store.messages.nextSeq(groupId);
        return store.messages.insert({
          groupId,
          senderId: conn.user.id,
          type,
          body: body ?? '',
          attachmentId,
          clientMsgId,
          seq,
        });
      });
      store.groups.update(groupId, {});
    } catch (err) {
      log.error('message.insert_failed', { err: String(err?.message || err), groupId });
      metrics.inc('message.insert_failed');
      // 可能是并发下唯一索引冲突，尝试回放
      if (clientMsgId) {
        const dup = store.messages.findByClientId(groupId, conn.user.id, clientMsgId);
        if (dup) {
          conn.sendJSON({
            type: 'ack',
            clientMsgId,
            messageId: dup.id,
            seq: Number(dup.seq),
            createdAt: dup.created_at,
            duplicate: true,
          });
          return;
        }
      }
      conn.sendJSON({
        type: 'send_failed',
        code: 'persist_failed',
        clientMsgId,
        message: '消息保存失败，请重试',
      });
      return;
    }

    conn.sendJSON({
      type: 'ack',
      clientMsgId,
      messageId: created.id,
      seq: Number(created.seq),
      createdAt: created.created_at,
    });
    broadcast(groupId, { type: 'message', groupId, message: view(created) });
    metrics.inc('message.sent');
    metrics.observe('message.persist', Date.now() - t0);
    log.info('message.sent', {
      groupId,
      userId: conn.user.id,
      messageId: created.id,
      seq: Number(created.seq),
      type,
    });
  }

  function view(m) {
    return {
      id: m.id,
      groupId: m.group_id,
      seq: Number(m.seq),
      senderId: m.sender_id,
      senderName: m.sender_name ?? null,
      senderUsername: m.sender_username ?? null,
      senderKind: m.sender_kind || 'human',
      senderAvatar: m.sender_avatar || '',
      type: m.type,
      body: m.body,
      attachmentId: m.attachment_id || null,
      createdAt: m.created_at,
    };
  }

  function onClose(conn) {
    for (const groupId of conn.subs) {
      rooms.get(groupId)?.delete(conn);
      if (rooms.get(groupId)?.size === 0) rooms.delete(groupId);
      else broadcast(groupId, { type: 'presence', groupId, online: onlineUserIds(groupId) });
    }
    metrics.inc('ws.close');
  }

  function stats() {
    let connections = 0;
    for (const set of rooms.values()) connections += set.size;
    return { rooms: rooms.size, connections, onlineUsers: onlineUsers.length };
  }

  const onlineUsers = new Set();
  function trackUser(userId) {
    onlineUsers.add(userId);
  }
  function untrackUser(userId) {
    onlineUsers.delete(userId);
  }

  return { handle, onClose, broadcast, room, onlineUserIds, stats, trackUser, untrackUser, view, limits: L };
}
