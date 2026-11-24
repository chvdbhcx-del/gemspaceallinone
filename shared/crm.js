// Hovi Space: statuses, reminders, notes and quick-reply templates inside Gem Space's own page, as in
// Hivogram. Extra items go into the menu of a chat (right click on it in the list) and into the "⋮" menu of
// the open chat, the open chat's header shows its status, reminder and note, the chat list shows them next to
// the names, and a templates button sits next to the attach button of the message field.
// What the user keeps is stored by Hovi Space on this computer or phone, never by Gem Space: the page gets it
// with __hoviMeta(...) and hands each change back with __gemspaceMeta(edit) (inject.js). A template is only
// put into the message field (shared/chats.js, __gemspaceInsert), never sent. It relies on Gem Space's
// data-test="group-link", "chat-header", "attach-button" and "menu-item-*"; if those change, the items
// simply do not show and nothing else breaks.
(function () {
  if (window.__hoviCrm) return;
  window.__hoviCrm = true;
  if (!/(^|\.)gemspace\.com$/.test(location.hostname)) return;

  var ROW = '[data-test="group-link"]';
  var M = { statuses: [], notes: {}, status: {}, reminders: {}, templates: [] };
  var known = {};
  var lastRow = '';

  function text(el) {
    return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nameOf(row) {
    return text(row && row.querySelector('h6')).slice(0, 80);
  }
  function edit(e) {
    try { if (window.__gemspaceMeta) window.__gemspaceMeta(e); } catch (_) {}
  }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

  window.__hoviMeta = function (m) {
    m = obj(m);
    M = {
      statuses: Array.isArray(m.statuses) ? m.statuses : [],
      notes: obj(m.notes),
      status: obj(m.status),
      reminders: obj(m.reminders),
      templates: Array.isArray(m.templates) ? m.templates : [],
    };
    soon();
  };

  function statusOf(chat) {
    var id = M.status[chat];
    for (var i = 0; id && i < M.statuses.length; i++) if (M.statuses[i].id === id) return M.statuses[i];
    return null;
  }
  function isDue(chat) {
    var at = M.reminders[chat];
    return !!at && at <= Date.now();
  }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function remindText(at) {
    var d = new Date(at), now = new Date();
    var day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var hm = d.getHours() + ':' + two(d.getMinutes());
    if (at <= Date.now()) return 'пора ответить';
    if (at < day + 864e5) return 'сегодня ' + hm;
    if (at < day + 2 * 864e5) return 'завтра ' + hm;
    return d.getDate() + '.' + two(d.getMonth() + 1) + ' ' + hm;
  }

  // the user's changes are shown at once and handed to Hovi Space, which sends the tidied state back
  function setNote(chat, note) {
    note = String(note || '').trim().slice(0, 1000);
    if (note) M.notes[chat] = note; else delete M.notes[chat];
    edit({ chat: chat, note: note });
    soon();
  }
  function setStatus(chat, id) {
    if (id) M.status[chat] = id; else delete M.status[chat];
    edit({ chat: chat, status: id || '' });
    soon();
  }
  function setReminder(chat, at) {
    if (at) M.reminders[chat] = at; else delete M.reminders[chat];
    edit({ chat: chat, remind: at || 0 });
    soon();
  }
  function saveTemplates(list) {
    M.templates = list;
    edit({ templates: list });
  }
  function saveStatuses(list) {
    M.statuses = list;
    edit({ statuses: list });
    soon();
  }
  function newId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  var ICON = {
    flag: 'M6 3a1 1 0 0 1 1 1v1h11a1 1 0 0 1 .8 1.6L16.25 10l2.55 3.4A1 1 0 0 1 18 15H7v6a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1m1 4v6h9l-1.8-2.4a1 1 0 0 1 0-1.2L16 7z',
    bell: 'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2m6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5z',
    note: 'M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm15.01-1.13.71-.71a1 1 0 0 1 1.41 0l.71.71a1 1 0 0 1 0 1.41l-.71.71zm-.71.71-5.3 5.3V21h2.12l5.3-5.3z',
    bolt: 'M13.5 2.1a1 1 0 0 1 .5 1.04L13.2 9H18a1 1 0 0 1 .8 1.6l-7 10a1 1 0 0 1-1.79-.74L10.8 14H6a1 1 0 0 1-.8-1.6l7-10a1 1 0 0 1 1.3-.3M7.95 12H12a1 1 0 0 1 1 1.14l-.38 2.62L16.05 11H12a1 1 0 0 1-1-1.14l.38-2.62z',
    chevron: 'M9.3 6.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4l-4.6 4.6a1 1 0 1 1-1.4-1.4l3.9-3.9-3.9-3.9a1 1 0 0 1 0-1.4',
    check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
    clock: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20m0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16m0 2a1 1 0 0 1 1 1v4.6l3.2 1.9a1 1 0 1 1-1 1.72l-3.7-2.2A1 1 0 0 1 11 12V7a1 1 0 0 1 1-1',
    edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z',
  };
  function svg(name, size, cls) {
    size = size || 24;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + size + '" height="' + size + '"' +
      (cls ? ' class="' + esc(cls) + '"' : '') + ' fill="currentColor"><path d="' + ICON[name] + '"/></svg>';
  }

  function css() {
    if (document.getElementById('hovi-crm-css')) return;
    var st = document.createElement('style');
    st.id = 'hovi-crm-css';
    st.textContent = [
      '.hovi-pop{position:fixed;z-index:2147483000;box-sizing:border-box;min-width:220px;max-width:340px;max-height:60vh;overflow:auto;padding:8px 0;',
      'background:var(--base-10,#fafafa);border:1px solid var(--base-30,#e7e6e8);border-radius:8px;box-shadow:var(--box-shadow-popover,0 10px 40px #0000001a);',
      'color:var(--base-110,#1f1f21);font:var(--font-body-4,15px/24px Roboto,Arial,sans-serif)}',
      '.hovi-item{display:flex;align-items:center;width:100%;min-height:40px;box-sizing:border-box;padding:8px 16px;border:0;background:none;',
      'color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.hovi-item:hover,.hovi-item.on{background:var(--base-17,#f3f3f3)}',
      '.hovi-item .hovi-ic{width:24px;flex-shrink:0;display:flex;align-items:center;justify-content:center;margin-inline-end:24px;color:var(--base-80,#65636b)}',
      '.hovi-item .hovi-tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hovi-item .hovi-sub{display:block;color:var(--base-80,#65636b);font:var(--font-subtitle-4,13px/18px Roboto,Arial,sans-serif);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hovi-item .hovi-end{flex-shrink:0;margin-inline-start:12px;color:var(--base-80,#65636b);display:flex}',
      '.hovi-item.danger{color:var(--danger-40,#e34646)}',
      '.hovi-dot{display:inline-block;width:12px;height:12px;border-radius:50%}',
      '.hovi-sep{height:1px;margin:4px 16px;background:var(--base-120_08,#1c1b1e14)}',
      '.hovi-marks{display:inline-flex;align-items:center;gap:4px;margin-inline-start:6px;flex-shrink:0;color:var(--base-80,#65636b)}',
      '.hovi-marks svg{display:block}',
      '.hovi-marks .due{color:var(--warning-40,#dc9b1c)}',
      '.hovi-pill{display:inline-block;max-width:120px;padding:0 7px;border-radius:9px;color:#fff;font:500 11px/18px var(--primary-font-family,Roboto,Arial,sans-serif);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hovi-head{display:inline-flex;align-items:center;gap:6px;margin-inline-end:8px;min-width:0}',
      '.hovi-hb{display:inline-flex;align-items:center;gap:6px;max-width:220px;height:32px;box-sizing:border-box;padding:0 10px;border:1px solid var(--base-30,#e7e6e8);',
      'border-radius:16px;background:none;color:var(--base-110,#1f1f21);font:var(--font-subtitle-3,500 13px/18px Roboto,Arial,sans-serif);cursor:pointer;white-space:nowrap}',
      '.hovi-hb:hover{background:var(--base-17,#f3f3f3)}',
      '.hovi-hb span{overflow:hidden;text-overflow:ellipsis}',
      '.hovi-hb.ghost{color:var(--base-80,#65636b)}',
      '.hovi-hb.icon{width:32px;padding:0;justify-content:center}',
      '.hovi-hb.due{border-color:var(--warning-40,#dc9b1c);color:var(--warning-50,#bd7e14)}',
      '.hovi-hb.set{color:var(--brand-secondary-40,#8c6df2)}',
      '.hovi-bg{position:fixed;inset:0;z-index:2147483001;background:#0006;display:flex;align-items:center;justify-content:center}',
      '.hovi-modal{box-sizing:border-box;width:min(460px,92vw);max-height:86vh;overflow:auto;padding:20px 24px;border-radius:12px;',
      'background:var(--base-10,#fafafa);color:var(--base-110,#1f1f21);box-shadow:var(--box-shadow-12,0 0 16px #00000029);font:var(--font-body-4,15px/24px Roboto,Arial,sans-serif)}',
      '.hovi-modal h3{margin:0 0 4px;font:var(--font-title-9,500 20px/24px Roboto,Arial,sans-serif)}',
      '.hovi-modal .hovi-hint{margin:0 0 12px;color:var(--base-80,#65636b);font:var(--font-subtitle-4,13px/18px Roboto,Arial,sans-serif)}',
      '.hovi-modal textarea,.hovi-modal input:not([type=color]){width:100%;box-sizing:border-box;padding:10px 12px;border:0;border-bottom:2px solid transparent;',
      'border-radius:8px;background:var(--base-20,#edecee);color:var(--base-110,#1f1f21);font:inherit;resize:vertical}',
      '.hovi-modal textarea:focus,.hovi-modal input:focus{outline:none;border-bottom-color:var(--brand-secondary-40,#8c6df2)}',
      '.hovi-modal label{display:block;margin:10px 0 4px;color:var(--base-80,#65636b);font:var(--font-subtitle-3,500 13px/18px Roboto,Arial,sans-serif)}',
      '.hovi-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
      '.hovi-btn{height:36px;padding:0 16px;border:0;border-radius:8px;background:var(--base-20,#edecee);color:var(--base-110,#1f1f21);font:var(--font-button,500 13px/18px Roboto,Arial,sans-serif);cursor:pointer}',
      '.hovi-btn:hover{background:var(--base-30,#e7e6e8)}',
      '.hovi-btn.primary{background:var(--brand-primary-40,#ff4d4d);color:#fff}',
      '.hovi-btn.primary:hover{background:var(--brand-primary-50,#cf4041)}',
      '.hovi-btn.danger{margin-inline-end:auto;background:none;color:var(--danger-40,#e34646)}',
      '.hovi-btn.link{background:none;color:var(--brand-secondary-40,#8c6df2);padding:0 4px}',
      '.hovi-list{margin:0 -8px}',
      '.hovi-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px}',
      '.hovi-row:hover{background:var(--base-17,#f3f3f3)}',
      '.hovi-row .hovi-grow{flex:1;min-width:0}',
      '.hovi-row .hovi-grow b{display:block;font:var(--font-body-2,500 15px/24px Roboto,Arial,sans-serif);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hovi-row .hovi-grow small{display:block;color:var(--base-80,#65636b);font:var(--font-subtitle-4,13px/18px Roboto,Arial,sans-serif);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hovi-row input[type=color]{width:32px;height:32px;padding:0;border:0;border-radius:50%;background:none;cursor:pointer}',
      '.hovi-x{width:32px;height:32px;flex-shrink:0;border:0;border-radius:50%;background:none;color:var(--base-80,#65636b);font:18px/1 Arial,sans-serif;cursor:pointer}',
      '.hovi-x:hover{background:var(--base-20,#edecee)}',
      '.hovi-x:disabled{opacity:.3;cursor:default;background:none}',
      '.hovi-empty{padding:12px 8px;color:var(--base-80,#65636b)}',
      '.hovi-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483002;max-width:80vw;padding:10px 16px;border-radius:8px;',
      'background:var(--addition-100,#27282a);color:#fff;font:var(--font-subtitle-4,13px/18px Roboto,Arial,sans-serif);box-shadow:var(--box-shadow-popover,0 10px 40px #0000001a)}',
      '.hovi-tpl{position:relative}',
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }

  function toast(msg) {
    var old = document.querySelector('.hovi-toast');
    if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'hovi-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  // ---------- our own popovers (submenus, the header and the templates button), styled like Gem Space's ----------

  var pop = null; // { el, source, owner }
  function closePop() {
    if (!pop) return;
    pop.el.remove();
    if (pop.source) pop.source.classList.remove('on');
    pop = null;
  }
  // items: [{ icon, dot, title, sub, check, danger, sep, onClick }]
  function openPop(anchor, items, place, source) {
    closePop();
    css();
    var el = document.createElement('div');
    el.className = 'hovi-pop';
    el.setAttribute('data-hovi', '1');
    items.forEach(function (it) {
      if (it.sep) {
        var s = document.createElement('div');
        s.className = 'hovi-sep';
        el.appendChild(s);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'hovi-item' + (it.danger ? ' danger' : '');
      var ic = it.dot ? '<span class="hovi-dot" style="background:' + esc(it.dot) + '"></span>' : it.icon ? svg(it.icon) : '';
      b.innerHTML = '<span class="hovi-ic">' + ic + '</span><span class="hovi-tt">' + esc(it.title) +
        (it.sub ? '<span class="hovi-sub">' + esc(it.sub) + '</span>' : '') + '</span>' +
        (it.check ? '<span class="hovi-end">' + svg('check', 20) + '</span>' : '');
      b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keeps the message field's caret
      b.addEventListener('click', function () {
        closePop();
        if (it.onClick) it.onClick();
      });
      el.appendChild(b);
    });
    document.body.appendChild(el);
    var r = anchor.getBoundingClientRect();
    var w = el.offsetWidth, h = el.offsetHeight;
    var W = window.innerWidth, H = window.innerHeight;
    var x, y;
    if (place === 'right') {
      x = r.right + 4; y = r.top - 8;
      if (x + w > W - 8) x = r.left - w - 4;
    } else if (place === 'up') {
      x = r.left; y = r.top - h - 8;
      if (y < 8) y = r.bottom + 8;
    } else {
      x = r.right - w; y = r.bottom + 8;
      if (x < 8) x = r.left;
    }
    x = Math.max(8, Math.min(x, W - w - 8));
    y = Math.max(8, Math.min(y, H - h - 8));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (source) source.classList.add('on');
    pop = { el: el, source: source || null, anchor: anchor };
    return el;
  }
  document.addEventListener('click', function (e) {
    if (!pop) return;
    if (pop.el.contains(e.target) || (pop.anchor && pop.anchor.contains(e.target))) return;
    closePop();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePop();
  }, true);
  window.addEventListener('resize', closePop);

  function statusItems(chat) {
    var cur = M.status[chat] || '';
    var items = M.statuses.map(function (s) {
      return { dot: s.color, title: s.name, check: s.id === cur, onClick: function () { setStatus(chat, s.id === cur ? '' : s.id); } };
    });
    if (cur) items.push({ icon: 'flag', title: 'Без статуса', onClick: function () { setStatus(chat, ''); } });
    items.push({ sep: true }, { icon: 'edit', title: 'Изменить статусы…', onClick: statusesDialog });
    return items;
  }
  function at(hours) { return Date.now() + hours * 36e5; }
  function at9(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  }
  function monday9() { return at9(((8 - new Date().getDay()) % 7) || 7); }
  function remindItems(chat) {
    var items = [
      { icon: 'clock', title: 'Через 30 минут', onClick: function () { setReminder(chat, at(0.5)); } },
      { icon: 'clock', title: 'Через 1 час', onClick: function () { setReminder(chat, at(1)); } },
      { icon: 'clock', title: 'Через 3 часа', onClick: function () { setReminder(chat, at(3)); } },
      { icon: 'clock', title: 'Завтра в 9:00', onClick: function () { setReminder(chat, at9(1)); } },
      { icon: 'clock', title: 'В понедельник в 9:00', onClick: function () { setReminder(chat, monday9()); } },
      { icon: 'edit', title: 'Выбрать время…', onClick: function () { timeDialog(chat); } },
    ];
    if (M.reminders[chat]) items.push({ sep: true }, { icon: 'bell', title: 'Убрать напоминание', sub: remindText(M.reminders[chat]), danger: true, onClick: function () { setReminder(chat, 0); } });
    return items;
  }
  function firstLine(s) { return String(s || '').split('\n')[0]; }
  function templateItems(chat, inOpenChat) {
    var items = M.templates.map(function (t) {
      return { icon: 'bolt', title: t.title || firstLine(t.text), sub: t.title ? firstLine(t.text) : '', onClick: function () { insert(t.text, inOpenChat ? '' : chat); } };
    });
    if (!items.length) items.push({ icon: 'edit', title: 'Добавить шаблон…', onClick: function () { templatesDialog(true); } });
    else items.push({ sep: true }, { icon: 'edit', title: 'Изменить шаблоны…', onClick: function () { templatesDialog(false); } });
    return items;
  }

  // a template into the message field of the open chat, or of `chat` of the list, which is opened first
  function insert(body, chat) {
    if (!window.__gemspaceInsert) return;
    window.__gemspaceInsert(chat || '', body, Object.keys(known), function (ok, error) {
      if (!ok) toast(error || 'Не удалось вставить шаблон');
    });
  }

  // ---------- dialogs ----------

  function modal(build) {
    closePop();
    css();
    var bg = document.createElement('div');
    bg.className = 'hovi-bg';
    bg.setAttribute('data-hovi', '1');
    var box = document.createElement('div');
    box.className = 'hovi-modal';
    bg.appendChild(box);
    function close() { bg.remove(); }
    // the page must not see the keys typed here (its own shortcuts, "type anywhere" into its message field)
    ['keydown', 'keyup', 'keypress', 'input', 'paste', 'copy', 'cut'].forEach(function (t) {
      bg.addEventListener(t, function (e) {
        if (t === 'keydown' && e.key === 'Escape') close();
        e.stopPropagation();
      });
    });
    bg.addEventListener('mousedown', function (e) { if (e.target === bg) close(); });
    document.body.appendChild(bg);
    build(box, close);
    var f = box.querySelector('textarea, input:not([type=color])');
    if (f) setTimeout(function () { f.focus(); if (f.select && f.tagName === 'INPUT') f.select(); }, 30);
    return { box: box, close: close };
  }
  function buttons(box, list) {
    var row = document.createElement('div');
    row.className = 'hovi-btns';
    list.forEach(function (b) {
      if (!b) return;
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'hovi-btn' + (b.kind ? ' ' + b.kind : '');
      el.textContent = b.title;
      el.addEventListener('click', b.onClick);
      row.appendChild(el);
    });
    box.appendChild(row);
  }

  function noteDialog(chat) {
    modal(function (box, close) {
      var had = M.notes[chat] || '';
      box.innerHTML = '<h3>Заметка</h3><p class="hovi-hint">' + esc(chat) + ' · видна только вам, в Hovi Space</p>' +
        '<textarea rows="6" maxlength="1000" placeholder="Например: хочет скидку, перезвонить после 15:00"></textarea>';
      var ta = box.querySelector('textarea');
      ta.value = had;
      function save() { setNote(chat, ta.value); close(); }
      ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); });
      buttons(box, [
        had && { title: 'Удалить', kind: 'danger', onClick: function () { setNote(chat, ''); close(); } },
        { title: 'Отмена', onClick: close },
        { title: 'Сохранить', kind: 'primary', onClick: save },
      ]);
    });
  }

  function localInput(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + 'T' + two(d.getHours()) + ':' + two(d.getMinutes());
  }
  function timeDialog(chat) {
    modal(function (box, close) {
      var start = M.reminders[chat] && M.reminders[chat] > Date.now() ? M.reminders[chat] : Math.ceil(at(1) / 9e5) * 9e5;
      box.innerHTML = '<h3>Напомнить</h3><p class="hovi-hint">' + esc(chat) + ' · Hovi Space покажет уведомление в это время</p>' +
        '<input type="datetime-local">';
      var inp = box.querySelector('input');
      inp.value = localInput(start);
      inp.min = localInput(Date.now());
      function save() {
        var t = new Date(inp.value).getTime();
        if (!t || isNaN(t)) return toast('Укажите дату и время');
        if (t <= Date.now()) return toast('Это время уже прошло');
        setReminder(chat, t);
        close();
      }
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
      buttons(box, [{ title: 'Отмена', onClick: close }, { title: 'Сохранить', kind: 'primary', onClick: save }]);
    });
  }

  var PALETTE = ['#3aa0ff', '#ffa726', '#66bb6a', '#ef5350', '#ab47bc', '#26c6da', '#8d6e63', '#78909c'];
  function statusesDialog() {
    var list = M.statuses.map(function (s) { return { id: s.id, name: s.name, color: s.color }; });
    modal(function (box, close) {
      function draw() {
        box.innerHTML = '<h3>Статусы чатов</h3><p class="hovi-hint">Видны только вам. Чат с удалённым статусом останется без статуса.</p><div class="hovi-list"></div>';
        var wrap = box.querySelector('.hovi-list');
        list.forEach(function (s, i) {
          var row = document.createElement('div');
          row.className = 'hovi-row';
          row.innerHTML = '<input type="color"><input type="text" maxlength="30"><button type="button" class="hovi-x" title="Удалить">×</button>';
          var c = row.children[0], n = row.children[1];
          c.value = /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#3aa0ff';
          n.value = s.name;
          c.addEventListener('input', function () { s.color = c.value; });
          n.addEventListener('input', function () { s.name = n.value; });
          row.children[2].addEventListener('click', function () { list.splice(i, 1); draw(); });
          wrap.appendChild(row);
        });
        if (list.length < 12) {
          var add = document.createElement('button');
          add.type = 'button';
          add.className = 'hovi-btn link';
          add.textContent = '+ Добавить статус';
          add.addEventListener('click', function () {
            list.push({ id: newId('s-'), name: '', color: PALETTE[list.length % PALETTE.length] });
            draw();
            var ins = box.querySelectorAll('input[type=text]');
            if (ins.length) ins[ins.length - 1].focus();
          });
          box.appendChild(add);
        }
        buttons(box, [
          { title: 'Отмена', onClick: close },
          { title: 'Сохранить', kind: 'primary', onClick: function () {
            saveStatuses(list.filter(function (s) { return s.name.trim(); }).map(function (s) { return { id: s.id, name: s.name.trim(), color: s.color }; }));
            close();
          } },
        ]);
      }
      draw();
    });
  }

  var EXAMPLES = [
    ['Приветствие', 'Здравствуйте, {имя}! Чем могу помочь?'],
    ['Счёт отправлен', '{имя}, счёт отправил. Проверьте, пожалуйста, и напишите, если будут вопросы.'],
    ['Спасибо за заказ', 'Спасибо за заказ, {имя}! Как только отправим, пришлю номер для отслеживания.'],
  ];
  function templatesDialog(startNew) {
    var list = M.templates.map(function (t) { return { id: t.id, title: t.title, text: t.text }; });
    modal(function (box, close) {
      function save() { saveTemplates(list); }
      function form(t) {
        var fresh = !t;
        t = t || { id: newId('t-'), title: '', text: '' };
        box.innerHTML = '<h3>' + (fresh ? 'Новый шаблон' : 'Шаблон') + '</h3>' +
          '<p class="hovi-hint">Шаблон вставляется в поле сообщения, отправляете вы сами. {имя} заменится на имя собеседника.</p>' +
          '<label>Название</label><input type="text" maxlength="40" placeholder="Например: Приветствие">' +
          '<label>Текст</label><textarea rows="6" maxlength="4000"></textarea>';
        var ti = box.querySelector('input'), ta = box.querySelector('textarea');
        ti.value = t.title;
        ta.value = t.text;
        buttons(box, [
          { title: 'Назад', onClick: draw },
          { title: 'Сохранить', kind: 'primary', onClick: function () {
            var body = ta.value.trim();
            if (!body) return toast('Напишите текст шаблона');
            t.title = ti.value.trim();
            t.text = body;
            if (fresh) list.push(t);
            save();
            draw();
          } },
        ]);
        setTimeout(function () { (fresh ? ti : ta).focus(); }, 30);
      }
      function draw() {
        box.innerHTML = '<h3>Шаблоны ответов</h3><p class="hovi-hint">Кнопка ⚡ у поля сообщения вставляет шаблон в текст, ничего не отправляя.</p><div class="hovi-list"></div>';
        var wrap = box.querySelector('.hovi-list');
        if (!list.length) wrap.innerHTML = '<div class="hovi-empty">Шаблонов пока нет.</div>';
        list.forEach(function (t, i) {
          var row = document.createElement('div');
          row.className = 'hovi-row';
          row.innerHTML = '<div class="hovi-grow"><b></b><small></small></div>' +
            '<button type="button" class="hovi-x" title="Выше">↑</button><button type="button" class="hovi-x" title="Ниже">↓</button>' +
            '<button type="button" class="hovi-x" title="Изменить">' + svg('edit', 18) + '</button><button type="button" class="hovi-x" title="Удалить">×</button>';
          row.querySelector('b').textContent = t.title || firstLine(t.text);
          row.querySelector('small').textContent = t.text.replace(/\s+/g, ' ');
          var bs = row.querySelectorAll('button');
          bs[0].disabled = i === 0;
          bs[1].disabled = i === list.length - 1;
          bs[0].addEventListener('click', function () { list.splice(i - 1, 0, list.splice(i, 1)[0]); save(); draw(); });
          bs[1].addEventListener('click', function () { list.splice(i + 1, 0, list.splice(i, 1)[0]); save(); draw(); });
          bs[2].addEventListener('click', function () { form(t); });
          bs[3].addEventListener('click', function () { list.splice(i, 1); save(); draw(); });
          row.querySelector('.hovi-grow').addEventListener('click', function () { form(t); });
          wrap.appendChild(row);
        });
        buttons(box, [
          !list.length && { title: 'Добавить примеры', kind: 'link', onClick: function () {
            EXAMPLES.forEach(function (e) { list.push({ id: newId('t-'), title: e[0], text: e[1] }); });
            save();
            draw();
          } },
          list.length < 60 && { title: 'Новый шаблон', onClick: function () { form(null); } },
          { title: 'Готово', kind: 'primary', onClick: close },
        ]);
      }
      if (startNew) form(null); else draw();
    });
  }

  // ---------- Gem Space's own menus: our items at their end, made like their own items ----------

  function nativeItem(tpl, icon, title, arrow, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('data-hovi', '1');
    var content = tpl && tpl.firstElementChild;
    var iconSpan = content && content.firstElementChild;
    var titleSpan = content && content.querySelector('[title]');
    var nsvg = tpl && tpl.querySelector('svg');
    if (content && iconSpan && titleSpan && iconSpan !== titleSpan) {
      // the same container, size and theme classes as Gem Space's item, without a "danger" look
      b.className = tpl.getAttribute('data-test') === 'menu-item-delete_group' ? tpl.className.split(/\s+/)[0] : tpl.className;
      b.innerHTML = '<span class="' + esc(content.className) + '"><span class="' + esc(iconSpan.className) + '">' +
        svg(icon, 24, nsvg && nsvg.getAttribute('class')) + '</span><span class="' + esc(titleSpan.className) + '"></span></span>' +
        (arrow ? '<span class="hovi-end" style="display:flex;margin-inline-start:12px;color:var(--icon-color,var(--base-80))">' + svg('chevron', 20) + '</span>' : '');
      var ts = b.querySelector('span > span:last-child');
      ts.textContent = title;
      ts.title = title;
    } else {
      b.className = 'hovi-item';
      b.innerHTML = '<span class="hovi-ic">' + svg(icon) + '</span><span class="hovi-tt"></span>' + (arrow ? '<span class="hovi-end">' + svg('chevron', 20) + '</span>' : '');
      b.querySelector('.hovi-tt').textContent = title;
    }
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      onClick(b, e);
    });
    return b;
  }

  function addToMenu(box, chat, inOpenChat) {
    if (!chat || box.querySelector('[data-hovi]')) return;
    css();
    var items = box.querySelectorAll('[data-test^="menu-item-"]');
    var tpl = null;
    for (var i = 0; i < items.length; i++) if (items[i].getAttribute('data-test') !== 'menu-item-delete_group') { tpl = items[i]; break; }
    tpl = tpl || items[0];
    var hr = box.querySelector('hr');
    var sep;
    if (hr) { sep = hr.cloneNode(true); } else { sep = document.createElement('div'); sep.className = 'hovi-sep'; }
    sep.setAttribute('data-hovi', '1');
    box.appendChild(sep);
    var st = statusOf(chat);
    var subs = [];
    function sub(icon, title, list) {
      var b = nativeItem(tpl, icon, title, true, function (el) {
        if (pop && pop.source === el) return closePop();
        openPop(el, list(), 'right', el);
      });
      var t = null;
      b.addEventListener('mouseenter', function () {
        clearTimeout(t);
        t = setTimeout(function () { if (!pop || pop.source !== b) openPop(b, list(), 'right', b); }, 180);
      });
      b.addEventListener('mouseleave', function () { clearTimeout(t); });
      subs.push(b);
      box.appendChild(b);
    }
    sub('bolt', 'Ответить шаблоном', function () { return templateItems(chat, inOpenChat); });
    sub('flag', st ? 'Статус: ' + st.name : 'Статус', function () { return statusItems(chat); });
    sub('bell', M.reminders[chat] ? 'Напоминание: ' + remindText(M.reminders[chat]) : 'Напомнить', function () { return remindItems(chat); });
    box.appendChild(nativeItem(tpl, 'note', M.notes[chat] ? 'Изменить заметку…' : 'Заметка…', false, function () {
      noteDialog(chat);
      closeNative();
    }));
    // Gem Space's own items close our submenu, as its own submenus do
    box.addEventListener('mouseover', function (e) {
      var b = e.target.closest && e.target.closest('button');
      if (b && subs.indexOf(b) < 0 && pop && subs.indexOf(pop.source) >= 0) closePop();
    });
  }
  // Gem Space closes its menu on a click outside it
  function closeNative() {
    try { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch (e) {}
  }

  function activeChat() {
    var h = document.querySelector('[data-test="chat-header"]');
    var first = h && h.firstElementChild;
    if (!first) return '';
    var leaves = [];
    var all = first.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length || el.closest('svg') || el.closest('[data-hovi]')) continue;
      var t = text(el).slice(0, 80);
      if (t) leaves.push({ t: t, el: el });
    }
    for (i = 0; i < leaves.length; i++) if (known[leaves[i].t]) return leaves[i].t;
    for (i = 0; i < leaves.length; i++) {
      var k = leaves[i].t;
      if (M.notes[k] || M.status[k] || M.reminders[k]) return k;
    }
    // the title is the biggest text of the header's left part
    var best = null, size = 0;
    for (i = 0; i < leaves.length; i++) {
      var s = parseFloat(getComputedStyle(leaves[i].el).fontSize) || 0;
      if (s > size && leaves[i].t.length > 1) { size = s; best = leaves[i].t; }
    }
    return best || '';
  }

  // ---------- what we draw in the page ----------

  function rowMarks(row, chat) {
    var h = row.querySelector('h6');
    if (!h || !h.parentElement) return;
    var st = statusOf(chat), note = M.notes[chat], rem = M.reminders[chat];
    var sig = [st ? st.id + st.name + st.color : '', note ? 1 : 0, rem ? (rem <= Date.now() ? 'due' : 'on') : ''].join('|');
    var mine = h.parentElement.querySelector(':scope > .hovi-marks');
    if (sig === '||') { if (mine) mine.remove(); return; }
    if (mine && mine.getAttribute('data-sig') === sig) return;
    if (!mine) {
      mine = document.createElement('span');
      mine.className = 'hovi-marks';
      mine.setAttribute('data-hovi', '1');
      h.after(mine);
    }
    mine.setAttribute('data-sig', sig);
    mine.innerHTML = (st ? '<span class="hovi-pill" style="background:' + esc(st.color) + '"></span>' : '') +
      (note ? '<span title="Есть заметка">' + svg('note', 14) + '</span>' : '') +
      (rem ? '<span class="' + (rem <= Date.now() ? 'due' : '') + '" title="Напоминание: ' + esc(remindText(rem)) + '">' + svg('bell', 14) + '</span>' : '');
    var pill = mine.querySelector('.hovi-pill');
    if (pill) { pill.textContent = st.name; pill.title = 'Статус: ' + st.name; }
  }

  function headerBar() {
    var h = document.querySelector('[data-test="chat-header"]');
    if (!h) return;
    var chat = activeChat();
    var actions = h.children[1];
    var bar = h.querySelector('.hovi-head');
    if (!chat || !actions || h.children.length < 2) { if (bar) bar.remove(); return; }
    var st = statusOf(chat), note = M.notes[chat] || '', rem = M.reminders[chat];
    var sig = [chat, st ? st.id + st.name + st.color : '', note, rem ? remindText(rem) : ''].join('|');
    if (bar && bar.getAttribute('data-sig') === sig && bar.parentElement === actions) return;
    if (!bar) {
      bar = document.createElement('span');
      bar.className = 'hovi-head';
      bar.setAttribute('data-hovi', '1');
    }
    if (bar.parentElement !== actions) actions.insertBefore(bar, actions.firstChild);
    bar.setAttribute('data-sig', sig);
    bar.innerHTML = '';
    function btn(cls, html, title, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'hovi-hb ' + cls;
      b.innerHTML = html;
      b.title = title;
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (pop && pop.anchor === b) return closePop();
        onClick(b);
      });
      bar.appendChild(b);
      return b;
    }
    btn(st ? '' : 'ghost', st ? '<span class="hovi-dot" style="background:' + esc(st.color) + '"></span><span>' + esc(st.name) + '</span>' : svg('flag', 18) + '<span>Статус</span>',
      'Статус чата', function (b) { openPop(b, statusItems(chat), 'down'); });
    btn(rem ? (rem <= Date.now() ? 'due' : 'set') : 'ghost icon', svg('bell', 18) + (rem ? '<span>' + esc(remindText(rem)) + '</span>' : ''),
      rem ? 'Напоминание: ' + remindText(rem) : 'Напомнить', function (b) { openPop(b, remindItems(chat), 'down'); });
    btn(note ? 'set icon' : 'ghost icon', svg('note', 18), note ? 'Заметка: ' + note : 'Добавить заметку', function () { noteDialog(chat); });
  }

  function templatesButton() {
    var fab = document.querySelector('[data-test="attach-button"]');
    var mine = document.querySelector('.hovi-tpl');
    if (!fab) { if (mine) mine.remove(); return; }
    var wrap = fab.parentElement;
    if (!wrap || !wrap.parentElement) return;
    if (mine && mine.previousElementSibling === wrap) return;
    if (mine) mine.remove();
    css();
    mine = document.createElement('div');
    mine.className = 'hovi-tpl';
    mine.setAttribute('data-hovi', '1');
    var b = document.createElement('button');
    b.type = 'button';
    // Gem Space's attach button, with our icon: same size, colours and hover
    b.className = String(fab.className || '').replace(/\bAnpm6rDOIv0sdeoyhwmu\b/, '');
    var fsvg = fab.querySelector('svg');
    b.innerHTML = svg('bolt', 24, fsvg && fsvg.getAttribute('class'));
    b.title = 'Шаблоны ответов';
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (pop && pop.anchor === b) return closePop();
      openPop(b, templateItems(activeChat(), true), 'up');
    });
    mine.appendChild(b);
    wrap.after(mine);
  }

  function menus() {
    var marks = document.querySelectorAll('[data-test="menu-item-read"],[data-test="menu-item-unread"],[data-test="menu-item-chat-appearance"]');
    for (var i = 0; i < marks.length; i++) {
      var box = marks[i].parentElement;
      if (!box || box.querySelector(':scope > [data-hovi]')) continue;
      if (marks[i].getAttribute('data-test') === 'menu-item-chat-appearance') addToMenu(box, activeChat(), true);
      else addToMenu(box, lastRow, false);
    }
    // a submenu whose Gem Space menu has closed goes with it
    if (pop && pop.source && !document.contains(pop.source)) closePop();
  }

  function paint() {
    timer = null;
    try {
      var rows = document.querySelectorAll(ROW);
      for (var i = 0; i < rows.length; i++) {
        var n = nameOf(rows[i]);
        if (!n) continue;
        known[n] = 1;
        rowMarks(rows[i], n);
      }
      menus();
      headerBar();
      templatesButton();
    } catch (e) {}
  }
  var timer = null;
  function soon() {
    if (!timer) timer = setTimeout(paint, 60);
  }

  // the chat a menu was opened for: right click on its row, or a click on the "⋯" of the row
  function remember(e) {
    var row = e.target && e.target.closest && e.target.closest(ROW);
    if (row) lastRow = nameOf(row);
  }
  document.addEventListener('contextmenu', remember, true);
  document.addEventListener('pointerdown', remember, true);

  function start() {
    try {
      new MutationObserver(function (list) {
        for (var i = 0; i < list.length; i++) {
          var t = list[i].target;
          if (!(t.closest && t.closest('[data-hovi]'))) return soon();
        }
      }).observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
    // reminders turn due and "сегодня" becomes "завтра" without any change in the page
    setInterval(function () {
      document.querySelectorAll('.hovi-marks, .hovi-head').forEach(function (el) { el.removeAttribute('data-sig'); });
      soon();
    }, 30000);
    edit({ get: true });
    soon();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
