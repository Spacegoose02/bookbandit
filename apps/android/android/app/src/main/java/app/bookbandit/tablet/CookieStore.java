package app.bookbandit.tablet;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.HttpUrl;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Cookies from the BookBandit server (the sign-in session of whoever is reading on a shared
 * tablet), kept natively and saved across restarts. The WebView never sees them.
 */
public final class CookieStore implements CookieJar {

    public interface Persister {
        void save(String json);
    }

    public static final String SESSION_COOKIE = "bb_session";

    private final List<Cookie> cookies = new ArrayList<>();
    private final Persister persister;

    public CookieStore(String savedJson, Persister persister) {
        this.persister = persister;
        if (savedJson != null && !savedJson.isEmpty()) load(savedJson);
    }

    @Override
    public synchronized void saveFromResponse(HttpUrl url, List<Cookie> incoming) {
        if (incoming.isEmpty()) return;
        long now = System.currentTimeMillis();
        for (Cookie c : incoming) {
            removeMatching(c.name(), c.domain(), c.path());
            if (c.expiresAt() > now) cookies.add(c);
        }
        persist();
    }

    @Override
    public synchronized List<Cookie> loadForRequest(HttpUrl url) {
        long now = System.currentTimeMillis();
        List<Cookie> out = new ArrayList<>();
        boolean dropped = false;
        for (Iterator<Cookie> it = cookies.iterator(); it.hasNext();) {
            Cookie c = it.next();
            if (c.expiresAt() <= now) {
                it.remove();
                dropped = true;
            } else if (c.matches(url)) {
                out.add(c);
            }
        }
        if (dropped) persist();
        return out;
    }

    /** The signed-in session, if any. Used to tell which person's offline data applies. */
    public synchronized String sessionValue() {
        long now = System.currentTimeMillis();
        for (Cookie c : cookies) {
            if (c.name().equals(SESSION_COOKIE) && c.expiresAt() > now) return c.value();
        }
        return null;
    }

    public synchronized void clear() {
        cookies.clear();
        persist();
    }

    private void removeMatching(String name, String domain, String path) {
        cookies.removeIf(c -> c.name().equals(name) && c.domain().equals(domain) && c.path().equals(path));
    }

    private void persist() {
        if (persister == null) return;
        JSONArray arr = new JSONArray();
        for (Cookie c : cookies) {
            JSONObject o = new JSONObject();
            try {
                o.put("name", c.name());
                o.put("value", c.value());
                o.put("domain", c.domain());
                o.put("path", c.path());
                o.put("expiresAt", c.persistent() ? c.expiresAt() : Long.MAX_VALUE);
                o.put("secure", c.secure());
                o.put("httpOnly", c.httpOnly());
                o.put("hostOnly", c.hostOnly());
                arr.put(o);
            } catch (JSONException ignored) {
                // skip this cookie
            }
        }
        persister.save(arr.toString());
    }

    private void load(String json) {
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Cookie.Builder b = new Cookie.Builder()
                        .name(o.getString("name"))
                        .value(o.getString("value"))
                        .path(o.optString("path", "/"))
                        .expiresAt(o.optLong("expiresAt", Long.MAX_VALUE));
                String domain = o.getString("domain");
                if (o.optBoolean("hostOnly", true)) b.hostOnlyDomain(domain);
                else b.domain(domain);
                if (o.optBoolean("secure")) b.secure();
                if (o.optBoolean("httpOnly")) b.httpOnly();
                cookies.add(b.build());
            }
        } catch (JSONException | IllegalArgumentException e) {
            cookies.clear();
        }
    }
}
