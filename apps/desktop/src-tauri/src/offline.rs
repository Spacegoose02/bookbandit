//! Books saved on this PC for offline reading, and reading positions waiting to upload.
//!
//! Layout under the app data folder:
//!
//! ```text
//! offline/index.json         who was signed in last, the saved books, pending positions
//! offline/<bookId>/book.epub the file (or .pdf/.cbz/...)
//! offline/<bookId>/cover     the cover image, when the book has one
//! ```
//!
//! Content lock: every saved book remembers who saved it, and the offline library only shows the
//! books saved by the person who was signed in last. A download is made with that person's own
//! sign-in, so the server's content lock already decided they may see it; on every sync each saved
//! book is checked again and removed if the server now answers 404 (re-rated, removed, locked).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub id: String,
    pub display_name: String,
    pub role: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalProgress {
    pub locator: Value,
    pub percent: f64,
    pub finished: bool,
    /// Device clock, ms.
    pub updated_at: i64,
    pub device_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OfflineBook {
    pub book_id: String,
    pub owner_id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub format: String,
    pub file_name: String,
    pub has_cover: bool,
    pub size_bytes: u64,
    pub saved_at: i64,
    pub progress: Option<LocalProgress>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingProgress {
    pub owner_id: String,
    pub book_id: String,
    pub progress: LocalProgress,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub last_user: Option<UserInfo>,
    pub books: Vec<OfflineBook>,
    pub pending: Vec<PendingProgress>,
}

pub struct Store {
    dir: PathBuf,
    index: Mutex<Index>,
}

impl Store {
    pub fn open(dir: PathBuf) -> Store {
        let index = fs::read(dir.join("index.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Store { dir, index: Mutex::new(index) }
    }

    fn save(&self, index: &Index) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let tmp = self.dir.join("index.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&tmp, self.dir.join("index.json")).map_err(|e| e.to_string())
    }

    /// Runs `f` on the index and writes it back.
    pub fn update<T>(&self, f: impl FnOnce(&mut Index) -> T) -> Result<T, String> {
        let mut idx = self.index.lock().map_err(|_| "offline store is unavailable".to_string())?;
        let out = f(&mut idx);
        self.save(&idx)?;
        Ok(out)
    }

    pub fn read<T>(&self, f: impl FnOnce(&Index) -> T) -> T {
        let idx = self.index.lock().unwrap_or_else(|e| e.into_inner());
        f(&idx)
    }

    pub fn book_dir(&self, book_id: &str) -> PathBuf {
        self.dir.join(safe_segment(book_id))
    }

    /// The saved books the last signed-in person may open, newest first.
    pub fn visible_books(&self) -> (Option<UserInfo>, Vec<OfflineBook>) {
        self.read(|i| {
            let Some(user) = i.last_user.clone() else { return (None, vec![]) };
            let mut books: Vec<_> = i.books.iter().filter(|b| b.owner_id == user.id).cloned().collect();
            books.sort_by_key(|b| -b.progress.as_ref().map(|p| p.updated_at).unwrap_or(b.saved_at));
            (Some(user), books)
        })
    }

    /// One saved book, only if the last signed-in person saved it.
    pub fn visible_book(&self, book_id: &str) -> Option<OfflineBook> {
        self.visible_books().1.into_iter().find(|b| b.book_id == book_id)
    }

    pub fn put_book(&self, book: OfflineBook) -> Result<(), String> {
        self.update(|i| {
            i.books.retain(|b| !(b.book_id == book.book_id && b.owner_id == book.owner_id));
            i.books.push(book);
        })
    }

    /// Forgets a person's copy; deletes the files once nobody on this PC has the book saved.
    pub fn remove_book(&self, owner_id: &str, book_id: &str) -> Result<(), String> {
        let still_used = self.update(|i| {
            i.books.retain(|b| !(b.book_id == book_id && b.owner_id == owner_id));
            i.pending.retain(|p| !(p.book_id == book_id && p.owner_id == owner_id));
            i.books.iter().any(|b| b.book_id == book_id)
        })?;
        if !still_used {
            let _ = fs::remove_dir_all(self.book_dir(book_id));
        }
        Ok(())
    }

    /// Saves a position read offline and queues it for upload. Older positions are ignored.
    pub fn record_progress(&self, owner_id: &str, book_id: &str, p: LocalProgress) -> Result<(), String> {
        self.update(|i| {
            let Some(b) = i.books.iter_mut().find(|b| b.book_id == book_id && b.owner_id == owner_id) else {
                return;
            };
            if b.progress.as_ref().is_some_and(|cur| cur.updated_at > p.updated_at) {
                return;
            }
            b.progress = Some(p.clone());
            i.pending.retain(|x| !(x.book_id == book_id && x.owner_id == owner_id));
            i.pending.push(PendingProgress { owner_id: owner_id.into(), book_id: book_id.into(), progress: p });
        })
    }

    /// A newer position from the server (read on another device) replaces the local one.
    pub fn apply_server_progress(&self, owner_id: &str, book_id: &str, p: LocalProgress) -> Result<(), String> {
        self.update(|i| {
            if let Some(b) = i.books.iter_mut().find(|b| b.book_id == book_id && b.owner_id == owner_id) {
                if b.progress.as_ref().map_or(true, |cur| p.updated_at > cur.updated_at) {
                    b.progress = Some(p);
                }
            }
        })
    }
}

/// Book ids are UUIDs; anything else is reduced to a safe folder name.
pub fn safe_segment(id: &str) -> String {
    let s: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
    if s.is_empty() { "_".into() } else { s }
}

pub fn file_name_for(format: &str) -> String {
    format!("book.{}", safe_segment(&format.to_ascii_lowercase()))
}

pub fn read_file(dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    fs::read(dir.join(name)).map_err(|e| format!("Couldn't open the saved copy: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("bb-offline-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn book(id: &str, owner: &str) -> OfflineBook {
        OfflineBook {
            book_id: id.into(),
            owner_id: owner.into(),
            title: id.into(),
            authors: vec![],
            format: "epub".into(),
            file_name: "book.epub".into(),
            has_cover: false,
            size_bytes: 1,
            saved_at: 1,
            progress: None,
        }
    }

    fn prog(at: i64) -> LocalProgress {
        LocalProgress { locator: json!({"kind":"epub","cfi":"x","percent":0.5}), percent: 0.5, finished: false, updated_at: at, device_name: None }
    }

    fn user(id: &str) -> UserInfo {
        UserInfo { id: id.into(), display_name: id.into(), role: "kid".into() }
    }

    #[test]
    fn only_shows_the_last_readers_books() {
        let s = Store::open(tmp());
        s.put_book(book("adult-book", "mom")).unwrap();
        s.put_book(book("kid-book", "mia")).unwrap();
        assert!(s.visible_books().1.is_empty(), "nobody signed in yet");
        s.update(|i| i.last_user = Some(user("mia"))).unwrap();
        let (_, books) = s.visible_books();
        assert_eq!(books.iter().map(|b| b.book_id.as_str()).collect::<Vec<_>>(), vec!["kid-book"]);
        assert!(s.visible_book("adult-book").is_none());
    }

    #[test]
    fn queues_newest_progress_and_survives_reopen() {
        let dir = tmp();
        let s = Store::open(dir.clone());
        s.put_book(book("b1", "mia")).unwrap();
        s.record_progress("mia", "b1", prog(10)).unwrap();
        s.record_progress("mia", "b1", prog(5)).unwrap(); // older, ignored
        s.record_progress("dad", "b1", prog(20)).unwrap(); // not dad's copy
        let s = Store::open(dir);
        s.read(|i| {
            assert_eq!(i.pending.len(), 1);
            assert_eq!(i.pending[0].progress.updated_at, 10);
            assert_eq!(i.books[0].progress.as_ref().unwrap().updated_at, 10);
        });
        s.apply_server_progress("mia", "b1", prog(8)).unwrap();
        assert_eq!(s.read(|i| i.books[0].progress.as_ref().unwrap().updated_at), 10);
        s.apply_server_progress("mia", "b1", prog(30)).unwrap();
        assert_eq!(s.read(|i| i.books[0].progress.as_ref().unwrap().updated_at), 30);
    }

    #[test]
    fn removes_files_when_no_one_has_the_book() {
        let s = Store::open(tmp());
        fs::create_dir_all(s.book_dir("b1")).unwrap();
        s.put_book(book("b1", "mia")).unwrap();
        s.put_book(book("b1", "dad")).unwrap();
        s.remove_book("mia", "b1").unwrap();
        assert!(s.book_dir("b1").exists());
        s.remove_book("dad", "b1").unwrap();
        assert!(!s.book_dir("b1").exists());
    }

    #[test]
    fn keeps_folder_names_safe() {
        assert_eq!(safe_segment("../../etc"), "etc");
        assert_eq!(safe_segment("5f0c-1a"), "5f0c-1a");
        assert_eq!(file_name_for("EPUB"), "book.epub");
    }
}
