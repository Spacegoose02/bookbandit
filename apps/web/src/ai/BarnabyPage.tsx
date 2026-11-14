import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { isDemo } from "../api/client";
import { useSession } from "../app/session";
import { BarnabyEmpty } from "../brand/Barnaby";
import { aiApi, type AiConversation } from "./api";
import { BarnabyChat } from "./BarnabyChat";
import { useAiStatus } from "./useAiStatus";
import "./ai.css";

/** /barnaby: all of my chats with Barnaby, plus links to the family log and settings for grown-ups. */
export function BarnabyPage() {
  const { me } = useSession();
  const status = useAiStatus();
  const [params, setParams] = useSearchParams();
  const current = params.get("c");
  const [list, setList] = useState<AiConversation[]>([]);

  const reload = () => void aiApi.conversations().then(setList, () => setList([]));
  useEffect(reload, []);

  if (!me) return null;
  if (status && !status.available)
    return (
      <BarnabyEmpty title={me.isKid ? "Barnaby is napping" : "Barnaby isn't ready yet"}>
        <p>{status.message}</p>
        {me.role === "admin" && (
          <Link className="bb-btn bb-btn-primary" to="/barnaby/settings">
            Set up Barnaby
          </Link>
        )}
      </BarnabyEmpty>
    );

  const select = (id: string | null) => setParams(id ? { c: id } : {});
  const grownUp = me.role === "parent" || me.role === "admin";

  return (
    <div className="bb-page bb-barnaby-page">
      <aside className="bb-conv-list" aria-label="Chats">
        <button type="button" className="bb-btn bb-btn-primary" onClick={() => select(null)}>
          + New chat
        </button>
        <ul>
          {list.map((c) => (
            <li key={c.id}>
              <button type="button" className={c.id === current ? "is-active" : ""} onClick={() => select(c.id)}>
                <span>
                  {c.bookId ? "📖 " : ""}
                  {c.title}
                </span>
                <time className="bb-muted">{new Date(c.updatedAt).toLocaleDateString()}</time>
              </button>
            </li>
          ))}
        </ul>
        {!me.isKid && (
          <nav className="bb-conv-links">
            {grownUp && <Link to="/barnaby/family">👨‍👩‍👧 Kids' Barnaby chats</Link>}
            {(me.role === "admin" || isDemo) && <Link to="/barnaby/settings">⚙️ Barnaby settings</Link>}
          </nav>
        )}
      </aside>
      <section className="bb-barnaby-main">
        {status && (
          <BarnabyChat
            key={current ?? "new"}
            status={status}
            name={me.displayName}
            kid={me.isKid}
            conversationId={current}
            onConversation={(id) => {
              select(id);
              reload();
            }}
          />
        )}
        {current && !me.isKid && (
          <button
            type="button"
            className="bb-btn bb-btn-small bb-conv-delete"
            onClick={() => void aiApi.deleteConversation(current).then(() => (select(null), reload()))}
          >
            Delete this chat
          </button>
        )}
      </section>
    </div>
  );
}
