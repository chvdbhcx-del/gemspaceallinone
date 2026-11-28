//! Hovi Space desktop: one window, an account rail on the left and one isolated webview per
//! Gem Space account (its own WebView2 data folder, so its own cookies and storage, and its own proxy).
//! The Gem Space web app itself is loaded unmodified from https://web.gemspace.com/.

mod crm;
mod feed;
mod store;
mod update;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent, PermissionKind, PermissionResponse, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, UserAttentionType, Webview, WebviewUrl, Window,
    WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use feed::{Feed, FeedItem};
use std::collections::BTreeMap;

use store::{Account, ChatMeta, Label, Settings, Store, Template};
use tauri_plugin_dialog::DialogExt;

pub const GEM_URL: &str = "https://web.gemspace.com/";
const MAIN: &str = "main";
pub(crate) const RAIL: &str = "rail";
const RAIL_WIDTH: f64 = 76.0;
/// "Все чаты": the chat list column next to the rail, the open chat stays visible on the right
const PANEL_WIDTH: f64 = 380.0;

/// Interface size as a zoom factor, from the settings (100% = 1.0).
fn ui_scale(app: &AppHandle) -> f64 {
    let pct = app.state::<AppState>().store.lock().unwrap().settings.ui_scale.clamp(80, 150);
    pct as f64 / 100.0
}

/// Where the account pages start: the rail, plus the chat list column while it is open. Both grow with
/// the interface size so their contents keep their proportions.
fn rail_width(app: &AppHandle) -> f64 {
    let panel = app.state::<AppState>().live.lock().unwrap().panel;
    ((RAIL_WIDTH + if panel { PANEL_WIDTH } else { 0.0 }) * ui_scale(app)).round()
}

/// Applies the interface size to the rail and every loaded account.
fn apply_scale(app: &AppHandle) {
    let z = ui_scale(app);
    if let Some(window) = main_window(app) {
        for wv in window.webviews() {
            let _ = wv.set_zoom(z);
        }
    }
    layout(app);
}
const ACC_PREFIX: &str = "acc-";

/// Injected into every account webview before the page's own scripts. It reroutes the page's web
/// notifications to Hovi Space (so they carry the account name), forwards account hotkeys and reads the
/// chat list the page shows for "Все чаты" (shared/chats.js). It types only when the user asks: a broadcast
/// (`__gemspaceSend`) or a template put into the message field without sending (`__gemspaceInsert`).
const INJECT_JS: &str = concat!(include_str!("inject.js"), "\n", include_str!("../../shared/chats.js"), "\n", include_str!("../../shared/crm.js"));

#[derive(Default)]
pub(crate) struct Live {
    unread: HashMap<String, u32>,
    /// accounts that got a notification since they were last opened
    attention: HashSet<String>,
    /// loaded (awake) accounts, least recently used first
    lru: Vec<String>,
    /// the rail covers the whole window (settings, account editor)
    overlay: bool,
    /// the chat list column ("Все чаты") is open next to the rail
    panel: bool,
    /// new messages of all accounts, from their notifications
    feed: Feed,
    /// a newer version found by the updater (update.rs)
    pub(crate) update: Option<update::UpdateView>,
    /// the chat list each awake account's page shows, for "Все чаты"
    chats: HashMap<String, Vec<ChatRow>>,
    /// accounts whose Gem Space page has finished loading (a broadcast waits for it after waking one)
    loaded: HashSet<String>,
    /// reminders already announced: chat -> the time they were set for (a moved reminder is announced again)
    told: BTreeMap<String, i64>,
    /// broadcast messages and templates waiting for their page's answer: token -> (account, reply)
    waiters: HashMap<String, (String, tokio::sync::oneshot::Sender<(bool, String)>)>,
    /// sign-in report: what the pages of not yet signed-in accounts load and how it ends (see diag())
    diag: std::collections::VecDeque<String>,
    /// what each account's page was last given for Gem Space's own menus (shared/crm.js), to send only changes
    meta_sent: HashMap<String, String>,
    /// hidden accounts asked to keep their memory low (WebView2 memory usage target), see layout()
    low_mem: HashSet<String>,
    /// when each account's page process last failed, to stop reloading a page that keeps failing
    failures: HashMap<String, Vec<std::time::Instant>>,
    /// accounts just moved into the shared browser with a copy of their sign-in, until their page shows
    /// whether it is still signed in (acc_chats: yes, acc_page on the sign-in page: no)
    migrating: HashSet<String>,
    /// sleeping accounts woken for a short visit by the patrol: account -> when, and whether its chat list came
    patrol: HashMap<String, (std::time::Instant, bool)>,
    /// when the patrol last visited each account, and the unread count it found then
    patrol_seen: HashMap<String, (std::time::Instant, u32)>,
}

/// Adds a line to the sign-in report (Settings, "Отчёт о входе"). Addresses only, never message text.
fn diag(app: &AppHandle, id: &str, line: &str) {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) % 86_400;
    let line: String = line.chars().take(600).collect();
    let row = format!("{:02}:{:02}:{:02} [{id}] {line}", secs / 3600, secs / 60 % 60, secs % 60);
    let st = app.state::<AppState>();
    let mut live = st.live.lock().unwrap();
    live.diag.push_back(row);
    while live.diag.len() > 5000 {
        live.diag.pop_front();
    }
}

/// An address without its query and fragment (they may carry sign-in tokens).
fn bare_url(url: &tauri::Url) -> String {
    format!("{}{}", url.origin().ascii_serialization(), url.path())
}

/// One row of an account's chat list, as its page shows it (shared/chats.js).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct ChatRow {
    name: String,
    #[serde(default)]
    time: String,
    #[serde(default)]
    preview: String,
    #[serde(default)]
    unread: u32,
    #[serde(default)]
    avatar: String,
}

impl ChatRow {
    /// Keeps what the page sends to sane sizes; an avatar must be an https URL.
    fn clean(mut self) -> ChatRow {
        self.name = self.name.chars().take(80).collect();
        self.time = self.time.chars().take(16).collect();
        self.preview = self.preview.chars().take(160).collect();
        if !self.avatar.starts_with("https://") || self.avatar.len() > 500 {
            self.avatar.clear();
        }
        self
    }
}

pub(crate) struct AppState {
    store: Mutex<Store>,
    pub(crate) live: Mutex<Live>,
}

#[derive(Serialize, Clone)]
struct AccountView {
    #[serde(flatten)]
    account: Account,
    unread: u32,
    attention: bool,
    awake: bool,
}

#[derive(Serialize, Clone)]
struct StateView {
    accounts: Vec<AccountView>,
    active: Option<String>,
    settings: Settings,
    total_unread: u32,
    feed: Vec<FeedItem>,
    chats: HashMap<String, Vec<ChatRow>>,
    labels: Vec<Label>,
    chat_labels: BTreeMap<String, Vec<String>>,
    /// notes, statuses and reminders of chats
    #[serde(flatten)]
    meta: ChatMeta,
    templates: Vec<Template>,
    /// broadcast messages each account sent today (the daily limit)
    sent_today: BTreeMap<String, u32>,
    update: Option<update::UpdateView>,
    version: String,
}

fn label_of(id: &str) -> String {
    format!("{ACC_PREFIX}{id}")
}

fn id_of(label: &str) -> Option<&str> {
    label.strip_prefix(ACC_PREFIX)
}

fn main_window(app: &AppHandle) -> Option<Window> {
    app.get_window(MAIN)
}

fn snapshot(app: &AppHandle) -> StateView {
    let st = app.state::<AppState>();
    let store = st.store.lock().unwrap().clone();
    let live = st.live.lock().unwrap();
    let mut total = 0;
    let accounts = store
        .accounts
        .iter()
        .map(|a| {
            let unread = live.unread.get(&a.id).copied().unwrap_or(0);
            total += unread;
            AccountView {
                account: a.clone(),
                unread,
                attention: live.attention.contains(&a.id),
                awake: live.lru.contains(&a.id),
            }
        })
        .collect();
    StateView {
        accounts,
        active: store.active.clone(),
        settings: store.settings.clone(),
        total_unread: total,
        feed: live.feed.items(),
        chats: live.chats.clone(),
        labels: store.labels.clone(),
        chat_labels: store.chat_labels.clone(),
        meta: store.meta.clone(),
        templates: store.templates.clone(),
        sent_today: if store.sent_day == chrono_day() { store.sent.clone() } else { BTreeMap::new() },
        update: live.update.clone(),
        version: app.package_info().version.to_string(),
    }
}

