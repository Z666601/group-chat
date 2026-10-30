/* 炫技层 B：光标光晕 / 气泡高光 / AI 解码文字 / 新消息脉冲 */
(function () {
  'use strict';
  if (document.documentElement.dataset.scifiWow === '1') return;
  document.documentElement.dataset.scifiWow = '1';

  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function off() {
    return (reduce && reduce.matches) ||
      (document.body && document.body.classList.contains('no-fx'));
  }

  // ── 光标光晕 ─────────────────────────────────────────
  var halo = null, tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
  function initHalo() {
    if (off() || halo) return;
    halo = document.createElement('div');
    halo.className = 'fx-halo';
    halo.setAttribute('aria-hidden', 'true');
    document.body.appendChild(halo);
    window.addEventListener('mousemove', function (e) {
      tx = e.clientX; ty = e.clientY;
    }, { passive: true });
    (function loop() {
      cx += (tx - cx) * 0.12;
      cy += (ty - cy) * 0.12;
      halo.style.transform = 'translate3d(' + (cx - 170) + 'px,' + (cy - 170) + 'px,0)';
      raf = window.requestAnimationFrame(loop);
    })();
  }

  // ── 气泡内光标高光 ───────────────────────────────────
  var hoverBound = new WeakSet();
  function bindGlow(el) {
    if (hoverBound.has(el)) return;
    hoverBound.add(el);
    el.addEventListener('mousemove', function (e) {
      var r = el.getBoundingClientRect();
      el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      el.style.setProperty('--my', (e.clientY - r.top) + 'px');
    }, { passive: true });
  }

  // ── AI 解码文字 ──────────────────────────────────────
  var GLYPHS = '01<>/\\|[]{}=+*#·—';
  function scramble(el, text, ms) {
    var start = performance.now();
    var limit = Math.min(text.length, 90);
    function frame(t) {
      var p = Math.min(1, (t - start) / ms);
      var out = '';
      for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        if (i < p * limit || ch === ' ' || ch === '\n') out += ch;
        else out += GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      el.textContent = out;
      if (p < 1) window.requestAnimationFrame(frame);
      else el.textContent = text;
    }
    window.requestAnimationFrame(frame);
  }

  function decorateMessage(row) {
    if (!row || row.dataset.wow === '1') return;
    row.dataset.wow = '1';
    var body = row.querySelector('.msg-body');
    if (body) bindGlow(body);
    if (!body || row.classList.contains('mine') || row.classList.contains('continues')) return;
    if (body.children.length) return;
    var text = body.textContent || '';
    if (!text.trim() || text.length > 400) return;
    scramble(body, text, 300);
  }

  // ── 新消息脉冲 ───────────────────────────────────────
  function pulseArea() {
    var box = document.getElementById('messages');
    if (!box) return;
    box.classList.remove('fx-pulse');
    void box.offsetWidth;
    box.classList.add('fx-pulse');
    window.setTimeout(function () { box.classList.remove('fx-pulse'); }, 900);
  }

  function watchMessages() {
    var box = document.getElementById('messages');
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('.msg'), decorateMessage);
    var mo = new MutationObserver(function (records) {
      var fresh = [];
      records.forEach(function (r) {
        Array.prototype.forEach.call(r.addedNodes || [], function (n) {
          if (n.nodeType !== 1) return;
          if (n.classList && n.classList.contains('msg')) fresh.push(n);
          if (n.querySelectorAll) fresh = fresh.concat(Array.prototype.slice.call(n.querySelectorAll('.msg')));
        });
      });
      if (!fresh.length) return;
      fresh.forEach(decorateMessage);
      pulseArea();
    });
    mo.observe(box, { childList: true, subtree: true });
    window.setTimeout(function () { mo.disconnect(); }, 30000);
  }

  function start() {
    if (off()) return;
    initHalo();
    watchMessages();
  }

  function boot() {
    var app = document.getElementById('app-view');
    if (!app) return;
    if (!app.hidden) { start(); return; }
    var mo = new MutationObserver(function () {
      if (!app.hidden) { mo.disconnect(); start(); }
    });
    mo.observe(app, { attributes: true, attributeFilter: ['hidden'] });
    window.setTimeout(function () { mo.disconnect(); }, 15000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
