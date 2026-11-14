/**
 * Settings → Your account: change your own display name, and (parents/admins) rename the kids
 * you look after. Sign out and Switch reader live here too.
 */
import { useEffect, useState, type FormEvent } from "react";
import type { Role } from "@bookbandit/shared";
import { ApiError, isDemo, request } from "../api/client";
import { useSession } from "../app/session";
import { authApi, enterApp } from "./api";

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
