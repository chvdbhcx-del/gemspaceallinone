// Hovi Space rail: what the user keeps about chats of "Все чаты" besides labels: a note, a status ("Открыт",
// "Ждёт клиента", "Готово" or their own) and a reminder, and the quick-reply templates (шаблоны). All of it
// stays on this computer (Rust saves it, crm.rs and lib.rs set_chat_meta / set_templates). A template is only
// put into the message field of a chat (lib.rs template_insert, shared/chats.js __gemspaceInsert), never sent.
// Uses app.js globals (state, invoke, openOverlay, renderFeed, icon, esc, Menu...).
'use strict';

const NOTE_PATH = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm2 16H8v-2h8zm0-4H8v-2h8zm-3-5V3.5L18.5 9z';
const BOLT_PATH = 'M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-7.5 14v-4.5H9l3.5-7V9H16z';
const FLAG_PATH = 'M14.4 6 14 4H5v17h2v-7h5.6l.4 2h7V6z';
const ALARM_PATH = 'M12 4a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 16a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm.5-11H11v5l4 2.4.8-1.2-3.3-2zM7.9 2.3 6.6.8 2 4.6l1.3 1.5zM22 4.6 17.4.8l-1.3 1.5 4.6 3.8z';

// ---------- notes, statuses, reminders ----------
const metaOf = () => ({ notes: state.notes || {}, statuses: state.statuses || [], chat_status: state.chat_status || {}, reminders: state.reminders || {} });
async function saveMeta(m) {
  Object.assign(state, m);
  renderFeed(); renderFeedButton();
  try { await invoke('set_chat_meta', { meta: m }); } catch (e) { alertErr(e); }
}
const noteOf = (key) => (state.notes || {})[key] || '';
const statusOf = (key) => { const id = (state.chat_status || {})[key]; return id ? (state.statuses || []).find((s) => s.id === id) || null : null; };
const remindOf = (key) => (state.reminders || {})[key] || 0;
const isDue = (key) => { const at = remindOf(key); return !!at && at <= Date.now(); };
const dueCount = () => Object.values(state.reminders || {}).filter((at) => at <= Date.now()).length;

function setNote(key, text) {
  const m = metaOf(); const notes = { ...m.notes };
  if (text.trim()) notes[key] = text.trim().slice(0, 1000); else delete notes[key];
  return saveMeta({ ...m, notes });
}
function setStatus(key, id) {
  const m = metaOf(); const cs = { ...m.chat_status };
  if (id) cs[key] = id; else delete cs[key];
  return saveMeta({ ...m, chat_status: cs });
}
function setReminder(key, at) {
  const m = metaOf(); const r = { ...m.reminders };
  if (at) r[key] = Math.round(at); else delete r[key];
  return saveMeta({ ...m, reminders: r });
}

// "сегодня в 18:00", "завтра в 9:00", "28 нояб. в 9:00"
function remindText(at) {
  const d = new Date(at);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86400000);
  const hm = d.toLocaleTimeString('ru-RU', { hour: 'numeric', minute: '2-digit' });
  if (diff === 0) return 'сегодня в ' + hm;
  if (diff === 1) return 'завтра в ' + hm;
  if (diff === -1) return 'вчера в ' + hm;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ' в ' + hm;
}
function at9(daysAhead) { const d = new Date(); d.setDate(d.getDate() + daysAhead); d.setHours(9, 0, 0, 0); return d.getTime(); }
function nextMonday9() { const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; return at9(add); }
const REMIND_QUICK = [
  ['Через 1 час', () => Date.now() + 3600e3],
  ['Через 3 часа', () => Date.now() + 3 * 3600e3],
  ['Завтра в 9:00', () => at9(1)],
  ['В понедельник в 9:00', nextMonday9],
];

// the status pill and the note / reminder marks of a row in "Все чаты"
function metaHtml(key) {
  const s = statusOf(key);
  return s ? `<span class="st" style="--c:${esc(s.color)}"><i></i>${esc(s.name)}</span>` : '';
}
function marksHtml(key) {
  const n = noteOf(key); const at = remindOf(key);
  return (n ? `<span class="mk" title="${esc(n)}">${icon(NOTE_PATH)}</span>` : '')
    + (at ? `<span class="mk bell${at <= Date.now() ? ' due' : ''}" title="Напоминание ${esc(remindText(at))}">${icon(BELL_PATH)}</span>` : '');
}
function metaTitle(key) {
  const n = noteOf(key); const at = remindOf(key); const s = statusOf(key);
  return (s ? `\nСтатус: ${s.name}` : '') + (at ? `\nНапоминание ${remindText(at)}` : '') + (n ? `\n\n${n}` : '');
}

