import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSession } from "../app/session";
import { BookEditDialog } from "./BookEditDialog";

/** Sent on `window` after the book editor saves, so open pages can reload that book. */
export const BOOK_EDITED = "bb:book-edited";

const Ctx = createContext<((bookId: string) => void) | null>(null);

/** Lets any page open the book editor. Only admins get an opener; for everyone else it's null. */
export function BookEditHost({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const [open, setOpen] = useState<string | null>(null);
  const edit = useCallback((bookId: string) => setOpen(bookId), []);
  const value = useMemo(() => (me?.role === "admin" ? edit : null), [me?.role, edit]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {open && value && (
        <BookEditDialog
          bookId={open}
          onClose={() => setOpen(null)}
          onSaved={(b) => {
            setOpen(null);
            window.dispatchEvent(new CustomEvent(BOOK_EDITED, { detail: { id: b.id } }));
          }}
        />
      )}
    </Ctx.Provider>
  );
}

/** Opens the book editor, or null when the signed-in person can't edit books. */
export function useBookEditor(): ((bookId: string) => void) | null {
  return useContext(Ctx);
}

/** Runs `cb` after a book is edited (any book, or only `bookId`). */
export function useBookEdited(cb: (id: string) => void, bookId?: string) {
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id && (!bookId || id === bookId)) cb(id);
    };
    window.addEventListener(BOOK_EDITED, on);
    return () => window.removeEventListener(BOOK_EDITED, on);
  }, [cb, bookId]);
}
