// Hovi Space rail: account tiles, account editor and settings. Talks to the Rust side through Tauri commands.
'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { Menu } = window.__TAURI__.menu;

const COLORS = ['#3aa0ff', '#26a69a', '#7e57c2', '#ef5350', '#ffa726', '#66bb6a', '#ec407a', '#8d6e63'];
let state = { accounts: [], active: null, settings: {}, total_unread: 0 };
let overlayKind = null; // null | 'add' | 'edit' | 'settings' | 'welcome' | 'update'
let panelOpen = false; // the chat list column next to the rail
let chatQuery = '';
let chatUnreadOnly = false;
let selectedChat = null; // 'account|name' of the chat opened from the list
let feedFilter = null; // account id or null for all
const feedSeen = new Set(); // feed rows already drawn, so only new ones slide in
let feedShown = 0;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

const PIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3l5 5-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z"/></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.3A8.5 8.5 0 0 1 8.7 4a8.5 8.5 0 1 0 11.3 11.3z"/></svg>';
const shown = new Map(); // id -> unread shown last time, so only a changed count pops

// Updates the tiles in place (keyed by account id): a state push every few seconds must not replay animations.
function renderRail() {
  const tiles = $('#tiles');
  const keep = new Set(state.accounts.map((a) => a.id));
  tiles.querySelectorAll('.tile').forEach((t) => { if (!keep.has(t.dataset.id)) { t.remove(); shown.delete(t.dataset.id); } });
  state.accounts.forEach((a, i) => {
    let b = tiles.querySelector(`.tile[data-id="${CSS.escape(a.id)}"]`);
    if (!b) {
      b = document.createElement('button');
      b.dataset.id = a.id;
      b.innerHTML = '<span class="ava"></span><span class="lbl"></span>';
      b.onclick = () => {
        if (panelOpen) setPanel(false); // an account tile leaves "Все чаты", as in Hivogram
        invoke('switch_account', { id: b.dataset.id }).catch(alertErr);
      };
      b.oncontextmenu = (e) => {
        e.preventDefault();
        const idx = state.accounts.findIndex((x) => x.id === b.dataset.id);
        if (idx >= 0) accountMenu(state.accounts[idx], idx);
      };
    }
    if (tiles.children[i + 1] !== b) tiles.insertBefore(b, tiles.children[i + 1] || null); // child 0 is the indicator
    b.className = 'tile' + (a.id === state.active ? ' active' : '') + (a.awake ? '' : ' sleeping');
    const hk = i < 9 ? `  (Ctrl+${i + 1})` : '';
    b.title = a.name + hk + (a.awake ? '' : '\nспит, откроется по клику') + (a.proxy ? `\nпрокси: ${a.proxy}` : '');
    b.setAttribute('aria-label', a.name + (a.unread ? `, непрочитанных: ${a.unread}` : ''));
    const ava = b.querySelector('.ava');
    ava.style.background = a.color || COLORS[0];
    ava.textContent = initials(a.name);
    b.querySelector('.lbl').textContent = a.name;
    b.querySelectorAll('.badge, .dot, .moon, .pin').forEach((x) => x.remove());
    const before = shown.get(a.id);
    if (a.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge' + (before !== undefined && a.unread > before ? ' pop' : '');
      badge.textContent = a.unread > 99 ? '99+' : a.unread;
      b.appendChild(badge);
    } else if (a.attention) {
      b.insertAdjacentHTML('beforeend', '<span class="dot"></span>');
    }
    shown.set(a.id, a.unread);
    if (!a.awake) b.insertAdjacentHTML('beforeend', `<span class="moon" title="спит">${MOON_SVG}</span>`);
    if (a.pinned) b.insertAdjacentHTML('beforeend', `<span class="pin" title="не усыпляется">${PIN_SVG}</span>`);
  });
  moveIndicator();
  // with no accounts the welcome screen has its own big button, and the feed has nothing to show
  const none = !state.accounts.length;
  $('#feed').hidden = none; $('.sep').hidden = none; $('#add').hidden = none;
  renderFeedButton();
  renderUpdateButton();
}

function renderUpdateButton() {
  const b = $('#upd');
  b.hidden = !state.update;
  if (state.update) b.title = `Доступна версия ${state.update.version}. Нажмите, чтобы обновить`;
}

function unreadChats() {
  const lists = state.chats || {};
  return state.accounts.reduce((n, a) => n + (lists[a.id] || []).filter((c) => c.unread).length, 0);
}

function renderFeedButton() {
  const b = $('#feed');
  const n = unreadChats() || (state.feed || []).length;
  b.classList.toggle('active', panelOpen);
  b.querySelectorAll('.badge').forEach((x) => x.remove());
  if (n > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge' + (n > feedShown ? ' pop' : '');
    badge.textContent = n > 99 ? '99+' : n;
    b.appendChild(badge);
  }
  b.setAttribute('aria-label', 'Все чаты' + (n ? `, непрочитанных: ${n}` : ''));
  const f = (state.feed || []).length;
  const fn = $('#p-feed-n'); if (fn) fn.textContent = f ? ' ' + (f > 99 ? '99+' : f) : '';
  feedShown = n;
}

function when(ms) {
  const d = new Date(ms);
  const now = new Date();
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + hm;
}