// ---------- the chat's right-click menu ----------
async function chatMenu(account, name) {
  const key = account + '|' + name;
  const st = statusOf(key);
  const at = remindOf(key);
  const statusItems = (state.statuses || []).map((s) => ({ id: 's-' + s.id, text: s.name, checked: !!(st && st.id === s.id), action: () => setStatus(key, st && st.id === s.id ? null : s.id) }));
  if (statusItems.length) statusItems.push({ item: 'Separator' });
  statusItems.push({ id: 's-new', text: 'Новый статус…', action: () => openOverlay('status', { key }) });
  const remindItems = REMIND_QUICK.map(([t, f], i) => ({ id: 'r-' + i, text: t, action: () => setReminder(key, f()) }));
  remindItems.push({ id: 'r-pick', text: 'Выбрать время…', action: () => openOverlay('remind', { key, account, name }) });
  if (at) remindItems.push({ item: 'Separator' }, { id: 'r-off', text: 'Убрать напоминание', action: () => setReminder(key, null) });
  const tpl = (state.templates || []).slice(0, 30).map((t) => ({ id: 't-' + t.id, text: t.title, action: () => insertTemplate(t, account, name) }));
  if (tpl.length) tpl.push({ item: 'Separator' });
  tpl.push({ id: 't-edit', text: tpl.length ? 'Изменить шаблоны…' : 'Создать шаблон…', action: () => openOverlay('templates') });
  const has = labelIds(account, name);
  const labelItems = (state.labels || []).map((l) => ({ id: 'l-' + l.id, text: l.name, checked: has.includes(l.id), action: () => toggleLabel(key, l.id) }));
  if (labelItems.length) labelItems.push({ item: 'Separator' });
  labelItems.push({ id: 'new-label', text: 'Новая метка…', action: () => openOverlay('label', { key }) });
  const menu = await Menu.new({ items: [
    { id: 'tpl', text: 'Ответить шаблоном', items: tpl },
    { item: 'Separator' },
    { id: 'st', text: st ? `Статус: ${st.name}` : 'Статус', items: statusItems },
    { id: 'rm', text: at ? `Напомнить (${remindText(at)})` : 'Напомнить', items: remindItems },
    { id: 'note', text: noteOf(key) ? 'Изменить заметку…' : 'Заметка…', action: () => openOverlay('note', { key, account, name }) },
    { id: 'lb', text: has.length ? `Метки (${has.length})` : 'Метки', items: labelItems },
  ] });
  await menu.popup();
}

async function statusMenu(id) {
  const s = (state.statuses || []).find((x) => x.id === id);
  if (!s) return;
  const menu = await Menu.new({ items: [
    { id: 'edit', text: 'Изменить…', action: () => openOverlay('status', { mark: s }) },
    { id: 'delete', text: 'Удалить статус', action: () => { const m = metaOf(); saveMeta({ ...m, statuses: m.statuses.filter((x) => x.id !== id) }); } },
  ] });
  await menu.popup();
}

// ---------- templates ----------
async function insertTemplate(t, account, name) {
  try { await invoke('template_insert', { account, name, text: t.text }); }
  catch (e) { openOverlay('notice', { title: 'Шаблон не вставлен', text: (typeof e === 'string' ? e : (e && e.message) || String(e)) + '.' }); }
}

async function saveTemplates(list) {
  state.templates = list;
  try { await invoke('set_templates', { templates: list }); } catch (e) { alertErr(e); }
}

const TEMPLATE_EXAMPLES = [
  ['Приветствие', 'Здравствуйте, {имя}! Чем могу помочь?'],
  ['Счёт отправлен', '{имя}, счёт отправил. Проверьте, пожалуйста, и напишите, если будут вопросы.'],
  ['Спасибо за заказ', 'Спасибо за заказ, {имя}! Как только отправим, пришлю номер для отслеживания.'],
];
const newId = (p) => p + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);