/// A state push is on its way (see publish).
static PUBLISH_PENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Pushes the state to the rail soon. Many changes in a row (titles, chat lists and notifications of dozens
/// of awake accounts) go out as one push, at most about ten times a second, instead of one each.
pub(crate) fn publish(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    if PUBLISH_PENDING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        PUBLISH_PENDING.store(false, Ordering::Release);
        publish_now(&app);
    });
}

/// Pushes the state to the rail and refreshes the window title and the tray tooltip.
fn publish_now(app: &AppHandle) {
    let view = snapshot(app);
    let _ = app.emit_to(RAIL, "state", &view);
    push_meta(app);
    let title = if view.total_unread > 0 { format!("({}) Hovi Space", view.total_unread) } else { "Hovi Space".into() };
    if let Some(w) = main_window(app) {
        let _ = w.set_title(&title);
    }
    if let Some(tray) = app.tray_by_id("tray") {
        let tip = if view.total_unread > 0 {
            format!("Hovi Space: {} непрочитанных", view.total_unread)
        } else {
            "Hovi Space".into()
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

fn save(app: &AppHandle) {
    let st = app.state::<AppState>();
    let store = st.store.lock().unwrap();
    if let Err(e) = store.save(app) {
        eprintln!("gemspace: cannot save state: {e}");
    }
}

/// Places the rail and the account webviews; only the active account is visible.
fn layout(app: &AppHandle) {
    let Some(window) = main_window(app) else { return };
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else { return };
    let size = size.to_logical::<f64>(scale);
    let st = app.state::<AppState>();
    let active = st.store.lock().unwrap().active.clone();
    let overlay = st.live.lock().unwrap().overlay;
    let rail_w = rail_width(app);
    let content_w = (size.width - rail_w).max(1.0);
    for wv in window.webviews() {
        let label = wv.label().to_string();
        if label == RAIL {
            let w = if overlay { size.width } else { rail_w };
            let _ = wv.set_position(LogicalPosition::new(0.0, 0.0));
            let _ = wv.set_size(LogicalSize::new(w, size.height));
        } else if let Some(id) = id_of(&label) {
            let _ = wv.set_position(LogicalPosition::new(rail_w, 0.0));
            let _ = wv.set_size(LogicalSize::new(content_w, size.height));
            let visible = !overlay && active.as_deref() == Some(id);
            if visible {
                let _ = wv.show();
            } else {
                let _ = wv.hide();
            }
            // a hidden account keeps running (messages, notifications) but gives back what memory it can
            let changed = {
                let mut live = st.live.lock().unwrap();
                if visible { live.low_mem.remove(id) } else { live.low_mem.insert(id.to_string()) }
            };
            if changed {
                #[cfg(windows)]
                memory_target(&wv, !visible);
            }
        }
    }
}

/// WebView2's memory usage target: low for a hidden account, so its page process trims its caches and
/// working set; normal again when it is shown.
#[cfg(windows)]
fn memory_target(wv: &Webview, low: bool) {
    let _ = wv.with_webview(move |pw| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows_core::Interface;
        let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
        unsafe {
            if let Ok(core) = pw.controller().CoreWebView2() {
                if let Ok(core) = core.cast::<ICoreWebView2_19>() {
                    let _ = core.SetMemoryUsageTargetLevel(level);
                }
            }
        }
    });
}

/// Number of unread chats from the page title: "(3) Gem Space", "3 · Gem Space" or "3 Gem Space".
fn unread_from_title(title: &str) -> u32 {
    let t = title.trim_start();
    let digits: String = if let Some(rest) = t.strip_prefix('(') {
        rest.chars().take_while(|c| c.is_ascii_digit()).collect()
    } else {
        let d: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
        let after = t[d.len()..].chars().next();
        if matches!(after, Some(' ') | Some('·') | Some('|') | Some('-')) { d } else { String::new() }
    };
    digits.parse().unwrap_or(0)
}

fn open_external(app: &AppHandle, url: &str) {
    if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") || url.starts_with("tel:") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

/// Creates the webview of an account (wakes it up). Must not run on the main thread: add_child waits for it.
fn create_account_webview(app: &AppHandle, account: &Account) -> tauri::Result<Webview> {
    let window = main_window(app).ok_or(tauri::Error::WindowNotFound)?;
    // accounts without a proxy share one browser (one browser, GPU and network process for all of them,
    // each account its own profile, so its own cookies and storage); an account with a proxy has its own,
    // since the proxy is set for a whole browser
    if account.shared && !account.wants_shared() {
        return Err(tauri::Error::Io(std::io::Error::other("Перезапустите Hovi Space, чтобы аккаунт открылся со своим прокси")));
    }
    let dir = if account.shared { store::shared_dir(app)? } else { store::account_dir(app, &account.id)? };
    tauri_runtime_wry::set_webview_profile(&label_of(&account.id), account.shared.then(|| store::profile_name(&account.id)).as_deref());
    let app_title = app.clone();
    let app_window = app.clone();
    let app_load = app.clone();
    let app_nav = app.clone();
    let app_perm = app.clone();
    let id_nav = account.id.clone();
    let id_win = account.id.clone();
    let id_load = account.id.clone();
    let id_perm = account.id.clone();
    let mut builder = WebviewBuilder::new(label_of(&account.id), WebviewUrl::External(GEM_URL.parse().unwrap()))
        .data_directory(dir)
        .initialization_script(INJECT_JS)
        .zoom_hotkeys_enabled(true)
        .enable_clipboard_access()
        .on_document_title_changed(move |wv, title| {
            if let Some(id) = id_of(wv.label()) {
                let n = unread_from_title(&title);
                let changed = {
                    let st = app_title.state::<AppState>();
                    let mut live = st.live.lock().unwrap();
                    let before = live.unread.insert(id.to_string(), n);
                    // everything read in Gem Space: the account's messages leave the feed. Only on a
                    // drop to zero, so a page whose title shows no count never empties the feed.
                    if n == 0 && before.unwrap_or(0) > 0 {
                        live.feed.clear(Some(id));
                    }
                    before != Some(n)
                };
                if changed {
                    publish(&app_title);
                }
            }
        })
        .on_navigation(move |url| {
            diag(&app_nav, &id_nav, &format!("navigate {}", bare_url(url)));
            true
        })
        .on_new_window(move |url, _features| {
            let keys: Vec<String> = url.query_pairs().map(|(k, _)| k.into_owned()).collect();
            diag(&app_window, &id_win, &format!("new window {} ?{}", bare_url(&url), keys.join(",")));
            // links from chats open in the system browser, never inside the account
            open_external(&app_window, url.as_str());
            NewWindowResponse::Deny
        })
        .on_page_load(move |_wv, payload| {
            let finished = payload.event() == PageLoadEvent::Finished;
            diag(&app_load, &id_load, &format!("page {} {}", if finished { "loaded" } else { "loading" }, bare_url(payload.url())));
            {
                let st = app_load.state::<AppState>();
                let mut live = st.live.lock().unwrap();
                if finished && payload.url().host_str().is_some_and(|h| h == "gemspace.com" || h.ends_with(".gemspace.com")) {
                    live.loaded.insert(id_load.clone());
                } else if !finished {
                    live.loaded.remove(&id_load);
                }
            }
            if finished {
                publish(&app_load);
            }
        })
        .on_permission_request(move |_wv, kind| {
            diag(&app_perm, &id_perm, &format!("permission {kind:?}"));
            match kind {
                // calls; notifications as in a browser where they were allowed (Gem Space's sign-in may
                // ask for them). Once signed in, inject.js reroutes the page's notifications to Hovi Space.
                PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::Notifications => PermissionResponse::Allow,
                _ => PermissionResponse::Default,
            }
        });
    let proxy = account.proxy.as_deref().map(str::trim).filter(|p| !p.is_empty() && !account.shared).and_then(|p| match store::parse_proxy(p) {
        Ok(url) => Some(url),
        Err(e) => {
            eprintln!("gemspace: bad proxy for {}: {e}", account.id);
            None
        }
    });
    // WebView2 introduces itself as "Microsoft Edge WebView2" (user agent "Edg/", Sec-CH-UA). The page
    // runs as in Chrome instead, where Gem Space's sign-in works: Chrome's user agent of the same version,
    // no client hints. wry's own arguments are kept (they are replaced once any are given), proxy included.
    #[cfg(windows)]
    {
        let major = tauri::webview_version().ok().and_then(|v| v.split('.').next().map(str::to_string)).unwrap_or_else(|| "142".into());
        builder = builder.user_agent(&format!(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36"
        ));
        // the HTTP cache of each account at most 64 MB: with dozens of accounts the default (a share of the
        // free disk each) fills gigabytes
        let mut args = String::from(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,UserAgentClientHint --disk-cache-size=67108864",
        );
        if let Some(url) = &proxy {
            args.push_str(&format!(" --proxy-server={}://{}:{}", url.scheme(), url.host_str().unwrap_or_default(), url.port().unwrap_or_default()));
        }
        builder = builder.additional_browser_args(&args);
    }
    if let Some(url) = proxy {
        builder = builder.proxy_url(url);
    }
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else {
        return Err(tauri::Error::WindowNotFound);
    };
    let size = size.to_logical::<f64>(scale);
    let rail_w = rail_width(app);
    let wv = window.add_child(
        builder,
        LogicalPosition::new(rail_w, 0.0),
        LogicalSize::new((size.width - rail_w).max(1.0), size.height),
    )?;
    let _ = wv.hide();
    #[cfg(windows)]
    no_tracking_prevention(app, &wv, &account.id);
    #[cfg(windows)]
    watch_process_failures(app, &wv, &account.id);
    #[cfg(windows)]
    if account.shared {
        log_profile(app, &wv, &account.id);
    }
    app.state::<AppState>().live.lock().unwrap().low_mem.remove(&account.id);
    let z = ui_scale(app);
    if (z - 1.0).abs() > f64::EPSILON {
        let _ = wv.set_zoom(z);
    }
    Ok(wv)
}

/// WebView2 is Edge and comes with Edge's tracking prevention, which blocks some storage of the page;
/// Chrome, where Gem Space's sign-in works, has none. So the account pages run without it, as in Chrome.
#[cfg(windows)]
fn no_tracking_prevention(app: &AppHandle, wv: &Webview, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    let _ = wv.with_webview(move |pw| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Profile3, ICoreWebView2_13, COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE,
        };
        use windows_core::Interface;
        let res = unsafe {
            (|| -> windows_core::Result<()> {
                let core = pw.controller().CoreWebView2()?;
                let profile = core.cast::<ICoreWebView2_13>()?.Profile()?;
                profile.cast::<ICoreWebView2Profile3>()?.SetPreferredTrackingPreventionLevel(COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE)
            })()
        };
        match res {
            Ok(()) => diag(&app, &id, "tracking prevention: off"),
            Err(e) => diag(&app, &id, &format!("tracking prevention: could not turn off ({e})")),
        }
    });
}

/// Which profile folder WebView2 gave an account of the shared browser, for the sign-in report: a moved sign-in
/// is found only if it is the one prepare_profiles copied it to.
#[cfg(windows)]
fn log_profile(app: &AppHandle, wv: &Webview, id: &str) {
    let (app, id) = (app.clone(), id.to_string());
    let expected = store::profile_dir(&app, &id).map(|p| p.display().to_string()).unwrap_or_default();
    let _ = wv.with_webview(move |pw| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_13;
        use windows_core::{Interface, PWSTR};
        let path = unsafe {
            (|| -> windows_core::Result<String> {
                let profile = pw.controller().CoreWebView2()?.cast::<ICoreWebView2_13>()?.Profile()?;
                let mut p = PWSTR::null();
                profile.ProfilePath(&mut p)?;
                Ok(webview2_com::take_pwstr(p))
            })()
        };
        match path {
            Ok(p) if p.eq_ignore_ascii_case(&expected) => diag(&app, &id, "shared browser profile: ok"),
            Ok(p) => diag(&app, &id, &format!("shared browser profile in an unexpected folder: {p}")),
            Err(e) => diag(&app, &id, &format!("shared browser profile: unknown ({e})")),
        }
    });
}