// The shared feed: new messages of every account, newest first. Read only: a row opens the chat in its account.
// The chat list column has two tabs, as Hivogram's "Все чаты | Входящие": the chats of every account (read
// from the chat list each page shows, see shared/chats.js) and the feed of new messages (from notifications).
let feedTab = (() => { try { return localStorage.getItem('gs-feed-tab') === 'new' ? 'new' : 'all'; } catch (e) { return 'all'; } })();
const chatSeen = new Set();

function segPill(seg) {
  const on = seg.querySelector('.on'); const pill = seg.querySelector('.seg-pill');
  if (on && pill) { pill.style.width = on.offsetWidth + 'px'; pill.style.transform = `translateX(${on.offsetLeft}px)`; }
}

// Rough time of a chat's last message from the label Gem Space shows ("18:05", "Вчера", "Пн", "23.11.2026"),
// only to merge the lists of several accounts in order.
const WEEK = { вс: 0, пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function chatTime(label) {
  const t = String(label || '').trim().toLowerCase();
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let m;
  if ((m = t.match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/))) {
    let h = +m[1] % 12 + (m[3] === 'pm' ? 12 : 0);
    if (!m[3]) h = +m[1];
    return day + (h * 60 + +m[2]) * 60000;
  }
  if (/^(вчера|yesterday)/.test(t)) return day - 12 * 3600000;
  const w = t.length <= 4 ? WEEK[t.replace(/\.$/, '')] : undefined; // a bare weekday label only
  if (w !== undefined) {
    const back = ((now.getDay() - w + 7) % 7) || 7;
    return day - back * 86400000 + 12 * 3600000;
  }
  if ((m = t.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/))) {
    const y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : now.getFullYear();
    return new Date(y, +m[2] - 1, +m[1], 12).getTime();
  }
  return 0;
}

// chats without a picture get a colour from their name, the way Gem Space gives them one; the account shows in the dot
const CHAT_COLORS = ['#e53935', '#f4511e', '#fb8c00', '#43a047', '#00897b', '#039be5', '#3949ab', '#8e24aa', '#d81b60', '#6d4c41'];
const chatColor = (n) => { let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0; return CHAT_COLORS[h % CHAT_COLORS.length]; };
const chatIni = (n) => initials(n.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim() || n);

function renderChats() {
  const box = $('#feed-list');
  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  const lists = state.chats || {};
  let rows = [];
  state.accounts.forEach((a) => (lists[a.id] || []).forEach((c, i) => rows.push({ ...c, account: a.id, i, at: chatTime(c.time) })));
  const present = state.accounts.filter((a) => (lists[a.id] || []).length);
  if (feedFilter && !present.some((a) => a.id === feedFilter)) feedFilter = null;
  const unread = rows.filter((r) => r.unread).length;
  $('#feed-chips').innerHTML = [
    `<button class="chip${!feedFilter && !chatUnreadOnly ? ' on' : ''}" data-k="all">Все</button>`,
    `<button class="chip${chatUnreadOnly ? ' on' : ''}" data-k="unread">Непрочитанные${unread ? ` <b class="u">${unread}</b>` : ''}</button>`,
  ].concat(present.map((a) => `<button class="chip${feedFilter === a.id ? ' on' : ''}" data-a="${esc(a.id)}"><i style="background:${esc(a.color)}"></i>${esc(a.name)}</button>`)).join('');
  $('#feed-chips').querySelectorAll('.chip').forEach((c) => {
    c.onclick = () => {
      if (c.dataset.k === 'all') { feedFilter = null; chatUnreadOnly = false; }
      else if (c.dataset.k === 'unread') chatUnreadOnly = !chatUnreadOnly;
      else feedFilter = feedFilter === c.dataset.a ? null : c.dataset.a;
      chatSeen.clear(); renderFeed();
    };
  });
  $('#feed-clear').hidden = true;
  const missing = state.accounts.filter((a) => !(lists[a.id] || []).length).map((a) => a.name);
  $('#feed-note').textContent = (missing.length ? `Пока без списка: ${missing.join(', ').replace(/\.$/, '')}. Чаты аккаунта появятся, когда он загрузится. ` : '')
    + 'Hovi Space только читает список, который показывает страница Gem Space, и никуда его не отправляет.';
  const q = chatQuery.trim().toLowerCase();
  rows = rows.filter((r) => (!feedFilter || r.account === feedFilter) && (!chatUnreadOnly || r.unread) && (!q || r.name.toLowerCase().includes(q)));
  rows.sort((a, b) => (b.at - a.at) || (a.account === b.account ? a.i - b.i : 0));
  if (!rows.length) {
    box.innerHTML = q || chatUnreadOnly
      ? `<div class="feed-empty"><b>${q ? 'Ничего не найдено' : 'Непрочитанных нет'}</b></div>`
      : `<div class="feed-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>
      <b>Список чатов ещё не загрузился</b><span>Он появится, когда откроются страницы аккаунтов. Если не появляется совсем, значит Gem Space поменял страницу, напишите нам.</span></div>`;
    return;
  }
  box.innerHTML = rows.map((c) => {
    const a = accounts.get(c.account);
    const key = c.account + '|' + c.name;
    const fresh = !chatSeen.has(key);
    const ci = chatIni(c.name);
    const ava = c.avatar ? `<span class="cav img"><img src="${esc(c.avatar)}" alt="" referrerpolicy="no-referrer" data-i="${esc(ci)}"></span>`
      : `<span class="cav" style="background:${chatColor(c.name)}">${esc(ci)}</span>`;
    return `<button class="gs-row${fresh ? ' new' : ''}${c.unread ? ' unread' : ''}${selectedChat === key ? ' selected' : ''}" data-a="${esc(c.account)}" data-n="${esc(c.name)}" title="${esc(c.name)} · ${esc(a.name)}">
      <span class="cav-wrap">${ava}<i class="acc-dot" style="background:${esc(a.color)}">${esc(initials(a.name).slice(0, 1))}</i></span>
      <span class="gs-main"><span class="gs-top"><span class="gs-name">${esc(c.name)}</span><span class="gs-time">${esc(c.time)}</span></span>
      <span class="gs-bottom"><span class="gs-prev">${esc(c.preview || (c.unread ? 'Новое сообщение' : ''))}</span>${c.unread ? `<span class="cnt">${c.unread > 999 ? '999+' : c.unread}</span>` : ''}</span></span></button>`;
  }).join('');
  rows.forEach((c) => chatSeen.add(c.account + '|' + c.name));
  box.querySelectorAll('.cav.img img').forEach((im) => { im.onerror = () => { const sp = im.parentNode; sp.classList.remove('img'); sp.style.background = chatColor(sp.closest('.gs-row').dataset.n); sp.textContent = im.dataset.i; }; });
  box.querySelectorAll('.gs-row').forEach((r) => {
    r.onclick = async () => {
      selectedChat = r.dataset.a + '|' + r.dataset.n;
      box.querySelectorAll('.gs-row.selected').forEach((x) => x.classList.remove('selected'));
      r.classList.add('selected');
      try { await invoke('chat_open', { account: r.dataset.a, name: r.dataset.n }); } catch (e) { alertErr(e); }
    };
  });
}

