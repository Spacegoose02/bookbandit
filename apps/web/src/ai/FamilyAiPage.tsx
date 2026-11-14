import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../app/session";
import { BarnabyEmpty } from "../brand/Barnaby";
import { aiApi, type AiConversation, type AiMessage, type KidAiRow } from "./api";
import { BarnabyChat } from "./BarnabyChat";
import "./ai.css";

const STATUS_LABEL: Record<string, string> = {
  on: "On",
  off: "Off",
  too_young: "Under 5: no chat",
  no_birth_year: "Needs a birth year",
  daily_limit: "Done for today",
};

/** /barnaby/family: a parent turns Barnaby on per kid and reads every chat (read-only). */
export function FamilyAiPage() {
  const { me } = useSession();
  const [kids, setKids] = useState<KidAiRow[] | null>(null);
  const [kidId, setKidId] = useState<string | null>(null);
  const [convs, setConvs] = useState<AiConversation[]>([]);
  const [open, setOpen] = useState<{ conversation: AiConversation; messages: AiMessage[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    aiApi.kids().then(
      (k) => {
        setKids(k);
        if (k[0]) setKidId((id) => id ?? k[0]!.id);
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  useEffect(() => {
    setOpen(null);
    if (!kidId) return setConvs([]);
    aiApi.kidConversations(kidId).then(
      (c) => {
        setConvs(c);
        if (c[0]) void aiApi.kidConversation(kidId, c[0].id).then(setOpen);
      },
      () => setConvs([]),
    );
  }, [kidId]);

  if (!me || me.isKid) return null;
  if (error) return <p className="bb-page bb-error">{error}</p>;
  if (!kids) return <div className="bb-page bb-muted">Loading…</div>;
  if (!kids.length) return <BarnabyEmpty title="No kids linked to you yet">Kids you're a parent of show up here.</BarnabyEmpty>;

  async function save(k: KidAiRow, patch: Partial<KidAiRow["settings"]>) {
    const next = { ...k.settings, ...patch };
    setKids((all) => all!.map((x) => (x.id === k.id ? { ...x, settings: next } : x)));
    try {
      await aiApi.setKidSettings(k.id, { enabled: next.enabled, webSearch: next.webSearch, dailyLimit: next.dailyLimit });
      const fresh = await aiApi.kids();
      setKids(fresh);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const kid = kids.find((k) => k.id === kidId);

  return (
    <div className="bb-page bb-family-ai">
      <p className="bb-crumbs">
        <Link to="/barnaby">← Barnaby</Link>
      </p>
      <h1>Kids' Barnaby chats</h1>
      <p className="bb-muted">
        Barnaby only talks about books each kid is allowed to see, never asks for personal details, and every message is kept here
        for you. Kids can't delete chats or change these settings.
      </p>
      <div className="bb-kid-ai-cards">
        {kids.map((k) => (
          <article key={k.id} className={`bb-kid-ai-card${k.id === kidId ? " is-active" : ""}`}>
            <header>
              <span className="bb-kid-ai-avatar" aria-hidden>
                {k.avatar ?? "🙂"}
              </span>
              <div>
                <h2>{k.displayName}</h2>
                <span className="bb-muted">
                  {k.age != null ? `Age ${k.age}` : "No birth year"} · {k.sentToday}/{k.settings.dailyLimit} today
                </span>
              </div>
              <span className={`bb-pill is-${k.status}`}>{STATUS_LABEL[k.status ?? "off"]}</span>
            </header>
            <label className="bb-switch">
              <input
                type="checkbox"
                checked={k.settings.enabled}
                disabled={k.status === "too_young"}
                onChange={(e) => void save(k, { enabled: e.target.checked })}
              />
              Barnaby chat
            </label>
            <label className="bb-switch">
              <input
                type="checkbox"
                checked={k.settings.webSearch}
                disabled={!k.settings.enabled}
                onChange={(e) => void save(k, { webSearch: e.target.checked })}
              />
              Web search (strict, kid sites only)
            </label>
            <label className="bb-field-inline">
              Questions per day
              <input
                type="number"
                min={1}
                max={500}
                value={k.settings.dailyLimit}
                onChange={(e) => void save(k, { dailyLimit: Math.max(1, Number(e.target.value) || 1) })}
              />
            </label>
            <button type="button" className="bb-btn bb-btn-small" onClick={() => setKidId(k.id)}>
              View chats{k.flaggedConversations ? ` · ⚠️ ${k.flaggedConversations} flagged` : ""}
            </button>
          </article>
        ))}
      </div>

      {kid && (
        <section className="bb-family-log">
          <h2>{kid.displayName}'s chats</h2>
          {convs.length === 0 ? (
            <p className="bb-muted">No chats yet.</p>
          ) : (
            <div className="bb-family-log-grid">
              <ul className="bb-conv-list-plain">
                {convs.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={open?.conversation.id === c.id ? "is-active" : ""}
                      onClick={() => void aiApi.kidConversation(kid.id, c.id).then(setOpen)}
                    >
                      <span>
                        {c.flagged ? "⚠️ " : ""}
                        {c.title}
                      </span>
                      <time className="bb-muted">{new Date(c.updatedAt).toLocaleString()}</time>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="bb-family-transcript">
                {open && (
                  <BarnabyChat
                    status={{
                      available: true,
                      reason: null,
                      message: null,
                      kid: true,
                      webSearch: false,
                      bookChat: false,
                      remainingToday: null,
                    }}
                    name={kid.displayName}
                    kid
                    messages={open.messages}
                    readOnly
                  />
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
