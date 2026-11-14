//! BookBandit for Windows.
//!
//! The window shows the family's own BookBandit server (the same web app as in a browser), so
//! sign-in, the content lock and every feature come from the server. Two pages ship with the app:
//! `index.html` (first-run server setup and pairing) and `offline.html` (books saved on this PC).
//! Server pages get no access to the native side; only the app's own pages can call commands.

mod links;
mod offline;
mod server;

use links::{book_id_from_page, is_on_server, normalize_server, parse_pair_link};
use offline::{LocalProgress, Store};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{Cookie, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use url::Url;

const MAIN: &str = "main";

#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Settings {
    server_url: Option<String>,
}

struct AppState {
    settings_path: PathBuf,
    settings: Mutex<Settings>,
    store: Store,
    /// Where the app's own pages are served from (differs in dev and per platform).
    local_base: Mutex<Option<Url>>,
    last_sync: Mutex<Option<Instant>>,
    device_name: String,
}

impl AppState {
    fn server(&self) -> Option<Url> {
        self.settings.lock().ok()?.server_url.as_deref().and_then(|s| Url::parse(s).ok())
    }

    fn set_server(&self, url: &Url) -> Result<(), String> {
        let mut s = self.settings.lock().map_err(|_| "settings unavailable")?;
        s.server_url = Some(url.to_string());
        if let Some(dir) = self.settings_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.settings_path, serde_json::to_vec_pretty(&*s).unwrap()).map_err(|e| e.to_string())
    }

    fn local_page(&self, page: &str) -> Option<Url> {
        self.local_base.lock().ok()?.as_ref()?.join(page).ok()
    }
}

fn device_name() -> String {
    let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    let host = host.trim();
    if host.is_empty() { "BookBandit desktop".into() } else { format!("{host} (desktop)") }
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(MAIN).ok_or_else(|| "The main window is closed".into())
}

/// The window's cookies for the server, as a Cookie header. Must not run on the main thread
/// (WebView2 deadlocks), so only call it from async commands or spawned tasks.
fn cookie_header(win: &WebviewWindow, server: &Url) -> String {
    win.cookies_for_url(server.clone())
        .unwrap_or_default()
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ")
}

fn client_for(app: &AppHandle, timeout: Duration) -> Result<server::Client, String> {
    let state = app.state::<AppState>();
    let base = state.server().ok_or("Set up your server first")?;
    let win = main_window(app)?;
    let cookie = cookie_header(&win, &base);
    Ok(server::Client::new(base, cookie, timeout))
}

fn navigate(app: &AppHandle, url: Url) {
    if let Ok(win) = main_window(app) {
        let _ = win.navigate(url);
    }
}

fn open_offline_library(app: &AppHandle) {
    if let Some(u) = app.state::<AppState>().local_page("offline.html") {
        navigate(app, u);
    }
}

fn open_setup(app: &AppHandle) {
    if let Some(u) = app.state::<AppState>().local_page("index.html?setup=1") {
        navigate(app, u);
    }
}

fn message(app: &AppHandle, title: &str, text: impl Into<String>, kind: MessageDialogKind) {
    app.dialog().message(text).title(title).kind(kind).show(|_| {});
}

// ---------------------------------------------------------------------------------------------
// Commands for the app's own pages

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    server_url: Option<String>,
    device_name: String,
    version: String,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        server_url: state.server().map(|u| u.to_string()),
        device_name: state.device_name.clone(),
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

/// Checks and saves the server address. With a pairing code (or a pasted pairing link), this
/// PC is paired to the family as a device, the same way a tablet is.
#[tauri::command]
async fn connect(app: AppHandle, address: String, code: Option<String>) -> Result<String, String> {
    let state = app.state::<AppState>();
    let server = normalize_server(&address)?;
    let code = code
        .filter(|c| !c.trim().is_empty())
        .or_else(|| parse_pair_link(&address).map(|p| p.code));
    server::check_server(&server).await?;

    if let Some(code) = code {
        let token = server::claim(&server, &code, &state.device_name).await?;
        let win = main_window(&app)?;
        let mut c = Cookie::new("bb_device", token);
        c.set_domain(server.host_str().unwrap_or_default().to_string());
        c.set_path("/");
        c.set_http_only(true);
        c.set_secure(server.scheme() == "https");
        c.set_same_site(cookie::SameSite::Lax);
        c.set_max_age(cookie::time::Duration::days(400));
        win.set_cookie(c).map_err(|e| format!("Paired, but couldn't save the sign-in: {e}"))?;
    }
    state.set_server(&server)?;
    Ok(server.to_string())
}

