package app.bookbandit.tablet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class ApiRouterTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    /** A fake server: path -> JSON for whoever the current identity is. */
    static final class FakeServer implements ApiRouter.Upstream {
        boolean online = true;
        String identity = "device";
        final Map<String, Map<String, ApiRouter.Response>> answers = new HashMap<>();
        final List<String> calls = new ArrayList<>();

        void answer(String identity, String pathAndQuery, int status, String json) {
            answers.computeIfAbsent(identity, k -> new HashMap<>()).put(pathAndQuery, ApiRouter.Response.json(status, json));
        }

        @Override
        public ApiRouter.Response execute(String method, String pathAndQuery, Map<String, String> headers, byte[] body) throws IOException {
            calls.add(method + " " + pathAndQuery);
            if (!online) throw new IOException("offline");
            ApiRouter.Response r = answers.getOrDefault(identity, new HashMap<>()).get(pathAndQuery);
            if (r == null) return ApiRouter.Response.json(404, "{\"message\":\"Not found\"}");
            // Responses are single-use streams; hand out a fresh copy.
            byte[] b = r.readAll();
            answers.get(identity).put(pathAndQuery, ApiRouter.Response.bytes(r.status, r.contentType, b));
            return ApiRouter.Response.bytes(r.status, r.contentType, b);
        }

        @Override
        public String identityKey() {
            return identity;
        }
    }

    FakeServer server;
    OfflineStore store;
    ApiRouter router;
    final List<String> seen = new ArrayList<>();

    @Before
    public void setUp() throws Exception {
        server = new FakeServer();
        store = new OfflineStore(tmp.newFolder("offline"));
        router = new ApiRouter(server, store, null, (identity, userId, role) -> seen.add(identity + "=" + userId + ":" + role));
        server.answer("device", "/api/users/me", 200, "{\"id\":\"kid-1\",\"role\":\"kid\"}");
        server.answer("s:parent", "/api/users/me", 200, "{\"id\":\"parent-1\",\"role\":\"parent\"}");
        server.answer("device", "/api/shelves", 200, "{\"items\":[{\"id\":\"kid\",\"name\":\"Your books\",\"kind\":\"kid\",\"books\":[]}]}");
    }

    static String text(ApiRouter.Response r) throws IOException {
        return new String(r.readAll(), StandardCharsets.UTF_8);
    }

    void download(String userId, String bookId, String fileId, String content) throws Exception {
        File part = store.tempFile(userId, bookId);
        try (FileOutputStream out = new FileOutputStream(part)) {
            out.write(content.getBytes(StandardCharsets.UTF_8));
        }
        JSONObject detail = new JSONObject()
                .put("id", bookId)
                .put("title", "Book " + bookId)
                .put("coverPath", "covers/x.jpg")
                .put("files", new JSONArray().put(new JSONObject().put("id", fileId).put("format", "epub")));
        store.commit(userId, bookId, fileId, "epub", detail, "COVER".getBytes(StandardCharsets.UTF_8), "image/png");
    }

    @Test
    public void learnsWhoIsReadingFromUsersMe() throws Exception {
        assertNull(router.currentUserId());
        ApiRouter.Response r = router.get("/api/users/me", null, null);
        assertEquals(200, r.status);
        assertTrue(text(r).contains("kid-1"));
        assertEquals("kid-1", router.currentUserId());
        assertEquals("kid", router.currentRole());
        assertEquals("device=kid-1:kid", seen.get(0));
    }

    @Test
    public void offlineServesThisPersonsCacheOnly() throws Exception {
        router.get("/api/users/me", null, null);
        assertEquals(200, router.get("/api/shelves", null, null).status);

        server.online = false;
        ApiRouter.Response r = router.get("/api/shelves", null, null);
        assertEquals(200, r.status);
        assertEquals("1", r.headers.get("X-BookBandit-Offline"));
        assertTrue(text(r).contains("Your books"));

        // A different person signing in on a shared tablet doesn't get the kid's cache.
        server.online = true;
        server.identity = "s:parent";
        router.get("/api/users/me", null, null);
        server.online = false;
        ApiRouter.Response p = router.get("/api/shelves", null, null);
        assertFalse(text(p).contains("Your books"));
    }

    @Test
    public void unknownPersonOfflineGetsAnOfflineError() throws Exception {
        server.online = false;
        ApiRouter.Response r = router.get("/api/shelves", null, null);
        assertEquals(503, r.status);
        assertTrue(text(r).contains("offline"));
    }

    @Test
    public void downloadedFileIsServedLocallyWithRanges() throws Exception {
        router.get("/api/users/me", null, null);
        download("kid-1", "b1", "f1", "0123456789");
        server.calls.clear();

        ApiRouter.Response whole = router.get("/api/books/b1/files/f1", null, null);
        assertEquals(200, whole.status);
        assertEquals("application/epub+zip", whole.contentType);
        assertEquals("0123456789", text(whole));
        assertTrue("never asks the server", server.calls.isEmpty());

        Map<String, String> h = new HashMap<>();
        h.put("Range", "bytes=2-4");
        ApiRouter.Response part = router.get("/api/books/b1/files/f1", null, h);
        assertEquals(206, part.status);
        assertEquals("bytes 2-4/10", part.headers.get("Content-Range"));
        assertEquals("234", text(part));

        // Another file id of the same book isn't on the tablet: goes to the server.
        router.get("/api/books/b1/files/other", null, null);
        assertEquals(1, server.calls.size());
    }

    @Test
    public void downloadsBelongToOnePerson() throws Exception {
        router.get("/api/users/me", null, null);
        download("kid-1", "b1", "f1", "kid book");
        server.identity = "s:parent";
        router.get("/api/users/me", null, null);
        server.calls.clear();
        router.get("/api/books/b1/files/f1", null, null);
        assertEquals("parent's request goes to the server (content lock)", 1, server.calls.size());
    }

    @Test
    public void offlineBookDetailAndCoverComeFromTheDownload() throws Exception {
        router.get("/api/users/me", null, null);
        download("kid-1", "b1", "f1", "x");
        server.online = false;
        ApiRouter.Response d = router.get("/api/books/b1", null, null);
        assertEquals(200, d.status);
        assertTrue(text(d).contains("Book b1"));
        ApiRouter.Response c = router.get("/api/books/b1/cover", null, null);
        assertEquals(200, c.status);
        assertEquals("image/png", c.contentType);
        assertEquals("COVER", text(c));
    }

    @Test
    public void shelvesGetAnOnThisTabletRow() throws Exception {
        router.get("/api/users/me", null, null);
        download("kid-1", "b1", "f1", "x");
        JSONObject shelves = new JSONObject(text(router.get("/api/shelves", null, null)));
        JSONArray items = shelves.getJSONArray("items");
        assertEquals(2, items.length());
        assertEquals("downloaded", items.getJSONObject(0).getString("id"));
        assertEquals("On this tablet", items.getJSONObject(0).getString("name"));
        assertEquals("b1", items.getJSONObject(0).getJSONArray("books").getJSONObject(0).getString("id"));

        // Offline with nothing cached still lists the downloads.
        ApiRouter fresh = new ApiRouter(server, new OfflineStore(tmp.newFolder("other")), null, null);
        fresh.get("/api/users/me", null, null);
        server.online = false;
        assertEquals(200, fresh.get("/api/shelves", null, null).status);

        JSONObject page = new JSONObject(text(router.get("/api/books", "shelf=downloaded&limit=10", null)));
        assertEquals(1, page.getInt("total"));
    }

    @Test
    public void bookTheServerNoLongerShowsIsRemoved() throws Exception {
        router.get("/api/users/me", null, null);
        download("kid-1", "b1", "f1", "x");
        assertNotNull(store.meta("kid-1", "b1"));
        // Re-rated above the kid's age: the server now answers 404.
        assertEquals(404, router.get("/api/books/b1", null, null).status);
        assertNull(store.meta("kid-1", "b1"));
        assertNull(store.bookFile("kid-1", "b1", "f1"));
    }

    @Test
    public void onlyBodyAndAcceptHeadersAreForwarded() {
        Map<String, String> in = new HashMap<>();
        in.put("Cookie", "evil=1");
        in.put("Authorization", "Bearer x");
        in.put("Content-Type", "application/json");
        in.put("Range", "bytes=0-1");
        Map<String, String> out = ApiRouter.forwardable(in);
        assertEquals(2, out.size());
        assertEquals("application/json", out.get("content-type"));
    }

    @Test
    public void rejectsUnsafeIds() {
        assertFalse(OfflineStore.isSafeId("../etc"));
        assertFalse(OfflineStore.isSafeId(""));
        assertTrue(OfflineStore.isSafeId("8c1f6c1e-1a2b-4c3d-9e8f-001122334455"));
    }
}
