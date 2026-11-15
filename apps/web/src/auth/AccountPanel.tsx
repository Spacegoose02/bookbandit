/**
 * Settings → Your account: change your own display name, and (parents/admins) rename the kids
 * you look after. Sign out and Switch reader live here too.
 */
import { useEffect, useState, type FormEvent } from "react";
import type { Role } from "@bookbandit/shared";
import { ApiError, isDemo, request } from "../api/client";
import { useSession } from "../app/session";
import { authApi, enterApp, type AuthStatus } from "./api";
import { SSO_ERRORS } from "./SignIn";

interface FamilyMember {
  id: string;
  displayName: string;
  role: Role;
  avatar: string | null;
}

const rename = (path: string, displayName: string) =>
  request<FamilyMember>(path, { method: "PATCH", body: JSON.stringify({ displayName }) });

function NameForm({
  label,
  initial,
  onSave,
}: {
  label: string;
  initial: string;
  onSave(name: string): Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== initial && name.trim().length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    setState("saving");
    setError(null);
    try {
      await onSave(name.trim());
      setState("saved");
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
      setState("idle");
    }
  }

  return (
    <form className="bb-name-form" onSubmit={submit}>
      <label className="bb-field">
        <span>{label}</span>
        <span className="bb-name-row">
          <input
            className="bb-input"
            value={name}
            maxLength={60}
            onChange={(e) => {
              setName(e.target.value);
              setState("idle");
            }}
          />
          <button className="bb-btn bb-btn-primary" disabled={!dirty || state === "saving"}>
            {state === "saving" ? "Saving…" : "Save"}
          </button>
        </span>
      </label>
      {state === "saved" && (
        <p className="bb-muted" role="status">
          Saved.
        </p>
      )}
      {error && (
        <p className="bb-auth-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

type Identity = NonNullable<AuthStatus["user"]>["identities"][number];

/** Read once: what came back from a "Link Tinyauth" round trip (`?sso_linked=1` or `?sso_error=…`). */
function linkResultFromUrl(): { ok: boolean; text: string } | null {
  const q = new URLSearchParams(window.location.search);
  if (q.get("sso_linked")) return { ok: true, text: "Linked. You can sign in with Tinyauth now." };
  const code = q.get("sso_error");
  return code ? { ok: false, text: SSO_ERRORS[code] ?? SSO_ERRORS.token! } : null;
}

/** Your own Tinyauth sign-ins: link one through the provider, or unlink one. */
function SingleSignOn() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [ids, setIds] = useState<Identity[]>([]);
  const [result, setResult] = useState(linkResultFromUrl);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isDemo) return;
    authApi
      .status()
      .then((s) => {
        setStatus(s);
        setIds(s.user?.identities ?? []);
      })
      .catch(() => setStatus(null));
    if (new URLSearchParams(window.location.search).has("sso_linked") || new URLSearchParams(window.location.search).has("sso_error")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const sso = status?.sso;
  if (!sso?.linkUrl) return null;
  const emails = ids.filter((i) => i.provider === "tinyauth");

  async function unlink(i: Identity) {
    setBusy(true);
    try {
      const u = await authApi.unlinkSso(i.id);
      setIds(u.identities);
      setResult({ ok: true, text: `Unlinked ${i.subject}.` });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bb-account-sso">
      <h2 className="bb-account-sub">Sign in with {sso.label}</h2>
      {result && (
        <p className={result.ok ? "bb-muted" : "bb-auth-error"} role={result.ok ? "status" : "alert"}>
          {result.text}
        </p>
      )}
      {emails.length > 0 ? (
        <ul className="bb-account-sso-list">
          {emails.map((i) => (
            <li key={i.id}>
              <span>{i.subject}</span>
              <button type="button" className="bb-btn" disabled={busy} onClick={() => void unlink(i)}>
                Unlink
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="bb-muted">Link your {sso.label} account to sign in to this profile with it.</p>
      )}
      <a className="bb-btn bb-btn-primary" href={sso.linkUrl}>
        {emails.length ? `Link another ${sso.label} account` : `Link ${sso.label} account`}
      </a>
    </div>
  );
}

export function AccountPanel() {
  const { me, updateMe } = useSession();
  const [kids, setKids] = useState<FamilyMember[]>([]);
  const canManageKids = me?.role === "parent" || me?.role === "admin";

  useEffect(() => {
    if (!canManageKids || isDemo) return;
    request<{ users: FamilyMember[] }>("/api/users")
      .then((r) => setKids(r.users.filter((u) => u.role === "kid")))
      .catch(() => setKids([]));
  }, [canManageKids]);

  if (!me) return null;

  async function signOut() {
    if (!isDemo) await authApi.signOut().catch(() => undefined);
    enterApp();
  }

  return (
    <section className="bb-account" aria-labelledby="bb-account-h">
      <h1 className="bb-h1" id="bb-account-h">
        Your account
      </h1>
      <NameForm
        label="Your name"
        initial={me.displayName}
        onSave={async (displayName) => {
          if (!isDemo) await rename("/api/users/me", displayName);
          updateMe({ displayName });
        }}
      />
      <SingleSignOn />
      {kids.length > 0 && (
        <div className="bb-account-kids">
          <h2 className="bb-account-sub">Kids' names</h2>
          {kids.map((k) => (
            <NameForm
              key={k.id}
              label={`${k.avatar ? `${k.avatar} ` : ""}${k.displayName}`}
              initial={k.displayName}
              onSave={async (displayName) => {
                const u = await rename(`/api/users/${encodeURIComponent(k.id)}`, displayName);
                setKids((all) => all.map((x) => (x.id === k.id ? { ...x, displayName: u.displayName } : x)));
              }}
            />
          ))}
        </div>
      )}
      <div className="bb-account-actions">
        <a className="bb-btn" href="/who">
          <span aria-hidden>👋</span> Switch reader
        </a>
        <button type="button" className="bb-btn" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </section>
  );
}
