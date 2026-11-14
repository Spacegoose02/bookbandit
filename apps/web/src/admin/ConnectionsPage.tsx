import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { adminApi, type MetadataSettings, type SmtpSettings } from "./api";
import { Card, ErrorNote, useAction, useLoad } from "./ui";
import { FamilyAppsCards } from "../family-apps/FamilyAppsCards";

/** Audiobookshelf, Send to Kindle email, online metadata lookup, and the family apps. Secrets are write-only. */
export function ConnectionsPage() {
  return (
    <>
      <h1 className="bb-h1">Connections</h1>
      <p className="bb-muted bb-admin-lede">
        Passwords and API keys are stored encrypted on your server and never shown again. Leave a secret field empty to keep
        the saved one.
      </p>
      <div className="bb-settings-grid">
        <AbsCard />
        <SmtpCard />
        <MetadataCard />
        <FamilyAppsCards />
      </div>
    </>
  );
}

function Status({ on, label }: { on: boolean; label: string }) {
  return <span className={`bb-status${on ? " is-on" : ""}`}>{label}</span>;
}

function AbsCard() {
  const loaded = useLoad(() => adminApi.absSettings());
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [libraryIds, setLibraryIds] = useState<string[]>([]);
  const [libraries, setLibraries] = useState<{ id: string; name: string }[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const action = useAction();
  const s = loaded.data;

  useEffect(() => {
    if (s?.configured) {
      setUrl(s.url);
      setEnabled(s.enabled);
      setLibraryIds(s.libraryIds);
    }
  }, [s]);

  const save = (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    void action.run(async () => {
      const saved = await adminApi.saveAbs({ enabled, url: url.trim(), libraryIds, ...(token ? { token } : {}) });
      loaded.setData(saved);
      setToken("");
      const t = await adminApi.testAbs();
      setLibraries(t.libraries);
      setMsg(`Connected as ${t.username}. Found ${t.libraries.length} ${t.libraries.length === 1 ? "library" : "libraries"}.`);
    });
  };

  return (
    <Card
      title="Audiobookshelf"
      actions={s ? <Status on={s.configured && s.enabled} label={s.configured ? (s.enabled ? "Connected" : "Off") : "Not set up"} /> : null}
    >
      <p className="bb-muted bb-small">
        Plays audiobooks from your Audiobookshelf server and keeps listening progress in sync. Per-person accounts, import and
        your own audiobook folder: <Link to="/admin/audio">Audiobooks</Link>.
      </p>
      <form onSubmit={save}>
        <label className="bb-field">
          Server address
          <input className="bb-input" type="url" placeholder="http://192.168.1.20:13378" value={url} onChange={(e) => setUrl(e.target.value)} required />
        </label>
        <label className="bb-field">
          API token
          <input
            className="bb-input"
            type="password"
            autoComplete="off"
            placeholder={s?.configured && s.hasToken ? "Saved. Paste a new one to replace it" : "Settings → Users → your user → API token"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required={!(s?.configured && s.hasToken)}
          />
        </label>
        {libraries && libraries.length > 0 && (
          <fieldset className="bb-field">
            <legend>Libraries to use</legend>
            <div className="bb-chips">
              {libraries.map((l) => {
                const on = libraryIds.includes(l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    className="bb-chip"
                    aria-pressed={on}
                    onClick={() => setLibraryIds(on ? libraryIds.filter((x) => x !== l.id) : [...libraryIds, l.id])}
                  >
                    {l.name}
                  </button>
                );
              })}
            </div>
            <p className="bb-muted bb-small">None picked means every book library. Save again after changing.</p>
          </fieldset>
        )}
        <label className="bb-field bb-field-inline">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Turned on
        </label>
        <ErrorNote error={loaded.error ?? action.error} />
        {msg && <p className="bb-ok">{msg}</p>}
        <div className="bb-form-actions">
          <button className="bb-btn bb-btn-primary" disabled={action.busy}>
            Save and test
          </button>
        </div>
      </form>
    </Card>
  );
}

function SmtpCard() {
  const loaded = useLoad(() => adminApi.smtpSettings());
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [testTo, setTestTo] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const action = useAction();
  const s: SmtpSettings | null = loaded.data;

  useEffect(() => {
    if (s?.configured) {
      setHost(s.host);
      setPort(String(s.port));
      setSecure(s.secure);
      setUser(s.user ?? "");
      setFrom(s.from);
      setEnabled(s.enabled);
    }
  }, [s]);

  const save = (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    void action.run(async () => {
      loaded.setData(
        await adminApi.saveSmtp({ enabled, host: host.trim(), port: Number(port), secure, user: user.trim() || undefined, from: from.trim(), ...(password ? { password } : {}) }),
      );
      setPassword("");
      setMsg("Saved.");
    });
  };

  return (
    <Card title="Send to Kindle email" actions={s ? <Status on={s.configured && s.enabled} label={s.configured ? (s.enabled ? "Ready" : "Off") : "Not set up"} /> : null}>
      <p className="bb-muted bb-small">
        The mail server used to email books to Kindles. Add the From address to each Kindle's approved senders list on Amazon.
      </p>
      <form onSubmit={save}>
        <div className="bb-form-row">
          <label className="bb-field">
            SMTP server
            <input className="bb-input" placeholder="smtp.gmail.com" value={host} onChange={(e) => setHost(e.target.value)} required />
          </label>
          <label className="bb-field bb-field-narrow">
            Port
            <input className="bb-input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} required />
          </label>
        </div>
        <label className="bb-field bb-field-inline">
          <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} /> TLS from the start (port 465)
        </label>
        <div className="bb-form-row">
          <label className="bb-field">
            Username
            <input className="bb-input" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />
          </label>
          <label className="bb-field">
            Password
            <input
              className="bb-input"
              type="password"
              autoComplete="new-password"
              placeholder={s?.configured && s.hasPassword ? "Saved" : "App password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </div>
        <label className="bb-field">
          From address
          <input className="bb-input" type="email" placeholder="books@example.com" value={from} onChange={(e) => setFrom(e.target.value)} required />
        </label>
        <label className="bb-field bb-field-inline">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Turned on
        </label>
        <div className="bb-form-actions">
          <button className="bb-btn bb-btn-primary" disabled={action.busy}>
            Save
          </button>
        </div>
      </form>
      {s?.configured && (
        <form
          className="bb-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            setMsg(null);
            void action.run(async () => {
              await adminApi.testSmtp(testTo.trim());
              setMsg(`Test email sent to ${testTo.trim()}.`);
            });
          }}
        >
          <input className="bb-input" type="email" placeholder="Send a test email to…" value={testTo} onChange={(e) => setTestTo(e.target.value)} required />
          <button className="bb-btn" disabled={action.busy}>
            Send test
          </button>
        </form>
      )}
      <ErrorNote error={loaded.error ?? action.error} />
      {msg && <p className="bb-ok">{msg}</p>}
    </Card>
  );
}

