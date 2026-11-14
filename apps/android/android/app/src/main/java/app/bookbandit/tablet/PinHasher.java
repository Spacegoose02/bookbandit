package app.bookbandit.tablet;

import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * The parent PIN that guards tablet settings and unpinning. Stored as "salt:hash" (hex), PBKDF2.
 * Wrong guesses lock the screen for longer each time (30 s, 60 s, 120 s, ... up to 1 hour).
 */
public final class PinHasher {

    private static final int ITERATIONS = 20_000;
    private static final int FREE_TRIES = 5;

    private int failures = 0;
    private long lockedUntil = 0;

    public static boolean isValidPin(String pin) {
        return pin != null && pin.matches("\\d{4,8}");
    }

    public static String hash(String pin) {
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        return Hex.encode(salt) + ":" + Hex.encode(derive(pin, salt));
    }

    public static boolean matches(String pin, String stored) {
        if (pin == null || stored == null) return false;
        int i = stored.indexOf(':');
        if (i <= 0) return false;
        byte[] salt = Hex.decode(stored.substring(0, i));
        byte[] expected = Hex.decode(stored.substring(i + 1));
        return MessageDigest.isEqual(expected, derive(pin, salt));
    }

    private static byte[] derive(String pin, byte[] salt) {
        try {
            PBEKeySpec spec = new PBEKeySpec(pin.toCharArray(), salt, ITERATIONS, 256);
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** Milliseconds until the next guess is allowed (0 = now). */
    public synchronized long retryAfter(long now) {
        return Math.max(0, lockedUntil - now);
    }

    /** Checks a guess, counting failures. Returns false while locked out. */
    public synchronized boolean check(String pin, String stored, long now) {
        if (retryAfter(now) > 0) return false;
        if (matches(pin, stored)) {
            failures = 0;
            lockedUntil = 0;
            return true;
        }
        failures++;
        if (failures >= FREE_TRIES) {
            int over = Math.min(failures - FREE_TRIES, 7);
            lockedUntil = now + Math.min(3_600_000L, 30_000L << over);
        }
        return false;
    }
}
