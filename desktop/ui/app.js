// Hovi Space rail: account tiles, account editor and settings. Talks to the Rust side through Tauri commands.
'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { Menu } = window.__TAURI__.menu;

const COLORS = ['#3aa0ff', '#26a69a', '#7e57c2', '#ef5350', '#ffa726', '#66bb6a', '#ec407a', '#8d6e63'];
let state = { accounts: [], active: null, settings: {}, total_unread: 0 };
let overlayKind = null; // null | 'add' | 'edit' | 'settings' | 'welcome' | 'feed'
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
        if (overlayKind === 'feed') closeOverlay(false); // switching an account hides the feed
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

function renderFeedButton() {
  const b = $('#feed');
  const n = (state.feed || []).length;
  b.classList.toggle('active', overlayKind === 'feed');
  b.querySelectorAll('.badge').forEach((x) => x.remove());
  if (n > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge' + (n > feedShown ? ' pop' : '');
    badge.textContent = n > 99 ? '99+' : n;
    b.appendChild(badge);
  }
  b.setAttribute('aria-label', 'Лента' + (n ? `, новых: ${n}` : ''));
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
// The feed overlay has two tabs: new messages (from notifications) and all chats of every account
// (read from the chat list each page shows, see shared/chats.js).
let feedTab = (() => { try { return localStorage.getItem('gs-feed-tab') === 'all' ? 'all' : 'new'; } catch (e) { return 'new'; } })();
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

function renderChats() {
  const box = $('#feed-list');
  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  const lists = state.chats || {};
  let rows = [];
  state.accounts.forEach((a) => (lists[a.id] || []).forEach((c, i) => rows.push({ ...c, account: a.id, i, at: chatTime(c.time) })));
  const present = state.accounts.filter((a) => (lists[a.id] || []).length);
  if (feedFilter && !present.some((a) => a.id === feedFilter)) feedFilter = null;
  const unreadOf = (id) => (lists[id] || []).reduce((n, c) => n + (c.unread ? 1 : 0), 0);
  $('#feed-chips').innerHTML = rows.length ? [`<button class="chip${feedFilter ? '' : ' on'}" data-a="">Все <b>${rows.length}</b></button>`]
    .concat(present.map((a) => `<button class="chip${feedFilter === a.id ? ' on' : ''}" data-a="${esc(a.id)}"><i style="background:${esc(a.color)}"></i>${esc(a.name)}${unreadOf(a.id) ? ` <b class="u">${unreadOf(a.id)}</b>` : ''}</button>`)).join('') : '';
  $('#feed-chips').querySelectorAll('.chip').forEach((c) => { c.onclick = () => { feedFilter = c.dataset.a || null; chatSeen.clear(); renderFeed(); }; });
  $('#feed-clear').hidden = true;
  $('#feed-lead').textContent = 'Чаты всех аккаунтов одним списком, свежие сверху. Клик откроет чат в его аккаунте.';
  const missing = state.accounts.filter((a) => !(lists[a.id] || []).length).map((a) => a.name);
  $('#feed-note').textContent = (missing.length ? `Пока без списка: ${missing.join(', ')}. Чаты аккаунта появятся, когда он загрузится, у спящих показан последний известный список. ` : '')
    + 'Hovi Space только читает список, который показывает сама страница Gem Space, и никуда его не отправляет.';
  rows = rows.filter((r) => !feedFilter || r.account === feedFilter);
  rows.sort((a, b) => (b.at - a.at) || (a.account === b.account ? a.i - b.i : 0));
  if (!rows.length) {
    box.innerHTML = `<div class="feed-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>
      <b>Список чатов ещё не загрузился</b><span>Он появится, когда откроются страницы аккаунтов. Если не появляется совсем, значит Gem Space поменял страницу, напишите нам.</span></div>`;
    return;
  }
  box.innerHTML = rows.map((c) => {
    const a = accounts.get(c.account);
    const key = c.account + '|' + c.name;
    const ci = initials(c.name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim() || c.name);
    const fresh = !chatSeen.has(key);
    const ava = c.avatar ? `<span class="ava img"><img src="${esc(c.avatar)}" alt="" referrerpolicy="no-referrer" data-i="${esc(ci)}"></span>`
      : `<span class="ava" style="background:${esc(a.color)}">${esc(ci)}</span>`;
    return `<button class="feed-row chat-row${fresh ? ' new' : ''}${c.unread ? ' unread' : ''}" data-a="${esc(c.account)}" data-n="${esc(c.name)}">
      ${ava}<span class="fr-main"><span class="fr-top"><span class="fr-title">${esc(c.name)}</span><span class="fr-acc"><i style="background:${esc(a.color)}"></i>${esc(a.name)}</span><span class="fr-time">${esc(c.time)}</span></span>
      <span class="fr-bottom"><span class="fr-body">${esc(c.preview || (c.unread ? 'Новое сообщение' : ''))}</span>${c.unread ? `<span class="cnt">${c.unread > 999 ? '999+' : c.unread}</span>` : ''}</span></span></button>`;
  }).join('');
  rows.forEach((c) => chatSeen.add(c.account + '|' + c.name));
  box.querySelectorAll('.ava.img img').forEach((im) => { im.onerror = () => { const s = im.parentNode; s.classList.remove('img'); s.textContent = im.dataset.i; }; });
  box.querySelectorAll('.chat-row').forEach((r) => {
    r.onclick = async () => {
      try { await invoke('chat_open', { account: r.dataset.a, name: r.dataset.n }); closeOverlay(false); } catch (e) { alertErr(e); }
    };
  });
}

function renderFeed() {
  const box = $('#feed-list');
  if (!box) return;
  if (feedTab === 'all') { renderChats(); return; }
  $('#feed-lead').textContent = 'Новые сообщения всех аккаунтов. Клик откроет чат в его аккаунте, ответить можно там.';
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
      try { await invoke('feed_open', { key: Number(r.dataset.key) }); closeOverlay(false); } catch (e) { alertErr(e); }
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
  $('#overlay').classList.toggle('side', kind === 'feed');
  $('#overlay').classList.toggle('welcome-mode', kind === 'welcome');
  $('#overlay').classList.toggle('form-mode', kind === 'add' || kind === 'edit' || kind === 'remove' || kind === 'settings');
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
  } else if (kind === 'feed') {
    $('#ov-title').textContent = 'Лента';
    body.innerHTML = `<div class="seg feed-tabs" id="feed-tabs"><button type="button" data-t="new">Новые сообщения</button><button type="button" data-t="all">Все чаты</button><span class="seg-pill"></span></div>
      <p class="hint lead" id="feed-lead"></p>
      <div class="feed-bar"><div id="feed-chips" class="chips"></div><button class="btn small" id="feed-clear">Очистить</button></div>
      <div id="feed-list"></div>
      <p class="hint" id="feed-note"></p>`;
    feedSeen.clear();
    (state.feed || []).forEach((i) => feedSeen.add(i.key));
    chatSeen.clear();
    $('#feed-clear').onclick = () => invoke('feed_clear', { account: feedFilter });
    const tabs = $('#feed-tabs');
    tabs.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.t === feedTab);
      b.onclick = () => {
        if (feedTab === b.dataset.t) return;
        feedTab = b.dataset.t;
        try { localStorage.setItem('gs-feed-tab', feedTab); } catch (e) {}
        tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        segPill(tabs);
        chatSeen.clear(); feedSeen.clear();
        renderFeed();
      };
    });
    requestAnimationFrame(() => segPill(tabs));
    renderFeed();
    renderFeedButton();
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
    const s = state.settings;
    $('#ov-title').textContent = '';
    const row = (ic, id, on, title, text) => `<label class="set-row"><span class="af-ic">${icon(ic)}</span><span class="af-txt"><b>${title}</b>${text ? `<small>${text}</small>` : ''}</span>
      <input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="switch"></span></label>`;
    const key = (k, text) => `<div class="key-row"><span class="keys">${k.map((x) => `<kbd>${x}</kbd>`).join('<i>+</i>')}</span><span>${text}</span></div>`;
    body.innerHTML = `<div class="acc-form settings-form">
      <div class="af-hero">
        <span class="af-ava set-ava">${icon(GEAR_PATH)}</span>
        <h1>Настройки</h1>
        <p>Hovi Space ${esc(state.version || '')}. Внутри обычная веб-версия Gem Space, Hovi Space её не изменяет.</p>
      </div>
      <div class="set-label">Уведомления</div>
      <div class="af-card set-card">
        ${row(BELL_PATH, 's-notif', s.notifications, 'Уведомления', 'О новых сообщениях во всех аккаунтах')}
        ${row(TEXT_PATH, 's-preview', s.notify_preview, 'Текст сообщения', 'Показывать в уведомлении, а не только имя')}
      </div>
      <div class="set-label">Память</div>
      <div class="af-card set-card">
        ${row(MOON_PATH, 's-sleep', s.sleep_enabled, 'Спящий режим', 'Давно не открытые аккаунты выгружаются и не присылают уведомлений')}
        <div class="set-row" id="s-max-row"><span class="af-ic">${icon(LAYERS_PATH)}</span><span class="af-txt"><b>Загружено одновременно</b><small>Открытый и «Не усыплять» не считаются</small></span>
          <span class="stepper"><button type="button" data-d="-1" aria-label="Меньше">−</button><input type="number" id="s-max" min="1" max="60" value="${s.max_awake}"><button type="button" data-d="1" aria-label="Больше">+</button></span></div>
      </div>
      <div class="set-label">Окно</div>
      <div class="af-card set-card">
        ${row(TRAY_PATH, 's-tray', s.close_to_tray, 'Сворачивать в трей', 'Крестик прячет окно, уведомления продолжают приходить')}
        <div class="set-row set-col"><div class="set-head"><span class="af-ic">${icon(SIZE_PATH)}</span><span class="af-txt"><b>Размер интерфейса</b><small>Панель аккаунтов и страницы Gem Space</small></span></div>
          <div class="seg" id="s-scale">${SCALES.map((v) => `<button type="button" data-v="${v}" class="${v === (s.ui_scale || 100) ? 'on' : ''}">${v}%</button>`).join('')}<span class="seg-pill"></span></div></div>
      </div>
      <div class="set-label">Обновления</div>
      <div class="af-card set-card">
        <div class="set-row"><span class="af-ic">${icon(REFRESH_PATH)}</span><span class="af-txt"><b>Версия ${esc(state.version || '')}</b><small id="s-check-res">Проверяются сами раз в несколько часов</small></span>
          <button class="btn small" id="s-check">Проверить</button></div>
      </div>
      <details class="af-card af-more">
        <summary><span class="af-ic">${icon(KEYS_PATH)}</span><span class="af-txt"><b>Горячие клавиши</b><small>Переключение аккаунтов с клавиатуры</small></span><span class="af-chev"></span></summary>
        <div class="keys-list">
          ${key(['Ctrl', '1…9'], 'Аккаунт по номеру')}
          ${key(['Ctrl', 'Tab'], 'Следующий аккаунт')}
          ${key(['Ctrl', 'Shift', 'Tab'], 'Предыдущий аккаунт')}
          ${key(['Ctrl', 'колесо'], 'Масштаб')}
          <div class="key-row"><span class="keys"><kbd>Правый клик</kbd></span><span>Изменить, усыпить, порядок, удалить</span></div>
        </div>
      </details>
      <div class="err"></div>
      <button class="btn primary big wide" id="f-ok">Сохранить</button>
      <button class="btn ghost wide" id="f-cancel">Отмена</button>
    </div>`;
    const seg = $('#s-scale');
    const movePill = () => segPill(seg);
    seg.querySelectorAll('button').forEach((btn) => {
      btn.onclick = () => { seg.querySelectorAll('button').forEach((x) => x.classList.remove('on')); btn.classList.add('on'); movePill(); };
    });
    requestAnimationFrame(movePill);
    const max = $('#s-max');
    const syncMax = () => $('#s-max-row').classList.toggle('off', !$('#s-sleep').checked);
    $('#s-sleep').addEventListener('change', syncMax); syncMax();
    body.querySelectorAll('.stepper button').forEach((btn) => {
      btn.onclick = () => {
        max.value = Math.max(1, Math.min(60, (parseInt(max.value, 10) || 8) + Number(btn.dataset.d)));
        max.classList.remove('bump'); void max.offsetWidth; max.classList.add('bump');
      };
    });
    $('#f-ok').onclick = async () => {
      const settings = {
        notifications: $('#s-notif').checked,
        notify_preview: $('#s-preview').checked,
        sleep_enabled: $('#s-sleep').checked,
        max_awake: Math.max(1, Math.min(60, parseInt($('#s-max').value, 10) || 8)),
        close_to_tray: $('#s-tray').checked,
        ui_scale: Number(($('#s-scale .on') || {}).dataset?.v) || 100,
      };
      await invoke('set_settings', { settings });
      closeOverlay();
    };
    $('#s-check').onclick = async () => {
      const res = $('#s-check-res');
      res.textContent = 'Проверяю…';
      try {
        const v = await invoke('check_update');
        res.textContent = v ? `Есть версия ${v}` : 'Это последняя версия';
        if (v) openOverlay('update');
      } catch (e) { res.textContent = 'Не удалось проверить: ' + (typeof e === 'string' ? e : (e && e.message) || e); }
    };
  }
  const cancel = $('#f-cancel');
  if (cancel) cancel.onclick = () => closeOverlay();
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
$('#feed').onclick = () => (overlayKind === 'feed' ? closeOverlay() : openOverlay('feed'));

window.addEventListener('keydown', (e) => {
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
  if (overlayKind === 'feed') renderFeed();
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
