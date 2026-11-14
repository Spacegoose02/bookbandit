package app.bookbandit.tablet;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * What the web pages can ask the tablet to do: pair, send API requests that have a body, download
 * books for offline reading, pin the screen, and manage the parent PIN.
 *
 * JavaScript: `registerPlugin("BookBandit")` (see apps/android/src/native.ts).
 */
@CapacitorPlugin(name = "BookBandit")
public class BookBanditPlugin extends Plugin {

    private final ExecutorService io = Executors.newFixedThreadPool(4);
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private final Set<String> queued = ConcurrentHashMap.newKeySet();
    private NativeState state;

    @Override
    public void load() {
        state = NativeState.get(getContext());
    }

    // ---- state and pairing -------------------------------------------------------------------

    @PluginMethod
    public void getState(PluginCall call) {
        JSObject o = new JSObject();
        o.put("paired", state.isPaired());
        o.put("server", state.server());
        o.put("deviceName", state.deviceName());
        o.put("deviceId", state.deviceId());
        o.put("lockedToPerson", state.lockedUserId() != null);
        o.put("hasPin", state.hasPin());
        o.put("autoPinKids", state.autoPinKids());
        o.put("pinned", isPinned());
        o.put("appVersion", BuildConfig.VERSION_NAME);
        o.put("pendingPairLink", state.takePendingPairLink());
        ApiRouter r = state.router();
        o.put("userId", r == null ? null : r.currentUserId());
        o.put("role", r == null ? null : r.currentRole());
        call.resolve(o);
    }