function renderFeed() {
  const box = $('#feed-list');
  if (!box) return;
  $('#p-q').parentNode.hidden = feedTab !== 'all';
  if (feedTab === 'all') { renderChats(); return; }
  $('#feed-note').textContent = 'Лента собирается из уведомлений аккаунтов, пока Hovi Space запущен. Спящие аккаунты сюда не пишут, важные отметьте «Не усыплять». Сообщения аккаунта уходят из ленты, когда в нём всё прочитано.';
  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  const items = (state.feed || []).filter((i) => accounts.has(i.account));
  if (feedFilter && !items.some((i) => i.account === feedFilter)) feedFilter = null;
  const present = state.accounts.filter((a) => items.some((i) => i.account === a.id));
  $('#feed-chips').innerHTML = items.length ? [`<button class="chip${feedFilter ? '' : ' on'}" data-a="">Все <b>${items.length}</b></button>`]
    .concat(present.map((a) => `<button class="chip${feedFilter === a.id ? ' on' : ''}" data-a="${esc(a.id)}"><i style="background:${esc(a.color)}"></i>${esc(a.name)} <b>${items.filter((i) => i.account === a.id).length}</b></button>`)).join('') : '';
  $('#feed-chips').querySelectorAll('.chip').forEach((c) => { c.onclick = () => { feedFilter = c.dataset.a || null; renderFeed(); }; });
  const rows = items.filter((i) => !feedFilter || i.account === feedFilter);
  $('#feed-clear').hidden = !items.length;
  if (!rows.length) {
    box.innerHTML = `<div class="feed-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14z"/></svg>
      <b>Новых сообщений нет</b><span>Здесь появятся сообщения всех аккаунтов, как только придут.</span></div>`;
    return;
  }
  box.innerHTML = rows.map((i) => {
    const a = accounts.get(i.account);
    const fresh = !feedSeen.has(i.key);
    return `<button class="feed-row${fresh ? ' new' : ''}" data-key="${i.key}">
      <span class="ava" style="background:${esc(a.color)}">${esc(initials(a.name))}</span>
      <span class="fr-main"><span class="fr-top"><span class="fr-acc">${esc(a.name)}</span><span class="fr-time">${esc(when(i.time))}</span></span>
      <span class="fr-title">${esc(i.title || a.name)}</span>${i.body ? `<span class="fr-body">${esc(i.body)}</span>` : ''}</span></button>`;
  }).join('');
  rows.forEach((i) => feedSeen.add(i.key));
  box.querySelectorAll('.feed-row').forEach((r) => {
    r.onclick = async () => {
      try { await invoke('feed_open', { key: Number(r.dataset.key) }); } catch (e) { alertErr(e); }
    };
  });
}

function moveIndicator() {
  const ind = $('#indicator');
  const active = $('#tiles .tile.active');
  if (!active) { ind.style.opacity = '0'; return; }
  ind.style.transform = `translateY(${active.offsetTop + (active.offsetHeight - 28) / 2}px)`;
  ind.style.opacity = '1';
}

async function accountMenu(a, i) {
  const items = [
    { id: 'edit', text: 'Изменить…', action: () => openOverlay('edit', a) },
    { id: 'reload', text: 'Перезагрузить', action: () => invoke('reload_account', { id: a.id }).catch(alertErr) },
  ];
  if (a.awake && a.id !== state.active) {
    items.push({ id: 'sleep', text: 'Усыпить сейчас', action: () => invoke('sleep_account', { id: a.id }).catch(alertErr) });
  }
  items.push({
    id: 'pin', text: a.pinned ? 'Можно усыплять' : 'Не усыплять',
    action: () => invoke('update_account', { id: a.id, name: a.name, color: a.color, proxy: a.proxy, pinned: !a.pinned }).catch(alertErr),
  });
  if (i > 0) items.push({ id: 'up', text: 'Выше', action: () => invoke('move_account', { id: a.id, delta: -1 }) });
  if (i < state.accounts.length - 1) items.push({ id: 'down', text: 'Ниже', action: () => invoke('move_account', { id: a.id, delta: 1 }) });
  items.push({ id: 'remove', text: 'Удалить аккаунт…', action: () => openOverlay('remove', a) });
  const menu = await Menu.new({ items });
  await menu.popup();
}

