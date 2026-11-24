//! What the user keeps about chats of "Все чаты", only on this computer: labels, a note, a status
//! ("Открыт", "Ждёт клиента", "Готово" or their own), a reminder, and the quick-reply templates.
//! Chats are keyed "<account id>|<chat name>". Everything here only checks and tidies what the rail or
//! a backup file gives; no Tauri, so it is tested on its own.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A label or a status: a name with a colour. Labels go on chats several at a time, a status one per chat.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Label {
    pub id: String,
    pub name: String,
    pub color: String,
}

/// A quick-reply template: put into the message field of the open chat, never sent by itself.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Template {
    pub id: String,
    pub title: String,
    pub text: String,
}

pub const MAX_LABELS: usize = 30;
pub const MAX_STATUSES: usize = 12;
pub const MAX_TEMPLATES: usize = 60;
pub const NOTE_MAX: usize = 1000;
pub const TEMPLATE_MAX: usize = 4000;
const MAX_CHATS: usize = 5000;

/// The statuses a new install starts with, as in Hivogram; the user can rename, recolour and delete them.
pub fn default_statuses() -> Vec<Label> {
    let s = |id: &str, name: &str, color: &str| Label { id: id.into(), name: name.into(), color: color.into() };
    vec![s("s-open", "Открыт", "#3aa0ff"), s("s-wait", "Ждёт клиента", "#ffa726"), s("s-done", "Готово", "#66bb6a")]
}

pub fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn safe_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
}

/// A colour as "#rrggbb"; anything else (it ends up in the rail's styles) becomes the first colour.
pub fn clean_color(c: &str) -> String {
    if safe_color(c) { c.to_lowercase() } else { "#3aa0ff".into() }
}

/// A name trimmed and cut to `max` characters.
pub fn clean_name(name: &str, max: usize) -> String {
    name.trim().chars().take(max).collect::<String>().trim_end().to_string()
}

fn chat_key(key: &str) -> bool {
    key.len() <= 200 && key.contains('|')
}

/// Well-formed names with colours, no repeated ids, at most `max`.
fn clean_marks(list: Vec<Label>, max: usize) -> Vec<Label> {
    let mut out: Vec<Label> = Vec::new();
    for l in list {
        let name = clean_name(&l.name, 30);
        if safe_id(&l.id) && safe_color(&l.color) && !name.is_empty() && !out.iter().any(|x| x.id == l.id) && out.len() < max {
            out.push(Label { id: l.id, name, color: l.color.to_lowercase() });
        }
    }
    out
}

/// Keeps only well-formed labels and assignments to labels that exist; trims names.
pub fn clean_labels(labels: Vec<Label>, chat_labels: BTreeMap<String, Vec<String>>) -> (Vec<Label>, BTreeMap<String, Vec<String>>) {
    let out = clean_marks(labels, MAX_LABELS);
    let mut map = BTreeMap::new();
    for (key, ids) in chat_labels.into_iter().take(MAX_CHATS) {
        if !chat_key(&key) {
            continue;
        }
        let mut ids: Vec<String> = ids.into_iter().filter(|i| out.iter().any(|l| &l.id == i)).collect();
        ids.dedup();
        if !ids.is_empty() {
            map.insert(key, ids);
        }
    }
    (out, map)
}

/// The notes, statuses and reminders of chats, as the rail saves them all together.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct ChatMeta {
    /// chat -> note
    pub notes: BTreeMap<String, String>,
    pub statuses: Vec<Label>,
    /// chat -> status id
    pub chat_status: BTreeMap<String, String>,
    /// chat -> when to remind, in ms since 1970 (UTC)
    pub reminders: BTreeMap<String, i64>,
}

