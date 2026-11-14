import { useEffect, useState } from "react";
import { Link, matchPath, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { useSession } from "../app/session";
import { BarnabyAvatar } from "../brand/Barnaby";
import { BarnabyChat } from "./BarnabyChat";
import { useAiStatus } from "./useAiStatus";
import "./ai.css";

/**
 * Barnaby's floating button, on every page. On a book or in the reader, the chat is about
 * that book (spoiler-free); anywhere else it's a general chat.
 */
export function BarnabyLauncher() {
  const { me } = useSession();
  const status = useAiStatus();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [general, setGeneral] = useState(false);
  const [book, setBook] = useState<{ id: string; title: string } | null>(null);
  const [convByKey, setConvByKey] = useState<Record<string, string>>({});

  const routeBookId =
    matchPath("/book/:id", location.pathname)?.params.id ?? matchPath("/read/:id", location.pathname)?.params.id ?? null;
  const inReader = !!matchPath("/read/:id", location.pathname);

  useEffect(() => {
    setGeneral(false);
    if (!routeBookId) return setBook(null);
    let live = true;
    api.book(routeBookId).then(
      (b) => live && setBook({ id: b.id, title: b.title }),
      () => live && setBook(null),
    );
    return () => {
      live = false;
    };
  }, [routeBookId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!me || !status || location.pathname.startsWith("/barnaby")) return null;
  // Kids only see Barnaby when a parent has switched him on (or to explain today's limit).
  if (
    !status.available &&
    !(status.kid && status.reason === "daily_limit") &&
    !(me.role === "admin" && status.reason === "not_configured")
  )
    return null;

  const chatBook = !general && status.bookChat ? book : null;
  const key = chatBook ? `book:${chatBook.id}` : "general";

  return (
    <>
      <button
        type="button"
        className={`bb-launcher${me.isKid ? " is-kid" : ""}${inReader ? " in-reader" : ""}${open ? " is-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="bb-barnaby-panel"
        aria-label={open ? "Close Barnaby" : "Ask Barnaby"}
      >
        <BarnabyAvatar size={me.isKid ? 64 : 52} />
        {!open && <span className="bb-launcher-label">{me.isKid ? "Ask me!" : "Ask Barnaby"}</span>}
      </button>
      {open && (
        <aside id="bb-barnaby-panel" className={`bb-barnaby-panel${me.isKid ? " is-kid" : ""}${inReader ? " in-reader" : ""}`} aria-label="Barnaby">
          <header className="bb-panel-head">
            <BarnabyAvatar size={36} />
            <div className="bb-panel-title">
              <strong>Barnaby</strong>
              <span className="bb-muted">
                {chatBook ? `About “${chatBook.title}” · no spoilers` : me.isKid ? "Your book buddy" : "Your library helper"}
              </span>
            </div>
            {book && status.bookChat && (
              <button type="button" className="bb-btn bb-btn-small" onClick={() => setGeneral((g) => !g)}>
                {general ? "This book" : "General"}
              </button>
            )}
            {!me.isKid && (
              <Link className="bb-btn bb-btn-small" to="/barnaby" onClick={() => setOpen(false)}>
                All chats
              </Link>
            )}
            <button type="button" className="bb-icon-btn" onClick={() => setOpen(false)} aria-label="Close">
              ✕
            </button>
          </header>
          {status.available ? (
            <BarnabyChat
              key={key}
              status={status}
              name={me.displayName}
              kid={me.isKid}
              book={chatBook}
              conversationId={convByKey[key] ?? null}
              onConversation={(id) => setConvByKey((m) => ({ ...m, [key]: id }))}
            />
          ) : (
            <div className="bb-panel-off">
              <p>{status.message}</p>
              {status.reason === "not_configured" && me.role === "admin" && (
                <Link className="bb-btn bb-btn-primary" to="/barnaby/settings" onClick={() => setOpen(false)}>
                  Set up Barnaby
                </Link>
              )}
            </div>
          )}
        </aside>
      )}
    </>
  );
}
