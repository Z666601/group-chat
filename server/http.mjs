// REST API 路由
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './db.mjs';
import * as auth from './auth.mjs';
import { getModelCatalog, findModel } from './models.mjs';
import { json, fail, readBody, readRawBody, clientIp, nowIso, newId } from './util.mjs';

/** 从请求头解析智能体身份（x-agent-token） */
function resolveAgent(req) {
  const token = String(req.headers['x-agent-token'] || '').trim();
  if (!token) return null;
  return store.agents.byTokenHash(auth.hashToken(token)) || null;
}

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function msgView(m) {
  const view = {
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
    replyTo: m.reply_to || null,
    createdAt: m.created_at,
  };
  if (m.reply_to) {
    const t = store.messages.byId(m.reply_to);
    view.replyPreview = !t
      ? { id: m.reply_to, missing: true }
      : {
          id: t.id,
          seq: Number(t.seq),
          senderName: t.sender_name || t.sender_username || '未知',
          senderKind: t.sender_kind || 'human',
          deleted: !!t.deleted_at,
          body: t.deleted_at ? '' : t.type === 'image' ? '[图片]' : String(t.body || '').slice(0, 140),
        };
  }
  return view;
}

function groupView(g, extra = {}) {
  return {
    id: g.id,
    name: g.name,
    avatar: g.avatar || '',
    ownerId: g.owner_id,
    status: g.status,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
    dissolvedAt: g.dissolved_at || null,
    ...extra,
  };
}

function memberView(m, online = new Set(), models = {}, caps = {}) {
  const kind = m.kind || 'human';
  const agentKey = kind === 'agent' && /^agent\./.test(m.username) ? m.username.slice(6) : null;
  return {
    id: m.user_id,
    username: m.username,
    displayName: m.display_name,
    avatar: m.avatar || '',
    role: m.role,
    kind,
    agentKey,
    model: agentKey ? models[agentKey] || '' : '',
    supportsModel: agentKey ? caps[agentKey] !== false : undefined,
    joinedAt: m.joined_at,
    lastReadSeq: Number(m.last_read_seq || 0),
    online: online.has(m.user_id),
  };
}