function alertErr(e) {
  const msg = typeof e === 'string' ? e : (e && e.message) || String(e);
  if (overlayKind) {
    const el = $('.err');
    if (el) { el.textContent = msg; el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); return; }
  }
  console.error(msg);
}

function colorPicker(current) {
  return `<div class="colors">${COLORS.map((c) =>
    `<button type="button" class="swatch${c === current ? ' on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>`;
}

const GLOBE = 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3a15.7 15.7 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8.2 8.2 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4zm.8 2h3a15.7 15.7 0 0 0 1.4 3.6A8 8 0 0 1 5.1 16zm3-8h-3a8 8 0 0 1 4.4-3.6C8 5.6 7.6 6.8 8.1 8zM12 20c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.3 5.6c.6-1.1 1.1-2.3 1.4-3.6h3a8 8 0 0 1-4.4 3.6zm1.7-5.6a16.5 16.5 0 0 0 0-4h3.4a8.2 8.2 0 0 1 0 4z';
const MOON_PATH = 'M20 15.3A8.5 8.5 0 0 1 8.7 4a8.5 8.5 0 1 0 11.3 11.3z';
const BELL_PATH = 'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1z';
const TEXT_PATH = 'M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM6 9h12v2H6zm8 5H6v-2h8zm4-6H6V6h12z';
const LAYERS_PATH = 'M12 16.5 4.6 10.8 3 12l9 7 9-7-1.6-1.2zM12 14l9-7-9-7-9 7z';
const TRAY_PATH = 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H5v-3h3.6a3.5 3.5 0 0 0 6.8 0H19zm0-5h-5a2 2 0 0 1-4 0H5V5h14z';
const REFRESH_PATH = 'M17.7 6.3A8 8 0 1 0 19.7 14h-2.1a6 6 0 1 1-1.4-6.2L13 11h7V4z';
const KEYS_PATH = 'M20 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm-9 3h2v2h-2zm0 3h2v2h-2zM8 8h2v2H8zm0 3h2v2H8zm-1 2H5v-2h2zm0-3H5V8h2zm9 7H8v-2h8zm0-4h-2v-2h2zm0-3h-2V8h2zm3 3h-2v-2h2zm0-3h-2V8h2z';
const SIZE_PATH = 'M9 4v3h5v12h3V7h5V4zm-6 8h3v7h3v-7h3V9H3z';
const SCALES = [80, 90, 100, 110, 125, 150];
const GEAR_PATH = 'M19.4 13a7.8 7.8 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.3 7.3 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.3 7.3 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.8 7.8 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.3 7.3 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.3 7.3 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z';
const icon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

// Colors and the name drive the big avatar on top, so the tile is seen before it is made.
function wireColors(root) {
  const ava = root.querySelector('#af-ava');
  root.querySelectorAll('.swatch').forEach((s) => {
    s.onclick = () => {
      root.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on'));
      s.classList.add('on');
      if (ava) { ava.style.background = s.dataset.c; ava.classList.remove('bump'); void ava.offsetWidth; ava.classList.add('bump'); }
    };
  });
  const name = root.querySelector('#f-name');
  if (name && ava) name.addEventListener('input', () => { ava.textContent = name.value.trim() ? initials(name.value) : '+'; });
}

function accountForm(a) {
  const color = a ? a.color : COLORS[state.accounts.length % COLORS.length];
  return `<div class="acc-form">
    <div class="af-hero">
      <span class="af-ava" id="af-ava" style="background:${esc(color)}">${a ? esc(initials(a.name)) : '+'}</span>
      <h1>${a ? 'Аккаунт' : 'Новый аккаунт'}</h1>
      <p>${a ? 'Название, цвет и прокси этого аккаунта' : 'Откроется веб-версия Gem Space, войдите по номеру телефона, как обычно'}</p>
    </div>
    <div class="af-card">
      <label class="af-field"><span>Название</span>
        <input type="text" id="f-name" maxlength="40" value="${esc(a ? a.name : '')}" placeholder="Например, Продажи или +7 900…"></label>
      <div class="af-field"><span>Цвет</span>${colorPicker(color)}</div>
    </div>
    <details class="af-card af-more"${a && a.proxy ? ' open' : ''}>
      <summary><span class="af-ic">${icon(GLOBE)}</span><span class="af-txt"><b>Прокси</b><small>Необязательно. С ним аккаунт выходит в сеть только через этот адрес</small></span><span class="af-chev"></span></summary>
      <input type="text" id="f-proxy" value="${esc(a && a.proxy ? a.proxy : '')}" placeholder="socks5://1.2.3.4:1080 или http://1.2.3.4:8080">
      <div class="hint">SOCKS5 или HTTP. Прокси с логином и паролем WebView2 не поддерживает.</div>
    </details>
    ${a ? `<label class="af-card af-toggle"><span class="af-ic">${icon(MOON_PATH)}</span><span class="af-txt"><b>Не усыплять</b><small>Аккаунт всегда загружен и присылает уведомления</small></span>
      <input type="checkbox" id="f-pin" ${a.pinned ? 'checked' : ''}><span class="switch"></span></label>` : ''}
    <div class="err"></div>
    <button class="btn primary big wide" id="f-ok">${a ? 'Сохранить' : 'Добавить и войти'}</button>
    <button class="btn ghost wide" id="f-cancel">Отмена</button>
  </div>`;
}

