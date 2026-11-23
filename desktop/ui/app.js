// Gemspace rail: account tiles, account editor and settings. Talks to the Rust side through Tauri commands.
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
  renderFeedButton();
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
function renderFeed() {
  const box = $('#feed-list');
  if (!box) return;
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

function wireColors(root) {
  root.querySelectorAll('.swatch').forEach((s) => {
    s.onclick = () => { root.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on')); s.classList.add('on'); };
  });
}

function accountForm(a) {
  return `
    <label class="field"><span>Название</span>
      <input type="text" id="f-name" maxlength="40" value="${esc(a ? a.name : '')}" placeholder="Например, Продажи или +7 900…"></label>
    <div class="field"><span>Цвет</span>${colorPicker(a ? a.color : COLORS[state.accounts.length % COLORS.length])}</div>
    <label class="field"><span>Прокси (необязательно)</span>
      <input type="text" id="f-proxy" value="${esc(a && a.proxy ? a.proxy : '')}" placeholder="socks5://1.2.3.4:1080 или http://1.2.3.4:8080">
      <div class="hint">С прокси аккаунт выходит в сеть только через него. Прокси с логином и паролем не поддерживаются.</div></label>
    ${a ? `<label class="check"><input type="checkbox" id="f-pin" ${a.pinned ? 'checked' : ''}><span>Не усыплять этот аккаунт</span></label>` : ''}
    <div class="err"></div>`;
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
  const body = $('#ov-body');
  $('#ov-close').hidden = kind === 'welcome';
  if (kind === 'welcome') {
    $('#ov-title').textContent = '';
    body.innerHTML = `<div class="empty"><img src="logo.png" alt=""><h1>Gemspace</h1>
      <p>Все аккаунты Gem Space в одном окне. Каждый аккаунт живёт отдельно: свои данные, свой вход, свой прокси.</p>
      <button class="btn primary" id="w-add">Добавить первый аккаунт</button></div>`;
    $('#w-add').onclick = () => openOverlay('add');
  } else if (kind === 'add') {
    $('#ov-title').textContent = 'Новый аккаунт';
    body.innerHTML = accountForm(null) +
      `<div class="row"><button class="btn primary" id="f-ok">Добавить и войти</button><button class="btn" id="f-cancel">Отмена</button></div>
       <p class="hint">Откроется веб-версия Gem Space, войдите в ней по номеру телефона как обычно.</p>`;
    wireColors(body);
    $('#f-name').focus();
    $('#f-ok').onclick = async () => {
      const v = formValues();
      try { await invoke('add_account', { name: v.name, color: v.color, proxy: v.proxy }); closeOverlay(false); }
      catch (e) { alertErr(e); }
    };
  } else if (kind === 'edit') {
    $('#ov-title').textContent = 'Аккаунт';
    body.innerHTML = accountForm(a) +
      `<div class="row"><button class="btn primary" id="f-ok">Сохранить</button><button class="btn" id="f-cancel">Отмена</button></div>`;
    wireColors(body);
    $('#f-ok').onclick = async () => {
      const v = formValues();
      try {
        const restart = await invoke('update_account', { id: a.id, ...v });
        if (restart) {
          $('.err').textContent = 'Новый прокси заработает после перезапуска Gemspace (Выйти в трее и открыть снова).';
          $('#f-ok').textContent = 'Готово';
          $('#f-ok').onclick = () => closeOverlay();
          return;
        }
        closeOverlay();
      } catch (e) { alertErr(e); }
    };
  } else if (kind === 'remove') {
    $('#ov-title').textContent = 'Удалить аккаунт?';
    body.innerHTML = `<p>«${esc(a.name)}» исчезнет из Gemspace, а его данные на этом компьютере будут стёрты.
      Сам аккаунт Gem Space останется, войти в него можно снова.</p>
      <div class="row"><button class="btn danger" id="f-ok">Удалить</button><button class="btn" id="f-cancel">Отмена</button></div><div class="err"></div>`;
    $('#f-ok').onclick = async () => {
      try { await invoke('remove_account', { id: a.id }); closeOverlay(); } catch (e) { alertErr(e); }
    };
  } else if (kind === 'feed') {
    $('#ov-title').textContent = 'Лента';
    body.innerHTML = `<p class="hint lead">Новые сообщения всех аккаунтов. Клик откроет чат в его аккаунте, ответить можно там.</p>
      <div class="feed-bar"><div id="feed-chips" class="chips"></div><button class="btn small" id="feed-clear">Очистить</button></div>
      <div id="feed-list"></div>
      <p class="hint">Лента собирается из уведомлений аккаунтов, пока Gemspace запущен. Спящие аккаунты сюда не пишут, важные отметьте «Не усыплять».
        Сообщения аккаунта уходят из ленты, когда в нём всё прочитано.</p>`;
    feedSeen.clear();
    (state.feed || []).forEach((i) => feedSeen.add(i.key));
    $('#feed-clear').onclick = () => invoke('feed_clear', { account: feedFilter });
    renderFeed();
    renderFeedButton();
  } else if (kind === 'settings') {
    const s = state.settings;
    $('#ov-title').textContent = 'Настройки';
    body.innerHTML = `
      <h2>Уведомления</h2>
      <div class="card">
        <label class="check"><input type="checkbox" id="s-notif" ${s.notifications ? 'checked' : ''}><span>Показывать уведомления о новых сообщениях</span></label>
        <label class="check"><input type="checkbox" id="s-preview" ${s.notify_preview ? 'checked' : ''}><span>Показывать текст сообщения в уведомлении</span></label>
      </div>
      <h2>Спящий режим</h2>
      <div class="card">
        <label class="check"><input type="checkbox" id="s-sleep" ${s.sleep_enabled ? 'checked' : ''}><span>Усыплять аккаунты, которыми давно не пользовались. Спящий аккаунт не занимает память, но и уведомлений не присылает, пока его не открыть.</span></label>
        <label class="field"><span>Сколько аккаунтов держать загруженными</span><input type="number" id="s-max" min="1" max="60" value="${s.max_awake}"></label>
        <div class="hint">Открытый аккаунт и отмеченные «Не усыплять» не засыпают никогда и в это число не входят.</div>
      </div>
      <h2>Окно</h2>
      <div class="card">
        <label class="check"><input type="checkbox" id="s-tray" ${s.close_to_tray ? 'checked' : ''}><span>Крестик сворачивает в трей, уведомления продолжают приходить</span></label>
      </div>
      <h2>Клавиши</h2>
      <div class="card"><p><kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> аккаунт по номеру, <kbd>Ctrl</kbd>+<kbd>Tab</kbd> и <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> следующий и предыдущий, <kbd>Ctrl</kbd>+колесо масштаб.</p>
        <p>Правый клик по аккаунту: изменить, перезагрузить, усыпить, порядок, удалить.</p></div>
      <p class="hint">Gemspace ${esc(state.version || '')}. Внутри открывается обычная веб-версия Gem Space (web.gemspace.com), Gemspace её не изменяет.</p>
      <div class="row"><button class="btn primary" id="f-ok">Сохранить</button><button class="btn" id="f-cancel">Отмена</button></div>`;
    $('#f-ok').onclick = async () => {
      const settings = {
        notifications: $('#s-notif').checked,
        notify_preview: $('#s-preview').checked,
        sleep_enabled: $('#s-sleep').checked,
        max_awake: Math.max(1, Math.min(60, parseInt($('#s-max').value, 10) || 8)),
        close_to_tray: $('#s-tray').checked,
      };
      await invoke('set_settings', { settings });
      closeOverlay();
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
invoke('get_state').then(apply);
