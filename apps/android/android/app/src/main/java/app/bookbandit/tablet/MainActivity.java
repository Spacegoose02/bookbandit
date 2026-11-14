package app.bookbandit.tablet;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private NativeState state;
    /** True when this app pinned the screen itself because a kid signed in. */
    private boolean autoPinned = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BookBanditPlugin.class);
        state = NativeState.get(this);
        super.onCreate(savedInstanceState);
        // Answer /api natively (device token, offline copies). Set before the first API request.
        bridge.setWebViewClient(new ApiWebViewClient(bridge, state));
        state.setKidListener(this::onReaderChanged);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"bookbandit".equals(data.getScheme()) || !"pair".equals(data.getHost())) return;
        // A scanned bookbandit://pair?server=...&code=... link. Only used before pairing; after that,
        // re-pairing goes through the PIN-locked tablet settings.
        if (state.isPaired()) return;
        state.setPendingPairLink(data.toString());
        if (bridge != null && bridge.getWebView() != null) {
            String q = data.getEncodedQuery();
            bridge.getWebView().loadUrl("https://localhost/native/setup.html" + (q == null ? "" : "?" + q));
        }
    }

    /** Called when the reader on this tablet changes (from GET /api/users/me). */
    private void onReaderChanged(String userId, String role) {
        runOnUiThread(() -> {
            boolean kid = "kid".equals(role);
            if (kid && state.autoPinKids() && !autoPinned) {
                try {
                    startLockTask();
                    autoPinned = true;
                } catch (RuntimeException ignored) {
                    // pinning not available on this tablet
                }
            } else if (!kid && autoPinned) {
                try {
                    stopLockTask();
                } catch (RuntimeException ignored) {
                    // already unpinned
                }
                autoPinned = false;
            }
        });
    }
}
