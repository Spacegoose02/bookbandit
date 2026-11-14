package app.bookbandit.tablet;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import org.json.JSONObject;

/**
 * Answers the web app's GET /api/... requests natively (see ApiRouter), so covers, book files and
 * JSON all carry the device token and work offline. Requests with a body can't be read here
 * (WebView doesn't expose them), so the page sends those through BookBanditPlugin.request.
 * Everything else goes to Capacitor as usual.
 */
public class ApiWebViewClient extends BridgeWebViewClient {

    private final NativeState state;

    public ApiWebViewClient(Bridge bridge, NativeState state) {
        super(bridge);
        this.state = state;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        String path = url.getPath();
        if ("localhost".equals(url.getHost()) && path != null) {
            if (path.equals("/native/state.js")) return stateScript();
            if (path.startsWith("/api/")) return api(request, path, url.getEncodedQuery());
        }
        return super.shouldInterceptRequest(view, request);
    }

    private WebResourceResponse api(WebResourceRequest request, String path, String query) {
        String method = request.getMethod().toUpperCase(Locale.ROOT);
        ApiRouter router = state.router();
        if (router == null) return toWebView(ApiRouter.Response.json(401, "{\"message\":\"This tablet isn't paired yet\"}"));
        if (!method.equals("GET") && !method.equals("HEAD")) {
            // Shouldn't happen: the page's fetch shim sends these through the plugin.
            return toWebView(ApiRouter.Response.json(405, "{\"message\":\"Send this through the BookBandit plugin\"}"));
        }
        return toWebView(router.get(path, query, request.getRequestHeaders()));
    }

    /** Settings the page needs before it starts, as a synchronous script. */
    private WebResourceResponse stateScript() {
        JSONObject o = new JSONObject();
        try {
            o.put("platform", "android");
            o.put("paired", state.isPaired());
            o.put("server", state.server() == null ? JSONObject.NULL : state.server());
            o.put("deviceName", state.deviceName());
            o.put("hasPin", state.hasPin());
            o.put("appVersion", BuildConfig.VERSION_NAME);
        } catch (Exception ignored) {
            // minimal state is fine
        }
        String js = "window.__BB_NATIVE__=" + o + ";";
        WebResourceResponse r = new WebResourceResponse(
                "application/javascript", "utf-8", new ByteArrayInputStream(js.getBytes(StandardCharsets.UTF_8)));
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        r.setResponseHeaders(h);
        return r;
    }

    static WebResourceResponse toWebView(ApiRouter.Response res) {
        String type = res.contentType == null ? "application/octet-stream" : res.contentType;
        String mime = type;
        String encoding = null;
        int semi = type.indexOf(';');
        if (semi >= 0) {
            mime = type.substring(0, semi).trim();
            String rest = type.substring(semi + 1).trim().toLowerCase(Locale.ROOT);
            if (rest.startsWith("charset=")) encoding = rest.substring(8).trim();
        }
        // WebResourceResponse refuses 3xx codes; OkHttp has already followed redirects.
        int status = res.status >= 300 && res.status < 400 ? 502 : res.status;
        Map<String, String> headers = new HashMap<>(res.headers);
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse(mime, encoding, status, reason(status), headers, res.body);
    }

    static String reason(int status) {
        switch (status) {
            case 200:
                return "OK";
            case 201:
                return "Created";
            case 204:
                return "No Content";
            case 206:
                return "Partial Content";
            case 400:
                return "Bad Request";
            case 401:
                return "Unauthorized";
            case 403:
                return "Forbidden";
            case 404:
                return "Not Found";
            case 416:
                return "Range Not Satisfiable";
            case 429:
                return "Too Many Requests";
            case 503:
                return "Service Unavailable";
            default:
                return status < 400 ? "OK" : "Error";
        }
    }
}
