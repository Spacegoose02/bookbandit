# E-reader sync changes (`ws/ereader`)

- 2026-11-14: E-reader sync: OPDS 1.2 catalog, KOReader kosync server (positions translated to and from the web reader's CFIs and pages), Kobo store-sync emulation (KEPUB, reading state, removal of books that get locked), e-reader sign-ins and an E-readers settings page (migration 0005). `/opds`, `/kosync` and `/kobo` must bypass Tinyauth on the proxy. See [the ereader README](../../apps/server/src/ereader/README.md) (#19)