function formValues() {
  const on = document.querySelector('.swatch.on');
  return {
    name: $('#f-name').value,
    color: on ? on.dataset.c : COLORS[0],
    proxy: $('#f-proxy').value.trim() || null,
    pinned: $('#f-pin') ? $('#f-pin').checked : false,
  };
}

async function openOverlay(kind, a) {
  overlayKind = kind;
  await invoke('set_overlay', { open: true });
  $('#overlay').hidden = false;
  $('#overlay').classList.toggle('welcome-mode', kind === 'welcome');
  $('#overlay').classList.toggle('form-mode', kind === 'add' || kind === 'edit' || kind === 'remove');
  $('#overlay').classList.toggle('set-mode', kind === 'settings');
  const body = $('#ov-body');
  $('#ov-close').hidden = kind === 'welcome';
  if (kind === 'welcome') {
    $('#ov-title').textContent = '';
    const f = (icon, title, text) => `<div class="feature"><span class="f-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icon}"/></svg></span><b>${title}</b><span>${text}</span></div>`;
    body.innerHTML = `<div class="welcome">
      <div class="w-logo"><img src="logo.png" alt=""></div>
      <h1>Hovi Space</h1>
      <p class="w-sub">Все ваши аккаунты Gem Space в одном окне</p>
      <div class="features">
        ${f('M12 1 3 5v6c0 5.5 3.8 10.7 9 12 5.2-1.3 9-6.5 9-12V5zm0 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm0 14c-2.5-.8-4.6-2.7-5.6-5.1C7.8 14.6 10 14 12 14s4.2.6 5.6 1.9c-1 2.4-3.1 4.3-5.6 5.1z', 'Отдельный вход', 'У каждого аккаунта свои данные, как в разных браузерах')}
        ${f('M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14z', 'Общая лента', 'Новые сообщения всех аккаунтов в одном списке')}
        ${f('M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1z', 'Уведомления', 'С именем аккаунта, даже когда окно свёрнуто')}
        ${f('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3a15.7 15.7 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8.2 8.2 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4zm.8 2h3a15.7 15.7 0 0 0 1.4 3.6A8 8 0 0 1 5.1 16zm3-8h-3a8 8 0 0 1 4.4-3.6C8 5.6 7.6 6.8 8.1 8zM12 20c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.3 5.6c.6-1.1 1.1-2.3 1.4-3.6h3a8 8 0 0 1-4.4 3.6zm1.7-5.6a16.5 16.5 0 0 0 0-4h3.4a8.2 8.2 0 0 1 0 4z', 'Свой прокси', 'SOCKS5 или HTTP отдельно для каждого аккаунта')}
      </div>
      <button class="btn primary big" id="w-add">Добавить первый аккаунт</button>
      <p class="w-note">Откроется обычная веб-версия Gem Space, вход по номеру телефона, как всегда.<br>Hovi Space ничего не отправляет на свои серверы.</p>
    </div>`;
    $('#w-add').onclick = () => openOverlay('add');
  } else if (kind === 'add') {
    $('#ov-title').textContent = '';
    body.innerHTML = accountForm(null);
    wireColors(body);
    $('#f-name').focus();
    $('#f-ok').onclick = async () => {
      const v = formValues();
      try { await invoke('add_account', { name: v.name, color: v.color, proxy: v.proxy }); closeOverlay(false); }
      catch (e) { alertErr(e); }
    };
  } else if (kind === 'edit') {
    $('#ov-title').textContent = '';
    body.innerHTML = accountForm(a);
    wireColors(body);
    $('#f-ok').onclick = async () => {
      const v = formValues();
      try {
        const restart = await invoke('update_account', { id: a.id, ...v });
        if (restart) {
          $('.err').textContent = 'Новый прокси заработает после перезапуска Hovi Space (Выйти в трее и открыть снова).';
          $('#f-ok').textContent = 'Готово';
          $('#f-ok').onclick = () => closeOverlay();
          return;
        }
        closeOverlay();
      } catch (e) { alertErr(e); }
    };
  } else if (kind === 'remove') {
    $('#ov-title').textContent = '';
    body.innerHTML = `<div class="acc-form">
      <div class="af-hero"><span class="af-ava" style="background:${esc(a.color)}">${esc(initials(a.name))}</span>
        <h1>Удалить «${esc(a.name)}»?</h1>
        <p>Аккаунт исчезнет из Hovi Space, а его данные на этом компьютере будут стёрты. Сам аккаунт Gem Space останется, войти в него можно снова.</p></div>
      <div class="err"></div>
      <button class="btn danger-fill big wide" id="f-ok">Удалить</button>
      <button class="btn ghost wide" id="f-cancel">Отмена</button></div>`;
    $('#f-ok').onclick = async () => {
      try { await invoke('remove_account', { id: a.id }); closeOverlay(); } catch (e) { alertErr(e); }
    };
  } else if (kind === 'update') {
    const u = state.update;
    $('#ov-title').textContent = 'Обновление';
    body.innerHTML = u ? `<p>Доступна новая версия Hovi Space <b>${esc(u.version)}</b>, у вас ${esc(state.version || '')}.</p>
      ${u.notes ? `<div class="card notes">${esc(u.notes)}</div>` : ''}
      <p class="hint">Hovi Space скачает обновление, проверит его подпись, установит и перезапустится. Аккаунты и входы сохранятся.</p>
      <div class="progress" hidden><span></span></div>
      <div class="row"><button class="btn primary" id="f-ok">Обновить сейчас</button><button class="btn" id="f-cancel">Позже</button></div><div class="err"></div>`
      : `<p>У вас последняя версия Hovi Space ${esc(state.version || '')}.</p><div class="row"><button class="btn" id="f-cancel">Закрыть</button></div>`;
    if (u) {
      $('#f-ok').onclick = async () => {
        $('#f-ok').disabled = true; $('#f-cancel').disabled = true;
        $('#f-ok').textContent = 'Скачивается…';
        $('.progress').hidden = false;
        try { await invoke('install_update'); } catch (e) {
          $('#f-ok').disabled = false; $('#f-cancel').disabled = false; $('#f-ok').textContent = 'Повторить';
          alertErr(e);
        }
      };
    }
  } else if (kind === 'settings') {
    $('#ov-title').textContent = '';
    $('#ov-close').hidden = true;
    renderSettings(a || '');
  }
  const cancel = $('#f-cancel');
  if (cancel) cancel.onclick = () => closeOverlay();
}

