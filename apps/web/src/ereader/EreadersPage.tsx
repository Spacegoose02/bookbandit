/**
 * E-readers: sign-ins for OPDS apps, KOReader progress sync and Kobo sync, with setup steps.
 * Grown-ups manage their own; parents also manage their kids'. The server enforces who may.
 * Self-contained (its own fetch calls and demo data) so it doesn't touch the shared API client.
 */
import { useCallback, useEffect, useState } from "react";
import { isDemo } from "../api/client";
import { useSession } from "../app/session";

type Kind = "login" | "kobo";

interface Credential {
  id: string;
  userId: string;
  kind: Kind;
  name: string;
  username: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

interface Person {
  id: string;
  displayName: string;
  role: string;
}

interface Created {
  credential: Credential;
  username?: string;
  password?: string;
  koboApiEndpoint?: string;
}

interface Setup {
  opdsUrl: string;
  kosyncUrl: string;
}

const demoOrigin = typeof window !== "undefined" ? window.location.origin : "https://books.example.com";
const DEMO = {
  setup: { opdsUrl: `${demoOrigin}/opds`, kosyncUrl: `${demoOrigin}/kosync` },
  people: [
    { id: "u-adult", displayName: "Sam", role: "parent" },
    { id: "u-kid", displayName: "Mia", role: "kid" },
  ] as Person[],
  credentials: [
    { id: "c1", userId: "u-adult", kind: "login", name: "KOReader on the Kindle", username: "sam-7kq2", createdAt: Date.parse("2026-11-10T19:00:00Z"), lastUsedAt: Date.parse("2026-11-13T21:14:00Z") },
    { id: "c2", userId: "u-kid", kind: "kobo", name: "Mia's Kobo Nia", username: null, createdAt: Date.parse("2026-11-12T08:00:00Z"), lastUsedAt: Date.parse("2026-11-13T19:40:00Z") },
  ] as Credential[],
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function when(ms: number | null): string {
  if (!ms) return "never";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="bb-ereader-copy">
      <code>{value}</code>
      <button
        type="button"
        className="bb-btn bb-btn-ghost"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setDone(true));
        }}
      >
        {done ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

export function EreadersPage() {
  const { me } = useSession();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [kind, setKind] = useState<Kind>("login");
  const [name, setName] = useState("");
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (isDemo) {
      setSetup(DEMO.setup);
      setCredentials((c) => (c.length ? c : DEMO.credentials));
      setPeople(DEMO.people);
      return;
    }
    try {
      const [list, users] = await Promise.all([
        call<{ credentials: Credential[]; setup: Setup }>("/api/ereader/credentials"),
        call<{ users: Person[] }>("/api/users"),
      ]);
      setSetup(list.setup);
      setCredentials(list.credentials);
      setPeople(users.users);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!me) return null;
  if (me.isKid)
    return (
      <div className="bb-page">
        <h1 className="bb-h1">E-readers</h1>
        <p>Ask a grown-up to set up your e-reader.</p>
      </div>
    );

  const nameOf = (id: string) => (id === me.id ? "You" : (people.find((p) => p.id === id)?.displayName ?? "Someone"));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isDemo) {
        const credential: Credential = {
          id: `c${Date.now()}`,
          userId: userId || me!.id,
          kind,
          name,
          username: kind === "login" ? "sam-m4tz" : null,
          createdAt: Date.now(),
          lastUsedAt: null,
        };
        setCreated(
          kind === "login"
            ? { credential, username: "sam-m4tz", password: "k7qm-4xpa-9hzt-wr3d" }
            : { credential, koboApiEndpoint: `${demoOrigin}/kobo/bbk_3f9c1d0a7e5b42c88d1e6f0a9b2c4d7e8f10a2b3c4d5e6f7` },
        );
        setCredentials((c) => [credential, ...c]);
      } else {
        const res = await call<Created>("/api/ereader/credentials", {
          method: "POST",
          body: JSON.stringify({ kind, name, ...(userId && userId !== me!.id ? { userId } : {}) }),
        });
        setCreated(res);
        await load();
      }
      setName("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(c: Credential) {
    if (!window.confirm(`Sign out "${c.name}"? It stops syncing until you set it up again.`)) return;
    try {
      if (!isDemo) await call(`/api/ereader/credentials/${c.id}`, { method: "DELETE" });
      setCredentials((list) => list.filter((x) => x.id !== c.id));
      if (created?.credential.id === c.id) setCreated(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="bb-page bb-ereaders">
      <h1 className="bb-h1">E-readers</h1>
      <p className="bb-muted">
        Read on a Kobo, a Kindle or Kobo running KOReader, or any OPDS app. Each sign-in only sees the books its person is
        allowed to see, and reading positions sync with this app.
      </p>
      {error && (
        <p role="alert" className="bb-ereader-error">
          {error}
        </p>
      )}

      {created && (
        <section className="bb-ereader-created" aria-live="polite">
          <h2>“{created.credential.name}” is ready</h2>
          <p className="bb-muted">Copy these now. The password and Kobo address aren't shown again.</p>
          {created.password ? (
            <>
              <dl>
                <dt>Username</dt>
                <dd>
                  <Copy value={created.username!} />
                </dd>
                <dt>Password</dt>
                <dd>
                  <Copy value={created.password} />
                </dd>
              </dl>
              <ol>
                <li>
                  <strong>KOReader progress sync:</strong> Tools → Progress sync → Custom sync server →{" "}
                  <code>{setup?.kosyncUrl}</code>, then Login with the username and password above.
                </li>
                <li>
                  <strong>OPDS catalog</strong> (KOReader, Moon+ Reader, Thorium, Librera, Panels): add{" "}
                  <code>{setup?.opdsUrl}</code> with the same username and password.
                </li>
              </ol>
            </>
          ) : (
            <>
              <dl>
                <dt>Kobo address</dt>
                <dd>
                  <Copy value={created.koboApiEndpoint!} />
                </dd>
              </dl>
              <ol>
                <li>Plug the Kobo into a computer and open the <code>.kobo/Kobo/Kobo eReader.conf</code> file.</li>
                <li>
                  In the <code>[OneStoreServices]</code> section, set <code>api_endpoint=</code> to the address above.
                </li>
                <li>Eject the Kobo and tap Sync. Books arrive as KEPUBs, and positions sync both ways.</li>
              </ol>
            </>
          )}
          <button type="button" className="bb-btn" onClick={() => setCreated(null)}>
            Done
          </button>
        </section>
      )}

      <section>
        <h2>Add an e-reader</h2>
        <form className="bb-ereader-form" onSubmit={create}>
          <fieldset className="bb-field">
            <legend>What is it?</legend>
            <label className="bb-field bb-field-inline">
              <input type="radio" name="kind" checked={kind === "login"} onChange={() => setKind("login")} /> KOReader or an
              OPDS app (username and password)
            </label>
            <label className="bb-field bb-field-inline">
              <input type="radio" name="kind" checked={kind === "kobo"} onChange={() => setKind("kobo")} /> A Kobo with its own
              store sync
            </label>
          </fieldset>
          <label className="bb-field">
            Name
            <input
              className="bb-input"
              required
              maxLength={60}
              placeholder={kind === "kobo" ? "Mia's Kobo Clara" : "KOReader on the Kindle"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {people.length > 1 && (
            <label className="bb-field">
              Whose is it?
              <select className="bb-input" value={userId || me.id} onChange={(e) => setUserId(e.target.value)}>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === me.id ? `Mine (${p.displayName})` : p.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="submit" className="bb-btn bb-btn-primary" disabled={busy || !name.trim()}>
            Create sign-in
          </button>
        </form>
      </section>

      <section>
        <h2>Signed-in e-readers</h2>
        {credentials.length === 0 ? (
          <p className="bb-muted">None yet.</p>
        ) : (
          <ul className="bb-ereader-list">
            {credentials.map((c) => (
              <li key={c.id}>
                <div>
                  <strong>{c.name}</strong>
                  <div className="bb-muted">
                    {c.kind === "kobo" ? "Kobo sync" : `KOReader / OPDS · ${c.username}`} · {nameOf(c.userId)} · last used{" "}
                    {when(c.lastUsedAt)}
                  </div>
                </div>
                <button type="button" className="bb-btn" onClick={() => void revoke(c)}>
                  Sign out
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {setup && (
        <section className="bb-muted">
          <h2>Addresses</h2>
          <p>
            OPDS catalog: <code>{setup.opdsUrl}</code>
            <br />
            KOReader sync server: <code>{setup.kosyncUrl}</code>
          </p>
        </section>
      )}
    </div>
  );
}
