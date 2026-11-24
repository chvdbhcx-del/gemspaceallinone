// Hovi Space: shared chat list. Runs in every account page after inject.js. It only READS the chat list
// that the page already shows (name, time, preview, unread count, avatar of the rows in the DOM) and
// hands it to Hovi Space for the "Все чаты" list across accounts. Nothing is sent anywhere else. It relies
// on Gem Space's data-test="group-link" rows; if their markup changes, the list simply stays empty and
// Hovi Space shows a hint instead. It types in Gem Space only when the user asks: __gemspaceSend below for a
// broadcast (рассылка) to chats they picked, and __gemspaceInsert for a template, which is only put into the
// message field and never sent.
(function () {
  if (window.__gemspaceChats) return;
  window.__gemspaceChats = true;
  if (!/(^|\.)gemspace\.com$/.test(location.hostname)) return;
  var ROW = '[data-test="group-link"]';
  var MAX = 40;

  function text(el) {
    return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }
  // the absolutely placed wrapper of a virtualized row knows its place in the list
  function placeOf(row) {
    for (var el = row, i = 0; el && i < 4; el = el.parentElement, i++) {
      var top = parseFloat(el.style && el.style.top);
      if (!isNaN(top)) return top;
    }
    return 1e9;
  }
  function read() {
    var rows = document.querySelectorAll(ROW);
    var out = [];
    var seen = {};
    for (var i = 0; i < rows.length && out.length < MAX; i++) {
      var row = rows[i];
      var h = row.querySelector('h6');
      var name = text(h);
      if (!name || seen[name]) continue;
      seen[name] = 1;
      // line 1: [name and badges] [time]; line 2: [preview] [unread count, mute icon...]
      var line1 = h.parentElement && h.parentElement.parentElement;
      var time = '';
      if (line1 && line1.lastElementChild && !line1.lastElementChild.contains(h)) time = text(line1.lastElementChild);
      if (time.length > 16) time = '';
      var line2 = line1 && line1.nextElementSibling;
      var preview = '';
      var unread = 0;
      if (line2) {
        var first = line2.firstElementChild || line2;
        preview = text(first);
        // a preview not loaded yet comes as a row of placeholder blocks
        if (/^[\u2591-\u2593\u2588\s]*$/.test(preview)) preview = '';
        var all = line2.querySelectorAll('*');
        for (var k = 0; k < all.length; k++) {
          var el = all[k];
          if (el.children.length || first.contains(el)) continue;
          var t = text(el);
          if (/^\d{1,4}\+?$/.test(t)) { unread = parseInt(t, 10) || 0; break; }
        }
      }
      var img = row.querySelector('img');
      var avatar = img && /^https:\/\//.test(img.src) ? img.src : '';
      out.push({ name: name.slice(0, 80), time: time, preview: preview.slice(0, 160), unread: unread, avatar: avatar.slice(0, 500), place: placeOf(row) });
    }
    out.sort(function (a, b) { return a.place - b.place; });
    return out.map(function (c) { delete c.place; return c; });
  }

  var last = '';
  var timer = null;
  function flush() {
    timer = null;
    var list;
    try { list = read(); } catch (e) { return; }
    // a chat list means the account is signed in: from now on Hovi Space reroutes its notifications (inject.js)
    if (list.length && window.__gemspaceInstall) {
      try { localStorage.setItem('hovi-signed-in', '1'); } catch (e) {}
      window.__gemspaceInstall();
    }
    var json = JSON.stringify(list);
    if (json === last) return;
    last = json;
    try { if (window.__gemspaceSendChats) window.__gemspaceSendChats(list); } catch (e) {}
  }
  function soon() {
    if (!timer) timer = setTimeout(flush, 1200);
  }
  function start() {
    try {
      new MutationObserver(soon).observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (e) {}
    setInterval(soon, 15000);
    soon();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);

  // "Все чаты" is open next to the page: the page's own left part (its navigation and chat list) is hidden in
  // this window only, so the open chat takes the whole width, as in Hivogram. Nothing changes in Gem Space itself.
  // Only when that part has a sibling, so a layout where the chat sits inside it is never hidden.
  window.__gemspaceFocus = function (on) {
    var root = document.documentElement;
    if (!document.getElementById('hovi-focus')) {
      var st = document.createElement('style');
      st.id = 'hovi-focus';
      st.textContent = 'html.hovi-focus #gem > * > *:has([data-test="groups-navigation"]):not(:only-child) { display: none !important; }';
      (document.head || root).appendChild(st);
    }
    root.classList.toggle('hovi-focus', !!on);
  };

  // Opens a chat by name: clicks its row, the same as the user would. If the row is scrolled out of
  // the virtualized list, scrolls the list to the top first, where recent chats are.
  window.__gemspaceOpenChat = function (name) {
    function find() {
      var rows = document.querySelectorAll(ROW);
      for (var i = 0; i < rows.length; i++) if (text(rows[i].querySelector('h6')) === name) return rows[i];
      return null;
    }
    var row = find();
    if (row) { row.click(); return; }
    var any = document.querySelector(ROW);
    for (var el = any; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY)) { el.scrollTop = 0; break; }
    }
    setTimeout(function () { var r = find(); if (r) r.click(); }, 400);
  };
  // Broadcast (рассылка), started only by the user: opens one chat of the list by its exact name, checks that
  // this chat is the one open, puts the text into the message field and sends it the way a person would
  // (the send button, or Enter). Reports the result with __gemspaceSent({token, ok, error}). It refuses
  // rather than guesses: no such row, another chat open, a draft already in the field, or a field that is
  // not emptied after sending are all reported as errors, and the broadcast stops on repeated errors.
  function visible(el) {
    if (!el || !el.getClientRects().length) return false;
    var r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 10;
  }
  function inList(el) {
    return !!(el.closest && (el.closest(ROW) || el.closest('[data-test="groups-navigation"]') || el.closest('[data-test="group-search"]')));
  }
  function composer() {
    var all = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]');
    var best = null;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (inList(el) || !visible(el)) continue;
      if (el.closest && el.closest('[role="dialog"]')) continue;
      // the message field is the lowest one on the screen
      if (!best || el.getBoundingClientRect().top > best.getBoundingClientRect().top) best = el;
    }
    return best;
  }
  function fieldText(el) {
    return String(el.tagName === 'TEXTAREA' ? el.value : (el.innerText || el.textContent || '')).replace(/[\s​]+/g, ' ').trim();
  }
  // the open chat's title: a leaf with exactly this name, outside the chat list, in the upper part of the screen
  function headerShows(name) {
    var all = document.querySelectorAll('h1, h2, h3, h4, h5, h6, span, div, p, b, strong');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length > 1 || inList(el) || text(el) !== name || !visible(el)) continue;
      if (el.getBoundingClientRect().top < window.innerHeight * 0.3) return true;
    }
    return false;
  }
  function sendButton(field) {
    var box = field;
    for (var up = 0; up < 6 && box; up++, box = box.parentElement) {
      var bs = box.querySelectorAll('button, [role="button"]');
      for (var i = 0; i < bs.length; i++) {
        var b = bs[i];
        var label = [b.getAttribute('data-test'), b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-testid')].join(' ');
        if (/send|отправ|submit/i.test(label) && b.getClientRects().length && !b.disabled) return b;
      }
    }
    return null;
  }
  function wait(test, ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function tick() {
        var v = null;
        try { v = test(); } catch (e) {}
        if (v || Date.now() - t0 > ms) return resolve(v);
        setTimeout(tick, 150);
      })();
    });
  }
  function clear(field) {
    try {
      field.focus();
      if (field.tagName === 'TEXTAREA') { field.select(); } else { document.getSelection().selectAllChildren(field); }
      document.execCommand('delete');
    } catch (e) {}
  }
  var sending = false;
  window.__gemspaceSend = function (name, body, token) {
    function answer(ok, error) {
      try { if (window.__gemspaceSent) window.__gemspaceSent({ token: token, ok: ok, error: error || '' }); } catch (e) {}
    }
    function done(ok, error) {
      sending = false;
      answer(ok, error);
    }
    // a second message while one is on its way is refused without touching the first one's lock
    if (sending) return answer(false, 'Предыдущее сообщение ещё отправляется');
    sending = true;
    name = String(name || ''); body = String(body || '');
    if (!name || !body.trim()) return done(false, 'Пустой текст');
    (async function () {
      // an account woken up for this message shows its chat list only after a while
      if (!(await wait(function () { return document.querySelector(ROW); }, 20000))) return done(false, 'Список чатов не загрузился');
      window.__gemspaceOpenChat(name);
      var row = await wait(function () {
        var rows = document.querySelectorAll(ROW);
        for (var i = 0; i < rows.length; i++) if (text(rows[i].querySelector('h6')) === name) return rows[i];
        return null;
      }, 3000);
      if (!row) return done(false, 'Чат не найден в списке');
      if (!(await wait(function () { return headerShows(name); }, 8000))) return done(false, 'Не открылся нужный чат');
      var field = await wait(composer, 5000);
      if (!field) return done(false, 'Нет поля для сообщения (канал или закрытый чат?)');
      await wait(function () { return false; }, 400); // a draft of this chat comes back right after opening it
      if (fieldText(field)) return done(false, 'В поле уже есть черновик, чат пропущен');
      field.focus();
      var lines = body.replace(/\r\n?/g, '\n').split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (i) {
          // a new line inside the message, not "send"
          if (field.tagName === 'TEXTAREA') document.execCommand('insertText', false, '\n');
          else if (!document.execCommand('insertLineBreak')) document.execCommand('insertParagraph');
        }
        if (lines[i]) document.execCommand('insertText', false, lines[i]);
      }
      var want = body.replace(/\s+/g, ' ').trim();
      if (fieldText(field) !== want) {
        clear(field);
        return done(false, 'Не удалось вставить текст в поле');
      }
      await wait(function () { return false; }, 250);
      var btn = sendButton(field);
      if (btn) btn.click();
      else {
        ['keydown', 'keypress', 'keyup'].forEach(function (type) {
          field.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        });
      }
      var gone = await wait(function () { var f = composer(); return !f || !fieldText(f); }, 6000);
      if (!gone) {
        clear(composer() || field);
        return done(false, 'Gem Space не принял отправку');
      }
      done(true);
    })().catch(function (e) { done(false, 'Ошибка: ' + (e && e.message || e)); });
  };

  // Quick-reply template (шаблон), picked by the user: puts the text into the message field of the open chat,
  // or first opens the chat `name` of the list, and never sends it: the user reads it and presses "Отправить"
  // in Gem Space. {имя} becomes the first word of the open chat's name, found among `names` (the account's
  // chats) by the title on screen; when no name is known it stays as typed, for the user to fill in.
  // Answers like a broadcast message, with __gemspaceSent({token, ok, error}).
  window.__gemspaceInsert = function (name, body, names, token) {
    function answer(ok, error) {
      try { if (window.__gemspaceSent) window.__gemspaceSent({ token: token, ok: ok, error: error || '' }); } catch (e) {}
    }
    function done(ok, error) {
      sending = false;
      answer(ok, error);
    }
    if (sending) return answer(false, 'Подождите, предыдущий текст ещё вставляется');
    sending = true;
    name = String(name || ''); body = String(body || '');
    if (!body.trim()) return done(false, 'Пустой шаблон');
    (async function () {
      if (name) {
        if (!(await wait(function () { return document.querySelector(ROW); }, 20000))) return done(false, 'Список чатов не загрузился');
        window.__gemspaceOpenChat(name);
        if (!(await wait(function () { return headerShows(name); }, 8000))) return done(false, 'Не открылся нужный чат');
      }
      var field = await wait(composer, name ? 5000 : 1500);
      if (!field) return done(false, 'Откройте чат, в который вставить шаблон');
      if (name) await wait(function () { return false; }, 400); // the chat's own draft comes back first
      var who = name;
      if (!who && names && names.length) {
        for (var n = 0; n < names.length && n < 60; n++) if (headerShows(String(names[n]))) { who = String(names[n]); break; }
      }
      var first = who ? (who.replace(/[«»"“”]/g, '').trim().split(/\s+/)[0] || '') : '';
      var filled = first ? body.replace(/\{имя\}/gi, function () { return first; }) : body;
      field.focus();
      try {
        if (field.tagName === 'TEXTAREA') { var l = field.value.length; field.setSelectionRange(l, l); }
        else { var sel = document.getSelection(); sel.selectAllChildren(field); sel.collapseToEnd(); }
      } catch (e) {}
      var before = fieldText(field);
      if (before && !/\s$/.test(field.tagName === 'TEXTAREA' ? field.value : (field.innerText || ''))) document.execCommand('insertText', false, ' ');
      var lines = filled.replace(/\r\n?/g, '\n').split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (i) {
          if (field.tagName === 'TEXTAREA') document.execCommand('insertText', false, '\n');
          else if (!document.execCommand('insertLineBreak')) document.execCommand('insertParagraph');
        }
        if (lines[i]) document.execCommand('insertText', false, lines[i]);
      }
      var want = filled.replace(/\s+/g, ' ').trim();
      if (fieldText(field).indexOf(want) < 0) return done(false, 'Не удалось вставить текст в поле');
      done(true);
    })().catch(function (e) { done(false, 'Ошибка: ' + (e && e.message || e)); });
  };
})();
