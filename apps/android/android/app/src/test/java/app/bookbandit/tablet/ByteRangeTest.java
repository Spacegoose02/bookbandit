package app.bookbandit.tablet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;

import org.junit.Test;

public class ByteRangeTest {

    @Test
    public void noHeaderOrOddHeaderMeansWholeFile() {
        assertNull(ByteRange.parse(null, 100));
        assertNull(ByteRange.parse("items=0-1", 100));
        assertNull(ByteRange.parse("bytes=0-1,5-6", 100));
        assertNull(ByteRange.parse("bytes=abc", 100));
        assertNull(ByteRange.parse("bytes=5-2", 100));
    }

    @Test
    public void openAndClosedRanges() {
        ByteRange r = ByteRange.parse("bytes=10-19", 100);
        assertEquals(10, r.start);
        assertEquals(19, r.end);
        assertEquals(10, r.length());

        r = ByteRange.parse("bytes=90-", 100);
        assertEquals(90, r.start);
        assertEquals(99, r.end);

        r = ByteRange.parse("bytes=50-500", 100);
        assertEquals(99, r.end);
    }

    @Test
    public void suffixRange() {
        ByteRange r = ByteRange.parse("bytes=-30", 100);
        assertEquals(70, r.start);
        assertEquals(99, r.end);
        r = ByteRange.parse("bytes=-300", 100);
        assertEquals(0, r.start);
    }

    @Test
    public void pastTheEndIsUnsatisfiable() {
        assertSame(ByteRange.UNSATISFIABLE, ByteRange.parse("bytes=100-", 100));
        assertSame(ByteRange.UNSATISFIABLE, ByteRange.parse("bytes=-0", 100));
    }
}