impl ChatMeta {
    pub fn clean(self) -> ChatMeta {
        let notes = self
            .notes
            .into_iter()
            .filter(|(k, _)| chat_key(k))
            .map(|(k, v)| (k, v.trim().chars().take(NOTE_MAX).collect::<String>()))
            .filter(|(_, v)| !v.is_empty())
            .take(MAX_CHATS)
            .collect();
        let statuses = clean_marks(self.statuses, MAX_STATUSES);
        let chat_status = self
            .chat_status
            .into_iter()
            .filter(|(k, v)| chat_key(k) && statuses.iter().any(|s| &s.id == v))
            .take(MAX_CHATS)
            .collect();
        // a reminder in the past stays (it is due now), one past the year 2100 or before 2020 is a broken value
        let reminders = self
            .reminders
            .into_iter()
            .filter(|(k, at)| chat_key(k) && (1_577_836_800_000..4_102_444_800_000).contains(at))
            .take(MAX_CHATS)
            .collect();
        ChatMeta { notes, statuses, chat_status, reminders }
    }

    /// Drops everything of a removed account.
    pub fn forget_account(&mut self, id: &str) {
        let prefix = format!("{id}|");
        self.notes.retain(|k, _| !k.starts_with(&prefix));
        self.chat_status.retain(|k, _| !k.starts_with(&prefix));
        self.reminders.retain(|k, _| !k.starts_with(&prefix));
    }

    /// Adds a backup file's notes, statuses and reminders: the file wins for a chat both have.
    /// `rekey` gives a chat key its account's id on this device.
    pub fn merge(&mut self, other: ChatMeta, rekey: impl Fn(&str) -> Option<String>) {
        for s in other.statuses {
            match self.statuses.iter_mut().find(|x| x.id == s.id) {
                Some(x) => *x = s,
                None => self.statuses.push(s),
            }
        }
        for (k, v) in other.notes {
            if let Some(k) = rekey(&k) {
                self.notes.insert(k, v);
            }
        }
        for (k, v) in other.chat_status {
            if let Some(k) = rekey(&k) {
                self.chat_status.insert(k, v);
            }
        }
        for (k, v) in other.reminders {
            if let Some(k) = rekey(&k) {
                self.reminders.insert(k, v);
            }
        }
        *self = std::mem::take(self).clean();
    }
}

/// Templates with an id, a title and a text; a missing title is taken from the text.
pub fn clean_templates(list: Vec<Template>) -> Vec<Template> {
    let mut out: Vec<Template> = Vec::new();
    for t in list {
        let text: String = t.text.trim().chars().take(TEMPLATE_MAX).collect();
        if !safe_id(&t.id) || text.is_empty() || out.iter().any(|x| x.id == t.id) || out.len() >= MAX_TEMPLATES {
            continue;
        }
        let mut title = clean_name(&t.title, 40);
        if title.is_empty() {
            title = clean_name(&text.split_whitespace().collect::<Vec<_>>().join(" "), 40);
        }
        out.push(Template { id: t.id, title, text });
    }
    out
}

/// Adds a backup file's templates: one with the same id is replaced.
pub fn merge_templates(mine: &[Template], other: Vec<Template>) -> Vec<Template> {
    let mut all = mine.to_vec();
    for t in other {
        match all.iter_mut().find(|x| x.id == t.id) {
            Some(x) => *x = t,
            None => all.push(t),
        }
    }
    clean_templates(all)
}

