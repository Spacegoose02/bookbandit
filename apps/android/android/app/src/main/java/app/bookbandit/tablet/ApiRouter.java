package app.bookbandit.tablet;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Answers the web app's /api requests on the tablet. Plain Java (no Android types) so it can be
 * unit tested on the JVM.
 *
 * Online, every request goes to the server (which applies the content lock) and good GET answers
 * are cached for the person who asked. Offline, the cache and downloaded books answer instead.
 * Downloaded book files are served from the tablet even when online.
 */
public final class ApiRouter {

    /** The server, reached with the device token and this tablet's sign-in cookies. */
    public interface Upstream {
        Response execute(String method, String pathAndQuery, Map<String, String> headers, byte[] body) throws IOException;

        /** Who is signed in right now, as far as the cookies go ("device" when only the device token). */
        String identityKey();
    }

    public interface Listener {
        /** GET /api/users/me answered: this identity is that person. */
        void onUser(String identityKey, String userId, String role);
    }

    public static final class Response {
        public final int status;
        public final String contentType;
        public final Map<String, String> headers;
        public final InputStream body;
        /** -1 when unknown. */
        public final long length;

        public Response(int status, String contentType, Map<String, String> headers, InputStream body, long length) {
            this.status = status;
            this.contentType = contentType;
            this.headers = headers == null ? new HashMap<>() : headers;
            this.body = body;
            this.length = length;
        }

        public static Response bytes(int status, String contentType, byte[] body) {
            return new Response(status, contentType, null, new ByteArrayInputStream(body), body.length);
        }

        public static Response json(int status, String json) {
            return bytes(status, "application/json; charset=utf-8", json.getBytes(StandardCharsets.UTF_8));
        }

        public byte[] readAll() throws IOException {
            return OfflineStore.readAll(body);
        }
    }

    public static final String DOWNLOADED_SHELF = "downloaded";
    static final int MAX_CACHED_BYTES = 4 * 1024 * 1024;
    private static final Pattern FILE_PATH = Pattern.compile("^/api/books/([A-Za-z0-9_-]+)/files/([A-Za-z0-9_-]+)$");
    private static final Pattern COVER_PATH = Pattern.compile("^/api/books/([A-Za-z0-9_-]+)/cover$");
    private static final Pattern BOOK_PATH = Pattern.compile("^/api/books/([A-Za-z0-9_-]+)$");

    private final Upstream upstream;
    private final OfflineStore store;
    private final Listener listener;
    /** identity key -> {userId, role} */
    private final Map<String, String[]> people;

    public ApiRouter(Upstream upstream, OfflineStore store, Map<String, String[]> knownPeople, Listener listener) {
        this.upstream = upstream;
        this.store = store;
        this.people = knownPeople == null ? new HashMap<>() : new HashMap<>(knownPeople);
        this.listener = listener;
    }

    /** The person behind the current cookies, if this tablet has seen them before. */
    public synchronized String currentUserId() {
        String[] p = people.get(upstream.identityKey());
        return p == null ? null : p[0];
    }

    public synchronized String currentRole() {
        String[] p = people.get(upstream.identityKey());
        return p == null ? null : p[1];
    }

    private synchronized void remember(String identity, String userId, String role) {
        people.put(identity, new String[] { userId, role });
    }

    // ---- GET -----------------------------------------------------------------------------

    public Response get(String path, String query, Map<String, String> requestHeaders) {
        String pathAndQuery = query == null || query.isEmpty() ? path : path + "?" + query;
        String userId = currentUserId();

        // A downloaded file is served from the tablet, online or not.
        Matcher fm = FILE_PATH.matcher(path);
        if (userId != null && fm.matches()) {
            File f = store.bookFile(userId, fm.group(1), fm.group(2));
            if (f != null) return serveFile(f, contentTypeFor(store.meta(userId, fm.group(1))), header(requestHeaders, "range"));
        }

        if (userId != null && "/api/books".equals(path) && DOWNLOADED_SHELF.equals(queryParam(query, "shelf"))) {
            return Response.json(200, downloadedPage(userId, query).toString());
        }

        Response res;
        try {
            res = upstream.execute("GET", pathAndQuery, forwardable(requestHeaders), null);
        } catch (IOException offline) {
            return offline(path, pathAndQuery, userId);
        }

        try {
            if ("/api/users/me".equals(path) && res.status == 200) {
                byte[] body = res.readAll();
                try {
                    JSONObject me = new JSONObject(new String(body, StandardCharsets.UTF_8));
                    String id = me.optString("id", null);
                    String role = me.optString("role", null);
                    if (OfflineStore.isSafeId(id)) {
                        String identity = upstream.identityKey();
                        remember(identity, id, role);
                        if (listener != null) listener.onUser(identity, id, role);
                        store.cachePut(id, pathAndQuery, res.contentType, body);
                    }
                } catch (JSONException ignored) {
                    // not our shape; pass it through
                }
                return Response.bytes(res.status, res.contentType, body);
            }

            userId = currentUserId();
            // The server no longer shows this book to this person (re-rated, removed): drop the
            // tablet's copy too, so the content lock holds offline.
            Matcher bm = BOOK_PATH.matcher(path);
            if (userId != null && res.status == 404 && bm.matches()) store.remove(userId, bm.group(1));

            if (userId != null && res.status == 200 && cacheable(path, res)) {
                byte[] body = res.readAll();
                store.cachePut(userId, pathAndQuery, res.contentType, body);
                if ("/api/shelves".equals(path)) body = withDownloadedShelf(userId, body);
                return new Response(res.status, res.contentType, res.headers, new ByteArrayInputStream(body), body.length);
            }
            return res;
        } catch (IOException e) {
            return offline(path, pathAndQuery, userId);
        }
    }

