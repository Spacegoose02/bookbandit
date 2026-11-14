import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSession } from "../app/session";
import { requestsApi } from "./api";
import { AskPanel } from "./AskPanel";
import { DownloadsPanel } from "./DownloadsPanel";
import { KidRequests } from "./KidRequests";
import { RequestList } from "./RequestList";
import { SettingsPanel } from "./SettingsPanel";
import { UploadPanel } from "./UploadPanel";
import type { RequestSummary } from "./types";
import "./requests.css";

type Tab = "ask" | "mine" | "approve" | "downloads" | "upload" | "settings";

/**
 * /requests: ask for a book, follow your requests, approve the family's, and (admins) run
 * downloads, uploads and downloader settings. Kids get their own simpler page.
 */
export function RequestsPage() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const [summary, setSummary] = useState<RequestSummary | null>(null);
  const [uploadsAllowed, setUploadsAllowed] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!me || me.isKid) return;
    requestsApi.summary().then(setSummary, () => setSummary(null));
    requestsApi.uploadAllowed().then((u) => setUploadsAllowed(u.allowed), () => setUploadsAllowed(false));
  }, [me, refresh]);

  if (!me) return null;
  if (me.isKid) return <KidRequests />;

  const admin = me.role === "admin";
  const approver = admin || me.role === "parent";
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "ask", label: "Ask for a book" },
    { id: "mine", label: "My requests", count: summary?.open },
    ...(approver ? [{ id: "approve" as const, label: "To approve", count: summary?.toApprove }] : []),
    ...(admin ? [{ id: "downloads" as const, label: "Downloads" }] : []),
    ...(admin || uploadsAllowed ? [{ id: "upload" as const, label: "Upload" }] : []),
    ...(admin ? [{ id: "settings" as const, label: "Downloaders" }] : []),
  ];
  const wanted = params.get("tab") as Tab | null;
  const tab: Tab = tabs.some((t) => t.id === wanted) ? wanted! : approver && summary?.toApprove && !params.get("q") ? "approve" : "ask";
  const go = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set("tab", t);
    if (t !== "ask") next.delete("q");
    setParams(next, { replace: true });
  };
  const changed = () => setRefresh((n) => n + 1);

  return (
    <div className="bb-page bb-requests">
      <h1 className="bb-h1">Requests</h1>
      <div className="bb-tabs" role="tablist" aria-label="Requests">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className="bb-tab" onClick={() => go(t.id)}>
            {t.label}
            {!!t.count && <span className="bb-count">{t.count}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "ask" && <AskPanel onCreated={changed} />}
        {tab === "mine" && <RequestList scope="mine" onChange={changed} key={`mine-${refresh}`} />}
        {tab === "approve" && <RequestList scope="approvals" onChange={changed} approvals />}
        {tab === "downloads" && <DownloadsPanel />}
        {tab === "upload" && <UploadPanel />}
        {tab === "settings" && <SettingsPanel />}
      </div>
    </div>
  );
}
