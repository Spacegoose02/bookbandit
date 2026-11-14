import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { RATING_LABELS, type ContentRating } from "@bookbandit/shared";
import { useSession } from "../app/session";
import { BarnabyAvatar, BarnabyEmpty } from "../brand/Barnaby";
import { BookCard } from "../library/BookCard";
import { aiApi, type KidAiRow, type SmartRequestResult } from "./api";
import { useAiStatus } from "./useAiStatus";
import "./ai.css";

const EXAMPLES = [
  "Something like Pixel Quest for a 10-year-old",
  "A cozy mystery with no gore",
  "Funny picture books about bedtime",
  "A big fantasy series to get lost in",
];

/**
 * /barnaby/find: "something like Pixel Quest for a 10-year-old". Barnaby picks from the library
 * (behind the content lock and the age asked for) and suggests a few books to request.
 */
export function FindBookPage() {
  const { me } = useSession();
  const status = useAiStatus();
  const [text, setText] = useState("");
  const [forKid, setForKid] = useState("");
  const [kids, setKids] = useState<KidAiRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SmartRequestResult | null>(null);

  useEffect(() => {
    if (me && !me.isKid) aiApi.kids().then(setKids, () => setKids([]));
  }, [me]);

  if (!me) return null;
  if (me.isKid)
    return (
      <BarnabyEmpty title="Ask Barnaby in the chat!">
        <Link className="bb-btn bb-btn-primary" to="/barnaby">
          Chat with Barnaby
        </Link>
      </BarnabyEmpty>
    );
  if (status && !status.smartRequests)
    return (
      <BarnabyEmpty title="Barnaby isn't ready yet">
        <p>{status.message ?? "An admin can add an AI provider in Barnaby settings."}</p>
      </BarnabyEmpty>
    );

  async function ask(q: string) {
    const trimmed = q.trim();
    if (trimmed.length < 3 || busy) return;
    setText(trimmed);
    setBusy(true);
    setError(null);
    try {
      setResult(await aiApi.smartRequest(trimmed, forKid || undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(text);
  };

  const i = result?.interpreted;
  return (
    <div className="bb-page bb-find">
      <p className="bb-crumbs">
        <Link to="/barnaby">← Barnaby</Link>
      </p>
      <div className="bb-find-head">
        <BarnabyAvatar size={56} thinking={busy} />
        <div>
          <h1 className="bb-h1">Find a book</h1>
          <p className="bb-muted">Tell Barnaby what you're after, in your own words. He'll look through your library first.</p>
        </div>
      </div>
      <form className="bb-find-form" onSubmit={onSubmit}>
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Something like Pixel Quest for a 10-year-old"
          aria-label="What kind of book?"
          maxLength={500}
        />
        {kids.length > 0 && (
          <label className="bb-find-for">
            For{" "}
            <select value={forKid} onChange={(e) => setForKid(e.target.value)}>
              <option value="">anyone</option>
              {kids.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.displayName}
                  {k.age != null ? ` (${k.age})` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="bb-btn bb-btn-primary" type="submit" disabled={busy || text.trim().length < 3}>
          {busy ? "Looking…" : "Find"}
        </button>
      </form>
      {!result && !busy && (
        <div className="bb-chat-starters">
          {EXAMPLES.map((x) => (
            <button key={x} type="button" className="bb-chip" onClick={() => void ask(x)}>
              {x}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="bb-error" role="alert">
          {error}
        </p>
      )}
      {result && i && (
        <>
          <p className="bb-find-understood">
            Looking for{" "}
            {[
              i.like.length ? `books like ${i.like.map((t) => `“${t}”`).join(" and ")}` : null,
              i.topics.length ? i.topics.join(", ") : null,
            ]
              .filter(Boolean)
              .join(", about ") || "a good read"}
            {i.forKid ? ` for ${i.forKid.displayName}` : i.age != null ? ` for a ${i.age}-year-old` : ""}
            {i.maxRating !== "adult" && i.maxRating !== "explicit" && (
              <span className="bb-pill">{RATING_LABELS[i.maxRating as ContentRating] ?? i.maxRating} and younger</span>
            )}
          </p>
          <section className="bb-shelf" aria-labelledby="bb-find-picks">
            <div className="bb-shelf-head">
              <h2 id="bb-find-picks">In your library</h2>
            </div>
            {result.picks.length ? (
              <ul className="bb-find-picks">
                {result.picks.map((b) => (
                  <li key={b.id}>
                    <BookCard book={b} />
                    <p>{b.reason}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="bb-muted">Nothing in the library fits yet.</p>
            )}
          </section>
          {result.outside.length > 0 && (
            <section className="bb-shelf" aria-labelledby="bb-find-outside">
              <div className="bb-shelf-head">
                <h2 id="bb-find-outside">Not in the library yet</h2>
              </div>
              <ul className="bb-find-outside">
                {result.outside.map((o) => (
                  <li key={o.title}>
                    <div>
                      <strong>{o.title}</strong>
                      {o.author && <span className="bb-muted"> by {o.author}</span>}
                      <p>{o.reason}</p>
                    </div>
                    <Link className="bb-btn bb-btn-small" to={`/requests?${new URLSearchParams({ tab: "ask", q: `${o.title} ${o.author}`.trim() })}`}>
                      Request it
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