function MetadataCard() {
  const loaded = useLoad(() => adminApi.metadataSettings());
  const [online, setOnline] = useState(true);
  const [hardcover, setHardcover] = useState("");
  const [google, setGoogle] = useState("");
  const [isbndb, setIsbndb] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const action = useAction();
  const s: MetadataSettings | null = loaded.data;

  useEffect(() => {
    if (s) setOnline(s.online);
  }, [s]);

  const save = (extra: { hardcoverToken?: string | null; googleApiKey?: string | null; isbndbKey?: string | null } = {}) =>
    action.run(async () => {
      setMsg(null);
      loaded.setData(
        await adminApi.saveMetadata({
          online,
          ...(hardcover ? { hardcoverToken: hardcover } : {}),
          ...(google ? { googleApiKey: google } : {}),
          ...(isbndb ? { isbndbKey: isbndb } : {}),
          ...extra,
        }),
      );
      setHardcover("");
      setGoogle("");
      setIsbndb("");
      setMsg("Saved. New scans and “Look up online” use these now.");
    });

  const keyHint = (has: boolean, env: boolean) => (has ? (env ? "Set in the server's environment" : "Saved") : "Optional");

  return (
    <Card title="Book details lookup" actions={s ? <Status on={s.online} label={s.online ? "On" : "Off"} /> : null}>
      <p className="bb-muted bb-small">
        When a new book arrives, BookBandit looks up its cover, description, series and age rating on Open Library, Google Books and
        Hardcover. Open Library needs no key.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="bb-field bb-field-inline">
          <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} /> Look up new books online
        </label>
        <label className="bb-field">
          Hardcover API token <span className="bb-muted bb-small">({s ? keyHint(s.hasHardcoverToken, s.fromEnv.hardcoverToken) : "…"})</span>
          <input
            className="bb-input"
            type="password"
            autoComplete="off"
            placeholder="hardcover.app → Settings → API"
            value={hardcover}
            onChange={(e) => setHardcover(e.target.value)}
          />
        </label>
        <label className="bb-field">
          Google Books API key <span className="bb-muted bb-small">({s ? keyHint(s.hasGoogleApiKey, s.fromEnv.googleApiKey) : "…"})</span>
          <input className="bb-input" type="password" autoComplete="off" placeholder="Raises Google's daily limit" value={google} onChange={(e) => setGoogle(e.target.value)} />
        </label>
        <label className="bb-field">
          ISBNdb API key <span className="bb-muted bb-small">({s ? keyHint(!!s.hasIsbndbKey, !!s.fromEnv.isbndbKey) : "…"})</span>
          <input className="bb-input" type="password" autoComplete="off" placeholder="Paid, optional: isbndb.com" value={isbndb} onChange={(e) => setIsbndb(e.target.value)} />
        </label>
        <ErrorNote error={loaded.error ?? action.error} />
        {msg && <p className="bb-ok">{msg}</p>}
        <div className="bb-form-actions">
          <button className="bb-btn bb-btn-primary" disabled={action.busy}>
            Save
          </button>
          {s?.saved && (s.hasHardcoverToken || s.hasGoogleApiKey || s.hasIsbndbKey) && (
            <button type="button" className="bb-btn bb-btn-ghost" disabled={action.busy} onClick={() => save({ hardcoverToken: null, googleApiKey: null, isbndbKey: null })}>
              Forget saved keys
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