    private static boolean cacheable(String path, Response res) {
        if (FILE_PATH.matcher(path).matches()) return false;
        if (res.length > MAX_CACHED_BYTES) return false;
        String t = res.contentType == null ? "" : res.contentType.toLowerCase(Locale.ROOT);
        return t.startsWith("application/json") || t.startsWith("image/");
    }

    private Response offline(String path, String pathAndQuery, String userId) {
        if (userId == null) return offlineError();
        Matcher cm = COVER_PATH.matcher(path);
        if (cm.matches()) {
            OfflineStore.Cached c = store.cover(userId, cm.group(1));
            if (c != null) return cached(c, false, userId);
        }
        Matcher bm = BOOK_PATH.matcher(path);
        if (bm.matches()) {
            JSONObject meta = store.meta(userId, bm.group(1));
            JSONObject detail = meta == null ? null : meta.optJSONObject("detail");
            if (detail != null) return Response.json(200, detail.toString());
        }
        OfflineStore.Cached c = store.cacheGet(userId, pathAndQuery);
        if (c != null) return cached(c, "/api/shelves".equals(path), userId);
        if ("/api/shelves".equals(path)) {
            return Response.json(200, new String(withDownloadedShelf(userId, "{\"items\":[]}".getBytes(StandardCharsets.UTF_8)), StandardCharsets.UTF_8));
        }
        return offlineError();
    }

    private Response cached(OfflineStore.Cached c, boolean shelves, String userId) {
        try {
            byte[] body = c.bytes();
            if (shelves) body = withDownloadedShelf(userId, body);
            Response r = Response.bytes(200, c.contentType, body);
            r.headers.put("X-BookBandit-Offline", "1");
            return r;
        } catch (IOException e) {
            return offlineError();
        }
    }

    static Response offlineError() {
        return Response.json(503, "{\"message\":\"You're offline, and this isn't saved on the tablet yet.\",\"offline\":true}");
    }

    // ---- other methods ---------------------------------------------------------------------

    /** POST/PUT/PATCH/DELETE from the web app. Throws IOException when offline. */
    public Response send(String method, String pathAndQuery, Map<String, String> headers, byte[] body) throws IOException {
        return upstream.execute(method, pathAndQuery, forwardable(headers), body);
    }

    // ---- downloaded shelf -------------------------------------------------------------------

    /** Adds an "On this tablet" row to the top of GET /api/shelves when the person has downloads. */
    byte[] withDownloadedShelf(String userId, byte[] shelvesJson) {
        List<JSONObject> books = store.list(userId);
        if (books.isEmpty()) return shelvesJson;
        try {
            JSONObject root = new JSONObject(new String(shelvesJson, StandardCharsets.UTF_8));
            JSONArray items = root.optJSONArray("items");
            if (items == null) return shelvesJson;
            JSONObject shelf = new JSONObject();
            shelf.put("id", DOWNLOADED_SHELF);
            shelf.put("name", "On this tablet");
            shelf.put("kind", "collection");
            shelf.put("total", books.size());
            JSONArray summaries = new JSONArray();
            for (int i = 0; i < books.size() && i < 20; i++) summaries.put(summary(books.get(i)));
            shelf.put("books", summaries);
            JSONArray out = new JSONArray();
            out.put(shelf);
            for (int i = 0; i < items.length(); i++) {
                JSONObject s = items.optJSONObject(i);
                if (s != null && !DOWNLOADED_SHELF.equals(s.optString("id"))) out.put(s);
            }
            root.put("items", out);
            return root.toString().getBytes(StandardCharsets.UTF_8);
        } catch (JSONException e) {
            return shelvesJson;
        }
    }

