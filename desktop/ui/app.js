// Gemspace rail: account tiles, account editor and settings. Talks to the Rust side through Tauri commands.
'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { Menu } = window.__TAURI__.menu;

const COLORS = ['#3aa0ff', '#26a69a', '#7e57c2', '#ef5350', '#ffa726', '#66bb6a', '#ec407a', '#8d6e63'];
let state = { accounts: [], active: null, settings: {}, total_unread: 0 };
let overlayKind = null; // null | 'add' | 'edit' | 'settings' | 'welcome'

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function renderRail() {
  const tiles = $('#tiles');
  tiles.innerHTML = '';
  state.accounts.forEach((a, i) => {
    const b = document.createElement('button');
    b.className = 'tile' + (a.id === state.active ? ' active' : '') + (a.awake ? '' : ' sleeping');
    const hk = i < 9 ? `  (Ctrl+${i + 1})` : '';
    b.title = a.name + hk + (a.awake ? '' : '\nспит, откроется по клику') + (a.proxy ? `\nпрокси: ${a.proxy}` : '');
    let marks = '';
    if (a.unread > 0) marks += `<span class="badge">${a.unread > 99 ? '99+' : a.unread}</span>`;
    else if (a.attention) marks += '<span class="dot"></span>';
    if (!a.awake) marks += '<span class="moon">☾</span>';
    if (a.pinned) marks += '<span class="pin">📌</span>';
    b.innerHTML = `<span class="ava" style="background:${esc(a.color || COLORS[0])}">${esc(initials(a.name))}</span>` +
      `<span class="lbl">${esc(a.name)}</span>${marks}`;
    b.onclick = () => invoke('switch_account', { id: a.id }).catch(alertErr);
    b.oncontextmenu = (e) => { e.preventDefault(); accountMenu(a, i); };
    tiles.appendChild(b);
  });
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
  if (overlayKind) { const el = $('.err'); if (el) { el.textContent = msg; return; } }
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
  const body = $('#ov-body');
  $('#ov-close').hidden = kind === 'welcome';
  if (kind === 'welcome') {
    $('#ov-title').textContent = '';
    body.innerHTML = `<div class="empty"><h1>Gemspace</h1>
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
      <div class="card"><p>Ctrl+1…9: аккаунт по номеру. Ctrl+Tab и Ctrl+Shift+Tab: следующий и предыдущий. Ctrl+колесо: масштаб.<br>
        Правый клик по аккаунту: изменить, усыпить, порядок, удалить.</p></div>
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
  $('#overlay').hidden = true;
  if (restore) await invoke('set_overlay', { open: false });
}

$('#ov-close').onclick = () => closeOverlay();
$('#add').onclick = () => openOverlay('add');
$('#gear').onclick = () => openOverlay('settings');

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && overlayKind && overlayKind !== 'welcome') { closeOverlay(); return; }
  if (!e.ctrlKey || e.altKey) return;
  let key = null;
  if (!e.shiftKey && e.key >= '1' && e.key <= '9') key = e.key;
  else if (e.key === 'Tab') key = e.shiftKey ? 'prev' : 'next';
  if (key && !overlayKind) { e.preventDefault(); invoke('hotkey', { key }); }
});
window.addEventListener('contextmenu', (e) => { if (!e.target.closest('input')) e.preventDefault(); });

function apply(s) {
  state = s;
  renderRail();
  if (!state.accounts.length && overlayKind !== 'add' && overlayKind !== 'welcome') openOverlay('welcome');
}

listen('state', (e) => apply(e.payload));
invoke('get_state').then(apply);