// ---------- settings, laid out like Hivogram's: a list of pages, each page with its rows; changes apply at once ----------
const USERS_PATH = 'M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 2 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z';
const CHATS_PATH = 'M4 4h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 3.5V15H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm16 4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-1v3l-3.5-3H10a2 2 0 0 1-1.6-.8L10 17h6a4 4 0 0 0 4-4z';
const SET_PAGES = [
  { id: 'accounts', ic: USERS_PATH, title: 'Аккаунты', sub: () => { const n = state.accounts.length; return n ? `${n} ${plural(n, 'аккаунт', 'аккаунта', 'аккаунтов')}, цвет, порядок, прокси` : 'Добавьте первый аккаунт'; } },
  { id: 'notifications', ic: BELL_PATH, title: 'Уведомления', sub: () => state.settings.notifications ? (state.settings.notify_preview ? 'Включены, с текстом сообщения' : 'Включены, без текста') : 'Выключены' },
  { id: 'chats', ic: CHATS_PATH, title: 'Все чаты и лента', sub: () => 'Общий список чатов всех аккаунтов' },
  { id: 'sleep', ic: MOON_PATH, title: 'Спящий режим', sub: () => state.settings.sleep_enabled ? `Загружено не больше ${state.settings.max_awake}` : 'Выключен, все аккаунты в памяти' },
  { id: 'window', ic: TRAY_PATH, title: 'Окно', sub: () => state.settings.close_to_tray ? 'Крестик сворачивает в трей' : 'Крестик закрывает приложение' },
  { id: 'keys', ic: KEYS_PATH, title: 'Горячие клавиши', sub: () => 'Переключение аккаунтов с клавиатуры' },
  { id: 'updates', ic: REFRESH_PATH, title: 'Обновления', sub: () => `Версия ${state.version || ''}` },
];
let setPage = '';
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}
async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  try { await invoke('set_settings', { settings: state.settings }); } catch (e) { alertErr(e); }
}

