// Hovi Space: runs in every account webview before the Gem Space page. It does not read or change
// the page (until sign-in it only watches its requests for the sign-in report): it only reroutes web notifications to Hovi Space (so they carry the account name, work
// for hidden accounts and fill the shared feed) and forwards the account hotkeys (Ctrl+1..9, Ctrl+Tab).
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
  function notify(title, opts, nid) {
    opts = opts || {};
    invoke('acc_notify', { title: String(title || ''), body: String(opts.body || ''), nid: nid || null });
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
  // As in Chrome (see the user agent in lib.rs): the page's navigator.userAgentData without the
  // "Microsoft Edge" / "WebView2" brands, as Chrome names itself.
  try {
    var uad = navigator.userAgentData;
    if (uad && uad.brands && uad.brands.some(function (b) { return /Edge|WebView/i.test(b.brand); })) {
      var fix = function (list) {
        return (list || []).map(function (b) { return /Edge|WebView/i.test(b.brand) ? { brand: 'Google Chrome', version: b.version } : b; })
          .filter(function (b, i, all) { return all.findIndex(function (x) { return x.brand === b.brand; }) === i; });
      };
      var fake = {
        brands: fix(uad.brands),
        mobile: uad.mobile,
        platform: uad.platform,
        getHighEntropyValues: function (h) {
          return uad.getHighEntropyValues(h).then(function (v) {
            if (v.brands) v.brands = fix(v.brands);
            if (v.fullVersionList) v.fullVersionList = fix(v.fullVersionList);
            return v;
          });
        },
        toJSON: function () { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
      };
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: function () { return fake; }, configurable: true });
    }
  } catch (e) {}

  var installed = false;

  // Sign-in report (Settings, "Отчёт о входе"): until the account is signed in, which requests the page
  // makes and how they end, so a sign-in that hangs here but not in a browser can be compared. Addresses
  // without query (it may carry tokens), statuses and errors; no headers, no successful bodies, nothing
  // after sign-in. It only watches: every call goes on exactly as without it.
  var diagOn = false;
  var diagBuf = [];
  var t0 = Date.now();
  function bare(u) {
    try { var x = new URL(String(u), location.href); return x.origin + x.pathname; } catch (e) { return String(u).split('?')[0].slice(0, 200); }
  }
  // names (never values) of an address's query, e.g. whether a Telegram link carries its start token
  function keys(u) {
    try { var q = Array.from(new URL(String(u), location.href).searchParams.keys()); return q.length ? ' ?' + q.join(',') : ''; } catch (e) { return ''; }
  }
  function log(line) {
    if (!diagOn) return;
    diagBuf.push('+' + ((Date.now() - t0) / 1000).toFixed(1) + 's ' + line);
    if (diagBuf.length > 300) diagBuf.shift();
  }
  function diagFlush() {
    if (diagBuf.length) invoke('acc_log', { lines: diagBuf.splice(0) });
  }
  function startDiag() {
    diagOn = true;
    var n = typeof Notification === 'function' ? Notification.permission : 'none';
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    log('start ' + bare(location.href) + ' | ' + navigator.userAgent + ' | lang ' + navigator.language + ' | tz ' + tz +
      ' | brands ' + (navigator.userAgentData ? JSON.stringify(navigator.userAgentData.brands) : 'none') + ' | notifications ' + n + ' | sw ' + !!navigator.serviceWorker + ' | push ' + !!window.PushManager + ' | cookies ' + navigator.cookieEnabled);
    var of = window.fetch;
    if (of) {
      window.fetch = function (input, init) {
        var p = of.apply(window, arguments);
        if (diagOn) {
          var m = (init && init.method) || (input && input.method) || 'GET';
          var u = bare((input && input.url) || input);
          p.then(function (r) {
            log('fetch ' + m + ' ' + u + ' -> ' + r.status);
            if (r.status >= 400) r.clone().text().then(function (t) { log('  ответ: ' + t.slice(0, 300)); }, function () {});
          }, function (e) { log('fetch ' + m + ' ' + u + ' FAILED ' + e); });
        }
        return p;
      };
    }
    var XP = window.XMLHttpRequest && XMLHttpRequest.prototype;
    if (XP) {
      var xo = XP.open, xs = XP.send;
      XP.open = function (m, u) { this.__hovi = m + ' ' + bare(u); return xo.apply(this, arguments); };
      XP.send = function () {
        var x = this;
        if (diagOn && x.__hovi) {
          x.addEventListener('loadend', function () {
            var t = '';
            if (x.status >= 400 && (x.responseType === '' || x.responseType === 'text')) t = ' ' + String(x.responseText).slice(0, 300);
            log('xhr ' + x.__hovi + ' -> ' + x.status + t);
          });
        }
        return xs.apply(this, arguments);
      };
    }
    var WS = window.WebSocket;
    if (WS) {
      var W = function (u, p) {
        var s = p === undefined ? new WS(u) : new WS(u, p);
        if (diagOn) {
          var name = bare(u), c = 0;
          log('ws connect ' + name);
          s.addEventListener('open', function () { log('ws open ' + name); });
          s.addEventListener('message', function (e) {
            c++;
            if (c <= 5 || c % 20 === 0) log('ws message #' + c + ' ' + name + ' (' + (e.data && (e.data.length || e.data.size || e.data.byteLength) || 0) + ' байт)');
          });
          s.addEventListener('error', function () { log('ws error ' + name); });
          s.addEventListener('close', function (e) { log('ws closed ' + name + ' code ' + e.code + ' ' + e.reason + ', messages ' + c); });
        }
        return s;
      };
      W.prototype = WS.prototype;
      W.CONNECTING = 0; W.OPEN = 1; W.CLOSING = 2; W.CLOSED = 3;
      window.WebSocket = W;
    }
    var ES = window.EventSource;
    if (ES) {
      var E = function (u, o) {
        var s = new ES(u, o);
        if (diagOn) {
          var name = bare(u);
          log('eventsource ' + name);
          s.addEventListener('error', function () { log('eventsource error ' + name + ' state ' + s.readyState); });
        }
        return s;
      };
      E.prototype = ES.prototype;
      E.CONNECTING = 0; E.OPEN = 1; E.CLOSED = 2;
      window.EventSource = E;
    }
    var wo = window.open;
    window.open = function (u) { log('window.open ' + (u ? bare(u) + keys(u) : '(пусто)')); return wo.apply(window, arguments); };
    // the page's own route changes (no reload) and what leads to a reload
    ['pushState', 'replaceState'].forEach(function (k) {
      var f = history[k];
      history[k] = function (st, t, u) { if (u) log(k + ' ' + bare(u)); return f.apply(history, arguments); };
    });
    window.addEventListener('beforeunload', function () { log('page unloads (reload or leave)'); diagFlush(); });
    document.addEventListener('visibilitychange', function () { log('visibility ' + document.visibilityState); });
    window.addEventListener('focus', function () { log('focus'); });
    if (navigator.serviceWorker) {
      log('service worker ' + (navigator.serviceWorker.controller ? 'controls the page' : 'not controlling yet'));
      // A service worker installed on the first visit takes over the page, and a page that reloads on that
      // loses its sign-in token (Gem Space then waits forever). Until sign-in the page does not hear of it.
      navigator.serviceWorker.addEventListener('controllerchange', function (e) {
        if (!diagOn) return;
        log('service worker took over: reload held back until sign-in');
        e.stopImmediatePropagation();
      }, true);
    }
    window.addEventListener('error', function (e) {
      if (e.target && e.target !== window && (e.target.src || e.target.href)) log('не загрузилось ' + bare(e.target.src || e.target.href));
      else log('ошибка ' + e.message + ' ' + bare(e.filename || '') + ':' + e.lineno);
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      var r = e.reason;
      log('ошибка (promise) ' + String((r && (r.stack || r.message)) || r).slice(0, 300));
    });
    var ce = console.error;
    console.error = function () {
      try { log('console.error ' + Array.prototype.map.call(arguments, function (a) { return String((a && a.message) || a); }).join(' ').slice(0, 300)); } catch (e) {}
      return ce.apply(console, arguments);
    };
    var lastState = '';
    setInterval(function () {
      if (!diagOn) return;
      var keys = [];
      try { for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); } catch (e) {}
      var st = location.pathname + location.hash.split('?')[0] + ' | localStorage: ' + keys.sort().join(',') +
        ' | cookies: ' + document.cookie.split(';').map(function (c) { return c.split('=')[0].trim(); }).filter(Boolean).join(',');
      if (st !== lastState) { lastState = st; log('state ' + st); }
      diagFlush();
    }, 2000);
    window.addEventListener('pagehide', diagFlush);
  }

  window.__gemspaceInstall = function () {
    if (installed) return;
    installed = true;
    log('signed in: chat list visible');
    diagFlush();
    diagOn = false;
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
  var signedIn = false;
  try { signedIn = localStorage.getItem('hovi-signed-in') === '1'; } catch (e) {}
  if (signedIn) window.__gemspaceInstall();
  else startDiag();

  // the chat list read by shared/chats.js goes to the rail's "Все чаты"
  window.__gemspaceSendChats = function (chats) { invoke('acc_chats', { chats: chats }); };
  // the result of one message of a broadcast the user started (shared/chats.js, __gemspaceSend)
  window.__gemspaceSent = function (r) { invoke('acc_sent', { token: String(r.token || ''), ok: !!r.ok, error: String(r.error || '') }); };

  window.addEventListener('keydown', function (e) {
    // F12 or Ctrl+Shift+I: developer tools of this account, to see why something does not load
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyI')) {
      e.preventDefault();
      invoke('acc_hotkey', { key: 'devtools' });
      return;
    }
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
