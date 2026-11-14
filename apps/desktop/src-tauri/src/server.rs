//! Talking to the family's BookBandit server from the native side.
//!
//! Requests carry the window's own cookies for the server (session, paired-device and any
//! Tinyauth cookie), so they act as whoever is signed in in the window. Nothing here stores a
//! password or token of its own.

use crate::links::pick_readable;
use crate::offline::{file_name_for, LocalProgress, OfflineBook, Store, UserInfo};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;

pub struct Client {
    http: reqwest::Client,
    base: Url,
    cookie: String,
}

#[derive(Debug)]
pub enum ApiError {
    /// Couldn't reach the server at all (offline, wrong address).
    Unreachable(String),
    /// The server answered with an error status.
    Status(u16, String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Unreachable(e) => write!(f, "Couldn't reach the server ({e})"),
            ApiError::Status(401, _) => write!(f, "Please sign in first"),
            ApiError::Status(404, _) => write!(f, "That book isn't available to you"),
            ApiError::Status(code, msg) if msg.is_empty() => write!(f, "The server said HTTP {code}"),
            ApiError::Status(_, msg) => write!(f, "{msg}"),
        }
    }
}

type R<T> = Result<T, ApiError>;

pub fn http_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(5))
        .user_agent(concat!("BookBanditDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

impl Client {
    pub fn new(base: Url, cookie: String, timeout: Duration) -> Client {
        Client { http: http_client(timeout), base, cookie }
    }

    fn url(&self, path: &str) -> Url {
        self.base.join(path.trim_start_matches('/')).expect("api path")
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> R<reqwest::Response> {
        let req = if self.cookie.is_empty() { req } else { req.header(reqwest::header::COOKIE, &self.cookie) };
        let res = req.header("Accept", "application/json").send().await.map_err(|e| ApiError::Unreachable(e.to_string()))?;
        if res.status().is_success() {
            return Ok(res);
        }
        let code = res.status().as_u16();
        let msg = res
            .json::<Value>()
            .await
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_default();
        Err(ApiError::Status(code, msg))
    }

    pub async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> R<T> {
        let res = self.send(self.http.get(self.url(path))).await?;
        res.json().await.map_err(|e| ApiError::Unreachable(e.to_string()))
    }

    pub async fn post_json<T: for<'de> Deserialize<'de>>(&self, path: &str, body: &Value) -> R<T> {
        let res = self.send(self.http.post(self.url(path)).json(body)).await?;
        res.json().await.map_err(|e| ApiError::Unreachable(e.to_string()))
    }

    pub async fn get_bytes(&self, path: &str) -> R<Vec<u8>> {
        let res = self.send(self.http.get(self.url(path))).await?;
        res.bytes().await.map(|b| b.to_vec()).map_err(|e| ApiError::Unreachable(e.to_string()))
    }

    /// Who is signed in in the window right now.
    pub async fn me(&self) -> R<UserInfo> {
        let v: Value = self.get_json("api/users/me").await?;
        Ok(UserInfo {
            id: v["id"].as_str().unwrap_or_default().to_string(),
            display_name: v["displayName"].as_str().unwrap_or_default().to_string(),
            role: v["role"].as_str().unwrap_or_default().to_string(),
        })
    }
}

/// Checks the address is a BookBandit server (`GET /api/health` says so).
pub async fn check_server(base: &Url) -> Result<(), String> {
    let c = Client::new(base.clone(), String::new(), Duration::from_secs(8));
    match c.get_json::<Value>("api/health").await {
        Ok(v) if v["name"] == "bookbandit" => Ok(()),
        Ok(_) | Err(ApiError::Status(..)) => Err(format!("{base} answered, but it isn't a BookBandit server")),
        Err(e) => Err(format!("{e}. Check the address and that this PC is on the same network.")),
    }
}

/// Claims a pairing code; returns the device token.
pub async fn claim(base: &Url, code: &str, device_name: &str) -> Result<String, String> {
    let c = Client::new(base.clone(), String::new(), Duration::from_secs(10));
    let v: Value = c
        .post_json("api/devices/claim", &json!({ "code": code.trim(), "name": device_name }))
        .await
        .map_err(|e| e.to_string())?;
    v["deviceToken"].as_str().map(String::from).ok_or_else(|| "The server didn't send a device token".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRef {
    id: String,
    format: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorRef {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookDetail {
    id: String,
    title: String,
    cover_path: Option<String>,
    #[serde(default)]
    authors: Vec<AuthorRef>,
    #[serde(default)]
    files: Vec<FileRef>,
}

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

pub fn progress_from_record(v: &Value) -> Option<LocalProgress> {
    Some(LocalProgress {
        locator: v.get("locator")?.clone(),
        percent: v["percent"].as_f64().unwrap_or(0.0),
        finished: v["finished"].as_bool().unwrap_or(false),
        updated_at: v["clientUpdatedAt"].as_i64()?,
        device_name: v["deviceName"].as_str().map(String::from),
    })
}

/// Downloads a book (as the signed-in person) into the offline store.
pub async fn save_book(c: &Client, store: &Store, book_id: &str) -> Result<OfflineBook, String> {
    let user = c.me().await.map_err(|e| e.to_string())?;
    store.update(|i| i.last_user = Some(user.clone()))?;

    let b: BookDetail = c.get_json(&format!("api/books/{}", enc(book_id))).await.map_err(|e| e.to_string())?;
    let formats: Vec<&str> = b.files.iter().map(|f| f.format.as_str()).collect();
    let file = pick_readable(&formats)
        .map(|i| &b.files[i])
        .ok_or("This book has no file the offline reader can open (audiobooks and CBR stay online)")?;

    let bytes = c
        .get_bytes(&format!("api/books/{}/files/{}", enc(&b.id), enc(&file.id)))
        .await
        .map_err(|e| e.to_string())?;
    let dir = store.book_dir(&b.id);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let file_name = file_name_for(&file.format);
    tokio::fs::write(dir.join(&file_name), &bytes).await.map_err(|e| e.to_string())?;

    let mut has_cover = false;
    if b.cover_path.is_some() {
        if let Ok(cover) = c.get_bytes(&format!("api/books/{}/cover", enc(&b.id))).await {
            has_cover = tokio::fs::write(dir.join("cover"), cover).await.is_ok();
        }
    }

    let progress = c
        .get_json::<Value>(&format!("api/progress/{}", enc(&b.id)))
        .await
        .ok()
        .and_then(|v| progress_from_record(&v["progress"]));
    let existing = store.read(|i| i.books.iter().find(|x| x.book_id == b.id && x.owner_id == user.id).and_then(|x| x.progress.clone()));
    let progress = match (existing, progress) {
        (Some(a), Some(s)) => Some(if a.updated_at >= s.updated_at { a } else { s }),
        (a, s) => a.or(s),
    };

    let book = OfflineBook {
        book_id: b.id.clone(),
        owner_id: user.id.clone(),
        title: b.title,
        authors: b.authors.into_iter().map(|a| a.name).collect(),
        format: file.format.to_ascii_lowercase(),
        file_name,
        has_cover,
        size_bytes: bytes.len() as u64,
        saved_at: now_ms(),
        progress,
    };
    store.put_book(book.clone())?;
    Ok(book)
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub signed_in: bool,
    pub uploaded: usize,
    pub updated_from_server: usize,
    pub removed: usize,
}

/// Uploads positions read offline, pulls newer ones, and drops books the person can no longer see.
pub async fn sync(c: &Client, store: &Store, device_name: &str) -> Result<SyncReport, String> {
    let mut report = SyncReport::default();
    let user = match c.me().await {
        Ok(u) => u,
        Err(ApiError::Status(401 | 403, _)) => return Ok(report),
        Err(e) => return Err(e.to_string()),
    };
    report.signed_in = true;
    store.update(|i| i.last_user = Some(user.clone()))?;

    // 1. Upload this person's queued positions (newest wins on the server).
    let pending: Vec<_> = store.read(|i| i.pending.iter().filter(|p| p.owner_id == user.id).cloned().collect());
    for chunk in pending.chunks(500) {
        let updates: Vec<Value> = chunk
            .iter()
            .map(|p| {
                json!({
                    "bookId": p.book_id,
                    "locator": p.progress.locator,
                    "updatedAt": p.progress.updated_at,
                    "deviceName": p.progress.device_name.clone().unwrap_or_else(|| device_name.to_string()),
                    "percent": p.progress.percent,
                    "finished": p.progress.finished,
                })
            })
            .collect();
        let res: Value = c.post_json("api/progress/batch", &json!({ "updates": updates })).await.map_err(|e| e.to_string())?;
        let results = res["results"].as_array().cloned().unwrap_or_default();
        for (p, r) in chunk.iter().zip(results.iter()) {
            match r["status"].as_str() {
                Some("not_found") => {
                    store.remove_book(&user.id, &p.book_id)?;
                    report.removed += 1;
                }
                Some(_) => {
                    report.uploaded += 1;
                    store.update(|i| {
                        i.pending.retain(|x| !(x.owner_id == p.owner_id && x.book_id == p.book_id && x.progress.updated_at <= p.progress.updated_at))
                    })?;
                }
                None => {}
            }
        }
    }

    // 2. Re-check each saved book against the content lock, and take newer positions.
    let books: Vec<_> = store.read(|i| i.books.iter().filter(|b| b.owner_id == user.id).map(|b| b.book_id.clone()).collect());
    for id in books {
        match c.get_json::<Value>(&format!("api/books/{}", enc(&id))).await {
            Err(ApiError::Status(404, _)) => {
                store.remove_book(&user.id, &id)?;
                report.removed += 1;
                continue;
            }
            Err(ApiError::Unreachable(e)) => return Err(e),
            _ => {}
        }
        if let Ok(v) = c.get_json::<Value>(&format!("api/progress/{}", enc(&id))).await {
            if let Some(p) = progress_from_record(&v["progress"]) {
                let newer = store.read(|i| {
                    i.books
                        .iter()
                        .find(|b| b.book_id == id && b.owner_id == user.id)
                        .is_some_and(|b| b.progress.as_ref().map_or(true, |cur| p.updated_at > cur.updated_at))
                });
                if newer {
                    store.apply_server_progress(&user.id, &id, p)?;
                    report.updated_from_server += 1;
                }
            }
        }
    }
    Ok(report)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
