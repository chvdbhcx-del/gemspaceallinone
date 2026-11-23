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
    settings: { sleep_enabled: true, max_awake: 8, notifications: true, notify_preview: false, close_to_tray: true },
    total_unread: 19,
    version: '0.1.0',
  };
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
