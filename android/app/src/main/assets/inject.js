// Gemspace: runs in every account WebView before the Gem Space page. It does not read or change
// the page: it only reroutes web notifications to Gemspace (so they carry the account name and
// arrive as Android notifications, which a WebView cannot show by itself).
(function () {
  if (window.__gemspace) return;
  window.__gemspace = true;
  if (!/(^|\.)gemspace\.com$/.test(location.hostname)) return;

  function notify(title, opts) {
    opts = opts || {};
    try {
      if (window.GemspaceBridge) {
        GemspaceBridge.postMessage(JSON.stringify({ t: 'notify', title: String(title || ''), body: String(opts.body || '') }));
      }
    } catch (e) {}
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
})();