/// What to do when a page process of an account fails (WebView2 ProcessFailed).
#[derive(Debug, PartialEq)]
enum Recovery {
    /// the page process crashed, was killed (out of memory) or hangs: load the page again
    Reload,
    /// the account's browser process is gone: close the account (and open it again if it is the open one)
    Restart,
    /// failed again and again within a few minutes: the account sleeps until it is opened
    Sleep,
    /// GPU, utility and other helper processes: WebView2 starts them again by itself
    Nothing,
}

/// Failures within this time count together; more than MAX_FAILURES of them put the account to sleep.
const FAILURE_WINDOW: std::time::Duration = std::time::Duration::from_secs(180);
const MAX_FAILURES: usize = 3;

fn recovery_for(kind: i32, recent_failures: usize) -> Recovery {
    // COREWEBVIEW2_PROCESS_FAILED_KIND: 0 browser exited, 1 render exited, 2 render unresponsive,
    // 3 frame render exited, 4 utility, 5 sandbox helper, 6 gpu, 7 ppapi plugin, 8 ppapi broker, 9 unknown
    let base = match kind {
        0 => Recovery::Restart,
        1 | 2 => Recovery::Reload,
        _ => return Recovery::Nothing,
    };
    if recent_failures > MAX_FAILURES { Recovery::Sleep } else { base }
}

/// Without this a crashed or hung account page stays white or frozen until the user restarts Hovi Space;
/// under memory pressure with many accounts Windows kills such page processes.
#[cfg(windows)]
fn watch_process_failures(app: &AppHandle, wv: &Webview, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    let _ = wv.with_webview(move |pw| {
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND;
        use webview2_com::ProcessFailedEventHandler;
        let Ok(core) = (unsafe { pw.controller().CoreWebView2() }) else { return };
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            unsafe { args.ProcessFailedKind(&mut kind)? };
            let recent = {
                let st = app.state::<AppState>();
                let mut live = st.live.lock().unwrap();
                let list = live.failures.entry(id.clone()).or_default();
                let now = std::time::Instant::now();
                list.retain(|t| now.duration_since(*t) < FAILURE_WINDOW);
                if matches!(kind.0, 0..=2) {
                    list.push(now);
                }
                list.len()
            };
            let what = recovery_for(kind.0, recent);
            diag(&app, &id, &format!("page process failed (kind {}): {what:?}", kind.0));
            match what {
                Recovery::Nothing => {}
                Recovery::Reload => {
                    if let Some(core) = sender {
                        unsafe {
                            let _ = core.Reload();
                        }
                    }
                }
                Recovery::Restart | Recovery::Sleep => {
                    // a webview is closed and created off the main thread (this handler runs on it)
                    let (app, id) = (app.clone(), id.clone());
                    std::thread::spawn(move || {
                        sleep(&app, &id);
                        let active = app.state::<AppState>().store.lock().unwrap().active.clone();
                        if what == Recovery::Restart && active.as_deref() == Some(id.as_str()) {
                            let _ = switch_to(&app, &id);
                        } else {
                            publish(&app);
                        }
                    });
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        unsafe {
            let _ = core.add_ProcessFailed(&handler, &mut token);
        }
    });
}

/// Share of the computer's memory in use, in percent (Windows), or None where it is not known.
fn memory_load() -> Option<u32> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut m: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if unsafe { GlobalMemoryStatusEx(&mut m) } != 0 {
            return Some(m.dwMemoryLoad);
        }
    }
    None
}

/// Memory in use from which the accounts not opened for longest go to sleep, one every check.
const MEMORY_HIGH: u32 = 88;

/// Guards the computer against running out of memory with many awake accounts (even with the sleep mode
/// off): while memory use is high, the least recently opened account that is neither open nor pinned
/// sleeps. A sleeping account loads again when it is opened.
fn memory_guard(app: &AppHandle) {
    let Some(load) = memory_load() else { return };
    if load < MEMORY_HIGH {
        return;
    }
    let st = app.state::<AppState>();
    let (active, pinned): (Option<String>, HashSet<String>) = {
        let store = st.store.lock().unwrap();
        (store.active.clone(), store.accounts.iter().filter(|a| a.pinned).map(|a| a.id.clone()).collect())
    };
    let victim = {
        let live = st.live.lock().unwrap();
        live.lru.iter().find(|id| Some(id.as_str()) != active.as_deref() && !pinned.contains(*id) && !live.waiters.values().any(|(a, _)| a == *id)).cloned()
    };
    if let Some(id) = victim {
        diag(app, &id, &format!("memory {load}% in use: account put to sleep"));
        sleep(app, &id);
        publish(app);
    }
}