export function createRouter({ log, metrics, hub, config, adminToken }) {
  const routes = [];
  const add = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/:[a-zA-Z]+/g, (m) => {
          keys.push(m.slice(1));
          return '([^/]+)';
        }) +
        '$',
    );
    routes.push({ method, regex, keys, handler, auth: opts.auth === undefined ? !opts.admin : opts.auth, admin: !!opts.admin });
  };

  // ── 系统 ──────────────────────────────────────────
  add(
    'GET',
    '/healthz',
    ({ res }) =>
      json(res, 200, {
        ok: true,
        status: 'healthy',
        now: nowIso(),
        uptimeSec: Math.round(process.uptime()),
        db: store.tableCounts(),
      }),
    { auth: false },
  );

  add(
    'GET',
    '/api/config',
    ({ res }) =>
      json(res, 200, {
        ok: true,
        limits: {
          maxTextLength: config.limits.maxTextLength,
          maxImageBytes: config.limits.maxImageBytes,
          acceptedImageTypes: [...IMAGE_MIME],
        },
        version: config.version,
      }),
    { auth: false },
  );

  // ── 鉴权 ──────────────────────────────────────────
  add(
    'POST',
    '/api/auth/register',
    ({ res, body, ip, userAgent }) => {
      const username = String(body.username || '').trim();
      const displayName = String(body.displayName || '').trim() || username;
      const password = String(body.password || '');
      const errors = auth.validateCredentials({ username, password, displayName });
      if (errors.length) {
        store.audit.log({ type: 'register_rejected', detail: { errors }, ip });
        metrics.inc('auth.register_rejected');
        return fail(res, 400, 'invalid_input', errors.join('；'));
      }
      if (store.users.byUsername(username)) {
        return fail(res, 409, 'username_taken', '该用户名已被占用');
      }
      const user = store.users.create({
        username,
        displayName,
        passwordHash: auth.hashPassword(password),
      });
      const token = auth.issueSession(user.id, userAgent);
      store.audit.log({ type: 'register', actorId: user.id, ip });
      metrics.inc('auth.register');
      return json(
        res,
        201,
        { ok: true, user: auth.publicUser(user), token },
        { 'set-cookie': auth.cookieHeader(token) },
      );
    },
    { auth: false },
  );

  add(
    'POST',
    '/api/auth/login',
    ({ res, body, ip, userAgent }) => {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const user = store.users.byUsername(username);
      if (!user || !auth.verifyPassword(password, user.password_hash)) {
        store.audit.log({ type: 'login_failed', actorId: user?.id || null, detail: { username }, ip });
        metrics.inc('auth.login_failed');
        return fail(res, 401, 'invalid_credentials', '用户名或密码不正确');
      }
      if (user.status !== 'active') {
        store.audit.log({ type: 'login_blocked', actorId: user.id, detail: { status: user.status }, ip });
        metrics.inc('auth.login_blocked');
        return fail(res, 403, 'account_disabled', '账号已被停用');
      }
      const token = auth.issueSession(user.id, userAgent);
      store.audit.log({ type: 'login', actorId: user.id, ip });
      metrics.inc('auth.login');
      return json(
        res,
        200,
        { ok: true, user: auth.publicUser(user), token },
        { 'set-cookie': auth.cookieHeader(token) },
      );
    },
    { auth: false },
  );

  // 本机免密进入：只认 socket 的真实远端地址；X-Forwarded-For 可被伪造，因此判本机不看 ctx.ip
  add(
    'POST',
    '/api/auth/local',
    ({ res, req, ip, userAgent }) => {
      if (!config.localAutologin) {
        return fail(res, 404, 'local_autologin_disabled', '本机免密进入未开启');
      }
      const peer = String(req?.socket?.remoteAddress || '');
      if (!/^(127\.|\[::1\]|::1$|localhost$)/.test(peer)) {
        store.audit.log({ type: 'login_local_denied', detail: { peer }, ip });
        metrics.inc('auth.login_local_denied');
        return fail(res, 403, 'not_local', '只允许本机回环地址免密进入');
      }
      const localUser = store.users.byUsername(config.localAutologinUser);
      if (!localUser || localUser.status !== 'active') {
        return fail(res, 404, 'local_user_missing', '本机免密账号不存在或已停用，请用密码登录');
      }
      const token = auth.issueSession(localUser.id, userAgent);
      store.audit.log({ type: 'login_local', actorId: localUser.id, detail: { peer }, ip });
      metrics.inc('auth.login_local');
      return json(
        res,
        200,
        { ok: true, user: auth.publicUser(localUser), token },
        { 'set-cookie': auth.cookieHeader(token) },
      );
    },
    { auth: false },
  );

  add('POST', '/api/auth/logout', ({ res, token, user, ip }) => {
    if (token) store.sessions.delete(token);
    store.audit.log({ type: 'logout', actorId: user?.id || null, ip });
    return json(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader('', { clear: true }) });
  });

  add('GET', '/api/me', ({ res, user }) => json(res, 200, { ok: true, user: auth.publicUser(user) }));

  // ── 群组 ──────────────────────────────────────────
  add('GET', '/api/groups', ({ res, user }) => {
    const rows = store.groups.listForUser(user.id);
    return json(res, 200, {
      ok: true,
      groups: rows.map((g) =>
        groupView(g, {
          role: g.role,
          memberCount: Number(g.member_count || 0),
          latestSeq: Number(g.latest_seq || 0),
          lastReadSeq: Number(g.last_read_seq || 0),
          unread: Math.max(0, Number(g.latest_seq || 0) - Number(g.last_read_seq || 0)),
        }),
      ),
    });
  });

  add('POST', '/api/groups', ({ res, user, body, ip }) => {
    const name = String(body.name || '').trim();
    const avatar = String(body.avatar || '').trim().slice(0, 8);
    if (name.length < 1 || name.length > 40) {
      return fail(res, 400, 'invalid_input', '群名称长度需为 1-40 位');
    }
    const g = store.groups.create({ name, avatar, ownerId: user.id });
    store.audit.log({ type: 'group_create', actorId: user.id, groupId: g.id, detail: { name }, ip });
    metrics.inc('group.create');
    return json(res, 201, { ok: true, group: groupView(g, { role: 'owner', memberCount: 1 }) });
  });

  add('GET', '/api/groups/:id', ({ res, user, params }) => {
    const g = store.groups.byId(params.id);
    if (!g) return fail(res, 404, 'group_not_found', '群组不存在');
    if (!store.members.isActive(g.id, user.id)) {
      store.audit.log({
        type: 'authz_denied',
        actorId: user.id,
        groupId: g.id,
        detail: { op: 'read_group' },
      });
      metrics.inc('authz.denied.read_group');
      return fail(res, 403, 'not_a_member', '你不是该群成员');
    }
    if (g.status !== 'active') return fail(res, 410, 'group_dissolved', '该群已解散');
    const me = store.members.get(g.id, user.id);
    const online = new Set(hub.onlineUserIds(g.id));
    const models = store.agents.modelsByGroup(g.id);
    const caps = store.agents.capsByGroup(g.id);
    return json(res, 200, {
      ok: true,
      group: groupView(g, {
        role: me.role,
        memberCount: store.members.activeIds(g.id).length,
        latestSeq: store.messages.latestSeq(g.id),
        inviteCode: me.role === 'owner' ? g.invite_code : undefined,
      }),
      members: store.members.list(g.id).map((m) => memberView(m, online, models, caps)),
      modelCatalog: models,
      agentStatus: hub.agentStatusView(),
    });
  });

  add('PATCH', '/api/groups/:id', ({ res, user, params, body, ip }) => {
    const g = store.groups.byId(params.id);
    if (!g) return fail(res, 404, 'group_not_found', '群组不存在');
    if (g.status !== 'active') return fail(res, 410, 'group_dissolved', '该群已解散');
    const me = store.members.get(g.id, user.id);
    if (!me || me.removed_at || me.role !== 'owner') {
      store.audit.log({
        type: 'authz_denied',
        actorId: user.id,
        groupId: g.id,
        detail: { op: 'update_group' },
        ip,
      });
      metrics.inc('authz.denied.update_group');
      return fail(res, 403, 'forbidden', '仅群主可修改群信息');
    }
    const fields = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (name.length < 1 || name.length > 40) return fail(res, 400, 'invalid_input', '群名称长度需为 1-40 位');
      fields.name = name;
    }
    if (body.avatar !== undefined) fields.avatar = String(body.avatar).trim().slice(0, 8);
    const updated = store.groups.update(g.id, fields);
    store.audit.log({ type: 'group_update', actorId: user.id, groupId: g.id, detail: fields, ip });
    hub.broadcast(g.id, { type: 'group-updated', groupId: g.id, group: groupView(updated) });
    metrics.inc('group.update');
    return json(res, 200, { ok: true, group: groupView(updated) });
  });

  add('POST', '/api/groups/:id/invite', ({ res, user, params }) => {
    const g = store.groups.byId(params.id);
    if (!g) return fail(res, 404, 'group_not_found', '群组不存在');
    if (g.status !== 'active') return fail(res, 410, 'group_dissolved', '该群已解散');
    if (!store.members.isActive(g.id, user.id)) {
      return fail(res, 403, 'not_a_member', '你不是该群成员');
    }
    return json(res, 200, {
      ok: true,
      inviteCode: g.invite_code,
      inviteUrl: `/join?code=${g.invite_code}`,
    });
  });

  add('POST', '/api/groups/join', ({ res, user, body, ip }) => {
    const code = String(body.inviteCode || '').trim();
    const g = store.groups.byInvite(code);
    if (!g) {
      store.audit.log({ type: 'join_failed', actorId: user.id, detail: { code }, ip });
      return fail(res, 404, 'invalid_invite', '邀请码无效');
    }
    if (g.status !== 'active') return fail(res, 410, 'group_dissolved', '该群已解散');
    if (store.members.isActive(g.id, user.id)) {
      return json(res, 200, { ok: true, group: groupView(g), alreadyMember: true });
    }
    if (store.members.activeIds(g.id).length >= config.maxGroupMembers) {
      return fail(res, 409, 'group_full', `群成员已达上限（${config.maxGroupMembers}）`);
    }
    store.members.add(g.id, user.id, 'member');
    store.audit.log({ type: 'member_join', actorId: user.id, groupId: g.id, ip });
    hub.broadcast(g.id, {
      type: 'member-changed',
      groupId: g.id,
      action: 'join',
      userId: user.id,
    });
    metrics.inc('group.join');
    return json(res, 200, { ok: true, group: groupView(g, { role: 'member' }) });
  });

  add('POST', '/api/groups/:id/members', ({ res, user, params, body, ip }) => {
    const g = store.groups.byId(params.id);
    if (!g) return fail(res, 404, 'group_not_found', '群组不存在');
    if (g.status !== 'active') return fail(res, 410, 'group_dissolved', '该群已解散');
    const me = store.members.get(g.id, user.id);
    if (!me || me.removed_at || me.role !== 'owner') {
      store.audit.log({ type: 'authz_denied', actorId: user.id, groupId: g.id, detail: { op: 'add_member' }, ip });
      return fail(res, 403, 'forbidden', '仅群主可直接添加成员');
    }
    const username = String(body.username || '').trim();
    const target = store.users.byUsername(username);
    if (!target) return fail(res, 404, 'user_not_found', '用户不存在');
    if (store.members.isActive(g.id, target.id)) {
      return json(res, 200, { ok: true, alreadyMember: true });
    }
    if (store.members.activeIds(g.id).length >= config.maxGroupMembers) {
      return fail(res, 409, 'group_full', `群成员已达上限（${config.maxGroupMembers}）`);
    }
    store.members.add(g.id, target.id, 'member');
    store.audit.log({
      type: 'member_add',
      actorId: user.id,
      groupId: g.id,
      targetId: target.id,
      ip,
    });
    hub.broadcast(g.id, { type: 'member-changed', groupId: g.id, action: 'add', userId: target.id });
    metrics.inc('group.member_add');
    return json(res, 200, { ok: true, member: { id: target.id, username: target.username } });
  });

  add('DELETE', '/api/groups/:id/members/:userId', ({ res, user, params, ip }) => {
    const g = store.groups.byId(params.id);
    if (!g) return fail(res, 404, 'group_not_found', '群组不存在');
    if (g.status !== 'active') return fail(res, 410, 'group_dissolved', '该群已解散');
    const me = store.members.get(g.id, user.id);
    if (!me || me.removed_at) return fail(res, 403, 'not_a_member', '你不是该群成员');
    const targetId = params.userId;
    const selfLeave = targetId === user.id;
    if (!selfLeave && me.role !== 'owner') {
      store.audit.log({
        type: 'authz_denied',
        actorId: user.id,
        groupId: g.id,
        targetId,
        detail: { op: 'remove_member' },
        ip,
      });
      metrics.inc('authz.denied.remove_member');
      return fail(res, 403, 'forbidden', '仅群主可移除成员');
    }
    if (!selfLeave && targetId === g.owner_id) {
      return fail(res, 400, 'cannot_remove_owner', '不能移除群主');
    }
    if (!store.members.isActive(g.id, targetId)) {
      return fail(res, 404, 'member_not_found', '该成员不在群内');
    }
    store.members.remove(g.id, targetId);
    store.audit.log({
      type: selfLeave ? 'member_leave' : 'member_remove',
      actorId: user.id,
      groupId: g.id,
      targetId,
      ip,
    });
    hub.broadcast(g.id, {
      type: 'member-changed',
      groupId: g.id,
      action: selfLeave ? 'leave' : 'remove',
      userId: targetId,
    });
    metrics.inc(selfLeave ? 'group.leave' : 'group.member_remove');
    return json(res, 200, { ok: true });
  });

  add('POST', '/api/groups/:id/leave', ({ res, user, params, ip }) => {
    const g = store.groups.byId(params.id);
    if (!g) return fail(res, 404, 'group_not_found', '群组不存在');
    if (g.owner_id === user.id) {
      return fail(res, 400, 'owner_cannot_leave', '群主需先解散群组或转让群主');
    }
    store.members.remove(g.id, user.id);
    store.audit.log({ type: 'member_leave', actorId: user.id, groupId: g.id, ip });
    hub.broadcast(g.id, { type: 'member-changed', groupId: g.id, action: 'leave', userId: user.id });
    metrics.inc('group.leave');
    return json(res, 200, { ok: true });
  });

  add('DELETE', '/api/groups/:id', ({ res, user, params, ip }) => {
    const g = store.groups.byId(params.id);
    if (!g) return fail(res, 404, 'group_not_found', '群组不存在');
    const me = store.members.get(g.id, user.id);
    if (!me || me.removed_at || me.role !== 'owner') {
      store.audit.log({ type: 'authz_denied', actorId: user.id, groupId: g.id, detail: { op: 'dissolve' }, ip });
      metrics.inc('authz.denied.dissolve');
      return fail(res, 403, 'forbidden', '仅群主可解散群组');
    }
    store.groups.dissolve(g.id);
    store.audit.log({ type: 'group_dissolve', actorId: user.id, groupId: g.id, ip });
    hub.broadcast(g.id, { type: 'group-dissolved', groupId: g.id });
    metrics.inc('group.dissolve');
    return json(res, 200, { ok: true });
  });

  // ── 消息 ──────────────────────────────────────────
  add('GET', '/api/groups/:id/messages', ({ res, user, params, url }) => {
    const g = store.groups.byId(params.id);
    if (!g) return fail(res, 404, 'group_not_found', '群组不存在');
    if (g.status !== 'active') return fail(res, 410, 'group_dissolved', '该群已解散，历史消息不可访问');
    if (!store.members.isActive(g.id, user.id)) {
      store.audit.log({
        type: 'authz_denied',
        actorId: user.id,
        groupId: g.id,
        detail: { op: 'read_messages' },
      });
      metrics.inc('authz.denied.read_messages');
      return fail(res, 403, 'not_a_member', '你不是该群成员，无法读取该群消息');
    }
    const beforeSeq = url.searchParams.get('beforeSeq');
    const aroundSeq = url.searchParams.get('aroundSeq');
    const limit = Number(url.searchParams.get('limit') || 30);
    const rows = aroundSeq
      ? store.messages.pageAround(g.id, aroundSeq, limit)
      : store.messages.page(g.id, { beforeSeq, limit });
    const oldest = rows.length ? Number(rows[0].seq) : null;
    const hasMore = oldest !== null ? store.messages.page(g.id, { beforeSeq: oldest, limit: 1 }).length > 0 : false;
    return json(res, 200, {
      ok: true,
      messages: rows.map(msgView),
      latestSeq: store.messages.latestSeq(g.id),
      hasMore,
    });
  });

  add('POST', '/api/groups/:id/messages', ({ res, user, params, body, ip }) => {
    const g = store.groups.byId(params.id);
    if (!g) return fail(res, 404, 'group_not_found', '群组不存在');
    if (g.status !== 'active') return fail(res, 410, 'group_dissolved', '该群已解散');
    if (!store.members.isActive(g.id, user.id)) {
      store.audit.log({
        type: 'authz_denied',
        actorId: user.id,
        groupId: g.id,
        detail: { op: 'send_message' },
        ip,
      });
      metrics.inc('authz.denied.send_message');
      return fail(res, 403, 'not_a_member', '你不是该群成员');
    }
    const text = String(body.text ?? '');
    const clientMsgId = body.clientMsgId ? String(body.clientMsgId).slice(0, 64) : null;
    if (clientMsgId) {
      const dup = store.messages.findByClientId(g.id, user.id, clientMsgId);
      if (dup) return json(res, 200, { ok: true, message: msgView(dup), duplicate: true });
    }
    if (!text.trim()) return fail(res, 400, 'empty_message', '消息内容不能为空');
    if (text.length > config.limits.maxTextLength) {
      store.audit.log({
        type: 'invalid_input',
        actorId: user.id,
        groupId: g.id,
        detail: { reason: 'text_too_long', length: text.length },
        ip,
      });
      metrics.inc('abuse.text_too_long');
      return fail(res, 400, 'text_too_long', `消息长度不能超过 ${config.limits.maxTextLength} 字`);
    }
    let replyTo = body.replyTo ? String(body.replyTo).slice(0, 64) : null;
    if (replyTo) {
      const target = store.messages.byId(replyTo);
      if (!target || target.group_id !== g.id || target.deleted_at) {
        return fail(res, 400, 'reply_target_not_found', '被引用的消息不存在或已删除');
      }
    }
    const created = store.tx(() => {
      const seq = store.messages.nextSeq(g.id);
      return store.messages.insert({ groupId: g.id, senderId: user.id, type: 'text', body: text, clientMsgId, replyTo, seq });
    });
    store.groups.update(g.id, {});
    hub.broadcast(g.id, { type: 'message', groupId: g.id, message: msgView(created) });
    metrics.inc('message.sent_rest');
    return json(res, 201, { ok: true, message: msgView(created) });
  });

  // ── 历史搜索（群成员可用，仅本群文本消息）──────────
  add('GET', '/api/groups/:id/search', ({ res, user, params, url }) => {
    const g = store.groups.byId(params.id);
    if (!g) return fail(res, 404, 'group_not_found', '群组不存在');
    if (g.status !== 'active') return fail(res, 410, 'group_dissolved', '该群已解散，历史消息不可访问');
    if (!store.members.isActive(g.id, user.id)) {
      store.audit.log({
        type: 'authz_denied',
        actorId: user.id,
        groupId: g.id,
        detail: { op: 'search_messages' },
      });
      metrics.inc('authz.denied.search_messages');
      return fail(res, 403, 'not_a_member', '你不是该群成员');
    }
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) return fail(res, 400, 'empty_query', '搜索关键词不能为空');
    const limit = Math.min(50, Number(url.searchParams.get('limit')) || 30);
    const rows = store.messages.search({ groupId: g.id, q, limit });
    metrics.inc('message.search');
    return json(res, 200, { ok: true, query: q, total: rows.length, messages: rows.map(msgView) });
  });

  // ── 图片上传与访问 ────────────────────────────────
  add(
    'POST',
    '/api/uploads',
    async ({ res, user, req, ip }) => {
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!IMAGE_MIME.has(mime)) {
        store.audit.log({ type: 'invalid_input', actorId: user.id, detail: { reason: 'bad_image_type', mime }, ip });
        metrics.inc('abuse.bad_image_type');
        return fail(res, 415, 'unsupported_media_type', '仅支持 PNG / JPEG / WebP / GIF 图片');
      }
      let buf;
      try {
        buf = await readRawBody(req, config.limits.maxImageBytes);
      } catch (err) {
        if (err.code === 'payload_too_large') {
          store.audit.log({ type: 'invalid_input', actorId: user.id, detail: { reason: 'image_too_large' }, ip });
          metrics.inc('abuse.image_too_large');
          return fail(res, 413, 'payload_too_large', `图片不能超过 ${Math.round(config.limits.maxImageBytes / 1024 / 1024)}MB`);
        }
        throw err;
      }
      if (!buf.length) return fail(res, 400, 'empty_file', '图片内容为空');
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
      const attId = newId('att');
      const dir = path.join(config.dataDir, 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${attId}.${ext}`);
      fs.writeFileSync(dest, buf);
      const att = store.attachments.create({
        id: attId,
        uploaderId: user.id,
        filename: String(req.headers['x-filename'] || `image.${ext}`).slice(0, 120),
        mime,
        size: buf.length,
        filePath: dest,
      });
      metrics.inc('upload.ok');
      return json(res, 201, {
        ok: true,
        attachment: {
          id: att.id,
          mime: att.mime,
          size: att.size,
          url: `/api/attachments/${att.id}`,
        },
      });
    },
    { auth: true },
  );

  add(
    'GET',
    '/api/attachments/:id',
    ({ res, user, params }) => {
      const att = store.attachments.byId(params.id);
      if (!att) return fail(res, 404, 'attachment_not_found', '附件不存在');
      if (att.group_id && !store.members.isActive(att.group_id, user.id)) {
        store.audit.log({
          type: 'authz_denied',
          actorId: user.id,
          groupId: att.group_id,
          detail: { op: 'read_attachment', attachmentId: att.id },
        });
        metrics.inc('authz.denied.read_attachment');
        return fail(res, 403, 'not_a_member', '你不是该群成员，无法访问该附件');
      }
      if (!fs.existsSync(att.path)) return fail(res, 410, 'attachment_missing', '附件已不存在');
      const data = fs.readFileSync(att.path);
      res.writeHead(200, {
        'content-type': att.mime,
        'content-length': data.length,
        'cache-control': 'private, max-age=3600',
      });
      res.end(data);
      return true;
    },
    { auth: true },
  );

  // ── 模型目录 ──────────────────────────────────────
  add('GET', '/api/models', ({ res }) => {
    const cat = getModelCatalog(config.modelOptions || []);
    return json(res, 200, { ok: true, count: cat.count, generatedAt: cat.generatedAt, models: cat.models });
  });

  add(
    'PATCH',
    '/api/groups/:id/agents/:agentKey',
    ({ res, user, params, body, ip }) => {
      const g = store.groups.byId(params.id);
      if (!g) return fail(res, 404, 'group_not_found', '群组不存在');
      if (g.status !== 'active') return fail(res, 410, 'group_dissolved', '该群已解散');
      const me = store.members.get(g.id, user.id);
      if (!me || me.removed_at || me.role !== 'owner') {
        store.audit.log({
          type: 'authz_denied',
          actorId: user.id,
          groupId: g.id,
          detail: { op: 'set_agent_model', agentKey: params.agentKey },
          ip,
        });
        metrics.inc('authz.denied.set_agent_model');
        return fail(res, 403, 'forbidden', '仅群主可修改智能体的模型');
      }
      const binding = store.agents.byKey(g.id, params.agentKey);
      if (!binding) return fail(res, 404, 'agent_not_found', '该智能体未接入本群');

      const model = String(body.model ?? '').trim();
      if (model.length > 64) return fail(res, 400, 'invalid_input', '模型名称过长');
      if (model) {
        const found = findModel(model);
        const fallback = new Set(config.modelOptions || []);
        if (!found && !fallback.has(model)) {
          return fail(res, 400, 'unknown_model', `未知模型：${model}`);
        }
      }
      const updated = store.agents.setModel(g.id, params.agentKey, model);
      store.audit.log({
        type: 'agent_model_set',
        actorId: user.id,
        groupId: g.id,
        targetId: binding.user_id,
        detail: { agentKey: params.agentKey, model },
        ip,
      });
      hub.broadcast(g.id, {
        type: 'agent-model-changed',
        groupId: g.id,
        agentKey: params.agentKey,
        model,
      });
      metrics.inc('agent.model_set');
      return json(res, 200, {
        ok: true,
        agentKey: params.agentKey,
        model: updated?.model || model,
      });
    },
    { auth: true },
  );

  // ── 智能体（Agent）：发放令牌 / 上下文 / 发言 ─────
  add(
    'POST',
    '/api/admin/agents',
    ({ res, body, ip }) => {
      const groupId = String(body.groupId || '');
      const agentKey = String(body.agentKey || '').trim().toLowerCase();
      const displayName = String(body.displayName || agentKey).trim().slice(0, 32);
      const avatar = String(body.avatar || '').trim().slice(0, 8);
      const supportsModel = body.supportsModel !== false;
      if (!/^[a-z0-9_-]{2,32}$/.test(agentKey)) {
        return fail(res, 400, 'invalid_input', 'agentKey 需为 2-32 位小写字母/数字/下划线/连字符');
      }
      const g = store.groups.byId(groupId);
      if (!g) return fail(res, 404, 'group_not_found', '群组不存在');
      if (g.status !== 'active') return fail(res, 410, 'group_dissolved', '该群已解散');

      const username = `agent.${agentKey}`;
      let user = store.users.byUsernameOnly(username);
      if (!user) {
        user = store.users.create({
          username,
          displayName: displayName || agentKey,
          passwordHash: 'x',
          avatar,
          kind: 'agent',
        });
      } else {
        store.run('UPDATE users SET display_name = ?, avatar = ?, kind = ? WHERE id = ?', [
          displayName || user.display_name,
          avatar || user.avatar,
          'agent',
          user.id,
        ]);
        user = store.users.byId(user.id);
      }
      store.members.add(groupId, user.id, 'member');
      const token = crypto.randomBytes(24).toString('base64url');
      store.agents.upsert({ groupId, agentKey, userId: user.id, tokenHash: auth.hashToken(token), supportsModel });
      store.audit.log({ type: 'agent_bind', groupId, targetId: user.id, detail: { agentKey }, ip });
      hub.broadcast(groupId, { type: 'member-changed', groupId, action: 'add', userId: user.id });
      metrics.inc('agent.bind');
      return json(res, 201, {
        ok: true,
        agentKey,
        userId: user.id,
        displayName: user.display_name,
        avatar: user.avatar || '',
        token,
      });
    },
    { admin: true },
  );

  add(
    'GET',
    '/api/admin/agents',
    ({ res, url }) => {
      const groupId = url.searchParams.get('groupId');
      if (!groupId) return fail(res, 400, 'invalid_input', '缺少 groupId');
      return json(res, 200, {
        ok: true,
        agents: store.agents.list(groupId).map((a) => ({
          agentKey: a.agent_key,
          userId: a.user_id,
          displayName: a.display_name,
          avatar: a.avatar || '',
          status: a.status,
        })),
      });
    },
    { admin: true },
  );

  add(
    'GET',
    '/api/agent/context',
    ({ res, req, url }) => {
      const binding = resolveAgent(req);
      if (!binding) return fail(res, 401, 'invalid_agent_token', 'Agent 令牌无效');
      if (binding.group_status !== 'active') return fail(res, 410, 'group_dissolved', '该群已解散');
      const sinceSeq = Number(url.searchParams.get('sinceSeq') || 0);
      const limit = Math.min(200, Number(url.searchParams.get('limit') || 50));
      const g = store.groups.byId(binding.group_id);
      const online = new Set(hub.onlineUserIds(binding.group_id));
      const rows = sinceSeq
        ? store.messages.since(binding.group_id, sinceSeq, limit)
        : store.messages.page(binding.group_id, { limit });
      return json(res, 200, {
        ok: true,
        agent: {
          key: binding.agent_key,
          userId: binding.user_id,
          displayName: binding.display_name,
          avatar: binding.avatar || '',
          model: binding.model || '',
        },
        group: { id: binding.group_id, name: g?.name || '' },
        members: store.members.list(binding.group_id).map((m) => memberView(m, online)),
        messages: rows.map(msgView),
        latestSeq: store.messages.latestSeq(binding.group_id),
      });
    },
    { auth: false },
  );

  add(
    'POST',
    '/api/agent/send',
    ({ res, req, body }) => {
      const binding = resolveAgent(req);
      if (!binding) return fail(res, 401, 'invalid_agent_token', 'Agent 令牌无效');
      if (binding.group_status !== 'active') return fail(res, 410, 'group_dissolved', '该群已解散');
      const text = String(body.text ?? '');
      const clientMsgId = body.clientMsgId ? String(body.clientMsgId).slice(0, 64) : null;
      if (clientMsgId) {
        const dup = store.messages.findByClientId(binding.group_id, binding.user_id, clientMsgId);
        if (dup) return json(res, 200, { ok: true, message: msgView(dup), duplicate: true });
      }
      if (!text.trim()) return fail(res, 400, 'empty_message', '消息内容不能为空');
      if (text.length > config.limits.maxTextLength) {
        return fail(res, 400, 'text_too_long', `消息长度不能超过 ${config.limits.maxTextLength} 字`);
      }
      const created = store.tx(() => {
        const seq = store.messages.nextSeq(binding.group_id);
        return store.messages.insert({
          groupId: binding.group_id,
          senderId: binding.user_id,
          type: 'text',
          body: text,
          clientMsgId,
          seq,
        });
      });
      store.groups.update(binding.group_id, {});
      hub.broadcast(binding.group_id, {
        type: 'message',
        groupId: binding.group_id,
        message: msgView(created),
      });
      metrics.inc('agent.message_sent');
      return json(res, 201, { ok: true, message: msgView(created) });
    },
    { auth: false },
  );

  // ── 管理台（审计 / 指标 / 台账查询）───────────────
  add(
    'GET',
    '/api/admin/overview',
    ({ res }) => {
      const counts = store.tableCounts();
      return json(res, 200, {
        ok: true,
        counts,
        metrics: metrics.snapshot(),
        auditByType: store.audit.countByType(),
        hub: hub.stats(),
        process: {
          rssMB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
          heapUsedMB: +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
          uptimeSec: Math.round(process.uptime()),
        },
        now: nowIso(),
      });
    },
    { admin: true },
  );

  add(
    'GET',
    '/api/admin/metrics',
    ({ res }) => json(res, 200, { ok: true, metrics: metrics.snapshot(), hub: hub.stats() }),
    { admin: true },
  );

  add(
    'GET',
    '/api/admin/audit',
    ({ res, url }) =>
      json(res, 200, {
        ok: true,
        records: store.audit.search({
          groupId: url.searchParams.get('groupId'),
          actorId: url.searchParams.get('actorId'),
          type: url.searchParams.get('type'),
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          limit: url.searchParams.get('limit') || 100,
        }),
      }),
    { admin: true },
  );

  add(
    'GET',
    '/api/admin/audit/export',
    ({ res, url }) => {
      const rows = store.audit.search({
        groupId: url.searchParams.get('groupId'),
        actorId: url.searchParams.get('actorId'),
        type: url.searchParams.get('type'),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        limit: url.searchParams.get('limit') || 1000,
      });
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [
        'id,ts,type,actor_id,group_id,target_id,detail,ip',
        ...rows.map((r) =>
          [r.id, r.ts, r.type, r.actor_id, r.group_id, r.target_id, JSON.stringify(r.detail), r.ip]
            .map(esc)
            .join(','),
        ),
      ].join('\n');
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="audit-${Date.now()}.csv"`,
      });
      res.end('\ufeff' + csv);
      return true;
    },
    { admin: true },
  );

  add(
    'GET',
    '/api/admin/messages',
    ({ res, url }) =>
      json(res, 200, {
        ok: true,
        messages: store.messages.search({
          groupId: url.searchParams.get('groupId'),
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          limit: url.searchParams.get('limit') || 100,
        }),
      }),
    { admin: true },
  );

  // ── 分发 ──────────────────────────────────────────
  async function dispatch(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = req.method.toUpperCase();
    const t0 = Date.now();
    let route = null;
    let params = null;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(url.pathname);
      if (m) {
        route = r;
        params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        break;
      }
    }
    if (!route) {
      if (url.pathname.startsWith('/api/')) {
        metrics.inc('http.not_found');
        return fail(res, 404, 'not_found', '接口不存在');
      }
      return false; // 交给静态文件处理
    }
    if (route.admin) {
      const provided = String(req.headers['x-admin-token'] || '');
      if (!adminToken || provided !== adminToken) {
        store.audit.log({ type: 'admin_denied', detail: { path: url.pathname }, ip: clientIp(req) });
        metrics.inc('authz.denied.admin');
        return fail(res, 403, 'admin_forbidden', '管理令牌无效');
      }
    }
    let user = null;
    let token = null;
    if (route.auth) {
      token = auth.tokenFrom(req);
      const resolved = auth.resolveUser(token);
      if (!resolved) {
        metrics.inc('http.unauthorized');
        return fail(res, 401, 'unauthenticated', '请先登录');
      }
      user = resolved.user;
    } else {
      token = auth.tokenFrom(req);
      const resolved = auth.resolveUser(token);
      user = resolved?.user || null;
    }

    let body = {};
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      if (route.handler.length && String(route.handler.constructor.name) === 'AsyncFunction') {
        body = {}; // 异步处理器自行读取原始 body
      } else {
        try {
          body = await readBody(req, 256 * 1024);
        } catch (err) {
          return fail(res, 400, err.code || 'bad_request', '请求体解析失败');
        }
      }
    }

    const ctx = {
      req,
      res,
      params: params || {},
      url,
      body,
      user,
      token,
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] || ''),
    };
    const result = await route.handler(ctx);
    metrics.inc('http.request');
    metrics.observe('http.duration', Date.now() - t0);
    if (result === false) return false;
    return true;
  }

  return { dispatch, routes };
}
