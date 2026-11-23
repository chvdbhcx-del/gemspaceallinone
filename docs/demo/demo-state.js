// Demo mode for screenshots: a fake window.__TAURI__ with made-up accounts, so the real rail UI
// (desktop/ui) renders without the app. Nothing here talks to Gem Space.
(function () {
  var state = {
    accounts: [
      { id: 'a1', name: 'Продажи', color: '#3aa0ff', proxy: null, pinned: true, unread: 4, attention: false, awake: true },
      { id: 'a2', name: 'Поддержка', color: '#26a69a', proxy: 'socks5://10.0.0.5:1080', pinned: false, unread: 12, attention: false, awake: true },
      { id: 'a3', name: 'Опт', color: '#7e57c2', proxy: null, pinned: false, unread: 0, attention: true, awake: true },
      { id: 'a4', name: 'Магазин', color: '#ffa726', proxy: null, pinned: false, unread: 2, attention: false, awake: true },
      { id: 'a5', name: 'Доставка', color: '#ef5350', proxy: null, pinned: false, unread: 0, attention: false, awake: false },
      { id: 'a6', name: 'Анна К.', color: '#ec407a', proxy: null, pinned: false, unread: 0, attention: false, awake: false },
      { id: 'a7', name: 'Склад', color: '#66bb6a', proxy: null, pinned: false, unread: 1, attention: false, awake: true },
    ],
    active: 'a1',
    settings: { sleep_enabled: true, max_awake: 8, notifications: true, notify_preview: true, close_to_tray: true, ui_scale: 100 },
    total_unread: 19,
    feed: (function () {
      var t = Date.now();
      var m = function (min) { return t - min * 60000; };
      return [
        { key: 9, account: 'a2', title: 'Денис Карпов', body: 'Добрый вечер! Когда будет возврат по заказу 2231?', time: m(0) },
        { key: 8, account: 'a1', title: 'Ирина Морозова', body: 'Счёт получила, оплачу сегодня 👍', time: m(1) },
        { key: 7, account: 'a3', title: 'Опт: заявки', body: 'Марк: Нужно 40 коробок к пятнице, успеете?', time: m(2) },
        { key: 6, account: 'a2', title: 'Светлана', body: 'Не приходит код подтверждения, что делать?', time: m(6) },
        { key: 5, account: 'a4', title: 'Ольга', body: 'Спасибо, всё пришло! Оставлю отзыв', time: m(9) },
        { key: 4, account: 'a7', title: 'Склад, смена 2', body: 'Паллеты на утро собраны, ждём машину', time: m(14) },
        { key: 3, account: 'a1', title: 'Кафе «Терраса»', body: 'Можно перенести доставку на среду?', time: m(23) },
        { key: 2, account: 'a2', title: 'Павел', body: 'Фото брака прикрепил, посмотрите', time: m(31) },
      ];
    })(),
    // what each account's page shows in its chat list ("Все чаты")
    chats: {
      a1: [
        { name: 'Ирина Морозова', time: '12:41', preview: 'Счёт получила, оплачу сегодня 👍', unread: 2, avatar: '' },
        { name: 'Кафе «Терраса»', time: '12:18', preview: 'Можно перенести доставку на среду?', unread: 1, avatar: '' },
        { name: 'Лиза', time: 'Вчера', preview: 'Хорошо, договорились', unread: 0, avatar: '' },
        { name: 'Бухгалтерия', time: 'Пн', preview: '📄 Акт сверки за октябрь.pdf', unread: 0, avatar: '' },
      ],
      a2: [
        { name: 'Денис Карпов', time: '12:42', preview: 'Добрый вечер! Когда будет возврат по заказу 2231?', unread: 3, avatar: '' },
        { name: 'Светлана', time: '12:36', preview: 'Не приходит код подтверждения, что делать?', unread: 1, avatar: '' },
        { name: 'Павел', time: '12:11', preview: 'Фото брака прикрепил, посмотрите', unread: 0, avatar: '' },
        { name: 'Gem Space', time: '09:30', preview: 'Новый вход в аккаунт с устройства Windows', unread: 0, avatar: '' },
      ],
      a3: [
        { name: 'Опт: заявки', time: '12:40', preview: 'Марк: Нужно 40 коробок к пятнице, успеете?', unread: 5, avatar: '' },
        { name: 'Марк', time: 'Вчера', preview: 'Скинул прайс на декабрь', unread: 0, avatar: '' },
      ],
      a4: [
        { name: 'Ольга', time: '12:33', preview: 'Спасибо, всё пришло! Оставлю отзыв', unread: 0, avatar: '' },
        { name: 'Сергей Лебедев', time: '11:02', preview: '📷 Фото', unread: 0, avatar: '' },
      ],
      a7: [
        { name: 'Склад, смена 2', time: '12:28', preview: 'Паллеты на утро собраны, ждём машину', unread: 1, avatar: '' },
      ],
    },
    // labels the user put on chats ("Все чаты", right click)
    labels: [{ id: 'l1', name: 'Клиенты', color: '#26a69a' }, { id: 'l2', name: 'Ждут оплату', color: '#ffa726' }],
    chat_labels: { 'a1|Ирина Морозова': ['l2'], 'a2|Денис Карпов': ['l1'], 'a1|Кафе «Терраса»': ['l1', 'l2'], 'a3|Опт: заявки': ['l1'] },
    version: '0.1.0',
  };
  if (/[?&]empty/.test(location.search)) { state.accounts = []; state.active = null; state.feed = []; state.chats = {}; state.total_unread = 0; }
  const tab = /[?&](chats|feed)/.exec(location.search);
  if (tab) {
    try { localStorage.setItem('gs-feed-tab', tab[1] === 'feed' ? 'new' : 'all'); } catch (e) {}
    addEventListener('load', () => setTimeout(() => document.querySelector('#feed') && document.querySelector('#feed').click(), 50));
  }
  var listeners = [];
  window.__TAURI__ = {
    core: {
      invoke: function (cmd) {
        if (cmd === 'get_state') return Promise.resolve(state);
        return Promise.resolve(null);
      },
    },
    event: { listen: function (n, cb) { listeners.push(cb); return Promise.resolve(function () {}); } },
    menu: { Menu: { new: function () { return Promise.resolve({ popup: function () {} }); } } },
  };
})();