// ---------- overlays: note, reminder, status, templates, one template, notice ----------
function crmOverlay(kind, body, a) {
  $('#ov-title').textContent = '';
  const acc = a && a.account ? state.accounts.find((x) => x.id === a.account) : null;
  const who = a && a.name ? `${esc(a.name)}${acc ? ' · ' + esc(acc.name) : ''}` : '';
  if (kind === 'note') {
    const cur = noteOf(a.key);
    body.innerHTML = `<div class="acc-form crm-form">
      <div class="af-hero"><span class="af-ava set-ava">${icon(NOTE_PATH)}</span><h1>Заметка</h1><p>${who}</p></div>
      <div class="af-card"><textarea id="f-note" maxlength="1000" rows="6" placeholder="Например: оптовик, скидка 10%, звонить после 15:00">${esc(cur)}</textarea>
        <div class="hint">Видна только вам, в «Все чатах». Ctrl+Enter сохраняет.</div></div>
      <div class="err"></div>
      <button class="btn primary big wide" id="f-ok">Сохранить</button>
      ${cur ? '<button class="btn ghost wide danger" id="f-del">Удалить заметку</button>' : ''}
      <button class="btn ghost wide" id="f-cancel">Отмена</button></div>`;
    const ta = $('#f-note'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    const ok = async () => { await setNote(a.key, ta.value); closeOverlay(); };
    $('#f-ok').onclick = ok;
    ta.onkeydown = (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); ok(); } };
    if ($('#f-del')) $('#f-del').onclick = async () => { await setNote(a.key, ''); closeOverlay(); };
  } else if (kind === 'remind') {
    const cur = remindOf(a.key);
    const start = new Date(cur || at9(1));
    const local = new Date(start.getTime() - start.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    body.innerHTML = `<div class="acc-form crm-form">
      <div class="af-hero"><span class="af-ava set-ava">${icon(ALARM_PATH)}</span><h1>Напоминание</h1><p>${who}</p></div>
      <div class="af-card"><div class="af-field"><span>Когда</span>
        <div class="chips crm-quick">${REMIND_QUICK.map(([t], i) => `<button type="button" class="chip" data-i="${i}">${t}</button>`).join('')}</div>
        <input type="datetime-local" id="f-at" value="${local}"></div>
        <div class="hint">В это время придёт уведомление Windows, а чат отметится колокольчиком. Hovi Space должен быть запущен, можно в трее.</div></div>
      <div class="err"></div>
      <button class="btn primary big wide" id="f-ok">Напомнить</button>
      ${cur ? '<button class="btn ghost wide danger" id="f-del">Убрать напоминание</button>' : ''}
      <button class="btn ghost wide" id="f-cancel">Отмена</button></div>`;
    body.querySelectorAll('.crm-quick .chip').forEach((c) => { c.onclick = async () => { await setReminder(a.key, REMIND_QUICK[c.dataset.i][1]()); closeOverlay(); }; });
    $('#f-ok').onclick = async () => {
      const t = new Date($('#f-at').value).getTime();
      if (!t) { alertErr('Выберите дату и время'); return; }
      if (t < Date.now() - 60000) { alertErr('Это время уже прошло'); return; }
      await setReminder(a.key, t); closeOverlay();
    };
    if ($('#f-del')) $('#f-del').onclick = async () => { await setReminder(a.key, null); closeOverlay(); };
  } else if (kind === 'status') {
    const s = a && a.mark;
    const color = s ? s.color : COLORS[(state.statuses || []).length % COLORS.length];
    body.innerHTML = `<div class="acc-form">
      <div class="af-hero"><span class="af-ava tag-ava" id="af-ava" style="background:${esc(color)}">${icon(FLAG_PATH)}</span>
        <h1>${s ? 'Статус' : 'Новый статус'}</h1><p>У чата один статус, например «В работе» или «Ждёт оплату». По статусам можно отфильтровать «Все чаты».</p></div>
      <div class="af-card">
        <label class="af-field"><span>Название</span><input type="text" id="f-name" maxlength="30" value="${esc(s ? s.name : '')}" placeholder="Например, В работе"></label>
        <div class="af-field"><span>Цвет</span>${colorPicker(color)}</div>
      </div>
      <div class="err"></div>
      <button class="btn primary big wide" id="f-ok">${s ? 'Сохранить' : 'Создать'}</button>
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
      const m = metaOf();
      let statuses = m.statuses.slice();
      const cs = { ...m.chat_status };
      if (s) statuses = statuses.map((x) => (x.id === s.id ? { ...x, name, color: c } : x));
      else {
        if (statuses.length >= 12) { alertErr('Статусов не больше 12'); return; }
        const id = newId('s');
        statuses.push({ id, name, color: c });
        if (a && a.key) cs[a.key] = id;
      }
      await saveMeta({ ...m, statuses, chat_status: cs });
      closeOverlay();
    };
    $('#f-ok').onclick = ok;
    $('#f-name').onkeydown = (e) => { if (e.key === 'Enter') ok(); };
  } else if (kind === 'templates') {
    const list = state.templates || [];
    body.innerHTML = `<div class="acc-form crm-form">
      <div class="af-hero"><span class="af-ava set-ava">${icon(BOLT_PATH)}</span><h1>Шаблоны</h1>
        <p>Готовые ответы для всех аккаунтов. Шаблон вставляется в поле сообщения открытого чата, а отправляете вы сами.</p></div>
      ${list.length ? `<div class="af-card tpl-list">${list.map((t, i) => `<div class="tpl-row" data-id="${esc(t.id)}">
          <button type="button" class="tpl-main" data-id="${esc(t.id)}"><b>${esc(t.title)}</b><small>${esc(t.text)}</small></button>
          <span class="tpl-ord"><button type="button" class="x" data-up="${i}" title="Выше" aria-label="Выше"${i ? '' : ' disabled'}>↑</button><button type="button" class="x" data-down="${i}" title="Ниже" aria-label="Ниже"${i < list.length - 1 ? '' : ' disabled'}>↓</button></span></div>`).join('')}</div>`
        : `<div class="af-card tpl-empty"><b>Шаблонов пока нет</b><span>Начните с примеров и поправьте их под себя, или создайте свой.</span>
          <button class="btn small" id="f-examples">Добавить примеры</button></div>`}
      <div class="af-card hint-card"><b>Как вставить</b><span>Кнопка с молнией в панели слева вставляет шаблон в открытый чат. В «Все чатах» правый клик по чату, «Ответить шаблоном», откроет этот чат и вставит текст. {имя} заменится на имя из чата.</span></div>
      <div class="err"></div>
      <button class="btn primary big wide" id="f-new">Новый шаблон</button>
      <button class="btn ghost wide" id="f-cancel">Готово</button></div>`;
    body.querySelectorAll('.tpl-main').forEach((b) => { b.onclick = () => openOverlay('template', { tpl: list.find((t) => t.id === b.dataset.id) }); });
    const move = async (i, d) => { const l = list.slice(); const [t] = l.splice(i, 1); l.splice(i + d, 0, t); await saveTemplates(l); openOverlay('templates'); };
    body.querySelectorAll('[data-up]').forEach((b) => { b.onclick = () => move(+b.dataset.up, -1); });
    body.querySelectorAll('[data-down]').forEach((b) => { b.onclick = () => move(+b.dataset.down, 1); });
    $('#f-new').onclick = () => openOverlay('template', {});
    if ($('#f-examples')) $('#f-examples').onclick = async () => { await saveTemplates(TEMPLATE_EXAMPLES.map(([title, text], i) => ({ id: newId('t') + i, title, text }))); openOverlay('templates'); };
  } else if (kind === 'template') {
    const t = a && a.tpl;
    body.innerHTML = `<div class="acc-form crm-form">
      <div class="af-hero"><span class="af-ava set-ava">${icon(BOLT_PATH)}</span><h1>${t ? 'Шаблон' : 'Новый шаблон'}</h1><p>Название видно в меню, текст вставляется в чат.</p></div>
      <div class="af-card">
        <label class="af-field"><span>Название</span><input type="text" id="f-name" maxlength="40" value="${esc(t ? t.title : '')}" placeholder="Например, Приветствие"></label>
        <label class="af-field"><span>Текст</span><textarea id="f-text" maxlength="4000" rows="6" placeholder="Здравствуйте, {имя}! …">${esc(t ? t.text : '')}</textarea></label>
        <div class="hint">{имя} заменится на имя из чата, например «Ирина».</div>
      </div>
      <div class="err"></div>
      <button class="btn primary big wide" id="f-ok">${t ? 'Сохранить' : 'Создать'}</button>
      ${t ? '<button class="btn ghost wide danger" id="f-del">Удалить шаблон</button>' : ''}
      <button class="btn ghost wide" id="f-cancel">Отмена</button></div>`;
    (t ? $('#f-text') : $('#f-name')).focus();
    $('#f-ok').onclick = async () => {
      const text = $('#f-text').value.trim();
      if (!text) { alertErr('Напишите текст шаблона'); $('#f-text').focus(); return; }
      const list = (state.templates || []).slice();
      if (!t && list.length >= 60) { alertErr('Шаблонов не больше 60'); return; }
      const title = $('#f-name').value.trim() || text.split(/\s+/).join(' ').slice(0, 40);
      if (t) list.splice(list.findIndex((x) => x.id === t.id), 1, { ...t, title, text });
      else list.push({ id: newId('t'), title, text });
      await saveTemplates(list);
      openOverlay('templates');
    };
    if ($('#f-del')) $('#f-del').onclick = async () => { await saveTemplates((state.templates || []).filter((x) => x.id !== t.id)); openOverlay('templates'); };
    $('#f-cancel').onclick = () => openOverlay('templates');
    return;
  } else if (kind === 'notice') {
    body.innerHTML = `<div class="acc-form"><div class="af-hero"><span class="af-ava set-ava">${icon(BOLT_PATH)}</span><h1>${esc(a.title)}</h1><p>${esc(a.text)}</p></div>
      <button class="btn primary big wide" id="f-cancel">Понятно</button></div>`;
  }
  const cancel = $('#f-cancel');
  if (cancel) cancel.onclick = () => closeOverlay();
}

// a reminder comes due while the list is open: its bell turns red without waiting for the next state push
setInterval(() => { if (Object.keys(state.reminders || {}).length) { renderFeedButton(); if (panelOpen) renderFeed(); } }, 20000);
