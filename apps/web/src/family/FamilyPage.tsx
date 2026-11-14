import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { RATING_LABELS } from "@bookbandit/shared";
import { BarnabyAvatar, BarnabyEmpty } from "../brand/Barnaby";
import { adminApi, type ChatMessage, type KidChat, type KidRequest } from "../admin/api";
import { ReadingTimeCard, WeekMinutes } from "./ReadingTime";
import { KidRewardsCard } from "../kid/KidRewardsCard";
import { Bar, Card, Cover, ErrorNote, RatingPill, timeAgo, useLoad } from "../admin/ui";

/** Parent dashboard: one card per kid with this week's reading, requests and Barnaby chats. */
export function FamilyPage() {
  const kids = useLoad(() => adminApi.familyKids());
  return (
    <>
      <h1 className="bb-h1">Your kids</h1>
      <ErrorNote error={kids.error} />
      {kids.data && kids.data.length === 0 ? (
        <BarnabyEmpty title="No kids linked to you yet" size={140}>
          <Link className="bb-link" to="/family/people">
            Add a kid
          </Link>
        </BarnabyEmpty>
      ) : (
        <div className="bb-kid-cards">
          {kids.data?.map((k) => (
            <Link key={k.id} to={`/family/kids/${k.id}`} className="bb-kid-card">
              <div className="bb-kid-card-head">
                <span className="bb-person-avatar" aria-hidden>
                  {k.avatar ?? "🙂"}
                </span>
                <div>
                  <strong>{k.displayName}</strong>
                  <div className="bb-muted bb-small">
                    {k.age != null ? `${k.age} · ` : ""}
                    {RATING_LABELS[k.maxRating]}
                  </div>
                </div>
              </div>
              <p className="bb-kid-card-now">
                {k.stats.lastBook ? (
                  <>
                    Reading <strong>{k.stats.lastBook.title}</strong>
                    <span className="bb-muted"> · {timeAgo(k.stats.lastReadAt)}</span>
                  </>
                ) : (
                  <span className="bb-muted">Hasn't opened a book yet</span>
                )}
              </p>
              <dl className="bb-kid-stats">
                <div>
                  <dt>Read this week</dt>
                  <WeekMinutes kidId={k.id} />
                </div>
                <div>
                  <dt>Finished this month</dt>
                  <dd>{k.stats.finishedLast30Days}</dd>
                </div>
                <div className={k.stats.pendingRequests ? "is-warn" : ""}>
                  <dt>Requests waiting</dt>
                  <dd>{k.stats.pendingRequests}</dd>
                </div>
                <div className={k.stats.aiFlaggedLast7Days ? "is-warn" : ""}>
                  <dt>Barnaby questions this week</dt>
                  <dd>
                    {k.stats.aiQuestionsLast7Days}
                    {k.stats.aiFlaggedLast7Days ? <small> ({k.stats.aiFlaggedLast7Days} flagged)</small> : null}
                  </dd>
                </div>
              </dl>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

const STATUS_LABEL: Record<KidRequest["status"], string> = {
  pending: "Waiting for you",
  approved: "Approved",
  declined: "Declined",
  downloading: "Downloading",
  done: "In the library",
  failed: "Couldn't get it",
};

export function KidPage() {
  const { id = "" } = useParams();
  const detail = useLoad(() => adminApi.familyKid(id), [id]);
  const d = detail.data;
  if (detail.error) return <ErrorNote error={detail.error} />;
  if (!d) return <p className="bb-muted">Loading…</p>;
  const reading = d.reading.filter((r) => !r.finished);
  const finished = d.reading.filter((r) => r.finished);

  return (
    <>
      <p className="bb-small">
        <Link className="bb-link" to="/family">
          ← All kids
        </Link>
      </p>
      <header className="bb-kid-header">
        <span className="bb-person-avatar is-big" aria-hidden>
          {d.kid.avatar ?? "🙂"}
        </span>
        <div>
          <h1 className="bb-h1">{d.kid.displayName}</h1>
          <p className="bb-muted">
            {d.kid.age != null ? `${d.kid.age} years old · ` : ""}sees books up to {RATING_LABELS[d.kid.maxRating]}
            {d.stats.lastReadAt ? ` · last read ${timeAgo(d.stats.lastReadAt)}` : ""}
          </p>
        </div>
      </header>

      <div className="bb-family-grid">
        <ReadingTimeCard kidId={d.kid.id} kidName={d.kid.displayName} />
        <KidRewardsCard kidId={d.kid.id} kidName={d.kid.displayName} />
        <Card title={`Reading now (${reading.length})`}>
          {reading.length === 0 ? <p className="bb-muted">Nothing open right now.</p> : null}
          <ul className="bb-reading-list">
            {reading.map((r) => (
              <li key={r.bookId}>
                <Cover src={adminApi.coverUrl({ id: r.bookId, coverPath: r.coverPath })} title={r.title} size={44} />
                <div className="bb-person-main">
                  <strong>{r.title}</strong>
                  <div className="bb-muted bb-small">
                    {r.authors.join(", ")} · {timeAgo(r.updatedAt)}
                    {r.deviceName ? ` on ${r.deviceName}` : ""}
                  </div>
                  <Bar value={r.percent} />
                </div>
                <span className="bb-pct">{Math.round(r.percent * 100)}%</span>
              </li>
            ))}
          </ul>
          {finished.length > 0 && (
            <>
              <h3 className="bb-subhead">Finished ({d.stats.finished})</h3>
              <ul className="bb-finished">
                {finished.map((r) => (
                  <li key={r.bookId}>
                    ✓ {r.title} <span className="bb-muted bb-small">· {timeAgo(r.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card title="Book requests">
          {d.requests.length === 0 ? <p className="bb-muted">No requests yet.</p> : null}
          <ul className="bb-requests">
            {d.requests.map((r) => (
              <li key={r.id}>
                <div className="bb-person-main">
                  <strong>{r.title}</strong>
                  {r.author ? <span className="bb-muted"> · {r.author}</span> : null}
                  <div className="bb-small">
                    <RatingPill rating={r.rating} /> <span className={`bb-req-status is-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                    <span className="bb-muted"> · {timeAgo(r.createdAt)}</span>
                  </div>
                  {r.note ? <div className="bb-muted bb-small">“{r.note}”</div> : null}
                </div>
              </li>
            ))}
          </ul>
          <p className="bb-small">
            <Link to="/requests?tab=approve">Approve or decline requests</Link>
          </p>
        </Card>

        <Card title="Chats with Barnaby" className="bb-chats-card">
          <p className="bb-muted bb-small">Every message {d.kid.displayName} sends Barnaby is kept here for you. Read-only.</p>
          {d.chats.length === 0 ? <p className="bb-muted">No chats yet.</p> : null}
          <ul className="bb-chat-list">
            {d.chats.map((c) => (
              <ChatRow key={c.conversationId} kidId={d.kid.id} chat={c} kidName={d.kid.displayName} kidAvatar={d.kid.avatar} />
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function ChatRow({ kidId, chat, kidName, kidAvatar }: { kidId: string; chat: KidChat; kidName: string; kidAvatar: string | null }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    setOpen((o) => !o);
    if (!messages)
      adminApi
        .familyChat(kidId, chat.conversationId)
        .then(setMessages)
        .catch((e: Error) => setError(e.message));
  };
  return (
    <li className={`bb-chat${chat.flagged ? " is-flagged" : ""}`}>
      <button className="bb-chat-summary" onClick={toggle} aria-expanded={open}>
        <span className="bb-chat-preview">“{chat.preview || "…"}”</span>
        <span className="bb-muted bb-small">
          {chat.messages} messages · {timeAgo(chat.lastAt)}
          {chat.bookTitle ? ` · about ${chat.bookTitle}` : ""}
          {chat.flagged ? ` · ${chat.flagged} flagged` : ""}
        </span>
      </button>
      {open && (
        <div className="bb-chat-log">
          <ErrorNote error={error} />
          {!messages && !error ? <p className="bb-muted">Loading…</p> : null}
          {messages?.map((m) => (
            <div key={m.id} className={`bb-msg is-${m.role}${m.moderation ? " is-moderated" : ""}`}>
              {m.role === "assistant" ? (
                <BarnabyAvatar size={28} />
              ) : (
                <span className="bb-msg-avatar" aria-label={kidName}>
                  {kidAvatar ?? "🙂"}
                </span>
              )}
              <div className="bb-msg-bubble">
                {m.content}
                {m.moderation ? <div className="bb-msg-mod">Safety filter: {m.moderation}</div> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
