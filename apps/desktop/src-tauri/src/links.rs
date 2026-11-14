//! Pure helpers for server addresses, pairing links and book pages. Unit-tested.

use url::Url;

/// Turns what a person types ("books.example.com", "http://nas:8080/") into a server root URL.
/// Plain host names get `https://`, except bare IPs, `localhost` and names with a port, which
/// are almost always on the home network without TLS.
pub fn normalize_server(input: &str) -> Result<Url, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("Type your BookBandit server's address".into());
    }
    if let Some(pair) = parse_pair_link(s) {
        return pair.server.ok_or_else(|| "That pairing link has no server address in it".into());
    }
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else {
        let host = s.split(['/', '?', '#']).next().unwrap_or("");
        let local = host.contains(':') || host.starts_with("localhost") || host.chars().all(|c| c.is_ascii_digit() || c == '.');
        format!("{}://{}", if local { "http" } else { "https" }, s)
    };
    let mut url = Url::parse(&with_scheme).map_err(|_| format!("\"{s}\" doesn't look like a web address"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("The address should start with http:// or https://".into());
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err(format!("\"{s}\" doesn't look like a web address"));
    }
    // The app lives at the root of the server (or of a sub-path when behind a path proxy).
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&format!("{path}/"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[derive(Debug, PartialEq)]
pub struct PairLink {
    pub server: Option<Url>,
    pub code: String,
}

/// Reads `bookbandit://pair?server=https://…&code=ABCD-1234` (what the parent's QR code holds).
pub fn parse_pair_link(s: &str) -> Option<PairLink> {
    let url = Url::parse(s.trim()).ok()?;
    if url.scheme() != "bookbandit" {
        return None;
    }
    let mut server = None;
    let mut code = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "server" => server = normalize_server(&v).ok(),
            "code" => code = Some(v.trim().to_string()),
            _ => {}
        }
    }
    Some(PairLink { server, code: code.filter(|c| !c.is_empty())? })
}

/// True when `page` is on the BookBandit server (same scheme, host and port, under its path).
pub fn is_on_server(server: &Url, page: &Url) -> bool {
    server.scheme() == page.scheme()
        && server.host_str() == page.host_str()
        && server.port_or_known_default() == page.port_or_known_default()
        && page.path().starts_with(server.path())
}

/// The book id on a web app page: `/book/<id>` or `/read/<id>`, relative to the server root.
pub fn book_id_from_page(server: &Url, page: &Url) -> Option<String> {
    if !is_on_server(server, page) {
        return None;
    }
    let rest = &page.path()[server.path().len()..];
    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    match (parts.next(), parts.next()) {
        (Some("book" | "read"), Some(id)) => {
            let id = urlencoding_decode(id);
            let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
            ok.then_some(id)
        }
        _ => None,
    }
}

fn urlencoding_decode(s: &str) -> String {
    url::form_urlencoded::parse(format!("x={s}").as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default()
}

/// Formats the offline reader can open, best first (EPUB reflows best). Matches the web reader.
pub const READABLE_FORMATS: [&str; 6] = ["epub", "azw3", "mobi", "fb2", "cbz", "pdf"];

/// Picks which of a book's files to keep offline. Returns its index.
pub fn pick_readable(formats: &[&str]) -> Option<usize> {
    READABLE_FORMATS
        .iter()
        .find_map(|want| formats.iter().position(|f| f.eq_ignore_ascii_case(want)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn normalizes_typed_addresses() {
        assert_eq!(normalize_server("books.example.com").unwrap().as_str(), "https://books.example.com/");
        assert_eq!(normalize_server("  http://nas:8080  ").unwrap().as_str(), "http://nas:8080/");
        assert_eq!(normalize_server("nas:8080").unwrap().as_str(), "http://nas:8080/");
        assert_eq!(normalize_server("192.168.1.20").unwrap().as_str(), "http://192.168.1.20/");
        assert_eq!(normalize_server("localhost:5173").unwrap().as_str(), "http://localhost:5173/");
        assert_eq!(normalize_server("https://home.lan/books").unwrap().as_str(), "https://home.lan/books/");
        assert!(normalize_server("").is_err());
        assert!(normalize_server("ftp://x").is_err());
    }

    #[test]
    fn reads_pairing_links() {
        let p = parse_pair_link("bookbandit://pair?server=https%3A%2F%2Fbooks.example.com&code=ABCD-1234").unwrap();
        assert_eq!(p.server.unwrap().as_str(), "https://books.example.com/");
        assert_eq!(p.code, "ABCD-1234");
        assert!(parse_pair_link("bookbandit://pair?server=https://x.com").is_none());
        assert!(parse_pair_link("https://x.com/?code=1").is_none());
        // A pairing link pasted into the address box sets the server.
        assert_eq!(
            normalize_server("bookbandit://pair?server=http://nas:8080&code=X1").unwrap().as_str(),
            "http://nas:8080/"
        );
    }

    #[test]
    fn finds_the_book_on_a_page() {
        let s = u("https://books.example.com/");
        assert_eq!(book_id_from_page(&s, &u("https://books.example.com/book/5f0c-1a")), Some("5f0c-1a".into()));
        assert_eq!(book_id_from_page(&s, &u("https://books.example.com/read/abc?x=1")), Some("abc".into()));
        assert_eq!(book_id_from_page(&s, &u("https://books.example.com/browse")), None);
        assert_eq!(book_id_from_page(&s, &u("https://evil.example.com/book/abc")), None);
        assert_eq!(book_id_from_page(&s, &u("http://books.example.com/book/abc")), None);
        assert_eq!(book_id_from_page(&s, &u("https://books.example.com/book/..%2F..")), None);
        let sub = u("https://home.lan/books/");
        assert_eq!(book_id_from_page(&sub, &u("https://home.lan/books/read/xyz")), Some("xyz".into()));
        assert_eq!(book_id_from_page(&sub, &u("https://home.lan/read/xyz")), None);
    }

    #[test]
    fn picks_the_best_file() {
        assert_eq!(pick_readable(&["pdf", "epub"]), Some(1));
        assert_eq!(pick_readable(&["mp3", "CBZ"]), Some(1));
        assert_eq!(pick_readable(&["m4b", "cbr"]), None);
    }
}