    private JSONObject downloadedPage(String userId, String query) {
        List<JSONObject> books = store.list(userId);
        int limit = parseInt(queryParam(query, "limit"), 50);
        int offset = parseInt(queryParam(query, "offset"), 0);
        JSONArray items = new JSONArray();
        for (int i = offset; i < books.size() && i < offset + limit; i++) items.put(summary(books.get(i)));
        JSONObject page = new JSONObject();
        try {
            page.put("items", items);
            page.put("limit", limit);
            page.put("offset", offset);
            page.put("total", books.size());
        } catch (JSONException ignored) {
            // cannot happen for these types
        }
        return page;
    }

    private static JSONObject summary(JSONObject meta) {
        JSONObject d = meta.optJSONObject("detail");
        JSONObject s = new JSONObject();
        try {
            if (d != null) {
                for (String k : new String[] { "id", "title", "publishedYear", "rating", "coverPath", "kindleOnly", "authors", "series", "percent" }) {
                    if (d.has(k)) s.put(k, d.get(k));
                }
            } else {
                s.put("id", meta.optString("bookId"));
                s.put("title", meta.optString("title"));
            }
        } catch (JSONException ignored) {
            // keep what we have
        }
        return s;
    }

    // ---- files ------------------------------------------------------------------------------

    static Response serveFile(File f, String contentType, String rangeHeader) {
        long len = f.length();
        ByteRange range = ByteRange.parse(rangeHeader, len);
        try {
            Map<String, String> h = new HashMap<>();
            h.put("Accept-Ranges", "bytes");
            if (range == ByteRange.UNSATISFIABLE) {
                h.put("Content-Range", "bytes */" + len);
                return new Response(416, "text/plain", h, new ByteArrayInputStream(new byte[0]), 0);
            }
            if (range == null) {
                h.put("Content-Length", String.valueOf(len));
                return new Response(200, contentType, h, OfflineStore.open(f), len);
            }
            h.put("Content-Range", "bytes " + range.start + "-" + range.end + "/" + len);
            h.put("Content-Length", String.valueOf(range.length()));
            return new Response(206, contentType, h, slice(f, range), range.length());
        } catch (IOException e) {
            return Response.json(500, "{\"message\":\"Couldn't read the saved book\"}");
        }
    }

    private static InputStream slice(File f, ByteRange r) throws IOException {
        RandomAccessFile raf = new RandomAccessFile(f, "r");
        raf.seek(r.start);
        return new InputStream() {
            long left = r.length();

            @Override
            public int read() throws IOException {
                if (left <= 0) return -1;
                int b = raf.read();
                if (b >= 0) left--;
                return b;
            }

            @Override
            public int read(byte[] buf, int off, int len) throws IOException {
                if (left <= 0) return -1;
                int n = raf.read(buf, off, (int) Math.min(len, left));
                if (n > 0) left -= n;
                return n;
            }

            @Override
            public void close() throws IOException {
                raf.close();
            }
        };
    }

    static String contentTypeFor(JSONObject meta) {
        String format = meta == null ? "" : meta.optString("format");
        switch (format) {
            case "epub":
                return "application/epub+zip";
            case "pdf":
                return "application/pdf";
            case "cbz":
                return "application/vnd.comicbook+zip";
            case "fb2":
                return "application/x-fictionbook+xml";
            case "mobi":
            case "azw3":
                return "application/x-mobipocket-ebook";
            default:
                return "application/octet-stream";
        }
    }

    // ---- headers and query -------------------------------------------------------------------

    /** Only headers that describe the request body or what's wanted; never the WebView's cookies. */
    static Map<String, String> forwardable(Map<String, String> in) {
        Map<String, String> out = new HashMap<>();
        if (in == null) return out;
        for (Map.Entry<String, String> e : in.entrySet()) {
            String k = e.getKey().toLowerCase(Locale.ROOT);
            if (k.equals("accept") || k.equals("accept-language") || k.equals("range") || k.equals("content-type")) {
                out.put(k, e.getValue());
            }
        }
        return out;
    }

    static String header(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
        }
        return null;
    }

    static String queryParam(String query, String name) {
        if (query == null) return null;
        for (String part : query.split("&")) {
            int i = part.indexOf('=');
            String k = i < 0 ? part : part.substring(0, i);
            if (k.equals(name)) {
                try {
                    return java.net.URLDecoder.decode(i < 0 ? "" : part.substring(i + 1), "UTF-8");
                } catch (java.io.UnsupportedEncodingException e) {
                    return null;
                }
            }
        }
        return null;
    }

    private static int parseInt(String s, int dflt) {
        try {
            return s == null ? dflt : Math.max(0, Math.min(500, Integer.parseInt(s)));
        } catch (NumberFormatException e) {
            return dflt;
        }
    }
}
