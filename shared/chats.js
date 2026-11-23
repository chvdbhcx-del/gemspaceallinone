// Gemspace: shared chat list. Runs in every account page after inject.js. It only READS the chat list
// that the page already shows (name, time, preview, unread count, avatar of the rows in the DOM) and
// hands it to Gemspace for the "Все чаты" list across accounts. Nothing is sent anywhere else, nothing
// is typed or sent in Gem Space. It relies on Gem Space's data-test="group-link" rows; if their markup
// changes, the list simply stays empty and Gemspace shows a hint instead.
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
})();
