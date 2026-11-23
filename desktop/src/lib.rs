//! Gemspace desktop: one window, an account rail on the left and one isolated webview per
//! Gem Space account (its own WebView2 data folder, so its own cookies and storage, and its own proxy).
//! The Gem Space web app itself is loaded unmodified from https://web.gemspace.com/.

mod feed;
mod store;
mod update;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;
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
use store::{Account, Settings, Store};

pub const GEM_URL: &str = "https://web.gemspace.com/";
const MAIN: &str = "main";
pub(crate) const RAIL: &str = "rail";
const RAIL_WIDTH: f64 = 76.0;
const ACC_PREFIX: &str = "acc-";

/// Injected into every account webview before the page's own scripts. It only reroutes the page's
/// web notifications to Gemspace (so they carry the account name) and forwards account hotkeys.
const INJECT_JS: &str = include_str!("inject.js");

#[derive(Default)]
pub(crate) struct Live {
    unread: HashMap<String, u32>,
    /// accounts that got a notification since they were last opened
    attention: HashSet<String>,
    /// loaded (awake) accounts, least recently used first
    lru: Vec<String>,
    /// the rail covers the whole window (settings, account editor, feed)
    overlay: bool,
    /// new messages of all accounts, from their notifications
    feed: Feed,
    /// a newer version found by the updater (update.rs)
    pub(crate) update: Option<update::UpdateView>,
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
        update: live.update.clone(),
        version: app.package_info().version.to_string(),
    }
}

