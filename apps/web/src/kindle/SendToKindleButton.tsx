import { useEffect, useState, type FormEvent } from "react";
import type { BookDetail } from "../api/types";
import { useSession } from "../app/session";
import { isKindleAddress, kindleApi, type KindleMe } from "./api";
import "./kindle.css";

const SENDABLE = ["epub", "pdf"];

/**
 * "Send to Kindle" on the book page. Shows only when an admin set up email, the book has an
 * EPUB or PDF, and this profile has (or can add) a Kindle address. No DRM'd files, ever: the
 * server sends plain files from /books only.
 */
export function SendToKindleButton({ book }: { book: Pick<BookDetail, "id" | "kindleOnly" | "files"> }) {
  const { me } = useSession();
  const [info, setInfo] = useState<KindleMe | null>(null);
  const [state, setState] = useState<"idle" | "ask" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    kindleApi.me().then(setInfo, () => setInfo(null));
  }, []);

  const sendable = !book.kindleOnly && book.files?.some((f) => SENDABLE.includes(f.format));
  if (!info?.available || !sendable || (!info.email && !info.canEdit)) return null;

  async function send() {
    setState("sending");
    try {
      const r = await kindleApi.send(book.id);
      setMessage(`Sent to ${r.sentTo}. It shows up on your Kindle in a few minutes.`);
      setState("sent");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  async function saveAndSend(e: FormEvent) {
    e.preventDefault();
    if (!me) return;
    if (!isKindleAddress(email)) {
      setMessage("Use your Kindle's address, ending in @kindle.com");
      return;
    }
    try {
      await kindleApi.setAddress(me.id, email);
      setInfo({ ...info!, email: email.trim().toLowerCase() });
      await send();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="bb-kindle">
      <button
        className="bb-btn bb-btn-big"
        disabled={state === "sending"}
        onClick={() => (info.email ? void send() : (setState("ask"), setMessage("")))}
        title={info.email ? `Send to ${info.email}` : undefined}
      >
        <span aria-hidden>{state === "sent" ? "✅" : "📨"}</span> {state === "sending" ? "Sending…" : "Send to Kindle"}
      </button>
      {state === "ask" && (
        <form className="bb-kindle-ask" onSubmit={saveAndSend}>
          <label className="bb-field">
            <span>Your Kindle's email address</span>
            <input
              className="bb-input"
              type="email"
              inputMode="email"
              placeholder="name_1234@kindle.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </label>
          <p className="bb-muted bb-small">
            Find it on Amazon under Manage Your Content and Devices → Preferences → Personal Document Settings.
            {info.fromAddress ? ` Add ${info.fromAddress} to the approved senders list there.` : ""}
          </p>
          <div className="bb-actions">
            <button className="bb-btn bb-btn-primary">Save and send</button>
            <button type="button" className="bb-btn bb-btn-ghost" onClick={() => setState("idle")}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {message && (
        <p className={state === "error" || state === "ask" ? "bb-error" : "bb-kindle-ok"} role="status">
          {message}
        </p>
      )}
    </div>
  );
}