    /** Claims a pairing code: { server, code, name, pin }. */
    @PluginMethod
    public void pair(PluginCall call) {
        String server = call.getString("server", "");
        String code = call.getString("code", "");
        String name = call.getString("name", "Tablet");
        String pin = call.getString("pin");
        if (!server.startsWith("http://") && !server.startsWith("https://")) {
            call.reject("The server address should start with http:// or https://", "BAD_SERVER");
            return;
        }
        if (pin != null && !pin.isEmpty() && !PinHasher.isValidPin(pin)) {
            call.reject("The PIN should be 4 to 8 digits", "BAD_PIN");
            return;
        }
        io.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("code", code);
                if (name != null && !name.trim().isEmpty()) body.put("name", name.trim());
                Request req = new Request.Builder()
                        .url(ServerClient.stripSlash(server) + "/api/devices/claim")
                        .post(RequestBody.create(body.toString(), MediaType.parse("application/json")))
                        .header("Accept", "application/json")
                        .build();
                try (okhttp3.Response res = ServerClient.plainClient().newCall(req).execute()) {
                    String text = res.body() == null ? "" : res.body().string();
                    JSONObject json = text.isEmpty() ? new JSONObject() : new JSONObject(text);
                    if (!res.isSuccessful()) {
                        call.reject(json.optString("message", "Pairing failed (HTTP " + res.code() + ")"), "PAIR_FAILED");
                        return;
                    }
                    JSONObject device = json.getJSONObject("device");
                    String locked = device.isNull("userId") ? null : device.optString("userId", null);
                    state.savePairing(
                            server,
                            json.getString("deviceToken"),
                            device.optString("id"),
                            device.optString("name", name),
                            locked,
                            pin == null || pin.isEmpty() ? null : PinHasher.hash(pin));
                    JSObject out = new JSObject();
                    out.put("deviceName", state.deviceName());
                    out.put("lockedToPerson", locked != null);
                    call.resolve(out);
                }
            } catch (IOException e) {
                call.reject("Couldn't reach " + server + ". Check the address and that this tablet is on the same network.", "OFFLINE");
            } catch (JSONException e) {
                call.reject("That doesn't look like a BookBandit server", "BAD_RESPONSE");
            }
        });
    }

    @PluginMethod
    public void unpair(PluginCall call) {
        if (!state.checkPin(call.getString("pin"))) {
            rejectPin(call);
            return;
        }
        stopPinning();
        state.unpair();
        call.resolve();
    }

    // ---- API requests with a body ------------------------------------------------------------

    /**
     * { method, path, headers, body?, bodyBase64? } -> { status, headers, body }.
     * Rejects with code OFFLINE when the server can't be reached, so the page sees a network error.
     */
    @PluginMethod
    public void request(PluginCall call) {
        ApiRouter router = state.router();
        if (router == null) {
            call.reject("This tablet isn't paired", "NOT_PAIRED");
            return;
        }
        String method = call.getString("method", "POST");
        String path = call.getString("path", "");
        if (!path.startsWith("/api/")) {
            call.reject("Only /api requests", "BAD_PATH");
            return;
        }
        Map<String, String> headers = new HashMap<>();
        JSObject h = call.getObject("headers", new JSObject());
        for (Iterator<String> it = h.keys(); it.hasNext();) {
            String k = it.next();
            headers.put(k, h.optString(k));
        }
        byte[] body = null;
        String b64 = call.getString("bodyBase64");
        String text = call.getString("body");
        if (b64 != null) body = Base64.decode(b64, Base64.DEFAULT);
        else if (text != null) body = text.getBytes(StandardCharsets.UTF_8);
        final byte[] payload = body;

        io.execute(() -> {
            try {
                ApiRouter.Response res = router.send(method, path, headers, payload);
                byte[] bytes = res.readAll();
                JSObject out = new JSObject();
                out.put("status", res.status);
                JSObject rh = new JSObject();
                rh.put("content-type", res.contentType);
                out.put("headers", rh);
                out.put("body", new String(bytes, StandardCharsets.UTF_8));
                call.resolve(out);
            } catch (IOException e) {
                call.reject("Offline", "OFFLINE");
            }
        });
    }

    // ---- offline downloads -------------------------------------------------------------------

    /** { bookId, fileId } — saves the book for whoever is signed in now. Progress: "download" events. */
    @PluginMethod
    public void download(PluginCall call) {
        ApiRouter router = state.router();
        ServerClient client = state.client();
        String bookId = call.getString("bookId");
        String fileId = call.getString("fileId");
        if (router == null || client == null) {
            call.reject("This tablet isn't paired", "NOT_PAIRED");
            return;
        }
        if (!OfflineStore.isSafeId(bookId) || !OfflineStore.isSafeId(fileId)) {
            call.reject("Bad book", "BAD_ID");
            return;
        }
        String userId = router.currentUserId();
        if (userId == null) {
            call.reject("Open the library once while online first", "NO_USER");
            return;
        }
        String key = userId + "/" + bookId;
        if (!queued.add(key)) {
            call.resolve(status("queued", bookId, 0, 0, null));
            return;
        }
        call.resolve(status("queued", bookId, 0, 0, null));
        downloads.execute(() -> {
            try {
                runDownload(client, userId, bookId, fileId);
            } finally {
                queued.remove(key);
            }
        });
    }

    private void runDownload(ServerClient client, String userId, String bookId, String fileId) {
        OfflineStore store = state.offline();
        try {
            // Ask the server first: it applies the content lock for this person.
            ApiRouter.Response detailRes = client.execute("GET", "/api/books/" + bookId, accept("application/json"), null);
            byte[] detailBytes = detailRes.readAll();
            if (detailRes.status != 200) {
                emit(status("error", bookId, 0, 0, detailRes.status == 404 ? "That book isn't available" : "HTTP " + detailRes.status));
                return;
            }
            JSONObject detail = new JSONObject(new String(detailBytes, StandardCharsets.UTF_8));
            String format = null;
            JSONArray files = detail.optJSONArray("files");
            for (int i = 0; files != null && i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                if (fileId.equals(f.optString("id"))) format = f.optString("format");
            }
            if (format == null) {
                emit(status("error", bookId, 0, 0, "That file isn't part of the book"));
                return;
            }

            ApiRouter.Response fileRes = client.execute("GET", "/api/books/" + bookId + "/files/" + fileId, new HashMap<>(), null);
            if (fileRes.status != 200) {
                fileRes.body.close();
                emit(status("error", bookId, 0, 0, "HTTP " + fileRes.status));
                return;
            }
            long total = fileRes.length;
            File part = store.tempFile(userId, bookId);
            long received = 0;
            long lastEmit = 0;
            try (InputStream in = fileRes.body; OutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    received += n;
                    long now = System.currentTimeMillis();
                    if (now - lastEmit > 250) {
                        lastEmit = now;
                        emit(status("downloading", bookId, received, total, null));
                    }
                }
            }

            byte[] cover = null;
            String coverType = null;
            if (!detail.isNull("coverPath") && detail.has("coverPath")) {
                try {
                    ApiRouter.Response c = client.execute("GET", "/api/books/" + bookId + "/cover", accept("image/*"), null);
                    byte[] bytes = c.readAll();
                    if (c.status == 200) {
                        cover = bytes;
                        coverType = c.contentType;
                    }
                } catch (IOException ignored) {
                    // no cover offline; the book still opens
                }
            }
            store.commit(userId, bookId, fileId, format, detail, cover, coverType);
            emit(status("done", bookId, received, received, null));
        } catch (IOException e) {
            emit(status("error", bookId, 0, 0, "The download stopped. Check the wifi and try again."));
        } catch (JSONException e) {
            emit(status("error", bookId, 0, 0, "The server sent something unexpected"));
        }
    }

    @PluginMethod
    public void removeDownload(PluginCall call) {
        ApiRouter router = state.router();
        String userId = router == null ? null : router.currentUserId();
        String bookId = call.getString("bookId");
        if (userId != null && OfflineStore.isSafeId(bookId)) state.offline().remove(userId, bookId);
        call.resolve();
    }

    /** Books downloaded for whoever is signed in now. */
    @PluginMethod
    public void listDownloads(PluginCall call) {
        ApiRouter router = state.router();
        String userId = router == null ? null : router.currentUserId();
        JSArray items = new JSArray();
        long used = 0;
        if (userId != null) {
            for (JSONObject m : state.offline().list(userId)) {
                JSObject o = new JSObject();
                o.put("bookId", m.optString("bookId"));
                o.put("fileId", m.optString("fileId"));
                o.put("title", m.optString("title"));
                o.put("format", m.optString("format"));
                o.put("sizeBytes", m.optLong("sizeBytes"));
                o.put("downloadedAt", m.optLong("downloadedAt"));
                items.put(o);
            }
            used = state.offline().usedBytes(userId);
        }
        JSObject out = new JSObject();
        out.put("items", items);
        out.put("usedBytes", used);
        out.put("freeBytes", getContext().getFilesDir().getUsableSpace());
        call.resolve(out);
    }

    @PluginMethod
    public void downloadStatus(PluginCall call) {
        ApiRouter router = state.router();
        String userId = router == null ? null : router.currentUserId();
        String bookId = call.getString("bookId");
        String s = "none";
        if (userId != null && OfflineStore.isSafeId(bookId)) {
            if (queued.contains(userId + "/" + bookId)) s = "downloading";
            else if (state.offline().meta(userId, bookId) != null) s = "done";
        }
        call.resolve(status(s, bookId, 0, 0, null));
    }

    // ---- screen pinning and the parent PIN ---------------------------------------------------

    @PluginMethod
    public void pinScreen(PluginCall call) {
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            try {
                a.startLockTask();
                call.resolve();
            } catch (RuntimeException e) {
                call.reject("This tablet doesn't allow screen pinning", "UNAVAILABLE");
            }
        });
    }

    /** { pin } */
    @PluginMethod
    public void unpinScreen(PluginCall call) {
        if (!state.checkPin(call.getString("pin"))) {
            rejectPin(call);
            return;
        }
        stopPinning();
        call.resolve();
    }

    void stopPinning() {
        Activity a = getActivity();
        if (a == null) return;
        a.runOnUiThread(() -> {
            try {
                a.stopLockTask();
            } catch (RuntimeException ignored) {
                // wasn't pinned
            }
        });
    }

    boolean isPinned() {
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) return am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE;
        return false;
    }

    /** { pin } -> resolves when right; rejects with WRONG_PIN (and retryAfterMs) otherwise. */
    @PluginMethod
    public void checkPin(PluginCall call) {
        if (state.checkPin(call.getString("pin"))) call.resolve();
        else rejectPin(call);
    }

    /** { oldPin, newPin } (newPin empty removes the PIN). */
    @PluginMethod
    public void setPin(PluginCall call) {
        if (!state.checkPin(call.getString("oldPin"))) {
            rejectPin(call);
            return;
        }
        String next = call.getString("newPin", "");
        if (next.isEmpty()) {
            state.setPinHash(null);
        } else if (!PinHasher.isValidPin(next)) {
            call.reject("The PIN should be 4 to 8 digits", "BAD_PIN");
            return;
        } else {
            state.setPinHash(PinHasher.hash(next));
        }
        call.resolve();
    }

    /** { value, pin } */
    @PluginMethod
    public void setAutoPinKids(PluginCall call) {
        if (!state.checkPin(call.getString("pin"))) {
            rejectPin(call);
            return;
        }
        state.setAutoPinKids(Boolean.TRUE.equals(call.getBoolean("value", false)));
        call.resolve();
    }

    private void rejectPin(PluginCall call) {
        long wait = state.pin.retryAfter(System.currentTimeMillis());
        JSObject data = new JSObject();
        data.put("retryAfterMs", wait);
        call.reject(wait > 0 ? "Too many tries. Wait a moment." : "That PIN isn't right", "WRONG_PIN", data);
    }

    // ---- helpers ----------------------------------------------------------------------------

    private static Map<String, String> accept(String type) {
        Map<String, String> h = new HashMap<>();
        h.put("accept", type);
        return h;
    }

    private static JSObject status(String s, String bookId, long received, long total, String error) {
        JSObject o = new JSObject();
        o.put("status", s);
        o.put("bookId", bookId);
        o.put("received", received);
        o.put("total", total);
        if (error != null) o.put("error", error);
        return o;
    }

    private void emit(JSObject o) {
        notifyListeners("download", o);
    }
}
