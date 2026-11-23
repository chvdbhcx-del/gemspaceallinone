//! Cloud updates on Windows, through the Tauri updater: the app reads latest.json of the newest
//! GitHub release of chvdbhcx-del/gemspaceallinone (tauri.conf.json, plugins.updater). The release job
//! writes it with the installer's signature, made with the secret TAURI_SIGNING_PRIVATE_KEY; the
//! updater installs only an installer whose signature matches the public key built into the app.
//! The rail shows "Обновить" when a newer version is out; installing restarts the app, accounts and
//! their logins stay.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::{publish, AppState, RAIL};

/// First check a little after start, then every few hours.
const FIRST_CHECK: Duration = Duration::from_secs(20);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct UpdateView {
    pub version: String,
    pub notes: String,
}

#[derive(Serialize, Clone)]
struct Progress {
    done: u64,
    total: Option<u64>,
}

/// Looks for a newer version; remembers it for the rail. Returns it, None when this is the newest.
pub async fn check(app: &AppHandle) -> Result<Option<UpdateView>, String> {
    let found = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let view = found.map(|u| UpdateView { version: u.version.clone(), notes: u.body.clone().unwrap_or_default() });
    let changed = {
        let st = app.state::<AppState>();
        let mut live = st.live.lock().unwrap();
        let changed = live.update != view;
        live.update = view.clone();
        changed
    };
    if changed {
        publish(app);
    }
    Ok(view)
}

pub fn start_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if let Err(e) = check(&app).await {
                eprintln!("gemspace: update check failed: {e}");
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// Downloads the newer version, checks its signature and runs its installer; the app restarts.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Обновлений нет, это последняя версия".to_string())?;
    let mut done: u64 = 0;
    let app_progress = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let _ = app_progress.emit_to(RAIL, "update-progress", Progress { done, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // on Windows the installer has taken over and the process is gone by now; elsewhere restart
    app.restart();
}
