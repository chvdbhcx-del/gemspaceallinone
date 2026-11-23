//! The shared feed: new messages of all accounts in one list, newest first.
//!
//! It is filled from the notifications the Gem Space pages show (inject.js reroutes them here),
//! so Hovi Space never reads the pages. It is read only: a row opens its account (and, when the
//! page gave the notification a click handler, the chat), replies are written in Gem Space itself.

use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// The feed keeps the latest messages only.
pub const MAX_ITEMS: usize = 200;
/// The same message shown twice (page notification and service worker) within this time is kept once.
const DUPLICATE_MS: u64 = 3000;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FeedItem {
    /// unique within this run of the app
    pub key: u64,
    pub account: String,
    pub title: String,
    pub body: String,
    /// unix time, milliseconds
    pub time: u64,
    /// the page's notification id (inject.js), used to click it; empty when the page gave none
    #[serde(skip)]
    pub nid: String,
}

#[derive(Default)]
pub struct Feed {
    items: VecDeque<FeedItem>,
    next: u64,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Feed {
    /// Adds a message on top; returns false for an immediate duplicate.
    pub fn push(&mut self, account: &str, title: &str, body: &str, nid: &str, time: u64) -> bool {
        let title: String = title.chars().take(120).collect();
        let body: String = body.chars().take(300).collect();
        if let Some(top) = self.items.iter().find(|i| i.account == account) {
            if top.title == title && top.body == body && time.saturating_sub(top.time) < DUPLICATE_MS {
                return false;
            }
        }
        self.next += 1;
        self.items.push_front(FeedItem { key: self.next, account: account.into(), title, body, time, nid: nid.into() });
        self.items.truncate(MAX_ITEMS);
        true
    }

    pub fn take(&mut self, key: u64) -> Option<FeedItem> {
        let i = self.items.iter().position(|i| i.key == key)?;
        self.items.remove(i)
    }

    /// Removes the account's messages, or all messages for None; returns whether anything went.
    pub fn clear(&mut self, account: Option<&str>) -> bool {
        let before = self.items.len();
        match account {
            Some(a) => self.items.retain(|i| i.account != a),
            None => self.items.clear(),
        }
        self.items.len() != before
    }

    pub fn items(&self) -> Vec<FeedItem> {
        self.items.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_first_and_capped() {
        let mut f = Feed::default();
        for i in 0..(MAX_ITEMS + 5) {
            assert!(f.push("a", "t", &i.to_string(), "", i as u64 * 10_000));
        }
        assert_eq!(f.items().len(), MAX_ITEMS);
        assert_eq!(f.items()[0].body, (MAX_ITEMS + 4).to_string());
    }

    #[test]
    fn duplicates_within_seconds_are_dropped() {
        let mut f = Feed::default();
        assert!(f.push("a", "Ирина", "Привет", "n1", 1000));
        assert!(!f.push("a", "Ирина", "Привет", "", 2500));
        assert!(f.push("b", "Ирина", "Привет", "", 2500));
        assert!(f.push("a", "Ирина", "Привет", "", 9000));
        assert_eq!(f.items().len(), 3);
    }

    #[test]
    fn take_and_clear() {
        let mut f = Feed::default();
        f.push("a", "1", "x", "n1", 0);
        f.push("b", "2", "y", "", 10_000);
        f.push("a", "3", "z", "", 20_000);
        let k = f.items()[1].key;
        assert_eq!(f.take(k).unwrap().title, "2");
        assert!(f.take(k).is_none());
        assert!(f.clear(Some("a")));
        assert_eq!(f.items().len(), 0);
        assert!(!f.clear(None));
    }
}