/// Reminders that are due at `now` and not yet announced at that time (`told`: chat -> the time announced).
pub fn due(reminders: &BTreeMap<String, i64>, told: &BTreeMap<String, i64>, now: i64) -> Vec<String> {
    reminders.iter().filter(|(k, at)| **at <= now && told.get(*k) != Some(at)).map(|(k, _)| k.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn l(id: &str, name: &str, color: &str) -> Label {
        Label { id: id.into(), name: name.into(), color: color.into() }
    }

    #[test]
    fn meta_is_cleaned() {
        let mut m = ChatMeta { statuses: default_statuses(), ..Default::default() };
        m.statuses.push(l("bad id", "x", "#000000"));
        m.notes.insert("a|Ирина".into(), "  перезвонить в 15:00  ".into());
        m.notes.insert("a|Пусто".into(), "   ".into());
        m.notes.insert("nobar".into(), "x".into());
        m.notes.insert("a|Длинная".into(), "я".repeat(NOTE_MAX + 50));
        m.chat_status.insert("a|Ирина".into(), "s-wait".into());
        m.chat_status.insert("a|Павел".into(), "nope".into());
        m.reminders.insert("a|Ирина".into(), 1_800_000_000_000);
        m.reminders.insert("a|Павел".into(), 5);
        let m = m.clean();
        assert_eq!(m.statuses.len(), 3);
        assert_eq!(m.notes.get("a|Ирина").map(String::as_str), Some("перезвонить в 15:00"));
        assert_eq!(m.notes.get("a|Длинная").map(|s| s.chars().count()), Some(NOTE_MAX));
        assert_eq!(m.notes.len(), 2);
        assert_eq!(m.chat_status.len(), 1);
        assert_eq!(m.reminders.len(), 1);
    }

    #[test]
    fn statuses_go_with_their_chats() {
        let mut m = ChatMeta { statuses: default_statuses(), ..Default::default() };
        m.chat_status.insert("a|Ирина".into(), "s-done".into());
        m.statuses.retain(|s| s.id != "s-done");
        let m = m.clean();
        assert!(m.chat_status.is_empty());
    }

    #[test]
    fn merge_and_forget() {
        let mut mine = ChatMeta { statuses: default_statuses(), ..Default::default() };
        mine.notes.insert("a|Ирина".into(), "старая".into());
        let mut file = ChatMeta { statuses: vec![l("s-open", "В работе", "#ff0000"), l("s-vip", "VIP", "#00ff00")], ..Default::default() };
        file.notes.insert("a|Ирина".into(), "новая".into());
        file.notes.insert("old|Павел".into(), "из файла".into());
        file.chat_status.insert("old|Павел".into(), "s-vip".into());
        file.reminders.insert("old|Павел".into(), 1_800_000_000_000);
        mine.merge(file, |k| Some(k.replacen("old|", "new|", 1)));
        assert_eq!(mine.statuses.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["В работе", "Ждёт клиента", "Готово", "VIP"]);
        assert_eq!(mine.notes.get("a|Ирина").map(String::as_str), Some("новая"));
        assert_eq!(mine.chat_status.get("new|Павел").map(String::as_str), Some("s-vip"));
        assert!(mine.reminders.contains_key("new|Павел"));
        mine.forget_account("new");
        assert!(!mine.notes.contains_key("new|Павел") && mine.chat_status.is_empty() && mine.reminders.is_empty());
        assert_eq!(mine.notes.len(), 1);
    }

    #[test]
    fn templates() {
        let t = |id: &str, title: &str, text: &str| Template { id: id.into(), title: title.into(), text: text.into() };
        let list = clean_templates(vec![
            t("t1", "Привет", "Здравствуйте, {имя}!"),
            t("t1", "Дубль", "x"),
            t("t2", "", "  Счёт   отправил,\nпроверьте почту  "),
            t("t3", "Пустой", "   "),
            t("../x", "Плохой id", "текст"),
        ]);
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].title, "Счёт отправил, проверьте почту");
        assert_eq!(list[1].text, "Счёт   отправил,\nпроверьте почту");
        let merged = merge_templates(&list, vec![t("t1", "Привет!", "Добрый день, {имя}!"), t("t9", "Новый", "текст")]);
        assert_eq!(merged.iter().map(|x| x.title.as_str()).collect::<Vec<_>>(), ["Привет!", "Счёт отправил, проверьте почту", "Новый"]);
    }

    #[test]
    fn reminders_come_due_once() {
        let mut r = BTreeMap::new();
        r.insert("a|Ирина".to_string(), 1000);
        r.insert("a|Павел".to_string(), 5000);
        let mut told = BTreeMap::new();
        assert_eq!(due(&r, &told, 2000), ["a|Ирина"]);
        told.insert("a|Ирина".to_string(), 1000);
        assert!(due(&r, &told, 2000).is_empty());
        r.insert("a|Ирина".to_string(), 1500); // moved to another time: announced again
        assert_eq!(due(&r, &told, 6000), ["a|Ирина", "a|Павел"]);
    }

    #[test]
    fn names_and_colours() {
        assert_eq!(clean_name("  Продажи  ", 40), "Продажи");
        assert_eq!(clean_color("#FF4D4D"), "#ff4d4d");
        assert_eq!(clean_color("red;background:url(x)"), "#3aa0ff");
        assert!(safe_id("s-open") && !safe_id("a b"));
    }
}