function renderSettings(page, back = false) {
  const prev = setPage;
  setPage = page;
  const s = state.settings;
  const cur = SET_PAGES.find((p) => p.id === page);
  const body = $('#ov-body');
  const nav = (p) => `<button class="set-row nav-row" data-p="${p.id}"><span class="af-ic">${icon(p.ic)}</span><span class="af-txt"><b>${p.title}</b><small>${esc(p.sub())}</small></span><span class="chev"></span></button>`;
  const toggle = (ic, id, on, title, text) => `<label class="set-row"><span class="af-ic">${icon(ic)}</span><span class="af-txt"><b>${title}</b>${text ? `<small>${text}</small>` : ''}</span>
    <input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="switch"></span></label>`;
  const note = (t) => `<p class="set-note">${t}</p>`;
  let html = '';
  if (!cur) {
    html = `<div class="set-brand"><img src="logo.png" alt=""><div><b>Hovi Space</b><small>Все аккаунты Gem Space в одном окне</small></div></div>
      <div class="af-card set-card">${SET_PAGES.map(nav).join('')}</div>
      <div class="af-card set-card"><div class="set-row set-col"><div class="set-head"><span class="af-ic">${icon(SIZE_PATH)}</span><span class="af-txt"><b>Размер интерфейса</b><small>Панель аккаунтов и страницы Gem Space</small></span></div>
        <div class="seg" id="s-scale">${SCALES.map((v) => `<button type="button" data-v="${v}" class="${v === (s.ui_scale || 100) ? 'on' : ''}">${v}%</button>`).join('')}<span class="seg-pill"></span></div></div></div>
      ${note('Внутри каждого аккаунта обычная веб-версия Gem Space. Hovi Space её не изменяет и ничего не отправляет от вашего имени.')}`;
  } else if (page === 'accounts') {
    html = `<div class="af-card set-card">${state.accounts.map((a) => `<button class="set-row acc-row" data-a="${esc(a.id)}"><span class="ava" style="background:${esc(a.color)}">${esc(initials(a.name))}</span>
        <span class="af-txt"><b>${esc(a.name)}</b><small>${a.awake ? 'Загружен' : 'Спит'}${a.pinned ? ' · не усыплять' : ''}${a.proxy ? ' · через прокси' : ''}${a.unread ? ` · непрочитанных ${a.unread}` : ''}</small></span><span class="chev"></span></button>`).join('')}
        <button class="set-row" id="s-add"><span class="af-ic">${icon('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z')}</span><span class="af-txt"><b>Добавить аккаунт</b><small>Новый вход в Gem Space по номеру телефона</small></span></button></div>
      ${note('У каждого аккаунта свои данные, как в отдельном браузере. Порядок меняется правым кликом по аккаунту в панели.')}`;
  } else if (page === 'notifications') {
    html = `<div class="af-card set-card">${toggle(BELL_PATH, 's-notif', s.notifications, 'Уведомления', 'О новых сообщениях во всех аккаунтах')}
      ${toggle(TEXT_PATH, 's-preview', s.notify_preview, 'Текст сообщения', 'Показывать в уведомлении, а не только имя')}</div>
      ${note('В заголовке уведомления стоит имя аккаунта, клик открывает этот аккаунт. Спящие аккаунты уведомлений не присылают.')}`;
  } else if (page === 'chats') {
    const n = (state.feed || []).length;
    html = `<div class="af-card set-card"><button class="set-row" id="s-open-chats"><span class="af-ic">${icon(CHATS_PATH)}</span><span class="af-txt"><b>Открыть «Все чаты»</b><small>Кнопка сверху панели аккаунтов</small></span><span class="chev"></span></button>
      <div class="set-row"><span class="af-ic">${icon(TRAY_PATH)}</span><span class="af-txt"><b>Лента</b><small>${n ? `${n} ${plural(n, 'новое сообщение', 'новых сообщения', 'новых сообщений')}` : 'Новых сообщений нет'}</small></span>
        <button class="btn small" id="s-feed-clear" ${n ? '' : 'disabled'}>Очистить</button></div></div>
      ${note('«Все чаты» собирает списки чатов, которые показывают страницы аккаунтов, и сортирует их по времени. Hovi Space только читает эти списки и никуда их не отправляет. У спящих аккаунтов показан последний известный список.')}`;
  } else if (page === 'sleep') {
    html = `<div class="af-card set-card">${toggle(MOON_PATH, 's-sleep', s.sleep_enabled, 'Спящий режим', 'Давно не открытые аккаунты выгружаются из памяти')}
      <div class="set-row" id="s-max-row"><span class="af-ic">${icon(LAYERS_PATH)}</span><span class="af-txt"><b>Загружено одновременно</b><small>Открытый и «Не усыплять» не считаются</small></span>
        <span class="stepper"><button type="button" data-d="-1" aria-label="Меньше">−</button><input type="number" id="s-max" min="1" max="60" value="${s.max_awake}"><button type="button" data-d="1" aria-label="Больше">+</button></span></div></div>
      ${note('Спящий аккаунт не присылает уведомлений и просыпается, когда вы его открываете. Важные аккаунты отметьте «Не усыплять» правым кликом.')}`;
  } else if (page === 'window') {
    html = `<div class="af-card set-card">${toggle(TRAY_PATH, 's-tray', s.close_to_tray, 'Сворачивать в трей', 'Крестик прячет окно, уведомления продолжают приходить')}</div>`;
  } else if (page === 'keys') {
    const key = (k, text) => `<div class="key-row"><span class="keys">${k.map((x) => `<kbd>${x}</kbd>`).join('<i>+</i>')}</span><span>${text}</span></div>`;
    html = `<div class="af-card set-card keys-list">${key(['Ctrl', '1…9'], 'Аккаунт по номеру')}${key(['Ctrl', 'Tab'], 'Следующий аккаунт')}${key(['Ctrl', 'Shift', 'Tab'], 'Предыдущий аккаунт')}
      ${key(['Ctrl', 'колесо'], 'Масштаб')}${key(['Esc'], 'Закрыть «Все чаты» и окна')}<div class="key-row"><span class="keys"><kbd>Правый клик</kbd></span><span>Изменить, усыпить, порядок, удалить</span></div></div>`;
  } else if (page === 'updates') {
    html = `<div class="af-card set-card"><div class="set-row"><span class="af-ic">${icon(REFRESH_PATH)}</span><span class="af-txt"><b>Версия ${esc(state.version || '')}</b><small id="s-check-res">Проверяются сами раз в несколько часов</small></span>
      <button class="btn small" id="s-check">Проверить</button></div></div>
      ${note('Обновление ставится поверх, аккаунты и входы сохраняются.')}`;
  }
  body.innerHTML = `<div class="set-view${back ? ' back' : prev !== page ? ' fwd' : ''}">
    <div class="set-top"><button class="x" id="s-back" title="${cur ? 'Назад' : 'Закрыть (Esc)'}">${cur ? icon('M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z') : '✕'}</button><h1>${cur ? cur.title : 'Настройки'}</h1></div>
    ${html}</div>`;
  $('#s-back').onclick = () => (cur ? renderSettings('', true) : closeOverlay());
  body.querySelectorAll('.nav-row').forEach((r) => { r.onclick = () => renderSettings(r.dataset.p); });
  const seg = $('#s-scale');
  if (seg) {
    seg.querySelectorAll('button').forEach((btn) => {
      btn.onclick = () => { seg.querySelectorAll('button').forEach((x) => x.classList.remove('on')); btn.classList.add('on'); segPill(seg); saveSettings({ ui_scale: Number(btn.dataset.v) }); };
    });
    requestAnimationFrame(() => segPill(seg));
  }
  const bind = (id, key, after) => { const el = $('#' + id); if (el) el.onchange = () => { saveSettings({ [key]: el.checked }); if (after) after(); }; };
  bind('s-notif', 'notifications', () => { $('#s-preview').closest('.set-row').classList.toggle('off', !$('#s-notif').checked); });
  if ($('#s-preview')) $('#s-preview').closest('.set-row').classList.toggle('off', !s.notifications);
  bind('s-preview', 'notify_preview');
  bind('s-tray', 'close_to_tray');
  const syncMax = () => $('#s-max-row') && $('#s-max-row').classList.toggle('off', !$('#s-sleep').checked);
  bind('s-sleep', 'sleep_enabled', syncMax);
  if ($('#s-sleep')) syncMax();
  const max = $('#s-max');
  if (max) {
    const put = (v) => { max.value = Math.max(1, Math.min(60, v || 8)); saveSettings({ max_awake: Number(max.value) }); };
    max.onchange = () => put(parseInt(max.value, 10));
    body.querySelectorAll('.stepper button').forEach((btn) => {
      btn.onclick = () => { put((parseInt(max.value, 10) || 8) + Number(btn.dataset.d)); max.classList.remove('bump'); void max.offsetWidth; max.classList.add('bump'); };
    });
  }
  body.querySelectorAll('.acc-row').forEach((r) => { r.onclick = () => { const a = state.accounts.find((x) => x.id === r.dataset.a); if (a) openOverlay('edit', a); }; });
  if ($('#s-add')) $('#s-add').onclick = () => openOverlay('add');
  if ($('#s-open-chats')) $('#s-open-chats').onclick = async () => { await closeOverlay(); setPanel(true); };
  if ($('#s-feed-clear')) $('#s-feed-clear').onclick = async () => { try { await invoke('feed_clear', { account: null }); } catch (e) { alertErr(e); } state.feed = []; renderSettings('chats'); };
  if ($('#s-check')) $('#s-check').onclick = async () => {
    const res = $('#s-check-res');
    res.textContent = 'Проверяю…';
    try {
      const v = await invoke('check_update');
      res.textContent = v ? `Есть версия ${v}` : 'Это последняя версия';
      if (v) openOverlay('update');
    } catch (e) { res.textContent = 'Не удалось проверить: ' + (typeof e === 'string' ? e : (e && e.message) || e); }
  };
}

