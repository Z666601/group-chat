/* scifi-fx.js —— 群聊炫技层（无依赖 / IIFE / 不污染 window）
   1) 星座粒子 canvas  2) HUD 角标  3) 扫描线  4) 消息入场光迹
   总闸：document.body.classList.add('no-fx') → 全部关闭
   折动：prefers-reduced-motion 下不创建 canvas、不跑光迹 */
(function () {
  'use strict';

  var body = document.body;
  var reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function reduced() { return !!(reduceMQ && reduceMQ.matches); }
  function off() { return body.classList.contains('no-fx'); }
  function idle() { return off() || reduced(); }

  /* ── 1. 星座粒子 ─────────────────────────────────────── */
  var canvas = null;
  var ctx = null;
  var stars = [];
  var raf = 0;
  var w = 0;
  var h = 0;
  var dpr = 1;
  var lastPaint = 0;
  var LINK = 120;
  var LINK2 = LINK * LINK;
  var FRAME_MS = 33; /* ~30fps，漂移足够顺滑，单帧成本减半 */
  var CYAN = '#63e6ff';
  var VIOLET = '#8b7cff';

  function seed() {
    var n = window.innerWidth < 720 ? 60 : 76;
    stars.length = 0;
    for (var i = 0; i < n; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 7,
        vy: (Math.random() - 0.5) * 7,
        r: 0.6 + Math.random() * 0.9,
        a: 0.18 + Math.random() * 0.3,
        c: Math.random() < 0.62 ? CYAN : VIOLET
      });
    }
  }

  function fit() {
    if (!canvas || !ctx) return;
    w = window.innerWidth;
    h = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      if (s.x > w || s.x < 0) s.x = Math.random() * w;
      if (s.y > h || s.y < 0) s.y = Math.random() * h;
    }
  }

  function paint(now) {
    raf = 0;
    if (!ctx) return;
    if (now - lastPaint < FRAME_MS) {
      raf = requestAnimationFrame(paint);
      return;
    }
    var dt = lastPaint ? Math.min((now - lastPaint) / 1000, 0.08) : 0.016;
    lastPaint = now;

    ctx.clearRect(0, 0, w, h);

    /* 连线：只算上半三角，约 2.8k 次距离比较/帧 */
    ctx.lineWidth = 0.7;
    for (var i = 0; i < stars.length; i++) {
      var a = stars[i];
      for (var j = i + 1; j < stars.length; j++) {
        var b = stars[j];
        var dx = a.x - b.x;
        var dy = a.y - b.y;
        var d2 = dx * dx + dy * dy;
        if (d2 > LINK2) continue;
        ctx.globalAlpha = (1 - Math.sqrt(d2) / LINK) * 0.12;
        ctx.strokeStyle = a.c;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    /* 粒子：漂移 + 出界回卷 */
    for (var k = 0; k < stars.length; k++) {
      var s = stars[k];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (s.x < -24) s.x = w + 24;
      else if (s.x > w + 24) s.x = -24;
      if (s.y < -24) s.y = h + 24;
      else if (s.y > h + 24) s.y = -24;
      ctx.globalAlpha = s.a;
      ctx.fillStyle = s.c;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    raf = requestAnimationFrame(paint);
  }

  function start() {
    if (raf || !ctx || document.hidden || idle()) return;
    raf = requestAnimationFrame(paint);
  }

  function stop() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function mountStars() {
    if (canvas || idle()) return;
    canvas = document.createElement('canvas');
    canvas.className = 'sfx-stars';
    canvas.setAttribute('aria-hidden', 'true');
    body.insertBefore(canvas, body.firstChild);
    ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) {
      canvas.remove();
      canvas = null;
      return;
    }
    w = window.innerWidth;
    h = window.innerHeight;
    seed();
    fit();
    start();
  }

  function unmountStars() {
    stop();
    if (canvas) {
      canvas.remove();
      canvas = null;
      ctx = null;
      stars.length = 0;
    }
  }

  /* ── 2 + 3. HUD 角标与扫描层 ─────────────────────────── */
  var hud = null;
  var hudMain = null;
  var hudBox = null;
  var hudRO = null;

  function place() {
    if (!hud) return;
    var mr = hudMain.getBoundingClientRect();
    var br = hudBox.getBoundingClientRect();
    var sb = hudBox.offsetWidth - hudBox.clientWidth; /* 避开滚动条 */
    hud.style.left = (br.left - mr.left) + 'px';
    hud.style.top = (br.top - mr.top) + 'px';
    hud.style.width = Math.max(0, br.width - sb) + 'px';
    hud.style.height = Math.max(0, br.height) + 'px';
  }

  function mountHud() {
    if (hud) return;
    hudBox = document.getElementById('messages');
    hudMain = hudBox && hudBox.closest ? hudBox.closest('.main') : null;
    if (!hudBox || !hudMain) return;

    hud = document.createElement('div');
    hud.className = 'sfx-hud';
    hud.setAttribute('aria-hidden', 'true');
    ['tl', 'tr', 'bl', 'br'].forEach(function (k) {
      var c = document.createElement('span');
      c.className = 'sfx-corner ' + k;
      hud.appendChild(c);
    });
    var scan = document.createElement('div');
    scan.className = 'sfx-scan';
    hud.appendChild(scan);
    hudMain.appendChild(hud);

    place();
    if (window.ResizeObserver) {
      hudRO = new ResizeObserver(place);
      hudRO.observe(hudBox);
    }
  }

  /* ── 4. 消息入场光迹 ─────────────────────────────────── */
  var seen = Object.create(null); /* 见过的 data-id：整表重绘时只闪真正的新消息 */
  var flashed = typeof WeakSet === 'function' ? new WeakSet() : null;

  function flash(el) {
    if (!el || el.classList.contains('sfx-in')) return;
    el.classList.add('sfx-in');
    setTimeout(function () { el.classList.remove('sfx-in'); }, 240);
  }

  function scanNew(records) {
    var box = document.getElementById('messages');
    if (!box) return;

    for (var i = 0; i < records.length; i++) {
      /* 乐观消息 ack 后 data-id 会原地换号，先记账，避免重绘时误闪 */
      if (records[i].type === 'attributes') {
        var tid = records[i].target && records[i].target.dataset ? records[i].target.dataset.id : '';
        if (tid) seen[tid] = 1;
      }
    }

    var rows = box.querySelectorAll('.msg');
    var fresh = [];
    for (var j = 0; j < rows.length; j++) {
      var el = rows[j];
      if (flashed && flashed.has(el)) continue;
      if (flashed) flashed.add(el);
      var id = el.dataset ? el.dataset.id : '';
      if (id && seen[id]) continue;
      if (id) seen[id] = 1;
      fresh.push(el);
    }

    /* 首屏 / 换群 / 加载更早：一次冒出多条，不闪 */
    if (idle() || !fresh.length || fresh.length > 2) return;
    for (var k = 0; k < fresh.length; k++) flash(fresh[k]);
  }

  function watchMessages() {
    var box = document.getElementById('messages');
    if (!box || !window.MutationObserver) return;
    scanNew([]); /* 先给已有消息记账 */
    new MutationObserver(scanNew).observe(box, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-id']
    });
  }

  /* ── 启动与联动 ──────────────────────────────────────── */
  var rzTimer = 0;

  function onResize() {
    place();
    if (rzTimer) clearTimeout(rzTimer);
    rzTimer = setTimeout(function () {
      rzTimer = 0;
      fit();
    }, 160);
  }

  function onMotionPref() {
    if (reduced()) unmountStars();
    else if (!canvas) mountStars();
    else start();
  }

  function onVisibility() {
    if (document.hidden) stop();
    else start();
  }

  function init() {
    body = document.body;
    mountHud();
    watchMessages();
    if (!idle()) mountStars();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });

    if (reduceMQ) {
      if (reduceMQ.addEventListener) reduceMQ.addEventListener('change', onMotionPref);
      else if (reduceMQ.addListener) reduceMQ.addListener(onMotionPref);
    }

    if (window.MutationObserver) {
      new MutationObserver(function () {
        if (idle()) {
          stop();
          return;
        }
        if (!canvas) mountStars();
        else start();
      }).observe(body, { attributes: true, attributeFilter: ['class'] });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
