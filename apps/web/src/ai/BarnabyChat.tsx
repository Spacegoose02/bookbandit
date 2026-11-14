import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { BarnabyAvatar } from "../brand/Barnaby";
import { aiApi, type AiMessage, type AiSource, type AiStatus } from "./api";

const KID_STARTERS = [
  "Find me a funny book 😂",
  "Tell me a dinosaur fact 🦖",
  "What does “enormous” mean?",
  "What should I read next? 📚",
];
const ADULT_STARTERS = [
  "What should I read next?",
  "Something cozy for a rainy evening",
  "Which books here are good for a 9 year old?",
  "Find me a short mystery",
];
const BOOK_STARTERS_KID = ["What's happened so far?", "Who is in this story?", "What does a hard word mean?"];
const BOOK_STARTERS = [
  "Recap what's happened so far",
  "Remind me who the main characters are",
  "Explain the last chapter",
  "What themes are showing up?",
];

export interface BarnabyChatProps {
  status: AiStatus;
  name: string;
  kid: boolean;
  /** Spoiler-free chat about this book. */
  book?: { id: string; title: string } | null;
  conversationId?: string | null;
  onConversation?: (id: string) => void;
  /** Read-only view (parent log). */
  messages?: AiMessage[];
  readOnly?: boolean;
}

export function BarnabyChat({
  status,
  name,
  kid,
  book,
  conversationId,
  onConversation,
  messages: given,
  readOnly,
}: BarnabyChatProps) {
  const [messages, setMessages] = useState<AiMessage[]>(given ?? []);
  const [convId, setConvId] = useState<string | null>(conversationId ?? null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [web, setWeb] = useState(false);
  const [remaining, setRemaining] = useState(status.remainingToday);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (given) return setMessages(given);
    setConvId(conversationId ?? null);
    if (!conversationId) return setMessages([]);
    aiApi.conversation(conversationId).then(
      (c) => setMessages(c.messages),
      () => setMessages([]),
    );
  }, [conversationId, given]);

  useEffect(() => {
    if (readOnly) return;
    end.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [messages, sending, readOnly]);

  async function send(message: string) {
    const trimmed = message.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    const pending: AiMessage = {
      id: "pending",
      role: "user",
      content: trimmed,
      moderation: null,
      createdAt: Date.now(),
      sources: [],
    };
    setMessages((m) => [...m, pending]);
    setText("");
    try {
      const r = await aiApi.chat({
        message: trimmed,
        conversationId: convId ?? undefined,
        bookId: convId ? undefined : book?.id,
        webSearch: web || undefined,
      });
      setMessages((m) => [...m.filter((x) => x !== pending), r.message, r.reply]);
      setRemaining(r.remainingToday);
      if (r.conversationId !== convId) {
        setConvId(r.conversationId);
        onConversation?.(r.conversationId);
      }
      if (r.searchError) setError(kid ? "Barnaby couldn't search the web just now." : `Web search failed: ${r.searchError}`);
    } catch (e) {
      setMessages((m) => m.filter((x) => x !== pending));
      setText(trimmed);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };

  const starters = book ? (kid ? BOOK_STARTERS_KID : BOOK_STARTERS) : kid ? KID_STARTERS : ADULT_STARTERS;
  const greeting = book
    ? kid
      ? `Let's talk about “${book.title}”! I only know the story up to where you are, so no spoilers. 🤫`
      : `Ask me anything about “${book.title}”. I only use the pages you've already read, so no spoilers.`
    : kid
      ? `Hi ${name}! I'm Barnaby. 🦝 Ask me about books, words or fun facts!`
      : `Hi ${name}, I'm Barnaby. I can find books in your library, answer questions${status.webSearch ? " (with the web if you like)" : ""}, and chat about what you're reading.`;

  return (
    <div className={`bb-chat${kid ? " is-kid" : ""}`}>
      <div className="bb-chat-log" role="log" aria-live="polite" aria-label="Chat with Barnaby">
        {!readOnly && (
          <BarnabyRow>
            <p>{greeting}</p>
          </BarnabyRow>
        )}
        {messages.map((m) =>
          m.role === "assistant" ? (
            <BarnabyRow key={m.id} note={readOnly ? m.moderation : null}>
              <MessageText text={m.content} sources={m.sources} />
              <SourceList sources={m.sources} kid={kid} />
            </BarnabyRow>
          ) : (
            <div key={m.id} className="bb-chat-me">
              <div className="bb-chat-me-bubble">
                {m.content}
                {readOnly && m.moderation && <ModerationTag note={m.moderation} />}
              </div>
            </div>
          ),
        )}
        {sending && (
          <div className="bb-chat-row">
            <BarnabyAvatar size={kid ? 52 : 40} thinking />
            <div className="bb-chat-bubble">
              <span className="bb-dots" aria-label="Barnaby is thinking">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
        {!readOnly && messages.length === 0 && !sending && (
          <div className="bb-chat-starters">
            {starters.map((s) => (
              <button key={s} type="button" className="bb-chip" onClick={() => void send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        <div ref={end} />
      </div>
      {error && (
        <p className="bb-chat-error" role="alert">
          {error}
        </p>
      )}
      {!readOnly && (
        <form className="bb-chat-form" onSubmit={onSubmit}>
          {status.webSearch && !book && (
            <label className="bb-chat-web" title="Look things up on the web">
              <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} />
              <span aria-hidden>🌐</span> {kid ? "Look it up" : "Search the web"}
            </label>
          )}
          <div className="bb-chat-input">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(text);
                }
              }}
              rows={1}
              maxLength={kid ? 500 : 4000}
              placeholder={kid ? "Ask Barnaby…" : book ? "Ask about this book…" : "Ask Barnaby anything…"}
              aria-label="Message to Barnaby"
              disabled={sending}
            />
            <button
              className="bb-btn bb-btn-primary bb-chat-send"
              type="submit"
              disabled={sending || !text.trim()}
              aria-label="Send"
            >
              {kid ? "Send 🚀" : "Send"}
            </button>
          </div>
          {kid && remaining != null && (
            <p className="bb-chat-left" aria-live="polite">
              ⭐ {remaining} {remaining === 1 ? "question" : "questions"} left today
            </p>
          )}
        </form>
      )}
    </div>
  );
}

function BarnabyRow({ children, note }: { children: ReactNode; note?: string | null }) {
  return (
    <div className="bb-chat-row">
      <BarnabyAvatar size={40} />
      <div className="bb-chat-bubble">
        {children}
        {note && <ModerationTag note={note} />}
      </div>
    </div>
  );
}

/** Plain text with paragraphs, simple "- " lists and [n] citations linked to their source. */
function MessageText({ text, sources }: { text: string; sources: AiSource[] }) {
  const web = sources.filter((s) => s.kind === "web");
  const blocks = text.split(/\n{2,}/);
  const inline = (line: string) =>
    line.split(/(\[\d+\])/g).map((part, i) => {
      const m = /^\[(\d+)\]$/.exec(part);
      const src = m ? web[Number(m[1]) - 1] : undefined;
      return src?.url ? (
        <sup key={i}>
          <a href={src.url} target="_blank" rel="noreferrer noopener" title={src.title}>
            {m![1]}
          </a>
        </sup>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      );
    });
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l)))
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""))}</li>
              ))}
            </ul>
          );
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