/// How many sleeping accounts the patrol visits at the same time, and how long a visit lasts at most and
/// at least once the page shows its chat list.
const PATROL_SLOTS: usize = 4;
const PATROL_MAX: std::time::Duration = std::time::Duration::from_secs(40);
const PATROL_MIN: std::time::Duration = std::time::Duration::from_secs(12);
/// The patrol starts no visit while this much of the computer's memory is in use.
const PATROL_MEMORY: u32 = 80;

/// The patrol (обход спящих): sleeping accounts are woken in turns, a few at a time, for up to 40 seconds,
/// so their unread counters stay current and new messages are announced even though they sleep. A visited
/// account stays hidden and asleep for the user (moon on its tile); opening it makes it a normal awake one.
/// 60 sleeping accounts take about 10 minutes for a round.
fn patrol(app: &AppHandle) {
    let st = app.state::<AppState>();
    let (settings, accounts, active) = {
        let store = st.store.lock().unwrap();
        (store.settings.clone(), store.accounts.clone(), store.active.clone())
    };
    let now = std::time::Instant::now();
    // visits that are over
    let over: Vec<String> = {
        let live = st.live.lock().unwrap();
        live.patrol
            .iter()
            .filter(|(id, (t, chats))| {
                let busy = live.waiters.values().any(|(a, _)| a == *id) || live.lru.contains(*id);
                !busy && (now.duration_since(*t) >= PATROL_MAX || (*chats && now.duration_since(*t) >= PATROL_MIN))
            })
            .map(|(id, _)| id.clone())
            .collect()
    };
    for id in over {
        let (before, after) = {
            let mut live = st.live.lock().unwrap();
            live.patrol.remove(&id);
            let after = live.unread.get(&id).copied().unwrap_or(0);
            let before = live.patrol_seen.insert(id.clone(), (now, after)).map(|(_, n)| n);
            (before, after)
        };
        if active.as_deref() != Some(id.as_str()) {
            sleep(app, &id);
        }
        // more unread chats than at its last visit: announced like a message (not at the first visit, which
        // would announce every old unread chat after a start)
        if let (Some(before), Some(account)) = (before.filter(|b| after > *b), accounts.iter().find(|a| a.id == id)) {
            st.live.lock().unwrap().attention.insert(id.clone());
            if settings.notifications {
                let n = after - before;
                let _ = app.notification().builder().title(account.name.clone()).body(format!("Новых чатов с сообщениями: {n}")).show();
            }
        }
        publish(app);
    }
    if !settings.sleep_enabled || !settings.patrol {
        return;
    }
    if memory_load().is_some_and(|m| m >= PATROL_MEMORY) {
        return;
    }
    // the next visits: the sleeping accounts visited longest ago (never visited first)
    let mut next: Vec<(Option<std::time::Instant>, String)> = {
        let live = st.live.lock().unwrap();
        if live.patrol.len() >= PATROL_SLOTS {
            return;
        }
        accounts
            .iter()
            .filter(|a| !live.lru.contains(&a.id) && !live.patrol.contains_key(&a.id) && Some(a.id.as_str()) != active.as_deref())
            .filter(|a| !(a.shared && !a.wants_shared()))
            .map(|a| (live.patrol_seen.get(&a.id).map(|(t, _)| *t), a.id.clone()))
            .collect()
    };
    // once around is enough for now: an account is visited again after a pause of at least 3 minutes
    next.retain(|(t, _)| t.is_none_or(|t| now.duration_since(t) >= std::time::Duration::from_secs(180)));
    next.sort();
    let free = PATROL_SLOTS - st.live.lock().unwrap().patrol.len();
    for (_, id) in next.into_iter().take(free) {
        let Some(account) = accounts.iter().find(|a| a.id == id) else { continue };
        if app.get_webview(&label_of(&id)).is_some() {
            continue;
        }
        st.live.lock().unwrap().patrol.insert(id.clone(), (now, false));
        if let Err(e) = create_account_webview(app, account) {
            diag(app, &id, &format!("patrol: could not wake ({e})"));
            let mut live = st.live.lock().unwrap();
            live.patrol.remove(&id);
            live.patrol_seen.insert(id.clone(), (now, live.unread.get(&id).copied().unwrap_or(0)));
        }
    }
    layout(app);
}

/// Makes sure the account is loaded and marks it as just used; then puts accounts over the limit to sleep.
fn wake(app: &AppHandle, id: &str) -> tauri::Result<()> {
    let account = {
        let st = app.state::<AppState>();
        let store = st.store.lock().unwrap();
        store.accounts.iter().find(|a| a.id == id).cloned()
    };
    let Some(account) = account else { return Ok(()) };
    if app.get_webview(&label_of(id)).is_none() {
        create_account_webview(app, &account)?;
    }
    {
        let st = app.state::<AppState>();
        let mut live = st.live.lock().unwrap();
        live.lru.retain(|x| x != id);
        live.lru.push(id.to_string());
        // opened during a patrol visit: from now on a normal awake account
        live.patrol.remove(id);
    }
    enforce_sleep(app);
    Ok(())
}

/// Closes the least recently used accounts beyond the limit. The active and pinned ones never sleep.
fn enforce_sleep(app: &AppHandle) {
    let st = app.state::<AppState>();
    let (settings, active, pinned): (Settings, Option<String>, HashSet<String>) = {
        let store = st.store.lock().unwrap();
        (
            store.settings.clone(),
            store.active.clone(),
            store.accounts.iter().filter(|a| a.pinned).map(|a| a.id.clone()).collect(),
        )
    };
    if !settings.sleep_enabled {
        return;
    }
    let limit = settings.max_awake.max(1);
    let victims: Vec<String> = {
        let live = st.live.lock().unwrap();
        let sleepable: Vec<&String> = live
            .lru
            .iter()
            .filter(|id| Some(id.as_str()) != active.as_deref() && !pinned.contains(*id))
            .collect();
        let awake_unpinned_limit = limit.saturating_sub(live.lru.len() - sleepable.len());
        let extra = sleepable.len().saturating_sub(awake_unpinned_limit);
        sleepable.into_iter().take(extra).cloned().collect()
    };
    for id in victims {
        sleep(app, &id);
    }
}

fn sleep(app: &AppHandle, id: &str) {
    if let Some(wv) = app.get_webview(&label_of(id)) {
        let _ = wv.close();
    }
    tauri_runtime_wry::set_webview_profile(&label_of(id), None);
    let st = app.state::<AppState>();
    let mut live = st.live.lock().unwrap();
    live.lru.retain(|x| x != id);
    live.patrol.remove(id);
    live.loaded.remove(id);
    live.low_mem.remove(id);
    // its next page starts without the menus' data, so it gets it in full again
    live.meta_sent.remove(id);
}

fn switch_to(app: &AppHandle, id: &str) -> Result<(), String> {
    {
        let st = app.state::<AppState>();
        let mut store = st.store.lock().unwrap();
        if !store.accounts.iter().any(|a| a.id == id) {
            return Err("нет такого аккаунта".into());
        }
        store.active = Some(id.to_string());
        let mut live = st.live.lock().unwrap();
        live.attention.remove(id);
        live.overlay = false;
    }
    wake(app, id).map_err(|e| e.to_string())?;
    layout(app);
    if let Some(wv) = app.get_webview(&label_of(id)) {
        let _ = wv.set_focus();
    }
    save(app);
    publish(app);
    Ok(())
}

fn cycle(app: &AppHandle, step: i64) {
    let next = {
        let st = app.state::<AppState>();
        let store = st.store.lock().unwrap();
        let n = store.accounts.len() as i64;
        if n == 0 {
            return;
        }
        let cur = store.active.as_ref().and_then(|a| store.accounts.iter().position(|x| &x.id == a)).unwrap_or(0) as i64;
        store.accounts[((cur + step).rem_euclid(n)) as usize].id.clone()
    };
    let _ = switch_to(app, &next);
}

