/* 科幻装饰层：侧栏数据流 + 频道标签（纯装饰，pointer-events:none） */
(function () {
  'use strict';
  if (document.documentElement.dataset.scifiDeco === '1') return;
  document.documentElement.dataset.scifiDeco = '1';

  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function off() {
    return (reduce && reduce.matches) ||
      (document.body && document.body.classList.contains('no-fx'));
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function makeTicker() {
    var el = document.createElement('div');
    el.className = 'fx-ticker';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<span class="fx-ticker__dot"></span><span class="fx-ticker__text"></span>';
    return el;
  }

  function makeChannel() {
    var el = document.createElement('div');
    el.className = 'fx-channel';
    el.setAttribute('aria-hidden', 'true');
    el.textContent = 'SECURE CHANNEL // NODE 07';
    return el;
  }

  function tick(el) {
    var t = new Date();
    var up = Math.floor(performance.now() / 1000);
    var mm = Math.floor(up / 60), ss = up % 60;
    var link = 12 + ((t.getSeconds() * 7) % 23);
    el.textContent =
      'SYS ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) +
      '  ·  LINK ' + link + 'ms  ·  UPTIME ' + pad(mm) + ':' + pad(ss) +
      '  ·  NODES 7/7  ·  ' + (link < 30 ? 'LINK STABLE' : 'LINK FLUCTUATING');
  }

  function start() {
    if (off()) return;
    var app = document.getElementById('app-view');
    var sidebar = document.querySelector('.sidebar');
    var main = document.querySelector('.main');
    if (!app || !sidebar || !main) return;

    var ticker = makeTicker();
    var me = sidebar.querySelector('.me');
    if (me && me.nextSibling) sidebar.insertBefore(ticker, me.nextSibling);
    else sidebar.insertBefore(ticker, sidebar.firstChild);

    var text = ticker.querySelector('.fx-ticker__text');
    tick(text);
    var timer = window.setInterval(function () {
      if (document.hidden) return;
      tick(text);
    }, 1000);

    var chan = makeChannel();
    main.appendChild(chan);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) tick(text);
    });
    window.addEventListener('beforeunload', function () { window.clearInterval(timer); });
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