/// Opens the server in the window (from the launcher or the offline library).
#[tauri::command]
fn open_server(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let server = state.server().ok_or("Set up your server first")?;
    let url = match path {
        Some(p) => server.join(p.trim_start_matches('/')).map_err(|e| e.to_string())?,
        None => server,
    };
    main_window(&app)?.navigate(url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn server_reachable(state: State<'_, AppState>) -> Result<bool, String> {
    let Some(server) = state.server() else { return Ok(false) };
    Ok(server::check_server(&server).await.is_ok())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Library {
    user: Option<offline::UserInfo>,
    books: Vec<offline::OfflineBook>,
    pending: usize,
}

#[tauri::command]
fn offline_library(state: State<'_, AppState>) -> Library {
    let (user, books) = state.store.visible_books();
    let pending = state
        .store
        .read(|i| i.pending.iter().filter(|p| user.as_ref().is_some_and(|u| u.id == p.owner_id)).count());
    Library { user, books, pending }
}

#[tauri::command]
fn offline_file(state: State<'_, AppState>, book_id: String) -> Result<tauri::ipc::Response, String> {
    let b = state.store.visible_book(&book_id).ok_or("That book isn't saved for you on this PC")?;
    let bytes = offline::read_file(&state.store.book_dir(&b.book_id), &b.file_name)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn offline_cover(state: State<'_, AppState>, book_id: String) -> Result<tauri::ipc::Response, String> {
    let b = state.store.visible_book(&book_id).filter(|b| b.has_cover).ok_or("No cover")?;
    Ok(tauri::ipc::Response::new(offline::read_file(&state.store.book_dir(&b.book_id), "cover")?))
}

#[tauri::command]
fn offline_progress(
    state: State<'_, AppState>,
    book_id: String,
    locator: Value,
    percent: f64,
    finished: bool,
) -> Result<(), String> {
    let b = state.store.visible_book(&book_id).ok_or("That book isn't saved for you on this PC")?;
    let p = LocalProgress {
        locator,
        percent: percent.clamp(0.0, 1.0),
        finished,
        updated_at: server::now_ms(),
        device_name: Some(state.device_name.clone()),
    };
    state.store.record_progress(&b.owner_id, &b.book_id, p)
}

#[tauri::command]
fn offline_remove(state: State<'_, AppState>, book_id: String) -> Result<(), String> {
    let b = state.store.visible_book(&book_id).ok_or("That book isn't saved for you on this PC")?;
    state.store.remove_book(&b.owner_id, &b.book_id)
}

#[tauri::command]
async fn sync_now(app: AppHandle) -> Result<server::SyncReport, String> {
    run_sync(&app).await
}

async fn run_sync(app: &AppHandle) -> Result<server::SyncReport, String> {
    let c = client_for(app, Duration::from_secs(20))?;
    let state = app.state::<AppState>();
    let report = server::sync(&c, &state.store, &state.device_name).await?;
    if let Ok(mut t) = state.last_sync.lock() {
        *t = Some(Instant::now());
    }
    Ok(report)
}

// ---------------------------------------------------------------------------------------------
// Menu

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, text: &str, accel: Option<&str>| MenuItem::with_id(app, id, text, true, accel);
    let library = Submenu::with_items(
        app,
        "&Library",
        true,
        &[
            &item("home", "&Home", Some("Alt+Home"))?,
            &item("back", "&Back", Some("Alt+Left"))?,
            &item("reload", "&Reload", Some("F5"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("change-server", "Change &server...", None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("quit", "E&xit", Some("Alt+F4"))?,
        ],
    )?;
    let offline = Submenu::with_items(
        app,
        "&Offline",
        true,
        &[
            &item("save-offline", "&Save this book for offline", Some("CmdOrCtrl+S"))?,
            &item("offline-library", "&Offline library", Some("CmdOrCtrl+O"))?,
            &item("sync", "S&ync reading progress now", None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "&View",
        true,
        &[
            &item("fullscreen", "&Full screen", Some("F11"))?,
            &item("zoom-in", "Zoom &in", Some("CmdOrCtrl+="))?,
            &item("zoom-out", "Zoom &out", Some("CmdOrCtrl+-"))?,
            &item("zoom-reset", "&Actual size", Some("CmdOrCtrl+0"))?,
        ],
    )?;
    Menu::with_items(app, &[&library, &offline, &view])
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    let Ok(win) = main_window(app) else { return };
    let state = app.state::<AppState>();
    match event.id().as_ref() {
        "home" => match state.server() {
            Some(s) => navigate(app, s),
            None => open_setup(app),
        },
        "back" => {
            let _ = win.eval("history.back()");
        }
        "reload" => {
            let _ = win.eval("location.reload()");
        }
        "change-server" => open_setup(app),
        "quit" => app.exit(0),
        "offline-library" => open_offline_library(app),
        "fullscreen" => {
            let full = win.is_fullscreen().unwrap_or(false);
            let _ = win.set_fullscreen(!full);
        }
        "zoom-in" | "zoom-out" | "zoom-reset" => {
            let mut z = ZOOM.lock().unwrap_or_else(|e| e.into_inner());
            *z = match event.id().as_ref() {
                "zoom-in" => (*z + 0.1).min(3.0),
                "zoom-out" => (*z - 0.1).max(0.5),
                _ => 1.0,
            };
            let _ = win.set_zoom(*z);
        }
        "save-offline" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { save_current_book(&app).await });
        }
        "sync" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                match run_sync(&app).await {
                    Ok(r) if !r.signed_in => message(&app, "Sync", "Sign in first, then sync again.", MessageDialogKind::Info),
                    Ok(r) => message(
                        &app,
                        "Sync",
                        format!(
                            "Reading progress is up to date.\n\nUploaded: {}\nUpdated from other devices: {}\nNo longer available (removed from this PC): {}",
                            r.uploaded, r.updated_from_server, r.removed
                        ),
                        MessageDialogKind::Info,
                    ),
                    Err(e) => message(&app, "Sync", e, MessageDialogKind::Warning),
                }
            });
        }
        _ => {}
    }
}

static ZOOM: Mutex<f64> = Mutex::new(1.0);

async fn save_current_book(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (Some(server), Ok(win)) = (state.server(), main_window(app)) else { return };
    let page = win.url().ok();
    let Some(book_id) = page.as_ref().and_then(|p| book_id_from_page(&server, p)) else {
        message(
            app,
            "Save for offline",
            "Open a book's page (or start reading it), then choose Offline > Save this book for offline.",
            MessageDialogKind::Info,
        );
        return;
    };
    let result = match client_for(app, Duration::from_secs(600)) {
        Ok(c) => server::save_book(&c, &state.store, &book_id).await,
        Err(e) => Err(e),
    };
    match result {
        Ok(b) => message(
            app,
            "Saved for offline",
            format!("\"{}\" is saved on this PC. Open it any time from Offline > Offline library, even without internet.", b.title),
            MessageDialogKind::Info,
        ),
        Err(e) => message(app, "Couldn't save the book", e, MessageDialogKind::Warning),
    }
}

// ---------------------------------------------------------------------------------------------

/// When a server page finishes loading we know we're online: upload offline reading and refresh
/// who is signed in.
fn on_page_loaded(win: &WebviewWindow, url: &Url) {
    let app = win.app_handle().clone();
    let state = app.state::<AppState>();
    let Some(server) = state.server() else { return };
    if !is_on_server(&server, url) {
        return;
    }
    // Queued offline reading always goes up at once; otherwise refresh at most once a minute.
    let has_pending = state.store.read(|i| !i.pending.is_empty());
    {
        let mut last = state.last_sync.lock().unwrap_or_else(|e| e.into_inner());
        if !has_pending && last.is_some_and(|t| t.elapsed() < Duration::from_secs(60)) {
            return;
        }
        *last = Some(Instant::now());
    }
    tauri::async_runtime::spawn(async move {
        let _ = run_sync(&app).await;
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window(MAIN) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            app_info,
            connect,
            open_server,
            server_reachable,
            offline_library,
            offline_file,
            offline_cover,
            offline_progress,
            offline_remove,
            sync_now
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let settings_path = config_dir.join("settings.json");
            let settings: Settings = std::fs::read(&settings_path)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default();
            app.manage(AppState {
                settings_path,
                settings: Mutex::new(settings),
                store: Store::open(data_dir.join("offline")),
                local_base: Mutex::new(None),
                last_sync: Mutex::new(None),
                device_name: device_name(),
            });

            let menu = build_menu(&handle)?;
            let win = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                .title("BookBandit")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 600.0)
                .menu(menu)
                .on_menu_event(|w, e| on_menu(w.app_handle(), e))
                .on_page_load(|w, p| {
                    if p.event() == PageLoadEvent::Finished {
                        on_page_loaded(&w, p.url());
                    }
                })
                // Links that open a new tab (Kindle, Hardcover, help pages) go to the normal browser.
                .on_new_window(move |url, _| {
                    use tauri_plugin_opener::OpenerExt;
                    if url.scheme() == "http" || url.scheme() == "https" {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            if let Ok(u) = win.url() {
                *app.state::<AppState>().local_base.lock().unwrap() = u.join("./").ok();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running BookBandit");
}
