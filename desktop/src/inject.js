// Gemspace: runs in every account webview before the Gem Space page. It does not read or change
// the page: it only reroutes web notifications to Gemspace (so they carry the account name and work
// for hidden accounts) and forwards the account hotkeys (Ctrl+1..9, Ctrl+Tab).
(function () {
  if (window.__gemspace) return;
  window.__gemspace = true;
  if (!/(^|\.)gemspace\.com$/.test(location.hostname)) return;

  function invoke(cmd, args) {
    try {
      var t = window.__TAURI_INTERNALS__;
      if (t && t.invoke) return t.invoke(cmd, args).catch(function () {});
    } catch (e) {}
  }
  function notify(title, opts) {
    opts = opts || {};
    invoke('acc_notify', { title: String(title || ''), body: String(opts.body || '') });
  }

  function GsNotification(title, opts) {
    var self = this;
    this.title = String(title || '');
    this.body = (opts && opts.body) || '';
    this.tag = (opts && opts.tag) || '';
    this.data = opts && opts.data;
    this.onclick = this.onclose = this.onerror = this.onshow = null;
    notify(title, opts);
    setTimeout(function () {
      if (typeof self.onshow === 'function') self.onshow(new Event('show'));
    }, 0);
  }
  GsNotification.prototype.close = function () {};
  GsNotification.prototype.addEventListener = function () {};
  GsNotification.prototype.removeEventListener = function () {};
  GsNotification.prototype.dispatchEvent = function () { return true; };
  GsNotification.permission = 'granted';
  GsNotification.maxActions = 0;
  GsNotification.requestPermission = function (cb) {
    if (typeof cb === 'function') cb('granted');
    return Promise.resolve('granted');
  };
  try {
    Object.defineProperty(window, 'Notification', { value: GsNotification, configurable: true, writable: true });
  } catch (e) {}

  if (window.ServiceWorkerRegistration && ServiceWorkerRegistration.prototype) {
    ServiceWorkerRegistration.prototype.showNotification = function (title, opts) {
      notify(title, opts);
      return Promise.resolve();
    };
  }
  if (navigator.permissions && navigator.permissions.query) {
    var query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function (d) {
      if (d && d.name === 'notifications') {
        return Promise.resolve({ state: 'granted', name: 'notifications', onchange: null,
          addEventListener: function () {}, removeEventListener: function () {} });
      }
      return query(d);
    };
  }

  window.addEventListener('keydown', function (e) {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    var key = null;
    if (!e.shiftKey && e.key >= '1' && e.key <= '9') key = e.key;
    else if (e.key === 'Tab') key = e.shiftKey ? 'prev' : 'next';
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    invoke('acc_hotkey', { key: key });
  }, true);
})();