async function closeOverlay(restore = true) {
  if (!state.accounts.length) { openOverlay('welcome'); return; }
  overlayKind = null;
  renderFeedButton();
  const ov = $('#overlay');
  ov.classList.add('closing');
  await new Promise((r) => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150));
  ov.classList.remove('closing');
  ov.hidden = true;
  if (restore) await invoke('set_overlay', { open: false });
}

$('#ov-close').onclick = () => closeOverlay();
$('#add').onclick = () => openOverlay('add');
$('#gear').onclick = () => openOverlay('settings');
$('#upd').onclick = () => openOverlay('update');
$('#feed').onclick = () => setPanel(!panelOpen);
$('#p-close').onclick = () => setPanel(false);
$('#p-q').oninput = (e) => { chatQuery = e.target.value; chatSeen.clear(); renderFeed(); };
$('#feed-clear').onclick = () => invoke('feed_clear', { account: feedFilter });
$('#p-tabs').querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    if (feedTab === b.dataset.t) return;
    feedTab = b.dataset.t;
    try { localStorage.setItem('gs-feed-tab', feedTab); } catch (e) {}
    $('#p-tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    segPill($('#p-tabs'));
    feedFilter = null; chatSeen.clear(); feedSeen.clear();
    renderFeed();
  };
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelOpen && !overlayKind) setPanel(false); });

// "Все чаты" opens as a column next to the rail; the account pages move right and stay visible.
async function setPanel(open) {
  panelOpen = open;
  document.body.classList.toggle('panel-open', open);
  $('#panel').hidden = !open;
  if (open) {
    $('#p-tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.t === feedTab));
    requestAnimationFrame(() => segPill($('#p-tabs')));
    chatSeen.clear(); feedSeen.clear();
    renderFeed();
  }
  renderFeedButton();
  await invoke('set_panel', { open });
  if (open && feedTab === 'all') $('#p-q').focus();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlayKind === 'settings' && setPage) { renderSettings('', true); return; }
  if (e.key === 'Escape' && overlayKind && overlayKind !== 'welcome') { closeOverlay(); return; }
  if (!e.ctrlKey || e.altKey) return;
  let key = null;
  if (!e.shiftKey && e.key >= '1' && e.key <= '9') key = e.key;
  else if (e.key === 'Tab') key = e.shiftKey ? 'prev' : 'next';
  if (key && !overlayKind) { e.preventDefault(); invoke('hotkey', { key }); }
});
window.addEventListener('resize', moveIndicator);
window.addEventListener('contextmenu', (e) => { if (!e.target.closest('input')) e.preventDefault(); });

function apply(s) {
  state = s;
  renderRail();
  if (panelOpen) renderFeed();
  if (!state.accounts.length && overlayKind !== 'add' && overlayKind !== 'welcome') openOverlay('welcome');
}

listen('state', (e) => apply(e.payload));
listen('update-progress', (e) => {
  const bar = $('.progress span');
  if (!bar) return;
  const { done, total } = e.payload;
  bar.style.width = total ? `${Math.min(100, (done / total) * 100).toFixed(1)}%` : '50%';
  if (total && done >= total) $('#f-ok').textContent = 'Устанавливается…';
});
invoke('get_state').then(apply);
