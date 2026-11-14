package app.bookbandit.tablet;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Everything the tablet keeps for reading offline, split by person so a shared family tablet never
 * shows one profile's books or cached pages to another (the server's content lock still decided
 * what each person got in the first place).
 *
 * <pre>
 * root/users/&lt;userId&gt;/cache/&lt;sha256(path?query)&gt;.bin|.type   last good GET responses (JSON, covers)
 * root/users/&lt;userId&gt;/books/&lt;bookId&gt;/meta.json                downloaded book: ids, title, detail JSON
 * root/users/&lt;userId&gt;/books/&lt;bookId&gt;/file                     the book file
 * root/users/&lt;userId&gt;/books/&lt;bookId&gt;/cover                    its cover, when it has one
 * </pre>
 */
public final class OfflineStore {

    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9_-]{1,80}");
    /** Cached responses per person; the oldest are dropped past this. */
    static final int MAX_CACHE_ENTRIES = 1500;

    private final File root;

    public OfflineStore(File root) {
        this.root = root;
    }

    public static boolean isSafeId(String id) {
        return id != null && SAFE_ID.matcher(id).matches();
    }

    private File userDir(String userId) {
        if (!isSafeId(userId)) throw new IllegalArgumentException("bad user id");
        return new File(new File(root, "users"), userId);
    }

    private File bookDir(String userId, String bookId) {
        if (!isSafeId(bookId)) throw new IllegalArgumentException("bad book id");
        return new File(new File(userDir(userId), "books"), bookId);
    }

    // ---- response cache -------------------------------------------------------------------

    public static final class Cached {
        public final String contentType;
        public final File body;

        Cached(String contentType, File body) {
            this.contentType = contentType;
            this.body = body;
        }

        public byte[] bytes() throws IOException {
            return readFile(body);
        }
    }

    public void cachePut(String userId, String pathAndQuery, String contentType, byte[] body) {
        try {
            File dir = new File(userDir(userId), "cache");
            if (!dir.isDirectory() && !dir.mkdirs()) return;
            String key = Hex.sha256(pathAndQuery);
            File tmp = new File(dir, key + ".tmp");
            write(tmp, body);
            write(new File(dir, key + ".type"), (contentType == null ? "" : contentType).getBytes(StandardCharsets.UTF_8));
            if (!tmp.renameTo(new File(dir, key + ".bin"))) tmp.delete();
            prune(dir);
        } catch (IOException | IllegalArgumentException e) {
            // A cache write failing only means less is available offline.
        }
    }

    public Cached cacheGet(String userId, String pathAndQuery) {
        if (!isSafeId(userId)) return null;
        File dir = new File(userDir(userId), "cache");
        String key = Hex.sha256(pathAndQuery);
        File bin = new File(dir, key + ".bin");
        if (!bin.isFile()) return null;
        String type = "application/octet-stream";
        try {
            type = new String(readFile(new File(dir, key + ".type")), StandardCharsets.UTF_8);
        } catch (IOException ignored) {
            // keep the default
        }
        return new Cached(type, bin);
    }

    private void prune(File dir) {
        File[] bins = dir.listFiles((d, name) -> name.endsWith(".bin"));
        if (bins == null || bins.length <= MAX_CACHE_ENTRIES) return;
        Arrays.sort(bins, Comparator.comparingLong(File::lastModified));
        for (int i = 0; i < bins.length - MAX_CACHE_ENTRIES; i++) {
            String key = bins[i].getName().replace(".bin", "");
            bins[i].delete();
            new File(dir, key + ".type").delete();
        }
    }

    // ---- downloads ------------------------------------------------------------------------

    /** Where to stream a download before it is committed. */
    public File tempFile(String userId, String bookId) throws IOException {
        File dir = bookDir(userId, bookId);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Can't create " + dir);
        return new File(dir, "file.part");
    }

    /**
     * Finishes a download: moves the file into place and writes its meta. `detail` is the server's
     * GET /api/books/:id JSON for this person.
     */
    public void commit(String userId, String bookId, String fileId, String format, JSONObject detail, byte[] cover, String coverType)
            throws IOException, JSONException {
        File dir = bookDir(userId, bookId);
        File part = new File(dir, "file.part");
        File file = new File(dir, "file");
        if (file.exists()) file.delete();
        if (!part.renameTo(file)) throw new IOException("Can't move download into place");
        if (cover != null) {
            write(new File(dir, "cover"), cover);
            write(new File(dir, "cover.type"), (coverType == null ? "image/jpeg" : coverType).getBytes(StandardCharsets.UTF_8));
        }
        JSONObject meta = new JSONObject();
        meta.put("bookId", bookId);
        meta.put("fileId", fileId);
        meta.put("format", format);
        meta.put("title", detail.optString("title", ""));
        meta.put("sizeBytes", file.length());
        meta.put("downloadedAt", System.currentTimeMillis());
        meta.put("detail", detail);
        write(new File(dir, "meta.json"), meta.toString().getBytes(StandardCharsets.UTF_8));
    }

    public JSONObject meta(String userId, String bookId) {
        if (!isSafeId(userId) || !isSafeId(bookId)) return null;
        File f = new File(bookDir(userId, bookId), "meta.json");
        if (!f.isFile()) return null;
        try {
            return new JSONObject(new String(readFile(f), StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            return null;
        }
    }

    /** The downloaded file, only if it is this exact file of this book for this person. */
    public File bookFile(String userId, String bookId, String fileId) {
        JSONObject meta = meta(userId, bookId);
        if (meta == null || !fileId.equals(meta.optString("fileId"))) return null;
        File f = new File(bookDir(userId, bookId), "file");
        return f.isFile() ? f : null;
    }

    public Cached cover(String userId, String bookId) {
        if (meta(userId, bookId) == null) return null;
        File dir = bookDir(userId, bookId);
        File f = new File(dir, "cover");
        if (!f.isFile()) return null;
        String type = "image/jpeg";
        try {
            type = new String(readFile(new File(dir, "cover.type")), StandardCharsets.UTF_8);
        } catch (IOException ignored) {
            // keep the default
        }
        return new Cached(type, f);
    }

    /** Downloaded books for one person, newest first. */
    public List<JSONObject> list(String userId) {
        List<JSONObject> out = new ArrayList<>();
        if (!isSafeId(userId)) return out;
        File[] dirs = new File(userDir(userId), "books").listFiles(File::isDirectory);
        if (dirs == null) return out;
        for (File d : dirs) {
            JSONObject m = meta(userId, d.getName());
            if (m != null) out.add(m);
        }
        out.sort((a, b) -> Long.compare(b.optLong("downloadedAt"), a.optLong("downloadedAt")));
        return out;
    }

    public void remove(String userId, String bookId) {
        if (!isSafeId(userId) || !isSafeId(bookId)) return;
        deleteTree(bookDir(userId, bookId));
    }

    public void removeAll() {
        deleteTree(new File(root, "users"));
    }

    public long usedBytes(String userId) {
        if (!isSafeId(userId)) return 0;
        return size(userDir(userId));
    }

    // ---- helpers --------------------------------------------------------------------------

    private static long size(File f) {
        if (f.isFile()) return f.length();
        File[] kids = f.listFiles();
        long n = 0;
        if (kids != null) for (File k : kids) n += size(k);
        return n;
    }

    static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    static void write(File f, byte[] data) throws IOException {
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(data);
        }
    }

    /** InputStream.readAllBytes and java.nio.file need newer Android than our minSdk. */
    static byte[] readAll(InputStream in) throws IOException {
        try (InputStream is = in) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = is.read(buf)) != -1) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    static byte[] readFile(File f) throws IOException {
        return readAll(new FileInputStream(f));
    }

    static InputStream open(File f) throws IOException {
        return new FileInputStream(f);
    }
}
