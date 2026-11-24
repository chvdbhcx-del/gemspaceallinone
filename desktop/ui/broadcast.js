// Hovi Space rail: broadcasts (рассылка). The user writes a text, picks chats of "Все чаты" (by label or one by
// one) and starts it; Hovi Space then sends the text to those chats one by one, with a random pause between
// two messages and a daily limit per account (Rust checks both the chat and the limit again, lib.rs
// broadcast_send). Only chats the accounts already have; nothing is sent to new contacts. The user can stop
// it at any moment. Uses app.js globals (state, invoke, openOverlay, setPanel...).
'use strict';

const MEGA_PATH = 'M3 10v4a1 1 0 0 0 1 1h2l4 5h2V4h-2L6 9H4a1 1 0 0 0-1 1zm13.5 2A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z';
const WARN_PATH = 'M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z';

let bcDraft = { text: '', picked: new Set(), q: '' }; // what the form shows, kept while the rail lives
let bc = null; // the running or finished broadcast: { items, i, stop, done, nextAt, reason, open }

const bcKey = (account, name) => account + '|' + name;
const bcSplit = (key) => { const i = key.indexOf('|'); return { account: key.slice(0, i), name: key.slice(i + 1) }; };
const bcRunning = () => !!(bc && !bc.done);

// every chat the account pages list now, newest first (the same rows as "Все чаты")
function bcChats() {
  const rows = [];
  state.accounts.forEach((a) => ((state.chats || {})[a.id] || []).forEach((c, i) => rows.push({ account: a.id, name: c.name, i, at: chatTime(c.time) })));
  rows.sort((x, y) => (y.at - x.at) || (x.account === y.account ? x.i - y.i : 0));
  return rows;
}

