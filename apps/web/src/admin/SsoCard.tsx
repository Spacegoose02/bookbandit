/**
 * Admin → Connections → Single sign-on: set up "Sign in with Tinyauth" (or any OpenID Connect
 * provider) here instead of with env vars. Saves apply at once; the client secret is write-only.
 * Server: apps/server/src/auth/sso-settings.ts.
 */
import { useEffect, useState } from "react";
import { adminApi, type SsoSettings } from "./api";
import { Card, ErrorNote, useAction, useLoad } from "./ui";

export function SsoCard() {
  const loaded = useLoad(() => adminApi.ssoSettings());
  const s: SsoSettings | null = loaded.data;
  const [label, setLabel] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [scopes, setScopes] = useState("");
  const [autoCreate, setAutoCreate] = useState(true);
  const [showOnSignIn, setShowOnSignIn] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const action = useAction();

  useEffect(() => {
    if (!s) return;
    setLabel(s.label);
    setIssuer(s.issuer);
    setClientId(s.clientId);
    setPublicUrl(s.publicUrl);
    setScopes(s.scopes);
    setAutoCreate(s.autoCreate);
    setShowOnSignIn(s.showOnSignIn);
  }, [s]);

  const save = () =>
    action.run(async () => {
      setMsg(null);
      const next = await adminApi.saveSso({
        label,
        issuer,
        clientId,
        publicUrl,
        scopes,
        autoCreate,
        showOnSignIn,
        ...(secret ? { clientSecret: secret } : {}),
      });
      loaded.setData(next);
      setSecret("");
      setMsg(
        next.active
          ? "Saved. Single sign-on works now, no restart needed."
          : "Saved. Fill in the issuer, client ID and client secret to turn it on.",
      );
    });

  const runTest = () =>
    action.run(async () => {
      setTest(null);
      const r = await adminApi.testSso(issuer);
      setTest(r.ok ? { ok: true, text: `Found ${r.issuer}. It answers like an OpenID Connect provider.` } : { ok: false, text: r.error ?? "That didn't work." });
    });

  const envHint = (fromEnv: boolean | undefined) => (fromEnv ? " (empty uses the container's setting)" : "");
  const callbackUrl = publicUrl ? `${publicUrl.replace(/\/+$/, "")}/auth/sso/callback` : (s?.callbackUrl ?? "");

  return (
    <Card title="Single sign-on" actions={s ? <span className={`bb-status${s.active ? " is-on" : ""}`}>{s.active ? "On" : "Off"}</span> : null}>
      <p className="bb-muted bb-small">
        Puts a “Sign in with …” button on the sign-in page, using Tinyauth (or another OpenID Connect provider). In Tinyauth, run{" "}
        <code>tinyauth oidc create bookbandit</code> and paste the client ID and secret it prints here.
      </p>
      <div className="bb-field">
        Callback URL <span className="bb-muted bb-small">(Tinyauth's trusted redirect URI for this client)</span>
        <div className="bb-copy-row">
          <code className="bb-copy-value">{callbackUrl || "…"}</code>
          <button
            type="button"
            className="bb-btn"
            disabled={!callbackUrl}
            onClick={() => {
              void navigator.clipboard?.writeText(callbackUrl).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <span className="bb-muted bb-small">
          For Tinyauth: <code>TINYAUTH_OIDC_CLIENTS_BOOKBANDIT_TRUSTEDREDIRECTURIS={callbackUrl || "…"}</code>
        </span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="bb-field">
          Name on the sign-in button<span className="bb-muted bb-small">{envHint(s?.fromEnv.label)}</span>
          <input className="bb-input" value={label} maxLength={40} placeholder="Tinyauth" onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="bb-field">
          Issuer URL<span className="bb-muted bb-small">{envHint(s?.fromEnv.issuer)}</span>
          <span className="bb-copy-row">
            <input
              className="bb-input bb-mono"
              type="url"
              value={issuer}
              placeholder="https://auth.example.com"
              onChange={(e) => {
                setIssuer(e.target.value);
                setTest(null);
              }}
            />
            <button type="button" className="bb-btn" disabled={action.busy || !issuer} onClick={() => void runTest()}>
              Test
            </button>
          </span>
        </label>
        {test && <p className={test.ok ? "bb-ok" : "bb-auth-error"}>{test.text}</p>}
        <label className="bb-field">
          Client ID<span className="bb-muted bb-small">{envHint(s?.fromEnv.clientId)}</span>
          <input className="bb-input bb-mono" value={clientId} autoComplete="off" onChange={(e) => setClientId(e.target.value)} />
        </label>
        <label className="bb-field">
          Client secret
          <input
            className="bb-input bb-mono"
            type="password"
            autoComplete="new-password"
            placeholder={s?.hasClientSecret ? (s.fromEnv.clientSecret ? "Set in the container; paste one to replace it" : "Saved; leave empty to keep it") : "Paste the client secret"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
        <label className="bb-field">
          Extra scopes <span className="bb-muted bb-small">(optional)</span>
          <input
            className="bb-input bb-mono"
            value={scopes}
            placeholder="openid, profile and email are always asked for"
            onChange={(e) => setScopes(e.target.value)}
          />
        </label>
        <label className="bb-field">
          BookBandit's address <span className="bb-muted bb-small">(optional{s?.fromEnv.publicUrl ? "; empty uses the container's PUBLIC_URL" : "; empty uses the address you're on now"})</span>
          <input
            className="bb-input bb-mono"
            type="url"
            value={publicUrl}
            placeholder="https://books.example.com"
            onChange={(e) => setPublicUrl(e.target.value)}
          />
        </label>
        <label className="bb-field bb-field-inline">
          <input type="checkbox" checked={autoCreate} onChange={(e) => setAutoCreate(e.target.checked)} /> Create an account for anyone who signs in with it
        </label>
        <p className="bb-muted bb-small bb-field-note">
          Only for a provider that just lets in people you trust, like your own Tinyauth with its approved emails. New accounts are grown-ups
          (not admins or parents); change them under People. Off: only emails linked under People can sign in.
        </p>
        <label className="bb-field bb-field-inline">
          <input type="checkbox" checked={showOnSignIn} onChange={(e) => setShowOnSignIn(e.target.checked)} /> Show on the sign-in page
        </label>
        <ErrorNote error={loaded.error ?? action.error} />
        {msg && <p className="bb-ok">{msg}</p>}
        <div className="bb-form-actions">
          <button className="bb-btn bb-btn-primary" disabled={action.busy}>
            Save
          </button>
          {s?.saved && (
            <button
              type="button"
              className="bb-btn bb-btn-ghost"
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  loaded.setData(await adminApi.forgetSso());
                  setSecret("");
                  setMsg("Removed the saved settings. The container's env vars apply, if it has any.");
                })
              }
            >
              Remove saved settings
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}
