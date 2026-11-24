fn main() {
    // App commands get ACL permissions (allow-<command>), so the remote Gem Space pages
    // can be given only acc_notify and acc_hotkey (capabilities/accounts.json).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "get_state",
        "add_account",
        "update_account",
        "remove_account",
        "move_account",
        "switch_account",
        "reload_account",
        "sleep_account",
        "set_overlay",
        "set_settings",
        "feed_open",
        "feed_clear",
        "check_update",
        "install_update",
        "hotkey",
        "chat_open",
        "set_panel",
        "set_labels",
        "backup_export",
        "backup_import",
        "broadcast_send",
        "acc_notify",
        "acc_chats",
        "acc_hotkey",
        "acc_sent",
        "acc_log",
        "login_report",
        "set_chat_meta",
        "set_templates",
        "template_insert",
    ])))
    .expect("failed to run tauri-build");
}
