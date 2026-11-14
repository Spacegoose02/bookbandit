package app.bookbandit.tablet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PinHasherTest {

    @Test
    public void validPins() {
        assertTrue(PinHasher.isValidPin("1234"));
        assertTrue(PinHasher.isValidPin("12345678"));
        assertFalse(PinHasher.isValidPin("123"));
        assertFalse(PinHasher.isValidPin("123456789"));
        assertFalse(PinHasher.isValidPin("12a4"));
        assertFalse(PinHasher.isValidPin(null));
    }

    @Test
    public void hashesAreSaltedAndVerify() {
        String a = PinHasher.hash("2468");
        String b = PinHasher.hash("2468");
        assertNotEquals(a, b);
        assertTrue(PinHasher.matches("2468", a));
        assertTrue(PinHasher.matches("2468", b));
        assertFalse(PinHasher.matches("2469", a));
        assertFalse(PinHasher.matches("2468", "garbage"));
    }

    @Test
    public void locksOutAfterFiveWrongTries() {
        PinHasher p = new PinHasher();
        String stored = PinHasher.hash("1357");
        long now = 1_000_000;
        for (int i = 0; i < 4; i++) assertFalse(p.check("0000", stored, now));
        assertEquals(0, p.retryAfter(now));
        assertFalse(p.check("0000", stored, now));
        assertEquals(30_000, p.retryAfter(now));
        // Even the right PIN is refused while locked.
        assertFalse(p.check("1357", stored, now + 1000));
        assertTrue(p.check("1357", stored, now + 30_000));
        assertEquals(0, p.retryAfter(now + 30_000));
    }

    @Test
    public void lockoutGrows() {
        PinHasher p = new PinHasher();
        String stored = PinHasher.hash("1357");
        long now = 0;
        for (int i = 0; i < 5; i++) p.check("0000", stored, now);
        now += 30_000;
        p.check("0000", stored, now);
        assertEquals(60_000, p.retryAfter(now));
    }
}
