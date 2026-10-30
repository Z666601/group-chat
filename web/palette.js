/* Ctrl+K 指挥舱：跳群 / 搜消息 / 叫智能体。纯原生，复用现有页面元素。 */
(function () {
  'use strict';
  if (document.documentElement.dataset.palette === '1') return;
  document.documentElement.dataset.palette = '1';

  var isOpen = false;
  var backdrop = null, input = null, listEl = null;
  var items = [], filtered = [], active = 0;

  function token() { return localStorage.getItem('gc_token') || ''; }
  function st() { return window.__gcState || {}; }

  function clickGroup(g) {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('.group-item'));
    var hit = nodes.find(function (b) { return (b.textContent || '').indexOf(g.name) >= 0; });
    if (hit) hit.click();
  }

  function focusSearch(q) {
    var s = document.getElementById('search-input');
    if (!s) return;
    s.value = q;
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.focus();
  }

  function mention(name) {
    var box = document.getElementById('composer-input');
    if (!box) return;
    box.value = (box.value ? box.value.replace(/\s+$/, '') + ' ' : '') + '@' + name + ' ';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
  }

  function actions(q) {
    var out = [];
    var s = st();
    if (q) {
      out.push({ kind: '动作', title: '搜索消息：' + q, hint: 'Enter', run: function () { close(); focusSearch(q); } });
    }
    out.push({ kind: '动作', title: '新建群聊', hint: '打开弹窗', run: function () { close(); var b = document.getElementById('btn-create-group'); if (b) b.click(); } });
    out.push({ kind: '动作', title: '成员面板', hint: '显示/隐藏', run: function () { close(); var b = document.getElementById('btn-toggle-members'); if (b) b.click(); } });
    (s.groups || []).forEach(function (g) {
      out.push({ kind: '群聊', title: (g.avatar ? g.avatar + ' ' : '') + g.name, hint: g.role === 'owner' ? '群主' : '成员', run: function () { close(); clickGroup(g); } });
    });
    return out;
  }

  function loadAgents() {
    var s = st();
    if (!s.currentGroupId) return;
    fetch('/api/groups/' + s.currentGroupId, { headers: { Authorization: 'Bearer ' + token() }, credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var members = (d && d.group && d.group.members) || [];
        members.filter(function (m) { return m.kind === 'agent'; }).forEach(function (m) {
          items.push({
            kind: '智能体',
            title: '@' + (m.displayName || m.username),
            hint: '插入到输入框',
            run: function () { close(); mention(m.displayName || m.username); }
          });
        });
        if (isOpen) render();
      })
      .catch(function () {});
  }

  function render() {
    var q = (input.value || '').trim().toLowerCase();
    filtered = items.filter(function (it) {
      return !q || (it.title + ' ' + it.kind).toLowerCase().indexOf(q) >= 0;
    }).slice(0, 18);
    if (active >= filtered.length) active = Math.max(0, filtered.length - 1);
    listEl.innerHTML = '';
    filtered.forEach(function (it, i) {
      var row = document.createElement('div');
      row.className = 'fx-palette-item' + (i === active ? ' active' : '');
      var left = document.createElement('span');
      left.className = 'fx-palette-title';
      left.textContent = it.title;
      var right = document.createElement('span');
      right.className = 'fx-palette-hint';
      right.textContent = it.kind + ' · ' + it.hint;
      row.append(left, right);
      row.addEventListener('mouseenter', function () { active = i; paintActive(); });
      row.addEventListener('click', function () { it.run(); });
      listEl.appendChild(row);
    });
    if (!filtered.length) {
      var empty = document.createElement('div');
      empty.className = 'fx-palette-empty';
      empty.textContent = '没有匹配项';
      listEl.appendChild(empty);
    }
  }

  function paintActive() {
    Array.prototype.forEach.call(listEl.children, function (el, i) {
      el.classList.toggle('active', i === active);
    });
  }

  function open() {
    if (isOpen) return;
    var app = document.getElementById('app-view');
    if (!app || app.hidden) return;
    isOpen = true;
    active = 0;
    items = actions('');
    backdrop = document.createElement('div');
    backdrop.className = 'fx-palette-backdrop';
    backdrop.innerHTML =
      '<div class="fx-palette" role="dialog" aria-label="指挥舱">' +
        '<input class="fx-palette-input" type="text" placeholder="跳群 / 搜消息 / @智能体 …" autocomplete="off">' +
        '<div class="fx-palette-list"></div>' +
        '<div class="fx-palette-foot"><span>↑↓ 选择</span><span>Enter 执行</span><span>Esc 关闭</span></div>' +
      '</div>';
    document.body.appendChild(backdrop);
    input = backdrop.querySelector('.fx-palette-input');
    listEl = backdrop.querySelector('.fx-palette-list');
    input.value = '';
    input.addEventListener('input', function () {
      items = actions(input.value.trim()).concat(items.filter(function (it) { return it.kind !== '动作' && it.kind !== '群聊'; }));
      render();
    });
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) close(); });
    render();
    loadAgents();
    window.setTimeout(function () { input.focus(); }, 30);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    if (backdrop) backdrop.remove();
    backdrop = input = listEl = null;
  }

  document.addEventListener('keydown', function (e) {
    var k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'k') {
      e.preventDefault();
      if (isOpen) close(); else open();
      return;
    }
    if (!isOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(filtered.length - 1, active + 1); paintActive(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paintActive(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      var it = filtered[active];
      if (it) it.run();
    }
  });
})();
