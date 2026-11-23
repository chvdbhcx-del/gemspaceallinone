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
    settings: { sleep_enabled: true, max_awake: 8, notifications: true, notify_preview: true, close_to_tray: true },
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
    version: '0.1.0',
  };
  if (/[?&]empty/.test(location.search)) { state.accounts = []; state.active = null; state.feed = []; state.total_unread = 0; }
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