function SourceList({ sources, kid }: { sources: AiSource[]; kid: boolean }) {
  const books = sources.filter((s) => s.kind === "book" && s.bookId);
  const web = sources.filter((s) => s.kind === "web" && s.url);
  if (!books.length && !web.length) return null;
  return (
    <div className="bb-chat-sources">
      {books.map((b) => (
        <Link key={b.bookId} className="bb-chip is-book" to={kid ? `/read/${b.bookId}` : `/book/${b.bookId}`}>
          <span aria-hidden>📖</span> {b.title}
        </Link>
      ))}
      {web.length > 0 && (
        <ol className="bb-chat-web-sources">
          {web.map((w) => (
            <li key={w.url}>
              <a href={w.url!} target="_blank" rel="noreferrer noopener">
                {w.title}
              </a>{" "}
              <span className="bb-muted">{hostOf(w.url!)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const NOTE_LABELS: Record<string, string> = {
  blocked: "Blocked",
  rewritten: "Answer replaced",
  redacted: "Personal details removed",
  canned: "Safety reply",
};

export function ModerationTag({ note }: { note: string }) {
  const [kind, detail] = note.split(":");
  return (
    <span className={`bb-mod-tag is-${kind}`}>
      {NOTE_LABELS[kind ?? ""] ?? kind}
      {detail ? `: ${detail.replace(/_/g, " ").replace(/,/g, ", ")}` : ""}
    </span>
  );
}
