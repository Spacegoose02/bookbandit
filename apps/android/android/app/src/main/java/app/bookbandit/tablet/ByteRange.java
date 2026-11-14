package app.bookbandit.tablet;

/** A single "bytes=start-end" Range request, resolved against a file length. */
public final class ByteRange {

    public final long start;
    public final long end; // inclusive

    private ByteRange(long start, long end) {
        this.start = start;
        this.end = end;
    }

    public long length() {
        return end - start + 1;
    }

    /** Marker for a range that starts past the end of the file (answer 416). */
    public static final ByteRange UNSATISFIABLE = new ByteRange(-1, -2);

    /**
     * Parses a Range header. Returns null when there is no usable range (serve the whole file),
     * UNSATISFIABLE when the range is past the end, or the resolved range. Multi-range requests are
     * answered with the whole file, which HTTP allows.
     */
    public static ByteRange parse(String header, long fileLength) {
        if (header == null) return null;
        String h = header.trim();
        if (!h.startsWith("bytes=") || h.indexOf(',') >= 0) return null;
        String spec = h.substring(6).trim();
        int dash = spec.indexOf('-');
        if (dash < 0) return null;
        String a = spec.substring(0, dash).trim();
        String b = spec.substring(dash + 1).trim();
        try {
            if (a.isEmpty()) {
                if (b.isEmpty()) return null;
                long suffix = Long.parseLong(b);
                if (suffix <= 0) return UNSATISFIABLE;
                if (fileLength == 0) return UNSATISFIABLE;
                long start = Math.max(0, fileLength - suffix);
                return new ByteRange(start, fileLength - 1);
            }
            long start = Long.parseLong(a);
            if (start < 0) return null;
            if (start >= fileLength) return UNSATISFIABLE;
            long end = b.isEmpty() ? fileLength - 1 : Math.min(Long.parseLong(b), fileLength - 1);
            if (end < start) return null;
            return new ByteRange(start, end);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
