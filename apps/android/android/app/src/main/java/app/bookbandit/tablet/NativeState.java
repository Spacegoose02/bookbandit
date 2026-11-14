package app.bookbandit.tablet;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.File;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The tablet's own state: which server it is paired with, its device token, the parent PIN,
 * kid-safety settings, sign-in cookies and offline data. Kept in app-private storage; the device
 * token never goes to the WebView.
 */
public final class NativeState {

    public interface KidListener {
        void onReaderChanged(String userId, String role);
    }

    private static NativeState instance;

    public static synchronized NativeState get(Context ctx) {
        if (instance == null) instance = new NativeState(ctx.getApplicationContext());
        return instance;
    }

    private final SharedPreferences prefs;
    private final OfflineStore offline;
    public final PinHasher pin = new PinHasher();
    private CookieStore cookies;
    private ServerClient client;
    private ApiRouter router;
    private volatile KidListener kidListener;
    /** A bookbandit://pair link that opened the app before it was paired. */
    private volatile String pendingPairLink;

    private NativeState(Context ctx) {
        prefs = ctx.getSharedPreferences("bookbandit", Context.MODE_PRIVATE);
        offline = new OfflineStore(new File(ctx.getFilesDir(), "offline"));
    }

    public boolean isPaired() {
        return prefs.getString("token", null) != null && prefs.getString("server", null) != null;
    }

    public String server() {
        return prefs.getString("server", null);
    }

    public String deviceName() {
        return prefs.getString("deviceName", "Tablet");
    }

    public String deviceId() {
        return prefs.getString("deviceId", null);
    }

    public String lockedUserId() {
        return prefs.getString("lockedUserId", null);
    }

    public OfflineStore offline() {
        return offline;
    }

    public synchronized void savePairing(String server, String token, String deviceId, String deviceName, String lockedUserId, String pinHash) {
        prefs.edit()
                .putString("server", ServerClient.stripSlash(server))
                .putString("token", token)
                .putString("deviceId", deviceId)
                .putString("deviceName", deviceName)
                .putString("lockedUserId", lockedUserId)
                .putString("pinHash", pinHash)
                .remove("cookies")
                .remove("people")
                .apply();
        cookies = null;
        client = null;
        router = null;
    }

    public synchronized void unpair() {
        prefs.edit().clear().apply();
        offline.removeAll();
        cookies = null;
        client = null;
        router = null;
    }

    // ---- PIN and kid safety -----------------------------------------------------------------

    public boolean hasPin() {
        return prefs.getString("pinHash", null) != null;
    }

    /** True when no PIN is set, or the PIN is right. */
    public boolean checkPin(String guess) {
        String stored = prefs.getString("pinHash", null);
        if (stored == null) return true;
        return pin.check(guess, stored, System.currentTimeMillis());
    }

    public void setPinHash(String hash) {
        prefs.edit().putString("pinHash", hash).apply();
    }

    public boolean autoPinKids() {
        return prefs.getBoolean("autoPinKids", false);
    }

    public void setAutoPinKids(boolean on) {
        prefs.edit().putBoolean("autoPinKids", on).apply();
    }

    public void setKidListener(KidListener l) {
        kidListener = l;
    }

    public void setPendingPairLink(String link) {
        pendingPairLink = link;
    }

    public String takePendingPairLink() {
        String l = pendingPairLink;
        pendingPairLink = null;
        return l;
    }

    // ---- server access ----------------------------------------------------------------------

    /** The /api router, or null when the tablet isn't paired. */
    public synchronized ApiRouter router() {
        if (!isPaired()) return null;
        if (router == null) {
            router = new ApiRouter(client(), offline, loadPeople(), (identity, userId, role) -> {
                savePerson(identity, userId, role);
                KidListener l = kidListener;
                if (l != null) l.onReaderChanged(userId, role);
            });
        }
        return router;
    }

    public synchronized ServerClient client() {
        if (!isPaired()) return null;
        if (client == null) {
            if (cookies == null) {
                cookies = new CookieStore(prefs.getString("cookies", null), json -> prefs.edit().putString("cookies", json).apply());
            }
            client = new ServerClient(server(), prefs.getString("token", ""), cookies);
        }
        return client;
    }

    private Map<String, String[]> loadPeople() {
        Map<String, String[]> out = new HashMap<>();
        try {
            JSONObject o = new JSONObject(prefs.getString("people", "{}"));
            for (Iterator<String> it = o.keys(); it.hasNext();) {
                String k = it.next();
                JSONObject p = o.getJSONObject(k);
                out.put(k, new String[] { p.getString("userId"), p.optString("role", null) });
            }
        } catch (JSONException ignored) {
            // start fresh
        }
        return out;
    }

    private synchronized void savePerson(String identity, String userId, String role) {
        try {
            JSONObject o = new JSONObject(prefs.getString("people", "{}"));
            JSONObject p = new JSONObject();
            p.put("userId", userId);
            p.put("role", role == null ? JSONObject.NULL : role);
            o.put(identity, p);
            // Old sign-ins pile up on a shared tablet; keep the newest few dozen.
            if (o.length() > 50) {
                Iterator<String> it = o.keys();
                if (it.hasNext()) o.remove(it.next());
            }
            prefs.edit().putString("people", o.toString()).apply();
        } catch (JSONException ignored) {
            // not saved; it is learned again next time online
        }
    }
}