// "{имя}" becomes the chat's first word ("Ирина Морозова" -> "Ирина")
function bcPersonal(text, name) {
  const first = String(name).replace(/[«»"“”]/g, '').trim().split(/\s+/)[0] || '';
  return text.replace(/\{имя\}/gi, first);
}

function bcForm(body) {
  const s = state.settings;
  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  const chats = bcChats();
  const known = new Set(chats.map((c) => bcKey(c.account, c.name)));
  bcDraft.picked = new Set([...bcDraft.picked].filter((k) => known.has(k)));
  $('#ov-title').textContent = '';
  const today = state.sent_today || {};
  const used = state.accounts.filter((a) => today[a.id]).map((a) => `${esc(a.name)} ${today[a.id]} из ${s.bc_limit}`).join(', ');
  body.innerHTML = `<div class="acc-form bc-form">
    <div class="af-hero"><span class="af-ava set-ava">${icon(MEGA_PATH)}</span><h1>Рассылка</h1>
      <p>Текст уйдёт в выбранные чаты по очереди, с паузой между сообщениями. Только в чаты, которые уже есть в ваших аккаунтах.</p></div>
    <div class="af-card">
      <label class="af-field"><span>Текст</span><textarea id="bc-text" maxlength="4000" rows="5" placeholder="Здравствуйте, {имя}! …">${esc(bcDraft.text)}</textarea></label>
      <div class="hint">{имя} заменится на имя из чата, например «Ирина». Можно вставить текст, скопированный из другого чата.</div>
    </div>
    <div class="af-card">
      <div class="af-field"><span>Кому <b id="bc-n" class="bc-n"></b></span>
        <div class="chips bc-chips">
          ${(state.labels || []).map((l) => `<button type="button" class="chip" data-l="${esc(l.id)}"><i class="sq" style="background:${esc(l.color)}"></i>${esc(l.name)}</button>`).join('')}
          <button type="button" class="chip" data-k="all">Все чаты</button>
          <button type="button" class="chip" data-k="none">Снять все</button>
        </div>
        <input type="text" id="bc-q" placeholder="Найти чат" value="${esc(bcDraft.q)}" autocomplete="off">
        <div class="bc-list" id="bc-list"></div>
      </div>
    </div>
    <div class="af-card set-card">
      <div class="set-row"><span class="af-ic">${icon(MOON_PATH)}</span><span class="af-txt"><b>Пауза между сообщениями</b><small>Случайная, в секундах. Не меньше 10</small></span>
        <span class="bc-range"><input type="number" id="bc-min" min="10" max="600" value="${s.bc_pause_min}"><i>–</i><input type="number" id="bc-max" min="10" max="900" value="${s.bc_pause_max}"></span></div>
      <div class="set-row"><span class="af-ic">${icon(LAYERS_PATH)}</span><span class="af-txt"><b>Не больше в день</b><small>С одного аккаунта${used ? `. Сегодня: ${used}` : ''}</small></span>
        <span class="bc-range"><input type="number" id="bc-limit" min="1" max="300" value="${s.bc_limit}"></span></div>
    </div>
    <div class="err"></div>
    <button class="btn primary big wide" id="f-ok">Начать рассылку</button>
    <button class="btn ghost wide" id="f-cancel">Отмена</button>
  </div>`;

  const list = $('#bc-list');
  const draw = () => {
    const q = bcDraft.q.trim().toLowerCase();
    const shown = chats.filter((c) => !q || c.name.toLowerCase().includes(q));
    list.innerHTML = shown.length ? shown.map((c) => {
      const a = accounts.get(c.account);
      const k = bcKey(c.account, c.name);
      return `<label class="bc-row"><input type="checkbox" data-k="${esc(k)}" ${bcDraft.picked.has(k) ? 'checked' : ''}>
        <span class="bc-dot" style="background:${esc(a.color)}"></span><span class="bc-name">${esc(c.name)}</span>${tagsHtml(c.account, c.name)}<span class="bc-acc">${esc(a.name)}</span></label>`;
    }).join('') : `<div class="hint bc-empty">${chats.length ? 'Ничего не найдено' : 'Список чатов ещё не загрузился. Откройте аккаунты и подождите немного.'}</div>`;
    list.querySelectorAll('input').forEach((cb) => { cb.onchange = () => { cb.checked ? bcDraft.picked.add(cb.dataset.k) : bcDraft.picked.delete(cb.dataset.k); count(); }; });
    count();
  };
  const count = () => {
    const n = bcDraft.picked.size;
    $('#bc-n').textContent = n ? `· выбрано ${n}` : '';
    $('#f-ok').textContent = n ? `Начать рассылку (${n})` : 'Начать рассылку';
  };
  body.querySelectorAll('.bc-chips .chip').forEach((c) => {
    c.onclick = () => {
      if (c.dataset.k === 'none') bcDraft.picked.clear();
      else if (c.dataset.k === 'all') chats.forEach((x) => bcDraft.picked.add(bcKey(x.account, x.name)));
      else chats.filter((x) => labelIds(x.account, x.name).includes(c.dataset.l)).forEach((x) => bcDraft.picked.add(bcKey(x.account, x.name)));
      draw();
    };
  });
  $('#bc-q').oninput = (e) => { bcDraft.q = e.target.value; draw(); };
  $('#bc-text').oninput = (e) => { bcDraft.text = e.target.value; };
  draw();

  $('#f-ok').onclick = async () => {
    const text = $('#bc-text').value.trim();
    const err = (m) => { const el = body.querySelector('.err'); el.textContent = m; el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); };
    if (!text) { err('Напишите текст'); $('#bc-text').focus(); return; }
    if (!bcDraft.picked.size) { err('Выберите хотя бы один чат'); return; }
    if (bcRunning()) { err('Предыдущая рассылка ещё идёт'); return; }
    let min = parseInt($('#bc-min').value, 10) || 25;
    let max = parseInt($('#bc-max').value, 10) || 70;
    min = Math.min(Math.max(min, 10), 600); max = Math.min(Math.max(max, min), 900);
    const limit = Math.min(Math.max(parseInt($('#bc-limit').value, 10) || 50, 1), 300);
    const settings = { ...state.settings, bc_pause_min: min, bc_pause_max: max, bc_limit: limit };
    const start = async () => {
      settings.bc_warned = true;
      state.settings = settings;
      try { await invoke('set_settings', { settings }); } catch (e) { err(String(e)); return; }
      const order = bcChats().map((c) => bcKey(c.account, c.name)).filter((k) => bcDraft.picked.has(k));
      bc = { items: order.map((k) => ({ ...bcSplit(k), status: 'wait', error: '' })), text, i: 0, stop: false, done: false, open: true };
      bcDraft = { text: '', picked: new Set(), q: '' };
      await closeOverlay();
      if (!panelOpen) await setPanel(true);
      renderBc();
      runBroadcast();
    };
    if (state.settings.bc_warned) start();
    else bcWarn(body, start);
  };
}

// shown once, before the first broadcast
function bcWarn(body, start) {
  body.innerHTML = `<div class="acc-form bc-form">
    <div class="af-hero"><span class="af-ava bc-warn-ava">${icon(WARN_PATH)}</span><h1>Риск блокировки</h1>
      <p>Правила Gem Space запрещают автоматические и массовые рассылки. Если Gem Space сочтёт рассылку спамом, он может заблокировать аккаунт без предупреждения.</p></div>
    <div class="af-card bc-tips">
      <b>Чтобы снизить риск:</b>
      <ul><li>пишите тем, кто ждёт сообщения от вас, а не всем подряд;</li>
      <li>не ставьте паузу меньше 20–30 секунд и большой дневной лимит;</li>
      <li>меняйте текст, {имя} делает сообщения разными;</li>
      <li>сначала попробуйте на одном-двух своих чатах.</li></ul>
    </div>
    <label class="af-card af-toggle"><span class="af-txt"><b>Понимаю риск</b><small>Ответственность за рассылку на мне. Hovi Space только вставляет текст и нажимает «Отправить»</small></span>
      <input type="checkbox" id="bc-ok"><span class="switch"></span></label>
    <div class="err"></div>
    <button class="btn primary big wide" id="f-ok" disabled>Продолжить</button>
    <button class="btn ghost wide" id="f-cancel">Отмена</button>
  </div>`;
  $('#bc-ok').onchange = (e) => { $('#f-ok').disabled = !e.target.checked; };
  $('#f-ok').onclick = start;
  $('#f-cancel').onclick = () => closeOverlay();
}

const bcSleep = (ms) => new Promise((resolve) => {
  const end = Date.now() + ms;
  (function tick() { if (bc.stop || Date.now() >= end) return resolve(); setTimeout(tick, 250); })();
});

async function runBroadcast() {
  const run = bc;
  let fails = 0;
  for (; run.i < run.items.length && !run.stop; run.i++) {
    const it = run.items[run.i];
    // the rail's own windows (settings, account editor) cover the pages: wait until they are closed
    while (overlayKind && !run.stop) await bcSleep(500);
    if (run.stop) break;
    if (((state.sent_today || {})[it.account] || 0) >= state.settings.bc_limit) { it.status = 'skip'; it.error = 'Дневной лимит аккаунта'; renderBc(); continue; }
    it.status = 'sending'; renderBc();
    try {
      await invoke('broadcast_send', { account: it.account, name: it.name, text: bcPersonal(run.text, it.name) });
      it.status = 'ok'; fails = 0;
    } catch (e) {
      it.status = 'err'; it.error = typeof e === 'string' ? e : (e && e.message) || String(e);
      if (++fails >= 3) { run.stop = true; run.reason = 'Три ошибки подряд, рассылка остановлена. Похоже, Gem Space поменял страницу или аккаунт недоступен.'; }
    }
    renderBc();
    if (run.stop || run.i === run.items.length - 1) break;
    const min = state.settings.bc_pause_min, max = state.settings.bc_pause_max;
    const ms = it.status === 'ok' ? (min + Math.random() * (max - min)) * 1000 : 3000;
    run.nextAt = Date.now() + ms;
    await bcSleep(ms);
    run.nextAt = 0;
  }
  run.items.forEach((x) => { if (x.status === 'wait' || x.status === 'sending') { x.status = 'skip'; x.error = x.error || 'Остановлено'; } });
  run.done = true;
  renderBc();
}

let bcTimer = null;
function renderBc() {
  const box = $('#bc-bar');
  if (!bc) { box.hidden = true; return; }
  box.hidden = false;
  const ok = bc.items.filter((x) => x.status === 'ok').length;
  const bad = bc.items.filter((x) => x.status === 'err').length;
  const skip = bc.items.filter((x) => x.status === 'skip').length;
  const total = bc.items.length;
  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  const left = bc.nextAt ? Math.max(0, Math.ceil((bc.nextAt - Date.now()) / 1000)) : 0;
  const line = bc.done
    ? `Готово: отправлено ${ok} из ${total}${bad ? `, ошибок ${bad}` : ''}${skip ? `, пропущено ${skip}` : ''}`
    : `Отправлено ${ok} из ${total}${bad ? `, ошибок ${bad}` : ''}${left ? ` · следующее через ${left} с` : ' · отправляется…'}`;
  const icon_ = { ok: '✓', err: '!', skip: '–', sending: '…', wait: '' };
  box.innerHTML = `<div class="bc-head"><span class="bc-ic">${icon(MEGA_PATH)}</span><span class="bc-txt"><b>Рассылка</b><small>${esc(line)}</small></span>
      ${bc.done ? '<button class="btn small" id="bc-close">Закрыть</button>' : '<button class="btn small danger" id="bc-stop">Стоп</button>'}</div>
    <div class="bc-prog"><span style="width:${Math.round(((ok + bad + skip) / total) * 100)}%"></span></div>
    ${bc.reason ? `<div class="bc-reason">${esc(bc.reason)}</div>` : ''}
    <button class="bc-more${bc.open ? ' open' : ''}" id="bc-more">${bc.open ? 'Скрыть список' : 'Показать список'}</button>
    ${bc.open ? `<div class="bc-items">${bc.items.map((x) => {
      const a = accounts.get(x.account);
      return `<div class="bc-item ${x.status}" title="${esc(x.error)}"><i class="bc-st">${icon_[x.status]}</i><span class="bc-dot" style="background:${esc(a ? a.color : '#888')}"></span><span class="bc-name">${esc(x.name)}</span>${x.error ? `<small>${esc(x.error)}</small>` : ''}</div>`;
    }).join('')}</div>` : ''}`;
  const stop = $('#bc-stop');
  if (stop) stop.onclick = () => { bc.stop = true; bc.reason = 'Остановлено вами'; renderBc(); };
  const close = $('#bc-close');
  if (close) close.onclick = () => { bc = null; renderBc(); };
  $('#bc-more').onclick = () => { bc.open = !bc.open; renderBc(); };
  clearTimeout(bcTimer);
  if (bc && !bc.done && bc.nextAt) bcTimer = setTimeout(renderBc, 1000);
}

$('#p-bc').onclick = () => openOverlay('broadcast');
