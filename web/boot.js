/* 群聊 · 开机动画 + 消息入场（纯原生，零依赖；不修改 app.js）
   接线：<head> 里引入 boot.css，</body> 前引入本文件。
   关闭：给 <body> 加 class="no-boot-motion"；系统 reduced-motion 时自动跳过。 */
(function () {
  'use strict';

  var root = document.documentElement;
  if (root.dataset.bootMotion === '1') return; // 防重复引入
  root.dataset.bootMotion = '1';

  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function motionOff() {
    return Boolean(
      (reduce && reduce.matches) ||
      (document.body && document.body.classList.contains('no-boot-motion'))
    );
  }

  function now() {
    return window.performance && window.performance.now ? window.performance.now() : Date.now();
  }

  function isVisible(el) {
    if (!el || el.hidden) return false;
    var cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
  }

  /* ── 1. 开机 splash ─────────────────────────────────
     最少显示 500ms，最迟 800ms 开始淡出（淡出 200ms），
     等 DOMContentLoaded + 视图可见 + 首帧；2s 为就绪兜底。
     纯视觉层 pointer-events:none，不拦截任何操作。 */
  var MIN_SHOW = 500;
  var MAX_SHOW = 800;
  var READY_TIMEOUT = 2000;
  var FADE_MS = 200;

  function showSplash() {
    if (motionOff() || document.getElementById('boot-splash')) return;

    var splash = document.createElement('div');
    splash.id = 'boot-splash';
    splash.className = 'boot-splash';
    splash.setAttribute('aria-hidden', 'true');
    splash.innerHTML =
      '<div class="boot-splash__stack">' +
        '<div class="boot-splash__mark">' +
          '<span class="boot-splash__ring"></span>' +
          '<span class="boot-splash__badge">群</span>' +
        '</div>' +
        '<p class="boot-splash__word">群聊</p>' +
      '</div>';
    document.body.appendChild(splash);

    var t0 = now();
    var appView = document.getElementById('app-view');
    var authView = document.getElementById('auth-view');
    var observer = null;
    var capTimer = 0;
    var deadline = 0;
    var done = false;
    var domReady = document.readyState === 'complete';

    function fadeOut() {
      if (!splash.isConnected) return;
      splash.classList.add('is-out');
      window.setTimeout(function () { splash.remove(); }, FADE_MS + 80);
    }

    function finish(force) {
      if (done) return;
      done = true;
      if (observer) observer.disconnect();
      window.clearTimeout(capTimer);
      window.clearTimeout(deadline);
      document.removeEventListener('visibilitychange', onPageVisible);
      var wait = force ? 0 : Math.max(0, MIN_SHOW - (now() - t0));
      window.setTimeout(fadeOut, wait);
    }

    function readyCheck() {
      if (done || !domReady) return;
      if (!isVisible(appView) && !isVisible(authView)) return;
      // 视图已可见，再等两个 rAF 确保首帧真正绘制
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () { finish(false); });
      });
    }

    function onPageVisible() {
      // 标签页被挂起会让定时器延后：回到前台且已超时则立即收尾
      if (document.visibilityState === 'visible' && now() - t0 >= MAX_SHOW) finish(true);
    }

    if (appView || authView) {
      observer = new MutationObserver(readyCheck);
      if (appView) observer.observe(appView, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
      if (authView) observer.observe(authView, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    }

    document.addEventListener('DOMContentLoaded', function () {
      domReady = true;
      readyCheck();
    }, { once: true });
    if (domReady) readyCheck();

    capTimer = window.setTimeout(function () { finish(true); }, MAX_SHOW);
    deadline = window.setTimeout(function () { finish(true); }, READY_TIMEOUT);
    document.addEventListener('visibilitychange', onPageVisible);
  }

  /* ── 2. 新消息入场 ──────────────────────────────────
     用 data-id 去重：整表重渲染时只给真正新增的那条做动画；
     首屏历史 / 切群 / 批量补齐（>3 条）整批跳过。 */
  function initMessages() {
    var box = document.getElementById('messages');
    if (!box) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMessages, { once: true });
      }
      return;
    }

    var seen = new Set();
    Array.prototype.forEach.call(box.querySelectorAll('.msg'), function (el) {
      var key = el.dataset.id || el.dataset.seq;
      if (key) seen.add(key);
    });

    function play(nodes) {
      var fresh = [];
      nodes.forEach(function (el) {
        if (!el.isConnected) return;
        var key = el.dataset.id || el.dataset.seq;
        if (!key || seen.has(key)) return;
        seen.add(key);
        fresh.push(el);
      });

      if (fresh.length === 0 || fresh.length > 3) return;
      if (motionOff()) return;

      fresh.forEach(function (el, i) {
        var delay = Math.min(i * 24, 60); // 错峰，最多 60ms
        el.style.setProperty('--boot-msg-delay', delay + 'ms');
        el.classList.add('boot-msg-in');
        function cleanup(e) {
          if (e && (e.target !== el || e.animationName !== 'boot-msg-in')) return;
          el.classList.remove('boot-msg-in');
          el.style.removeProperty('--boot-msg-delay');
          el.removeEventListener('animationend', cleanup);
        }
        el.addEventListener('animationend', cleanup);
      });
    }

    var observer = new MutationObserver(function (records) {
      var batch = [];
      records.forEach(function (r) {
        if (r.type === 'attributes') {
          if (r.target.classList && r.target.classList.contains('msg')) {
            var changed = r.target.dataset.id;
            if (changed) seen.add(changed);
          }
          return;
        }
        if (r.type !== 'childList') return;
        r.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (node.classList && node.classList.contains('msg')) batch.push(node);
          if (node.querySelectorAll) {
            Array.prototype.forEach.call(node.querySelectorAll('.msg'), function (el) {
              batch.push(el);
            });
          }
        });
      });
      if (!batch.length) return;
      play(Array.from(new Set(batch)));
    });

    observer.observe(box, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-id'],
    });
  }

  function start() {
    showSplash();
    initMessages();
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
