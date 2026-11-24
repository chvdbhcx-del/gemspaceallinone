// Hovi Space: runs in every account WebView before the Gem Space page. It does not read or change
// the page: it only reroutes web notifications to Hovi Space (so they carry the account name, fill
// the shared feed and arrive as Android notifications, which a WebView cannot show by itself).
(function () {
  if (window.__gemspace) return;
  window.__gemspace = true;
  if (!/(^|\.)gemspace\.com$/.test(location.hostname)) return;

  function notify(title, opts, nid) {
    opts = opts || {};
    try {
      if (window.GemspaceBridge) {
        GemspaceBridge.postMessage(JSON.stringify({ t: 'notify', title: String(title || ''), body: String(opts.body || ''), nid: nid || '' }));
      }
    } catch (e) {}
  }

  // The page's recent notifications by id, so a row of Hovi Space's feed can "click" one: that runs the
  // page's own click handler, which in Gem Space opens the chat. Nothing else is kept.
  var recent = {};
  var order = [];
  var seq = 0;
  window.__gemspaceOpen = function (nid) {
    var n = recent[nid];
    if (!n) return;
    var ev;
    try { ev = new Event('click', { cancelable: true }); } catch (e) { ev = { type: 'click' }; }
    try { if (typeof n.onclick === 'function') n.onclick.call(n, ev); } catch (e) {}
    (n._click || []).forEach(function (f) { try { f.call(n, ev); } catch (e) {} });
  };

  // Until the account is signed in, Hovi Space leaves the page exactly as in a browser: Gem Space's sign-in
  // (Telegram bot, QR) must see the real Notification and permission APIs, not ours. shared/chats.js calls
  // __gemspaceInstall once the chat list shows (signed in) and remembers it for this account.
  var installed = false;
  window.__gemspaceInstall = function () {
    if (installed) return;
    installed = true;
    function GsNotification(title, opts) {
      var self = this;
      this.title = String(title || '');
      this.body = (opts && opts.body) || '';
      this.tag = (opts && opts.tag) || '';
      this.data = opts && opts.data;
      this.onclick = this.onclose = this.onerror = this.onshow = null;
      this._click = [];
      var nid = 'n' + (++seq);
      recent[nid] = this;
      order.push(nid);
      if (order.length > 100) delete recent[order.shift()];
      notify(title, opts, nid);
      setTimeout(function () {
        if (typeof self.onshow === 'function') self.onshow(new Event('show'));
      }, 0);
    }
    GsNotification.prototype.close = function () {};
    GsNotification.prototype.addEventListener = function (type, f) {
      if (type === 'click' && typeof f === 'function') this._click.push(f);
    };
    GsNotification.prototype.removeEventListener = function (type, f) {
      if (type === 'click') this._click = this._click.filter(function (x) { return x !== f; });
    };
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
  };
  try { if (localStorage.getItem('hovi-signed-in') === '1') window.__gemspaceInstall(); } catch (e) {}

  // the chat list read by chats.js goes to Hovi Space's "Все чаты"
  window.__gemspaceSendChats = function (chats) {
    try { if (window.GemspaceBridge) GemspaceBridge.postMessage(JSON.stringify({ t: 'chats', chats: chats })); } catch (e) {}
  };
  // the result of one message of a broadcast the user started (shared/chats.js, __gemspaceSend)
  window.__gemspaceSent = function (r) {
    try { if (window.GemspaceBridge) GemspaceBridge.postMessage(JSON.stringify({ t: 'sent', token: String(r.token || ''), ok: !!r.ok, error: String(r.error || '') })); } catch (e) {}
  };
  // a status, reminder, note or template changed in Gem Space's own menus (shared/crm.js), or the page asks for them
  window.__gemspaceMeta = function (e) {
    try { if (window.GemspaceBridge) GemspaceBridge.postMessage(JSON.stringify({ t: 'meta', edit: e })); } catch (x) {}
  };
})();
