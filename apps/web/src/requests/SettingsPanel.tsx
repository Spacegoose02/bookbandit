import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { requestsApi } from "./api";
import type { DownloadSettings, DownloadSettingsInput } from "./types";

type Client = "shelfmark" | "sabnzbd" | "newznab";

/** Admin: Shelfmark, sabnzbd + Newznab indexer, direct downloads and upload rules. */
export function SettingsPanel() {
  const [s, setS] = useState<DownloadSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    requestsApi.settings().then(setS, (e: Error) => setError(e.message));
  }, []);

  const save = async (input: DownloadSettingsInput, what: string) => {
    setError(null);
    try {
      setS(await requestsApi.saveSettings(input));
      setSaved(what);
      setTimeout(() => setSaved(null), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!s) return error ? <p className="bb-error">{error}</p> : <p className="bb-muted">Loading…</p>;

  return (
    <div className="bb-dl-settings">
      {error && <p className="bb-error">{error}</p>}
      <section className="bb-rq-panel">
        <h2 className="bb-h2">When a request is approved</h2>
        <label className="bb-field-inline">
          <input type="checkbox" checked={s.autoDownload} onChange={(e) => save({ autoDownload: e.target.checked }, "general")} />
          Start the download right away
        </label>
        <p className="bb-muted bb-small">
          Tries {s.order.join(", then ")}.{" "}
          {s.available.length ? `Ready now: ${s.available.join(", ")}.` : "No downloader is ready yet: set one up below."}
        </p>
        <label className="bb-field-inline">
          <input
            type="checkbox"
            checked={s.order[0] === "sabnzbd"}
            onChange={(e) => save({ order: e.target.checked ? ["sabnzbd", "shelfmark"] : ["shelfmark", "sabnzbd"] }, "general")}
          />
          Try sabnzbd before Shelfmark
        </label>
        {saved === "general" && <Saved />}
      </section>

      <ClientForm
        client="shelfmark"
        title="Shelfmark"
        help="Shelfmark's address and its SHELFMARK_API_KEY. Point Shelfmark's own download folder somewhere other than your /books."
        current={s.shelfmark}
        saved={saved === "shelfmark"}
        onSave={(v) => save({ shelfmark: v ? { url: v.url, enabled: v.enabled, ...(v.apiKey ? { apiKey: v.apiKey } : {}) } : null }, "shelfmark")}
      />
      <ClientForm
        client="sabnzbd"
        title="sabnzbd"
        help="Needs a Newznab indexer (below) to find books for requests. Mount sabnzbd's completed folder into Bookbandit and map the path if it differs."
        current={s.sabnzbd}
        saved={saved === "sabnzbd"}
        extra={(v, set) => (
          <>
            <label className="bb-field">
              <span>Category</span>
              <input className="bb-input" value={v.category ?? "books"} onChange={(e) => set({ ...v, category: e.target.value })} />
            </label>
            <label className="bb-field">
              <span>sabnzbd's completed folder</span>
              <input className="bb-input" placeholder="/downloads/complete" value={v.from ?? ""} onChange={(e) => set({ ...v, from: e.target.value })} />
            </label>
            <label className="bb-field">
              <span>The same folder inside Bookbandit</span>
              <input className="bb-input" placeholder="/sab-complete" value={v.to ?? ""} onChange={(e) => set({ ...v, to: e.target.value })} />
            </label>
          </>
        )}
        initialExtra={{ category: s.sabnzbd?.category ?? "books", from: s.sabnzbd?.pathMap?.from ?? "", to: s.sabnzbd?.pathMap?.to ?? "" }}
        onSave={(v) =>
          save(
            {
              sabnzbd: v
                ? {
                    url: v.url,
                    enabled: v.enabled,
                    category: v.category || "books",
                    pathMap: v.from && v.to ? { from: v.from, to: v.to } : null,
                    ...(v.apiKey ? { apiKey: v.apiKey } : {}),
                  }
                : null,
            },
            "sabnzbd",
          )
        }
      />
      <ClientForm
        client="newznab"
        title="Newznab indexer"
        help="An indexer's API address and key (or a Prowlarr indexer feed). Searches the Books > Ebook category."
        current={s.newznab}
        saved={saved === "newznab"}
        onSave={(v) => save({ newznab: v ? { url: v.url, enabled: v.enabled, ...(v.apiKey ? { apiKey: v.apiKey } : {}) } : null }, "newznab")}
      />

      <section className="bb-rq-panel">
        <h2 className="bb-h2">Direct downloads and uploads</h2>
        <label className="bb-field-inline">
          <input type="checkbox" checked={s.direct.enabled} onChange={(e) => save({ direct: { enabled: e.target.checked } }, "files")} />
          Allow downloading a book file from a link (admins only)
        </label>
        <label className="bb-field-inline">
          <input type="checkbox" checked={s.uploads.allowAdults} onChange={(e) => save({ uploads: { allowAdults: e.target.checked } }, "files")} />
          Let grown-ups (not just admins) upload books into the inbox
        </label>
        <label className="bb-field-inline">
          Largest file
          <input
            className="bb-input bb-num"
            type="number"
            min={1}
            max={10000}
            defaultValue={s.uploads.maxMb}
            onBlur={(e) => {
              const mb = Number(e.target.value);
              if (mb >= 1) void save({ uploads: { maxMb: mb }, direct: { maxMb: mb } }, "files");
            }}
          />
          MB
        </label>
        {saved === "files" && <Saved />}
      </section>
    </div>
  );
}

function Saved() {
  return <p className="bb-outcome is-good">Saved</p>;
}

interface FormValue {
  enabled: boolean;
  url: string;
  apiKey: string;
  category?: string;
  from?: string;
  to?: string;
}

function ClientForm({
  client,
  title,
  help,
  current,
  saved,
  onSave,
  extra,
  initialExtra = {},
}: {
  client: Client;
  title: string;
  help: string;
  current: { enabled: boolean; url: string; hasApiKey: boolean } | null;
  saved: boolean;
  onSave: (v: FormValue | null) => Promise<void>;
  extra?: (v: FormValue, set: (v: FormValue) => void) => ReactNode;
  initialExtra?: Partial<FormValue>;
}) {
  const [v, setV] = useState<FormValue>({ enabled: current?.enabled ?? true, url: current?.url ?? "", apiKey: "", ...initialExtra });
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await onSave(v);
    setV((x) => ({ ...x, apiKey: "" }));
  };

  return (
    <form className="bb-rq-panel" onSubmit={submit}>
      <h2 className="bb-h2">
        {title}{" "}
        <span className={`bb-pill is-${current?.enabled ? "done" : "wait"}`}>{current ? (current.enabled ? "On" : "Off") : "Not set up"}</span>
      </h2>
      <p className="bb-muted bb-small">{help}</p>
      <div className="bb-form-grid">
        <label className="bb-field">
          <span>Address</span>
          <input className="bb-input" type="url" required placeholder="http://host:port" value={v.url} onChange={(e) => setV({ ...v, url: e.target.value })} />
        </label>
        <label className="bb-field">
          <span>API key</span>
          <input
            className="bb-input"
            type="password"
            autoComplete="off"
            required={!current?.hasApiKey}
            placeholder={current?.hasApiKey ? "Saved (leave blank to keep)" : ""}
            value={v.apiKey}
            onChange={(e) => setV({ ...v, apiKey: e.target.value })}
          />
        </label>
        {extra?.(v, setV)}
      </div>
      <label className="bb-field-inline">
        <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} />
        Use {title}
      </label>
      <div className="bb-req-actions">
        <button className="bb-btn bb-btn-primary" type="submit">
          Save
        </button>
        {current && (
          <button
            type="button"
            className="bb-btn"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              setTest(await requestsApi.testClient(client).catch((e: Error) => ({ ok: false, message: e.message })));
              setTesting(false);
            }}
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
        )}
        {current && (
          <button type="button" className="bb-btn bb-btn-ghost" onClick={() => onSave(null)}>
            Remove
          </button>
        )}
      </div>
      {saved && <Saved />}
      {test && <p className={`bb-outcome is-${test.ok ? "good" : "bad"}`}>{test.message}</p>}
    </form>
  );
}
