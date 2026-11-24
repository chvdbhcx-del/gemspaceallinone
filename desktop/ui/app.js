// Hovi Space rail: account tiles, account editor and settings. Talks to the Rust side through Tauri commands.
'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { Menu } = window.__TAURI__.menu;

const COLORS = ['#3aa0ff', '#26a69a', '#7e57c2', '#ef5350', '#ffa726', '#66bb6a', '#ec407a', '#8d6e63'];
const COLOR_NAMES = ['Голубой', 'Бирюзовый', 'Фиолетовый', 'Красный', 'Оранжевый', 'Зелёный', 'Розовый', 'Коричневый'];
let state = { accounts: [], active: null, settings: {}, total_unread: 0 };
let overlayKind = null; // null | 'welcome' | 'add' | 'edit' | 'remove' | 'settings' | 'update' | 'label' | 'broadcast' | one of CRM_KINDS
const CRM_KINDS = new Set(['note', 'remind', 'status', 'templates', 'template', 'notice']); // crm.js
let panelOpen = false; // the chat list column next to the rail
let chatQuery = '';
let chatUnreadOnly = false;
let labelFilter = null; // label id the chat list is narrowed to
let statusFilter = null; // status id the chat list is narrowed to (crm.js)
let remindOnly = false; // only chats with a reminder, soonest first
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
    const hk = i < 9 ? ` (Ctrl+${i + 1})` : '';
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
  $('#feed').hidden = none; $('.sep').hidden = none; $('#add').hidden = none; $('#tpl').hidden = none;
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
  // a reminder that came due: a bell on the tile until its chat is opened or the reminder moved
  const due = typeof dueCount === 'function' ? dueCount() : 0;
  b.querySelectorAll('.due-mark').forEach((x) => x.remove());
  if (due) b.insertAdjacentHTML('beforeend', `<span class="due-mark" title="Напоминаний: ${due}">${icon(BELL_PATH)}</span>`);
  const f = (state.feed || []).length;
  const fn = $('#p-feed-n'); if (fn) fn.textContent = f ? (f > 99 ? '99+' : String(f)) : '';
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
  ].concat((() => {
    const rem = rows.filter((r) => remindOf(r.account + '|' + r.name));
    if (!rem.length && !remindOnly) return [];
    const due = rem.filter((r) => isDue(r.account + '|' + r.name)).length;
    return [`<button class="chip${remindOnly ? ' on' : ''}" data-k="remind" title="Чаты с напоминанием, ближайшие сверху">Напоминания <b${due ? ' class="u"' : ''}>${due || rem.length}</b></button>`];
  })()).concat((state.statuses || []).map((s) => {
    const n = rows.filter((r) => (statusOf(r.account + '|' + r.name) || {}).id === s.id).length;
    if (!n && statusFilter !== s.id) return '';
    return `<button class="chip${statusFilter === s.id ? ' on' : ''}" data-s="${esc(s.id)}" title="Правый клик: изменить или удалить"><i style="background:${esc(s.color)}"></i>${esc(s.name)} <b>${n}</b></button>`;
  })).concat((state.labels || []).map((l) => {
    const n = rows.filter((r) => labelIds(r.account, r.name).includes(l.id)).length;
    return `<button class="chip tag-chip${labelFilter === l.id ? ' on' : ''}" data-l="${esc(l.id)}" title="Правый клик: изменить или удалить"><i class="sq" style="background:${esc(l.color)}"></i>${esc(l.name)}${n ? ` <b>${n}</b>` : ''}</button>`;
  })).concat(present.map((a) => `<button class="chip${feedFilter === a.id ? ' on' : ''}" data-a="${esc(a.id)}"><i style="background:${esc(a.color)}"></i>${esc(a.name)}</button>`)).join('');
  if (labelFilter && !(state.labels || []).some((l) => l.id === labelFilter)) labelFilter = null;
  if (statusFilter && !(state.statuses || []).some((x) => x.id === statusFilter)) statusFilter = null;
  $('#feed-chips').querySelectorAll('.chip').forEach((c) => {
    c.onclick = () => {
      if (c.dataset.k === 'all') { feedFilter = null; chatUnreadOnly = false; labelFilter = null; statusFilter = null; remindOnly = false; }
      else if (c.dataset.k === 'unread') chatUnreadOnly = !chatUnreadOnly;
      else if (c.dataset.k === 'remind') remindOnly = !remindOnly;
      else if (c.dataset.s) statusFilter = statusFilter === c.dataset.s ? null : c.dataset.s;
      else if (c.dataset.l) labelFilter = labelFilter === c.dataset.l ? null : c.dataset.l;
      else feedFilter = feedFilter === c.dataset.a ? null : c.dataset.a;
      chatSeen.clear(); renderFeed();
    };
    if (c.dataset.l) c.oncontextmenu = (e) => { e.preventDefault(); labelMenu(c.dataset.l); };
    if (c.dataset.s) c.oncontextmenu = (e) => { e.preventDefault(); statusMenu(c.dataset.s); };
  });
  $('#feed-clear').hidden = true;
  const missing = state.accounts.filter((a) => !(lists[a.id] || []).length).map((a) => a.name).join(', ');
  $('#feed-note').textContent = (missing ? `Пока без списка: ${missing}${missing.endsWith('.') ? '' : '.'} Их чаты появятся, когда аккаунт загрузится. ` : '')
    + 'Правый клик по чату: шаблон, статус, напоминание, заметка и метки, они видны только вам. Список берётся со страниц Gem Space и никуда не отправляется.';
  const q = chatQuery.trim().toLowerCase();
  const keyOf = (r) => r.account + '|' + r.name;
  rows = rows.filter((r) => (!feedFilter || r.account === feedFilter) && (!chatUnreadOnly || r.unread)
    && (!q || r.name.toLowerCase().includes(q) || String(r.preview || '').toLowerCase().includes(q) || noteOf(keyOf(r)).toLowerCase().includes(q))
    && (!labelFilter || labelIds(r.account, r.name).includes(labelFilter))
    && (!statusFilter || (statusOf(keyOf(r)) || {}).id === statusFilter)
    && (!remindOnly || remindOf(keyOf(r))));
  rows.sort((a, b) => (remindOnly ? remindOf(keyOf(a)) - remindOf(keyOf(b)) : 0) || (b.at - a.at) || (a.account === b.account ? a.i - b.i : 0));
  if (!rows.length) {
    const narrowed = labelFilter || statusFilter || remindOnly;
    box.innerHTML = q || chatUnreadOnly || narrowed
      ? `<div class="feed-empty"><b>${q ? 'Ничего не найдено' : chatUnreadOnly ? (narrowed ? 'Среди них непрочитанных нет' : 'Непрочитанных нет') : remindOnly ? 'Напоминаний нет' : statusFilter ? 'С этим статусом чатов нет' : 'С этой меткой чатов нет'}</b>${narrowed && !q && !chatUnreadOnly ? '<span>Ставится правым кликом по чату.</span>' : ''}</div>`
      : `<div class="feed-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>
      <b>Список чатов ещё не загрузился</b><span>Он появится, когда откроются страницы аккаунтов. Если его нет и после входа, значит Gem Space поменял страницу: сохраните «Отчёт о входе» в настройках и пришлите его.</span></div>`;
    return;
  }
  box.innerHTML = rows.map((c) => {
    const a = accounts.get(c.account);
    const key = c.account + '|' + c.name;
    const fresh = !chatSeen.has(key);
    const ci = chatIni(c.name);
    const ava = c.avatar ? `<span class="cav img"><img src="${esc(c.avatar)}" alt="" referrerpolicy="no-referrer" data-i="${esc(ci)}"></span>`
      : `<span class="cav" style="background:${chatColor(c.name)}">${esc(ci)}</span>`;
    return `<button class="gs-row${fresh ? ' new' : ''}${c.unread ? ' unread' : ''}${selectedChat === key ? ' selected' : ''}" data-a="${esc(c.account)}" data-n="${esc(c.name)}" title="${esc(c.name)} · ${esc(a.name)}${esc(metaTitle(key))}">
      <span class="cav-wrap">${ava}<i class="acc-dot" style="background:${esc(a.color)}">${esc(initials(a.name).slice(0, 1))}</i></span>
      <span class="gs-main"><span class="gs-top"><span class="gs-name">${esc(c.name)}</span>${tagsHtml(c.account, c.name)}${marksHtml(key)}<span class="gs-time">${esc(c.time)}</span></span>
      <span class="gs-bottom">${metaHtml(key)}<span class="gs-prev">${esc(c.preview || (c.unread ? 'Новое сообщение' : ''))}</span>${c.unread ? `<span class="cnt">${c.unread > 999 ? '999+' : c.unread}</span>` : ''}</span></span></button>`;
  }).join('');
  rows.forEach((c) => chatSeen.add(c.account + '|' + c.name));
  box.querySelectorAll('.cav.img img').forEach((im) => { im.onerror = () => { const sp = im.parentNode; sp.classList.remove('img'); sp.style.background = chatColor(sp.closest('.gs-row').dataset.n); sp.textContent = im.dataset.i; }; });
  box.querySelectorAll('.gs-row').forEach((r) => {
    r.onclick = async () => {
      selectedChat = r.dataset.a + '|' + r.dataset.n;
      if (isDue(selectedChat)) setReminder(selectedChat, null); // the reminder did its job: the chat is open
      box.querySelectorAll('.gs-row.selected').forEach((x) => x.classList.remove('selected'));
      r.classList.add('selected');
      try { await invoke('chat_open', { account: r.dataset.a, name: r.dataset.n }); } catch (e) { alertErr(e); }
    };
    r.oncontextmenu = (e) => { e.preventDefault(); chatMenu(r.dataset.a, r.dataset.n); };
  });
}