/// Pushes the state to the rail and refreshes the window title and the tray tooltip.
pub(crate) fn publish(app: &AppHandle) {
    let view = snapshot(app);
    let _ = app.emit_to(RAIL, "state", &view);
    let title = if view.total_unread > 0 { format!("({}) Gemspace", view.total_unread) } else { "Gemspace".into() };
    if let Some(w) = main_window(app) {
        let _ = w.set_title(&title);
    }
    if let Some(tray) = app.tray_by_id("tray") {
        let tip = if view.total_unread > 0 {
            format!("Gemspace: {} непрочитанных", view.total_unread)
        } else {
            "Gemspace".into()
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
    let content_w = (size.width - RAIL_WIDTH).max(1.0);
    for wv in window.webviews() {
        let label = wv.label().to_string();
        if label == RAIL {
            let w = if overlay { size.width } else { RAIL_WIDTH };
            let _ = wv.set_position(LogicalPosition::new(0.0, 0.0));
            let _ = wv.set_size(LogicalSize::new(w, size.height));
        } else if let Some(id) = id_of(&label) {
            let _ = wv.set_position(LogicalPosition::new(RAIL_WIDTH, 0.0));
            let _ = wv.set_size(LogicalSize::new(content_w, size.height));
            if !overlay && active.as_deref() == Some(id) {
                let _ = wv.show();
            } else {
                let _ = wv.hide();
            }
        }
    }
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
    let dir = store::account_dir(app, &account.id)?;
    let app_title = app.clone();
    let app_window = app.clone();
    let app_load = app.clone();
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
        .on_new_window(move |url, _features| {
            // links from chats open in the system browser, never inside the account
            open_external(&app_window, url.as_str());
            NewWindowResponse::Deny
        })
        .on_page_load(move |_wv, payload| {
            if payload.event() == PageLoadEvent::Finished {
                publish(&app_load);
            }
        })
        .on_permission_request(|_wv, kind| match kind {
            // calls
            PermissionKind::Microphone | PermissionKind::Camera => PermissionResponse::Allow,
            // web notifications are rerouted by inject.js; the native ones would come without the account name
            PermissionKind::Notifications => PermissionResponse::Deny,
            _ => PermissionResponse::Default,
        });
    if let Some(proxy) = account.proxy.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        match store::parse_proxy(proxy) {
            Ok(url) => builder = builder.proxy_url(url),
            Err(e) => eprintln!("gemspace: bad proxy for {}: {e}", account.id),
        }
    }
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else {
        return Err(tauri::Error::WindowNotFound);
    };
    let size = size.to_logical::<f64>(scale);
    let wv = window.add_child(
        builder,
        LogicalPosition::new(RAIL_WIDTH, 0.0),
        LogicalSize::new((size.width - RAIL_WIDTH).max(1.0), size.height),
    )?;
    let _ = wv.hide();
    Ok(wv)
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
    let st = app.state::<AppState>();
    st.live.lock().unwrap().lru.retain(|x| x != id);
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
    if let Some(p) = proxy.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        store::parse_proxy(p)?;
    }
    let id = {
        let st = app.state::<AppState>();
        let mut store = st.store.lock().unwrap();
        let id = store::new_id();
        let n = store.accounts.len() + 1;
        let name = if name.trim().is_empty() { format!("Аккаунт {n}") } else { name.trim().to_string() };
        store.accounts.push(Account { id: id.clone(), name, color, proxy: proxy.filter(|p| !p.trim().is_empty()), pinned: false });
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
    let proxy = proxy.filter(|p| !p.trim().is_empty());
    if let Some(p) = proxy.as_deref() {
        store::parse_proxy(p)?;
    }
    let proxy_changed = {
        let st = app.state::<AppState>();
        let mut store = st.store.lock().unwrap();
        let a = store.accounts.iter_mut().find(|a| a.id == id).ok_or("нет такого аккаунта")?;
        if !name.trim().is_empty() {
            a.name = name.trim().to_string();
        }
        a.color = color;
        a.pinned = pinned;
        let changed = a.proxy != proxy;
        a.proxy = proxy;
        changed
    };
    save(&app);
    publish(&app);
    // WebView2 takes the proxy when the account's browser starts, so a running account keeps the old one
    Ok(proxy_changed && app.get_webview(&label_of(&id)).is_some())
}

#[tauri::command]
async fn remove_account(app: AppHandle, id: String) -> Result<(), String> {
    sleep(&app, &id);
    let next = {
        let st = app.state::<AppState>();
        let mut store = st.store.lock().unwrap();
        store.accounts.retain(|a| a.id != id);
        store.pending_delete.push(id.clone());
        let mut live = st.live.lock().unwrap();
        live.unread.remove(&id);
        live.attention.remove(&id);
        live.feed.clear(Some(&id));
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

#[tauri::command]
async fn set_settings(app: AppHandle, settings: Settings) {
    app.state::<AppState>().store.lock().unwrap().settings = settings;
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
    publish(&app);
    let focused = main_window(&app).and_then(|w| w.is_focused().ok()).unwrap_or(false);
    let visible = focused && active.as_deref() == Some(id.as_str());
    if visible {
        return;
    }
    if active.as_deref() != Some(id.as_str()) {
        app.state::<AppState>().live.lock().unwrap().attention.insert(id.clone());
        publish(&app);
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

#[tauri::command]
async fn acc_hotkey(app: AppHandle, key: String) {
    handle_hotkey(&app, &key);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
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
            acc_notify,
            acc_hotkey
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let store = Store::load(&handle);
            app.manage(AppState { store: Mutex::new(store), live: Mutex::new(Live::default()) });
            store::purge_deleted(&handle);
            update::start_checks(handle.clone());

            let window = WindowBuilder::new(app, MAIN)
                .title("Gemspace")
                .inner_size(1280.0, 820.0)
                .min_inner_size(760.0, 480.0)
                .build()?;
            if let Some(icon) = app.default_window_icon().cloned() {
                let _ = window.set_icon(icon);
            }
            let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
            window.add_child(
                WebviewBuilder::new(RAIL, WebviewUrl::App("index.html".into())),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(RAIL_WIDTH, size.height),
            )?;

            let show = MenuItem::with_id(app, "show", "Открыть Gemspace", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("tray").tooltip("Gemspace").menu(&menu).show_menu_on_left_click(false);
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
        .expect("error while running Gemspace");
}

#[cfg(test)]
mod tests {
    use super::unread_from_title;

    #[test]
    fn unread_counts() {
        assert_eq!(unread_from_title("Gem Space"), 0);
        assert_eq!(unread_from_title("(3) Gem Space"), 3);
        assert_eq!(unread_from_title("12 · Gem Space"), 12);
        assert_eq!(unread_from_title("4G chat"), 0);
    }
}
