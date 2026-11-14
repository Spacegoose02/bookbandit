package app.bookbandit.tablet;

import java.io.IOException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.ResponseBody;

/** Talks to the BookBandit server with the device token and this tablet's cookies. */
public final class ServerClient implements ApiRouter.Upstream {

    private final OkHttpClient http;
    private final CookieStore cookies;
    private final String server;
    private final String deviceToken;

    public ServerClient(String server, String deviceToken, CookieStore cookies) {
        this.server = stripSlash(server);
        this.deviceToken = deviceToken;
        this.cookies = cookies;
        this.http = new OkHttpClient.Builder()
                .cookieJar(cookies)
                .connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(60, TimeUnit.SECONDS)
                .followRedirects(true)
                .build();
    }

    /** For pairing, before there is a token. */
    public static OkHttpClient plainClient() {
        return new OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build();
    }

    public String server() {
        return server;
    }

    @Override
    public String identityKey() {
        String s = cookies.sessionValue();
        return s == null ? "device" : "s:" + Hex.sha256(s).substring(0, 32);
    }

    @Override
    public ApiRouter.Response execute(String method, String pathAndQuery, Map<String, String> headers, byte[] body) throws IOException {
        if (!pathAndQuery.startsWith("/api/")) throw new IOException("Only /api is proxied");
        String m = method.toUpperCase(Locale.ROOT);
        Request.Builder b = new Request.Builder().url(server + pathAndQuery);
        for (Map.Entry<String, String> h : headers.entrySet()) b.header(h.getKey(), h.getValue());
        b.header("Authorization", "Bearer " + deviceToken);

        RequestBody rb = null;
        if (!m.equals("GET") && !m.equals("HEAD")) {
            String type = ApiRouter.header(headers, "content-type");
            byte[] bytes = body == null ? new byte[0] : body;
            boolean required = m.equals("POST") || m.equals("PUT") || m.equals("PATCH");
            if (body != null || required) {
                rb = RequestBody.create(bytes, type == null ? null : MediaType.parse(type));
            }
        }
        b.method(m, rb);

        okhttp3.Response res = http.newCall(b.build()).execute();
        ResponseBody rbody = res.body();
        Map<String, String> out = new HashMap<>();
        for (String name : new String[] { "Content-Range", "Accept-Ranges", "Content-Disposition", "Cache-Control", "ETag", "Retry-After" }) {
            String v = res.header(name);
            if (v != null) out.put(name, v);
        }
        String type = res.header("Content-Type", "application/octet-stream");
        long len = rbody == null ? 0 : rbody.contentLength();
        if (len >= 0) out.put("Content-Length", String.valueOf(len));
        return new ApiRouter.Response(
                res.code(),
                type,
                out,
                rbody == null ? new java.io.ByteArrayInputStream(new byte[0]) : rbody.byteStream(),
                len);
    }

    static String stripSlash(String s) {
        String out = s.trim();
        while (out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out;
    }
}