// ---------- labels on chats: kept by Rust in state.json, edited here ----------
const labelIds = (account, name) => ((state.chat_labels || {})[account + '|' + name]) || [];
function tagsHtml(account, name) {
  const ls = labelIds(account, name).map((id) => (state.labels || []).find((l) => l.id === id)).filter(Boolean);
  if (!ls.length) return '';
  const shown = ls.slice(0, 1).map((l) => `<span class="tag" style="--c:${esc(l.color)}">${esc(l.name)}</span>`).join('');
  return `<span class="tags">${shown}${ls.length > 1 ? `<span class="tag more">+${ls.length - 1}</span>` : ''}</span>`;
}
async function saveLabels(labels, map) {
  state.labels = labels; state.chat_labels = map;
  renderFeed();
  try { await invoke('set_labels', { labels, chatLabels: map }); } catch (e) { alertErr(e); }
}
function toggleLabel(key, id) {
  const map = { ...(state.chat_labels || {}) };
  const cur = map[key] || [];
  map[key] = cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat(id);
  if (!map[key].length) delete map[key];
  saveLabels(state.labels || [], map);
}
async function labelMenu(id) {
  const l = (state.labels || []).find((x) => x.id === id);
  if (!l) return;
  const menu = await Menu.new({ items: [
    { id: 'edit', text: 'Изменить…', action: () => openOverlay('label', { label: l }) },
    { id: 'delete', text: 'Удалить метку', action: () => saveLabels((state.labels || []).filter((x) => x.id !== id), state.chat_labels || {}) },
  ] });
  await menu.popup();
}