fn by_index(app: &AppHandle, idx: usize) {
    let id = {
        let st = app.state::<AppState>();
        let store = st.store.lock().unwrap();
        store.accounts.get(idx).map(|a| a.id.clone())
    };
    if let Some(id) = id {
        let _ = switch_to(app, &id);
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// ---------- commands of the rail (local UI) ----------
// They are async so that they run off the main thread: creating a webview waits for the main thread.

#[tauri::command]
async fn get_state(app: AppHandle) -> StateView {
    snapshot(&app)
}

#[tauri::command]
async fn add_account(app: AppHandle, name: String, color: String, proxy: Option<String>) -> Result<String, String> {
    let proxy = proxy.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = proxy.as_deref() {
        store::parse_proxy(p)?;
    }
    let (name, color) = (store::clean_name(&name, 40), store::clean_color(&color));
    let id = {
        let st = app.state::<AppState>();
        let mut store = st.store.lock().unwrap();
        let id = store::new_id();
        let n = store.accounts.len() + 1;
        let name = if name.is_empty() { format!("Аккаунт {n}") } else { name };
        let mut account = Account::new(id.clone(), name, color, proxy, false);
        // a new account has no data yet: without a proxy it starts in the shared browser right away
        account.shared = account.wants_shared();
        store.accounts.push(account);
        id
    };
    save(&app);
    switch_to(&app, &id)?;
    Ok(id)
}

/// Returns true when the account has to be restarted for a new proxy to apply.
#[tauri::command]
async fn update_account(
    app: AppHandle,
    id: String,
    name: String,
    color: String,
    proxy: Option<String>,
    pinned: bool,
) -> Result<bool, String> {
    let proxy = proxy.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = proxy.as_deref() {
        store::parse_proxy(p)?;
    }
    let (name, color) = (store::clean_name(&name, 40), store::clean_color(&color));
    let proxy_changed = {
        let st = app.state::<AppState>();
        let mut store = st.store.lock().unwrap();
        let a = store.accounts.iter_mut().find(|a| a.id == id).ok_or("нет такого аккаунта")?;
        if !name.is_empty() {
            a.name = name;
        }
        a.color = color;
        a.pinned = pinned;
        let changed = a.proxy != proxy;
        a.proxy = proxy;
        // with a proxy now (or none any more) it moves between the shared browser and one of its own at the
        // next start of Hovi Space (store::prepare_profiles)
        let moves = a.shared != a.wants_shared();
        (changed, moves)
    };
    let (proxy_changed, moves) = proxy_changed;
    save(&app);
    publish(&app);
    // WebView2 takes the proxy when the account's browser starts, so a running account keeps the old one
    Ok(proxy_changed && (moves || app.get_webview(&label_of(&id)).is_some()))
}

#[tauri::command]
async fn remove_account(app: AppHandle, id: String) -> Result<(), String> {
    sleep(&app, &id);
    let next = {
        let st = app.state::<AppState>();
        let mut store = st.store.lock().unwrap();
        store.accounts.retain(|a| a.id != id);
        store.pending_delete.push(id.clone());
        let prefix = format!("{id}|");
        store.chat_labels.retain(|k, _| !k.starts_with(&prefix));
        store.meta.forget_account(&id);
        store.sent.remove(&id);
        let mut live = st.live.lock().unwrap();
        live.unread.remove(&id);
        live.attention.remove(&id);
        live.feed.clear(Some(&id));
        live.chats.remove(&id);
        if store.active.as_deref() == Some(id.as_str()) {
            store.active = None;
            store.accounts.first().map(|a| a.id.clone())
        } else {
            None
        }
    };
    save(&app);
    // the account's browser process lets go of its files a little after the close
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        store::purge_deleted(&app2);
    });
    if let Some(next) = next {
        switch_to(&app, &next)?;
    } else {
        layout(&app);
        publish(&app);
    }
    Ok(())
}

#[tauri::command]
async fn move_account(app: AppHandle, id: String, delta: i64) -> Result<(), String> {
    {
        let st = app.state::<AppState>();
        let mut store = st.store.lock().unwrap();
        let n = store.accounts.len() as i64;
        let Some(i) = store.accounts.iter().position(|a| a.id == id) else { return Ok(()) };
        let j = (i as i64 + delta).clamp(0, n - 1) as usize;
        let a = store.accounts.remove(i);
        store.accounts.insert(j, a);
    }
    save(&app);
    publish(&app);
    Ok(())
}

#[tauri::command]
async fn switch_account(app: AppHandle, id: String) -> Result<(), String> {
    switch_to(&app, &id)
}

#[tauri::command]
async fn reload_account(app: AppHandle, id: String) -> Result<(), String> {
    match app.get_webview(&label_of(&id)) {
        Some(wv) => wv.reload().map_err(|e| e.to_string()),
        None => switch_to(&app, &id),
    }
}

#[tauri::command]
async fn sleep_account(app: AppHandle, id: String) -> Result<(), String> {
    let active = app.state::<AppState>().store.lock().unwrap().active.clone();
    if active.as_deref() == Some(id.as_str()) {
        return Err("Открытый аккаунт не усыпляется".into());
    }
    sleep(&app, &id);
    publish(&app);
    Ok(())
}

/// Opens a feed row: switches to its account and clicks the page's notification, which in Gem Space
/// opens the chat. The row leaves the feed.
#[tauri::command]
async fn feed_open(app: AppHandle, key: u64) -> Result<(), String> {
    let item = app.state::<AppState>().live.lock().unwrap().feed.take(key);
    let Some(item) = item else {
        publish(&app);
        return Ok(());
    };
    switch_to(&app, &item.account)?;
    if !item.nid.is_empty() && item.nid.chars().all(|c| c.is_ascii_alphanumeric()) {
        if let Some(wv) = app.get_webview(&label_of(&item.account)) {
            let _ = wv.eval(format!("window.__gemspaceOpen && window.__gemspaceOpen('{}')", item.nid));
        }
    }
    Ok(())
}

/// Opens a chat from "Все чаты": switches to its account and clicks the chat's row in the page.
#[tauri::command]
async fn chat_open(app: AppHandle, account: String, name: String) -> Result<(), String> {
    switch_to(&app, &account)?;
    let panel = app.state::<AppState>().live.lock().unwrap().panel;
    if let (Some(wv), Ok(js_name)) = (app.get_webview(&label_of(&account)), serde_json::to_string(&name)) {
        let _ = wv.eval(format!("{}window.__gemspaceOpenChat && window.__gemspaceOpenChat({js_name})", focus_js(panel)));
    }
    Ok(())
}