function renderFeed() {
  const box = $('#feed-list');
  if (!box) return;
  $('#p-q').parentNode.hidden = feedTab !== 'all';
  if (feedTab === 'all') { renderChats(); return; }
  $('#feed-note').textContent = 'Лента собирается из уведомлений, пока Hovi Space запущен. Спящие аккаунты сюда не пишут, важные отметьте «Не усыплять». Когда в аккаунте всё прочитано, его сообщения уходят из ленты.';
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
  if (i > 0) items.push({ id: 'up', text: 'Выше', action: () => invoke('move_account', { id: a.id, delta: -1 }).catch(alertErr) });
  if (i < state.accounts.length - 1) items.push({ id: 'down', text: 'Ниже', action: () => invoke('move_account', { id: a.id, delta: 1 }).catch(alertErr) });
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
  return `<div class="colors">${COLORS.map((c, i) =>
    `<button type="button" class="swatch${c === current ? ' on' : ''}" data-c="${c}" style="background:${c}" title="${COLOR_NAMES[i]}" aria-label="${COLOR_NAMES[i]}" aria-pressed="${c === current}"></button>`).join('')}</div>`;
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
const REPORT_PATH = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm-1 7V3.5L18.5 9zM8 13h8v2H8zm0 4h8v2H8zm0-8h3v2H8z';
const UPDATE_PATH = 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 5h2v6.2l2.6-2.6L17 12l-5 5-5-5 1.4-1.4 2.6 2.6z';
const TAG_PATH = 'M21.4 11.6 12.4 2.6A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 .6 1.4l9 9a2 2 0 0 0 2.8 0l7-7a2 2 0 0 0 0-2.8zM6.5 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z';
const SAVE_PATH = 'M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10z';
const icon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

// Colors and the name drive the big avatar on top, so the tile is seen before it is made.
function wireColors(root) {
  const ava = root.querySelector('#af-ava');
  root.querySelectorAll('.swatch').forEach((s) => {
    s.onclick = () => {
      root.querySelectorAll('.swatch').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
      s.classList.add('on'); s.setAttribute('aria-pressed', 'true');
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
      <p>${a ? 'Название, цвет и прокси этого аккаунта' : 'Откроется веб-версия Gem Space, войдите так же, как в браузере'}</p>
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

// Enter in a text field of the account form presses its main button
function submitOnEnter(root) {
  root.querySelectorAll('input[type=text]').forEach((el) => {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#f-ok').disabled) { e.preventDefault(); $('#f-ok').click(); } });
  });
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
  $('#overlay').classList.toggle('form-mode', kind !== 'welcome');
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
        ${f('M4 4h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 3.5V15H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm16 4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-1v3l-3.5-3H10a2 2 0 0 1-1.6-.8L10 17h6a4 4 0 0 0 4-4z', 'Все чаты', 'Чаты всех аккаунтов в одном списке, со статусами и заметками')}
        ${f('M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1z', 'Уведомления', 'С именем аккаунта, даже когда окно свёрнуто')}
        ${f('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3a15.7 15.7 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8.2 8.2 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4zm.8 2h3a15.7 15.7 0 0 0 1.4 3.6A8 8 0 0 1 5.1 16zm3-8h-3a8 8 0 0 1 4.4-3.6C8 5.6 7.6 6.8 8.1 8zM12 20c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.3 5.6c.6-1.1 1.1-2.3 1.4-3.6h3a8 8 0 0 1-4.4 3.6zm1.7-5.6a16.5 16.5 0 0 0 0-4h3.4a8.2 8.2 0 0 1 0 4z', 'Свой прокси', 'SOCKS5 или HTTP отдельно для каждого аккаунта')}
      </div>
      <button class="btn primary big" id="w-add">Добавить первый аккаунт</button>
      <button class="btn ghost" id="w-restore">Восстановить из резервной копии</button>
      <p class="w-note">Откроется обычная веб-версия Gem Space, вход такой же, как в браузере.<br>Hovi Space ничего не отправляет на свои серверы.</p>
    </div>`;
    $('#w-add').onclick = () => openOverlay('add');
    $('#w-restore').onclick = async () => {
      try {
        const res = await invoke('backup_import');
        if (!res) return;
        apply(await invoke('get_state'));
        if (state.accounts.length) { await closeOverlay(); if (!state.active) invoke('switch_account', { id: state.accounts[0].id }).catch(alertErr); }
      } catch (e) { alertErr(e); }
    };
  } else if (kind === 'broadcast') {
    bcForm(body);
  } else if (CRM_KINDS.has(kind)) {
    crmOverlay(kind, body, a); // binds its own buttons, Отмена included
    return;
  } else if (kind === 'label') {
    const l = a && a.label;
    const color = l ? l.color : COLORS[(state.labels || []).length % COLORS.length];
    $('#ov-title').textContent = '';
    body.innerHTML = `<div class="acc-form">
      <div class="af-hero"><span class="af-ava tag-ava" id="af-ava" style="background:${esc(color)}">${icon(TAG_PATH)}</span>
        <h1>${l ? 'Метка' : 'Новая метка'}</h1><p>Метки видны только вам, в этом окне. По ним можно отфильтровать «Все чаты».</p></div>
      <div class="af-card">
        <label class="af-field"><span>Название</span><input type="text" id="f-name" maxlength="30" value="${esc(l ? l.name : '')}" placeholder="Например, Клиенты или Ждут оплату"></label>
        <div class="af-field"><span>Цвет</span>${colorPicker(color)}</div>
      </div>
      <div class="err"></div>
      <button class="btn primary big wide" id="f-ok">${l ? 'Сохранить' : 'Создать'}</button>
      <button class="btn ghost wide" id="f-cancel">Отмена</button></div>`;
    body.querySelectorAll('.swatch').forEach((sw) => {
      sw.onclick = () => {
        body.querySelectorAll('.swatch').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
        sw.classList.add('on'); sw.setAttribute('aria-pressed', 'true'); $('#af-ava').style.background = sw.dataset.c;
      };
    });
    $('#f-name').focus();
    const ok = async () => {
      const name = $('#f-name').value.trim();
      if (!name) { $('#f-name').focus(); return; }
      const c = ($('.swatch.on') || {}).dataset?.c || COLORS[0];
      let labels = (state.labels || []).slice();
      let map = { ...(state.chat_labels || {}) };
      if (l) labels = labels.map((x) => (x.id === l.id ? { ...x, name, color: c } : x));
      else {
        if (labels.length >= 30) { body.querySelector('.err').textContent = 'Меток не больше 30'; return; }
        const id = 'l' + Date.now().toString(36);
        labels.push({ id, name, color: c });
        if (a && a.key) map[a.key] = (map[a.key] || []).concat(id);
      }
      await saveLabels(labels, map);
      closeOverlay();
    };
    $('#f-ok').onclick = ok;
    $('#f-name').onkeydown = (e) => { if (e.key === 'Enter') ok(); };
  } else if (kind === 'add') {
    $('#ov-title').textContent = '';
    body.innerHTML = accountForm(null);
    wireColors(body);
    $('#f-name').focus();
    $('#f-ok').onclick = async () => {
      const v = formValues();
      $('#f-ok').disabled = true;
      try { await invoke('add_account', { name: v.name, color: v.color, proxy: v.proxy }); closeOverlay(false); }
      catch (e) { $('#f-ok').disabled = false; alertErr(e); }
    };
    submitOnEnter(body);
  } else if (kind === 'edit') {
    $('#ov-title').textContent = '';
    body.innerHTML = accountForm(a);
    wireColors(body);
    $('#f-ok').onclick = async () => {
      const v = formValues();
      try {
        const restart = await invoke('update_account', { id: a.id, ...v });
        if (restart) {
          $('.err').textContent = 'Новый прокси заработает после перезапуска Hovi Space: нажмите «Выйти» в меню значка в трее и откройте Hovi Space снова.';
          $('#f-ok').textContent = 'Готово';
          $('#f-ok').onclick = () => closeOverlay();
          return;
        }
        closeOverlay();
      } catch (e) { alertErr(e); }
    };
    submitOnEnter(body);
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
    $('#ov-title').textContent = '';
    // release notes that only repeat the name and the version say nothing
    const notes = u && u.notes && !/^\s*(gemspace|hovi space)\s+v?[\d.]+\s*$/i.test(u.notes) ? u.notes : '';
    body.innerHTML = u ? `<div class="acc-form">
      <div class="af-hero"><span class="af-ava set-ava">${icon(UPDATE_PATH)}</span>
        <h1>Версия ${esc(u.version)}</h1><p>Сейчас у вас ${esc(state.version || '')}. Hovi Space скачает обновление, проверит подпись, установит его и перезапустится. Аккаунты и входы сохранятся.</p></div>
      ${notes ? `<div class="af-card notes">${esc(notes)}</div>` : ''}
      <div class="progress" hidden><span></span></div>
      <div class="err"></div>
      <button class="btn primary big wide" id="f-ok">Обновить сейчас</button>
      <button class="btn ghost wide" id="f-cancel">Позже</button></div>`
      : `<div class="acc-form"><div class="af-hero"><span class="af-ava set-ava">${icon(UPDATE_PATH)}</span>
        <h1>Обновлений нет</h1><p>У вас последняя версия Hovi Space ${esc(state.version || '')}.</p></div>
        <button class="btn ghost wide" id="f-cancel">Закрыть</button></div>`;
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
      <div class="set-label">Резервная копия</div>
      <div class="af-card set-card">
        <div class="set-row"><span class="af-ic">${icon(SAVE_PATH)}</span><span class="af-txt"><b>Аккаунты, настройки, метки и шаблоны</b><small id="s-backup-res">Аккаунты с прокси и порядком, метки, статусы, заметки, напоминания и шаблоны. Входы в файл не попадают: на новом компьютере в аккаунты нужно войти заново</small></span></div>
        <div class="set-row set-btns"><button class="btn small" id="s-export">Сохранить в файл</button><button class="btn small" id="s-import">Восстановить из файла</button></div>
      </div>
      <div class="set-label">Вход не проходит?</div>
      <div class="af-card set-card">
        <div class="set-row"><span class="af-ic">${icon(REPORT_PATH)}</span><span class="af-txt"><b>Отчёт о входе</b><small id="s-report-res">Попробуйте войти в аккаунт, затем сохраните отчёт и пришлите файл. В нём только адреса запросов и ошибки страницы, без переписки</small></span>
          <button class="btn small" id="s-report">Сохранить</button></div>
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
        ...state.settings, // the broadcast settings live in the same struct: a missing field would reset them
        notifications: $('#s-notif').checked,
        notify_preview: $('#s-preview').checked,
        sleep_enabled: $('#s-sleep').checked,
        max_awake: Math.max(1, Math.min(60, parseInt($('#s-max').value, 10) || 8)),
        close_to_tray: $('#s-tray').checked,
        ui_scale: Number(($('#s-scale .on') || {}).dataset?.v) || 100,
      };
      try { await invoke('set_settings', { settings }); } catch (e) { alertErr(e); return; }
      state.settings = settings;
      closeOverlay();
    };
    $('#s-export').onclick = async () => {
      try {
        const path = await invoke('backup_export');
        if (path) $('#s-backup-res').textContent = 'Сохранено: ' + path;
      } catch (e) { $('#s-backup-res').textContent = 'Не удалось сохранить: ' + (typeof e === 'string' ? e : (e && e.message) || e); }
    };
    $('#s-import').onclick = async () => {
      try {
        const res = await invoke('backup_import');
        if (!res) return;
        apply(await invoke('get_state'));
        await openOverlay('settings');
        $('#s-backup-res').textContent = res;
      } catch (e) { $('#s-backup-res').textContent = 'Не удалось восстановить: ' + (typeof e === 'string' ? e : (e && e.message) || e); }
    };
    $('#s-report').onclick = async () => {
      try {
        const path = await invoke('login_report');
        if (path) $('#s-report-res').textContent = 'Сохранено: ' + path;
      } catch (e) { $('#s-report-res').textContent = 'Не удалось сохранить: ' + (typeof e === 'string' ? e : (e && e.message) || e); }
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
$('#feed').onclick = () => setPanel(!panelOpen);
$('#p-close').onclick = () => setPanel(false);
$('#p-q').oninput = (e) => { chatQuery = e.target.value; chatSeen.clear(); renderFeed(); };
$('#feed-clear').onclick = () => invoke('feed_clear', { account: feedFilter }).catch(alertErr);
$('#p-tabs').querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    if (feedTab === b.dataset.t) return;
    feedTab = b.dataset.t;
    try { localStorage.setItem('gs-feed-tab', feedTab); } catch (e) {}
    $('#p-tabs').querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
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
    $('#p-tabs').querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x.dataset.t === feedTab); x.setAttribute('aria-selected', String(x.dataset.t === feedTab)); });
    requestAnimationFrame(() => segPill($('#p-tabs')));
    chatSeen.clear(); feedSeen.clear();
    renderFeed();
  }
  renderFeedButton();
  await invoke('set_panel', { open });
  if (open && feedTab === 'all') $('#p-q').focus();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlayKind && overlayKind !== 'welcome') { closeOverlay(); return; }
  // F12 / Ctrl+Shift+I here too open the developer tools of the open account's page, not of this rail
  if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyI')) { e.preventDefault(); invoke('hotkey', { key: 'devtools' }); return; }
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