/// One message of a broadcast (рассылка) the user started in "Все чаты": the rail calls this for each chat
/// it picked, with its own random pauses in between. Only a chat the account's page lists (never a new
/// contact), only within the account's daily limit; the account is shown while its page opens the chat,
/// types the text and sends it (shared/chats.js, `__gemspaceSend`). Returns how many it sent today.
#[tauri::command]
async fn broadcast_send(app: AppHandle, account: String, name: String, text: String) -> Result<u32, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Пустой текст".into());
    }
    if text.chars().count() > 4000 {
        return Err("Текст длиннее 4000 знаков".into());
    }
    {
        let st = app.state::<AppState>();
        let live = st.live.lock().unwrap();
        if !live.chats.get(&account).is_some_and(|rows| rows.iter().any(|c| c.name == name)) {
            return Err("Этого чата нет в списке аккаунта".into());
        }
        if live.waiters.values().any(|(a, _)| *a == account) {
            return Err("Аккаунт ещё отправляет предыдущее сообщение".into());
        }
    }
    {
        let st = app.state::<AppState>();
        let mut store = st.store.lock().unwrap();
        let today = chrono_day();
        if store.sent_day != today {
            store.sent_day = today;
            store.sent.clear();
        }
        let n = store.sent.get(&account).copied().unwrap_or(0);
        if n >= store.settings.bc_limit {
            return Err(format!("Дневной лимит аккаунта исчерпан ({n})"));
        }
    }
    switch_to(&app, &account)?;
    let wv = app.get_webview(&label_of(&account)).ok_or("Аккаунт не загружен")?;
    // an account woken up for this message has no Gem Space page yet to send it
    let started = std::time::Instant::now();
    while !app.state::<AppState>().live.lock().unwrap().loaded.contains(&account) {
        if started.elapsed() > std::time::Duration::from_secs(30) {
            return Err("Страница аккаунта не загрузилась".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let token = store::new_id();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let panel = {
        let st = app.state::<AppState>();
        let mut live = st.live.lock().unwrap();
        live.waiters.insert(token.clone(), (account.clone(), tx));
        live.panel
    };
    let q = |v: &str| serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into());
    let (jn, jt, jk) = (q(&name), q(&text), q(&token));
    let js = format!(
        "{}if (window.__gemspaceSend) window.__gemspaceSend({jn}, {jt}, {jk}); \
         else if (window.__gemspaceSent) window.__gemspaceSent({{ token: {jk}, ok: false, error: 'Страница ещё не загрузилась' }});",
        focus_js(panel)
    );
    let _ = wv.eval(js);
    // the page waits up to 20 s for its chat list, then opens the chat, types and sends
    let answer = tokio::time::timeout(std::time::Duration::from_secs(60), rx).await;
    app.state::<AppState>().live.lock().unwrap().waiters.remove(&token);
    match answer {
        Ok(Ok((true, _))) => {
            let n = {
                let st = app.state::<AppState>();
                let mut store = st.store.lock().unwrap();
                let n = store.sent.entry(account).or_insert(0);
                *n += 1;
                *n
            };
            save(&app);
            publish(&app);
            Ok(n)
        }
        Ok(Ok((false, error))) => Err(if error.is_empty() { "Не отправлено".into() } else { error.chars().take(200).collect() }),
        _ => Err("Страница не ответила".into()),
    }
}

/// The page's answer for one broadcast message (shared/chats.js via inject.js).
#[tauri::command]
async fn acc_sent(app: AppHandle, webview: Webview, token: String, ok: bool, error: String) {
    let Some(id) = id_of(webview.label()) else { return };
    let st = app.state::<AppState>();
    let mut live = st.live.lock().unwrap();
    // only the page the message went to can answer for it
    if live.waiters.get(&token).is_some_and(|(a, _)| a == id) {
        if let Some((_, tx)) = live.waiters.remove(&token) {
            let _ = tx.send((ok, error));
        }
    }
}

/// Saves the labels and which chats carry them (the rail edits them, Rust only keeps them tidy).
#[tauri::command]
async fn set_labels(app: AppHandle, labels: Vec<Label>, chat_labels: BTreeMap<String, Vec<String>>) {
    let (labels, chat_labels) = store::clean_labels(labels, chat_labels);
    {
        let st = app.state::<AppState>();
        let mut store = st.store.lock().unwrap();
        store.labels = labels;
        store.chat_labels = chat_labels;
    }
    save(&app);
    publish(&app);
}

/// Gives each loaded account's page what changed for its menus (see page_meta).
fn push_meta(app: &AppHandle) {
    let Some(window) = main_window(app) else { return };
    let st = app.state::<AppState>();
    let store = st.store.lock().unwrap().clone();
    for wv in window.webviews() {
        let Some(id) = id_of(wv.label()).map(str::to_string) else { continue };
        let json = crm::page_meta(&store.meta, &store.templates, &id).to_string();
        let fresh = st.live.lock().unwrap().meta_sent.get(&id) != Some(&json);
        if fresh {
            let _ = wv.eval(format!("window.__hoviMeta && window.__hoviMeta({json});"));
            st.live.lock().unwrap().meta_sent.insert(id, json);
        }
    }
}

/// A change made in Gem Space's own menus (shared/crm.js via inject.js), see crm::MetaEdit.
#[tauri::command]
async fn acc_meta(app: AppHandle, webview: Webview, edit: crm::MetaEdit) {
    let Some(id) = id_of(webview.label()).map(str::to_string) else { return };
    if edit.get {
        app.state::<AppState>().live.lock().unwrap().meta_sent.remove(&id);
        push_meta(&app);
        return;
    }
    {
        let st = app.state::<AppState>();
        let mut store = st.store.lock().unwrap();
        if !store.accounts.iter().any(|a| a.id == id) {
            return;
        }
        store.meta = store.meta.clone().apply(&id, &edit);
        if let Some(templates) = edit.templates {
            store.templates = crm::clean_templates(templates);
        }
    }
    save(&app);
    publish(&app);
    remind_due(&app);
}

/// Saves the notes, statuses and reminders of chats (the rail edits them, Rust keeps them tidy).
#[tauri::command]
async fn set_chat_meta(app: AppHandle, meta: ChatMeta) {
    {
        let st = app.state::<AppState>();
        st.store.lock().unwrap().meta = meta.clean();
    }
    save(&app);
    publish(&app);
    remind_due(&app);
}

/// Saves the quick-reply templates.
#[tauri::command]
async fn set_templates(app: AppHandle, templates: Vec<Template>) {
    {
        let st = app.state::<AppState>();
        st.store.lock().unwrap().templates = crm::clean_templates(templates);
    }
    save(&app);
    publish(&app);
}

/// Puts a template's text into the message field of a chat and never sends it: of the chat open in the
/// account (`name` None: the open account's open chat) or of the chat `name` of the list, which its page
/// opens first (shared/chats.js, `__gemspaceInsert`). The account's page gets the keyboard afterwards, so
/// the user can change the text and press Enter.
#[tauri::command]
async fn template_insert(app: AppHandle, account: Option<String>, name: Option<String>, text: String) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Пустой шаблон".into());
    }
    if text.chars().count() > crm::TEMPLATE_MAX {
        return Err("Текст длиннее 4000 знаков".into());
    }
    let account = match account {
        Some(a) => a,
        None => app.state::<AppState>().store.lock().unwrap().active.clone().ok_or("Сначала откройте аккаунт")?,
    };
    let names: Vec<String> = {
        let st = app.state::<AppState>();
        let live = st.live.lock().unwrap();
        let rows = live.chats.get(&account).cloned().unwrap_or_default();
        if let Some(n) = &name {
            if !rows.iter().any(|c| &c.name == n) {
                return Err("Этого чата нет в списке аккаунта".into());
            }
        }
        if live.waiters.values().any(|(a, _)| *a == account) {
            return Err("Аккаунт ещё занят предыдущим сообщением".into());
        }
        rows.into_iter().map(|c| c.name).collect()
    };
    switch_to(&app, &account)?;
    let wv = app.get_webview(&label_of(&account)).ok_or("Аккаунт не загружен")?;
    let started = std::time::Instant::now();
    while !app.state::<AppState>().live.lock().unwrap().loaded.contains(&account) {
        if started.elapsed() > std::time::Duration::from_secs(30) {
            return Err("Страница аккаунта не загрузилась".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let token = store::new_id();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let panel = {
        let st = app.state::<AppState>();
        let mut live = st.live.lock().unwrap();
        live.waiters.insert(token.clone(), (account.clone(), tx));
        live.panel
    };
    let j = |v: &serde_json::Value| serde_json::to_string(v).unwrap_or_else(|_| "null".into());
    let (jn, jt, jl, jk) = (
        j(&name.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)),
        j(&serde_json::Value::String(text)),
        j(&serde_json::Value::from(names)),
        j(&serde_json::Value::String(token.clone())),
    );
    let _ = wv.eval(format!(
        "{}if (window.__gemspaceInsert) window.__gemspaceInsert({jn}, {jt}, {jl}, {jk}); \
         else if (window.__gemspaceSent) window.__gemspaceSent({{ token: {jk}, ok: false, error: 'Страница ещё не загрузилась' }});",
        focus_js(panel)
    ));
    let answer = tokio::time::timeout(std::time::Duration::from_secs(45), rx).await;
    app.state::<AppState>().live.lock().unwrap().waiters.remove(&token);
    let _ = wv.set_focus();
    match answer {
        Ok(Ok((true, _))) => Ok(()),
        Ok(Ok((false, error))) => Err(if error.is_empty() { "Не вставлено".into() } else { error.chars().take(200).collect() }),
        _ => Err("Страница не ответила".into()),
    }
}

/// Announces reminders that came due with a system notification (even with message notifications off: the
/// user set them), once for each time they were set for. The rail shows them as due until they are moved,
/// removed, or their chat is opened from "Все чаты".
fn remind_due(app: &AppHandle) {
    let now = feed::now_ms() as i64;
    let st = app.state::<AppState>();
    let (due, store) = {
        let store = st.store.lock().unwrap().clone();
        let live = st.live.lock().unwrap();
        (crm::due(&store.meta.reminders, &live.told, now), store)
    };
    if due.is_empty() {
        return;
    }
    for key in &due {
        let Some(at) = store.meta.reminders.get(key).copied() else { continue };
        st.live.lock().unwrap().told.insert(key.clone(), at);
        let Some((acc, chat)) = key.split_once('|') else { continue };
        let account = store.accounts.iter().find(|a| a.id == acc).map(|a| a.name.clone()).unwrap_or_default();
        let note = store.meta.notes.get(key).map(|n| n.lines().next().unwrap_or("").chars().take(120).collect::<String>());
        let body = match note {
            Some(n) if !n.is_empty() => format!("{chat}\n{n}"),
            _ => chat.to_string(),
        };
        let _ = app.notification().builder().title(format!("Напоминание · {account}")).body(body).show();
    }
    if let Some(w) = main_window(app) {
        if !w.is_focused().unwrap_or(false) {
            let _ = w.request_user_attention(Some(UserAttentionType::Informational));
        }
    }
}

/// Writes the backup file where the user picks; returns its path, or None when the dialog was closed.
#[tauri::command]
async fn backup_export(app: AppHandle) -> Result<Option<String>, String> {
    let day = chrono_day();
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Сохранить резервную копию")
        .set_file_name(format!("Hovi Space {day}.json"))
        .add_filter("Резервная копия Hovi Space", &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let backup = app.state::<AppState>().store.lock().unwrap().backup();
    let json = serde_json::to_vec_pretty(&backup).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Не удалось записать файл: {e}"))?;
    Ok(Some(path.display().to_string()))
}

/// Reads a backup file the user picks and adds its accounts, settings and labels; returns what changed.
#[tauri::command]
async fn backup_import(app: AppHandle) -> Result<Option<String>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Восстановить из резервной копии")
        .add_filter("Резервная копия Hovi Space", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 5_000_000 {
        return Err("Файл слишком большой для резервной копии Hovi Space".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Не удалось прочитать файл: {e}"))?;
    let backup: store::Backup = serde_json::from_str(&text).map_err(|_| "Это не резервная копия Hovi Space".to_string())?;
    let (added, updated) = app.state::<AppState>().store.lock().unwrap().restore(backup)?;
    save(&app);
    apply_scale(&app);
    enforce_sleep(&app);
    publish(&app);
    Ok(Some(match (added, updated) {
        (0, 0) => "В файле нет аккаунтов, восстановлены настройки и метки.".to_string(),
        (0, u) => format!("Обновлено аккаунтов: {u}."),
        (a, 0) => format!("Добавлено аккаунтов: {a}. В них нужно войти заново."),
        (a, u) => format!("Добавлено аккаунтов: {a}, обновлено: {u}. В новые нужно войти заново."),
    }))
}

/// Today as YYYY-MM-DD in UTC, for the backup's file name.
fn chrono_day() -> String {
    let days = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64;
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Empties the feed, or only one account's rows.
#[tauri::command]
async fn feed_clear(app: AppHandle, account: Option<String>) {
    let changed = app.state::<AppState>().live.lock().unwrap().feed.clear(account.as_deref());
    if changed {
        publish(&app);
    }
}

/// Checks for a newer version now (settings); returns it, or None when this one is the newest.
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
    Ok(update::check(&app).await?.map(|u| u.version))
}

/// Installs the newer version and restarts.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    update::install(&app).await
}

#[tauri::command]
async fn set_overlay(app: AppHandle, open: bool) {
    app.state::<AppState>().live.lock().unwrap().overlay = open;
    layout(&app);
    if !open {
        let active = app.state::<AppState>().store.lock().unwrap().active.clone();
        if let Some(wv) = active.and_then(|id| app.get_webview(&label_of(&id))) {
            let _ = wv.set_focus();
        }
    }
}

/// Opens or closes the chat list column next to the rail.
#[tauri::command]
async fn set_panel(app: AppHandle, open: bool) {
    app.state::<AppState>().live.lock().unwrap().panel = open;
    layout(&app);
    if let Some(window) = main_window(&app) {
        for wv in window.webviews() {
            if id_of(wv.label()).is_some() {
                let _ = wv.eval(focus_js(open));
            }
        }
    }
}

/// While "Все чаты" is open, account pages show only the open chat (shared/chats.js, `__gemspaceFocus`).
fn focus_js(on: bool) -> String {
    format!("window.__gemspaceFocus && window.__gemspaceFocus({on});")
}

#[tauri::command]
async fn set_settings(app: AppHandle, mut settings: Settings) {
    settings.clamp();
    let rescale = {
        let st = app.state::<AppState>();
        let mut store = st.store.lock().unwrap();
        let rescale = store.settings.ui_scale != settings.ui_scale;
        store.settings = settings;
        rescale
    };
    if rescale {
        apply_scale(&app);
    }
    save(&app);
    enforce_sleep(&app);
    publish(&app);
}

#[tauri::command]
async fn hotkey(app: AppHandle, key: String) {
    handle_hotkey(&app, &key);
}

fn handle_hotkey(app: &AppHandle, key: &str) {
    match key {
        "next" => cycle(app, 1),
        "prev" => cycle(app, -1),
        "devtools" => {
            let active = app.state::<AppState>().store.lock().unwrap().active.clone();
            if let Some(wv) = active.and_then(|id| app.get_webview(&label_of(&id))) {
                wv.open_devtools();
            }
        }
        k => {
            if let Ok(n) = k.parse::<usize>() {
                if (1..=9).contains(&n) {
                    by_index(app, n - 1);
                }
            }
        }
    }
}

// ---------- commands of the account webviews (https://web.gemspace.com, see capabilities/accounts.json) ----------

#[tauri::command]
async fn acc_notify(app: AppHandle, webview: Webview, title: String, body: String, nid: Option<String>) {
    let Some(id) = id_of(webview.label()).map(str::to_string) else { return };
    let (account, settings, active) = {
        let st = app.state::<AppState>();
        let store = st.store.lock().unwrap();
        (store.accounts.iter().find(|a| a.id == id).cloned(), store.settings.clone(), store.active.clone())
    };
    let Some(account) = account else { return };
    let added = {
        let st = app.state::<AppState>();
        let mut live = st.live.lock().unwrap();
        live.feed.push(&id, &title, &body, nid.as_deref().unwrap_or(""), feed::now_ms())
    };
    if !added {
        return;
    }
    let focused = main_window(&app).and_then(|w| w.is_focused().ok()).unwrap_or(false);
    if active.as_deref() != Some(id.as_str()) {
        app.state::<AppState>().live.lock().unwrap().attention.insert(id.clone());
    }
    publish(&app);
    if focused && active.as_deref() == Some(id.as_str()) {
        return; // the user is looking at this account
    }
    if !settings.notifications {
        return;
    }
    let title = title.chars().take(120).collect::<String>();
    let body = if settings.notify_preview { body.chars().take(300).collect::<String>() } else { "Новое сообщение".into() };
    let heading = if title.is_empty() { account.name.clone() } else { format!("{} · {}", account.name, title) };
    let _ = app.notification().builder().title(heading).body(body).show();
    if !focused {
        if let Some(w) = main_window(&app) {
            let _ = w.request_user_attention(Some(UserAttentionType::Informational));
        }
    }
}

/// The chat list an account's page shows (read only, see shared/chats.js).
#[tauri::command]
async fn acc_chats(app: AppHandle, webview: Webview, chats: Vec<ChatRow>) {
    let Some(id) = id_of(webview.label()).map(str::to_string) else { return };
    let rows: Vec<ChatRow> = chats.into_iter().take(40).map(ChatRow::clean).collect();
    let mut moved_ok = false;
    let changed = {
        let st = app.state::<AppState>();
        let known = st.store.lock().unwrap().accounts.iter().any(|a| a.id == id);
        let mut live = st.live.lock().unwrap();
        if !rows.is_empty() && live.migrating.remove(&id) {
            moved_ok = true;
        }
        if let Some(visit) = live.patrol.get_mut(&id) {
            visit.1 |= !rows.is_empty();
        }
        known && live.chats.get(&id) != Some(&rows) && { live.chats.insert(id.clone(), rows); true }
    };
    if moved_ok {
        // its sign-in came along to the shared browser: the old folder can go
        diag(&app, &id, "shared browser: still signed in, the old folder is deleted");
        {
            let st = app.state::<AppState>();
            let mut store = st.store.lock().unwrap();
            if !store.legacy_cleanup.contains(&id) {
                store.legacy_cleanup.push(id.clone());
            }
        }
        save(&app);
        let app2 = app.clone();
        std::thread::spawn(move || store::purge_deleted(&app2));
    }
    // a page that loaded while "Все чаты" was open gets the same view as the others
    if app.state::<AppState>().live.lock().unwrap().panel {
        let _ = webview.eval(focus_js(true));
    }
    if changed {
        publish(&app);
    }
}

/// The page an account shows a while after it loaded (inject.js), to see whether a sign-in moved to the shared
/// browser is still there. On Gem Space's sign-in page it is not: the account goes back to its own browser,
/// where its sign-in still is, and stays there.
#[tauri::command]
async fn acc_page(app: AppHandle, webview: Webview, path: String) {
    let Some(id) = id_of(webview.label()).map(str::to_string) else { return };
    if !path.starts_with("/login") {
        return;
    }
    let st = app.state::<AppState>();
    if !st.live.lock().unwrap().migrating.remove(&id) {
        return;
    }
    diag(&app, &id, "shared browser: the sign-in did not come along, back to its own browser");
    {
        let mut store = st.store.lock().unwrap();
        let Some(a) = store.accounts.iter_mut().find(|a| a.id == id) else { return };
        a.shared = false;
        a.own_browser = true;
        if !store.profile_cleanup.contains(&id) {
            store.profile_cleanup.push(id.clone());
        }
    }
    save(&app);
    sleep(&app, &id);
    let active = st.store.lock().unwrap().active.clone();
    if active.as_deref() == Some(id.as_str()) {
        let _ = switch_to(&app, &id);
    } else {
        publish(&app);
    }
}

/// Lines of the sign-in report from a page that is not signed in yet (inject.js).
#[tauri::command]
async fn acc_log(app: AppHandle, webview: Webview, lines: Vec<String>) {
    let Some(id) = id_of(webview.label()).map(str::to_string) else { return };
    for line in lines.iter().take(200) {
        diag(&app, &id, line);
    }
}

/// Saves the sign-in report to a text file the user picks, to send it for a look.
#[tauri::command]
async fn login_report(app: AppHandle) -> Result<Option<String>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .set_title("Сохранить отчёт о входе")
        .set_file_name(format!("Hovi Space вход {}.txt", chrono_day()))
        .add_filter("Текст", &["txt"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let names: Vec<String> = {
        let st = app.state::<AppState>();
        let store = st.store.lock().unwrap();
        store.accounts.iter().map(|a| format!("[{}] {}{}", a.id, a.name, if a.proxy.is_some() { " (прокси)" } else { "" })).collect()
    };
    let mut text = format!(
        "Hovi Space {} · {} · WebView2 {}\nВремя в отчёте UTC.\n{}\n\n",
        app.package_info().version,
        std::env::consts::OS,
        tauri::webview_version().unwrap_or_default(),
        names.join("\n")
    );
    for line in app.state::<AppState>().live.lock().unwrap().diag.iter() {
        text.push_str(line);
        text.push('\n');
    }
    std::fs::write(&path, text).map_err(|e| format!("Не удалось записать файл: {e}"))?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
async fn acc_hotkey(app: AppHandle, key: String) {
    handle_hotkey(&app, &key);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        // links are opened by Rust (open_external, on_new_window of the accounts), not by the plugin's own
        // click handler in every page: the Gem Space pages may not call the plugin (ACL), so their links
        // (the Telegram bot link of the sign-in) went nowhere through it
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_state,
            add_account,
            update_account,
            remove_account,
            move_account,
            switch_account,
            reload_account,
            sleep_account,
            set_overlay,
            set_settings,
            feed_open,
            feed_clear,
            check_update,
            install_update,
            hotkey,
            chat_open,
            set_panel,
            acc_notify,
            acc_chats,
            acc_hotkey,
            set_labels,
            backup_export,
            backup_import,
            broadcast_send,
            acc_sent,
            acc_log,
            acc_meta,
            acc_page,
            login_report,
            set_chat_meta,
            set_templates,
            template_insert
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let store = Store::load(&handle);
            app.manage(AppState { store: Mutex::new(store), live: Mutex::new(Live::default()) });
            store::purge_deleted(&handle);
            let (moved, moves) = store::prepare_profiles(&handle);
            for (id, line) in moves {
                diag(&handle, &id, &line);
            }
            handle.state::<AppState>().live.lock().unwrap().migrating.extend(moved);
            update::start_checks(handle.clone());
            // reminders of chats: checked every 15 seconds while Hovi Space runs, and at once after a start
            let app_remind = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(15));
                remind_due(&app_remind);
                memory_guard(&app_remind);
            });
            // the patrol of sleeping accounts, every 5 seconds; it creates webviews, so not on the main thread
            let app_patrol = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(5));
                patrol(&app_patrol);
            });

            let window = WindowBuilder::new(app, MAIN)
                .title("Hovi Space")
                .inner_size(1280.0, 820.0)
                .min_inner_size(760.0, 480.0)
                .build()?;
            if let Some(icon) = app.default_window_icon().cloned() {
                let _ = window.set_icon(icon);
            }
            let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
            let rail = window.add_child(
                WebviewBuilder::new(RAIL, WebviewUrl::App("index.html".into())).devtools(false),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(rail_width(&handle), size.height),
            )?;
            let z = ui_scale(&handle);
            if (z - 1.0).abs() > f64::EPSILON {
                let _ = rail.set_zoom(z);
            }

            let show = MenuItem::with_id(app, "show", "Открыть Hovi Space", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("tray").tooltip("Hovi Space").menu(&menu).show_menu_on_left_click(false);
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.on_menu_event(|app, ev| match ev.id().as_ref() {
                "show" => show_main(app),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, ev| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                    show_main(tray.app_handle());
                }
            })
            .build(app)?;

            window.on_window_event({
                let app = handle.clone();
                move |ev| match ev {
                    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => layout(&app),
                    WindowEvent::CloseRequested { api, .. } => {
                        let to_tray = app.state::<AppState>().store.lock().unwrap().settings.close_to_tray;
                        if to_tray {
                            api.prevent_close();
                            if let Some(w) = main_window(&app) {
                                let _ = w.hide();
                            }
                        } else {
                            app.exit(0);
                        }
                    }
                    WindowEvent::Focused(true) => {
                        let st = app.state::<AppState>();
                        let active = st.store.lock().unwrap().active.clone();
                        if let Some(id) = active {
                            if st.live.lock().unwrap().attention.remove(&id) {
                                publish(&app);
                            }
                        }
                    }
                    _ => {}
                }
            });

            // open the last used account (or the first one) off the main thread
            let app2 = handle.clone();
            std::thread::spawn(move || {
                let first = {
                    let st = app2.state::<AppState>();
                    let store = st.store.lock().unwrap();
                    store
                        .active
                        .clone()
                        .filter(|a| store.accounts.iter().any(|x| &x.id == a))
                        .or_else(|| store.accounts.first().map(|a| a.id.clone()))
                };
                match first {
                    Some(id) => {
                        let _ = switch_to(&app2, &id);
                    }
                    None => {
                        layout(&app2);
                        publish(&app2);
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hovi Space");
}

#[cfg(test)]
mod tests {
    use super::{recovery_for, unread_from_title, Recovery};

    #[test]
    fn page_failures() {
        assert_eq!(recovery_for(1, 1), Recovery::Reload);
        assert_eq!(recovery_for(2, 3), Recovery::Reload);
        assert_eq!(recovery_for(0, 1), Recovery::Restart);
        assert_eq!(recovery_for(1, 4), Recovery::Sleep);
        assert_eq!(recovery_for(0, 4), Recovery::Sleep);
        assert_eq!(recovery_for(6, 9), Recovery::Nothing);
        assert_eq!(recovery_for(3, 1), Recovery::Nothing);
    }

    #[test]
    fn unread_counts() {
        assert_eq!(unread_from_title("Gem Space"), 0);
        assert_eq!(unread_from_title("(3) Gem Space"), 3);
        assert_eq!(unread_from_title("12 · Gem Space"), 12);
        assert_eq!(unread_from_title("4G chat"), 0);
    }
}
