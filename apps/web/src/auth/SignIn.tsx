/**
 * Everything someone sees before they're signed in:
 * - first run: create the family and the first admin
 * - a normal browser: username + password, a "Sign in with Tinyauth" button when single sign-on
 *   is set up, a Google button when Tinyauth forward auth is set up,
 *   and "Set up this tablet" to pair with a code
 * - a paired family tablet (or "Switch reader"): the "Who's reading?" picker, where kids
 *   tap their picture and sign in with a PIN or a picture sequence
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { SIGN_IN_PICTURES, type SignInPicture } from "@bookbandit/shared";
import { ApiError } from "../api/client";
import { BarnabyEmpty, BarnabyLogo } from "../brand/Barnaby";
import { authApi, enterApp, PICTURE_EMOJI, type AuthStatus, type Profile } from "./api";

/** What went wrong on the way back from single sign-on (`/?sso_error=…`). */
const SSO_ERRORS: Record<string, string> = {
  unlinked: "That account isn't linked to anyone in BookBandit yet. Ask the person who set up BookBandit to add your email on the People page.",
  setup: "BookBandit isn't set up yet. Open it once to create the family and its first admin.",
  disabled: "This profile is turned off. Ask the person who set up BookBandit.",
  device: "This tablet belongs to someone else, so it can't sign you in.",
  expired: "That sign-in took too long or was started somewhere else. Try again.",
  denied: "Sign-in was cancelled.",
  no_email: "Your sign-in didn't share a verified email, so BookBandit can't tell who you are.",
  provider: "BookBandit couldn't reach the sign-in server. Try again in a minute.",
  token: "Something went wrong finishing the sign-in. Try again, and ask the admin to check the server log if it keeps happening.",
};

function ssoErrorFromUrl(): string | null {
  const code = new URLSearchParams(window.location.search).get("sso_error");
  return code ? (SSO_ERRORS[code] ?? SSO_ERRORS.token!) : null;
}

function messageOf(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return "Too many tries. Wait a minute, then try again.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Loads the sign-in status and shows the right screen. `switching` opens the picker even when signed in. */
export function SignIn({ switching = false }: { switching?: boolean }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"auto" | "password" | "pair">(() => (ssoErrorFromUrl() ? "password" : "auto"));
  const [ssoError] = useState(ssoErrorFromUrl);

  useEffect(() => {
    if (!ssoError) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("sso_error");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [ssoError]);

  useEffect(() => {
    authApi
      .status()
      .then(async (s) => {
        setStatus(s);
        const picker = (s.device && !s.device.lockedTo) || (switching && s.signedIn);
        if (picker) setProfiles(await authApi.profiles());
      })
      .catch((e) => setError(messageOf(e)));
  }, [switching]);

  if (error)
    return (
      <BarnabyEmpty title="Barnaby can't reach the server">
        <p className="bb-muted">{error}</p>
      </BarnabyEmpty>
    );
  if (!status) return <div className="bb-boot" aria-busy="true" />;

  if (status.setupRequired) return <SetupScreen status={status} />;

  if (mode === "pair") return <PairScreen onBack={() => setMode("auto")} />;

  if (profiles && mode === "auto") {
    return (
      <WhoIsReading
        profiles={profiles}
        status={status}
        onGrownUp={() => setMode("password")}
        canCancel={switching && status.signedIn}
      />
    );
  }

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your family library.">
      {status.unlinkedEmail && (
        <p className="bb-auth-note" role="status">
          You're signed in to Google as <b>{status.unlinkedEmail}</b>, but nobody in BookBandit uses that email yet.
          Ask the person who set up BookBandit to add it to your profile.
        </p>
      )}
      <ErrorLine error={ssoError} />
      <PasswordForm />
      {status.sso && <SsoButton sso={status.sso} />}
      {status.google && <GoogleButton url={status.google.url} />}
      <div className="bb-auth-links">
        {profiles && (
          <button type="button" className="bb-link-btn" onClick={() => setMode("auto")}>
            Back to Who's reading?
          </button>
        )}
        {!status.device && (
          <button type="button" className="bb-link-btn" onClick={() => setMode("pair")}>
            Set up this tablet with a code
          </button>
        )}
      </div>
    </AuthShell>
  );
}

function AuthShell({ title, subtitle, children, wide = false }: { title: string; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="bb-auth">
      <div className={`bb-auth-card${wide ? " is-wide" : ""}`}>
        <div className="bb-auth-logo">
          <BarnabyLogo size={56} />
        </div>
        <h1 className="bb-auth-title">{title}</h1>
        {subtitle && <p className="bb-auth-sub">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className="bb-auth-error" role="alert">
      {error}
    </p>
  ) : null;
}

function SsoButton({ sso }: { sso: { label: string; url: string } }) {
  return (
    <>
      <div className="bb-auth-or">
        <span>or</span>
      </div>
      <a className="bb-btn bb-btn-big bb-auth-google bb-auth-sso" href={sso.url}>
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="10" width="16" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
        Sign in with {sso.label}
      </a>
    </>
  );
}

function GoogleButton({ url }: { url: string }) {
  return (
    <>
      <div className="bb-auth-or">
        <span>or</span>
      </div>
      <a className="bb-btn bb-btn-big bb-auth-google" href={url}>
        <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
          <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
          <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
          <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
          <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
        </svg>
        Sign in with Google
      </a>
    </>
  );
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

function SetupScreen({ status }: { status: AuthStatus }) {
  const [form, setForm] = useState({ householdName: "", displayName: "", username: "", password: "", confirm: "", email: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const min = status.limits.passwordMin;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) return setError("The two passwords don't match.");
    if (form.password.length < min) return setError(`Use at least ${min} characters for the password.`);
    setBusy(true);
    setError(null);
    try {
      await authApi.setup({
        householdName: form.householdName.trim() || "Our family",
        displayName: form.displayName.trim(),
        username: form.username.trim().toLowerCase(),
        password: form.password,
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
      });
      enterApp();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Welcome to BookBandit"
      subtitle="Let's set up your family library. You'll be the admin, and you can add everyone else after."
      wide
    >
      <form className="bb-auth-form" onSubmit={submit}>
        <div className="bb-auth-row">
          <label className="bb-field">
            <span>Family name</span>
            <input className="bb-input" value={form.householdName} onChange={set("householdName")} placeholder="The Smiths" autoComplete="off" />
          </label>
          <label className="bb-field">
            <span>Your name</span>
            <input className="bb-input" value={form.displayName} onChange={set("displayName")} placeholder="Dad" required autoComplete="name" />
          </label>
        </div>
        <label className="bb-field">
          <span>Username</span>
          <input
            className="bb-input"
            value={form.username}
            onChange={set("username")}
            required
            pattern="[A-Za-z0-9._\-]{2,40}"
            title="2 to 40 letters, numbers, dots, dashes or underscores"
            autoComplete="username"
            autoCapitalize="none"
          />
        </label>
        <div className="bb-auth-row">
          <label className="bb-field">
            <span>Password</span>
            <input className="bb-input" type="password" value={form.password} onChange={set("password")} required minLength={min} autoComplete="new-password" />
          </label>
          <label className="bb-field">
            <span>Password again</span>
            <input className="bb-input" type="password" value={form.confirm} onChange={set("confirm")} required autoComplete="new-password" />
          </label>
        </div>
        <label className="bb-field">
          <span>
            Sign-in email <span className="bb-muted">(optional, for single sign-on with Tinyauth or Google)</span>
          </span>
          <input className="bb-input" type="email" value={form.email} onChange={set("email")} placeholder="you@gmail.com" autoComplete="email" />
        </label>
        <ErrorLine error={error} />
        <button className="bb-btn bb-btn-primary bb-btn-big bb-auth-submit" disabled={busy}>
          {busy ? "Setting up…" : "Create my library"}
        </button>
      </form>
    </AuthShell>
  );
}

// ---------------------------------------------------------------------------
// Grown-ups
// ---------------------------------------------------------------------------

function PasswordForm({ profile }: { profile?: Profile }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authApi.login(profile ? { userId: profile.id, password } : { username: username.trim().toLowerCase(), password });
      enterApp();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <form className="bb-auth-form" onSubmit={submit}>
      {!profile && (
        <label className="bb-field">
          <span>Username</span>
          <input
            className="bb-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
          />
        </label>
      )}
      <label className="bb-field">
        <span>Password</span>
        <input
          className="bb-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoFocus={!!profile}
          autoComplete="current-password"
          minLength={1}
        />
      </label>
      <ErrorLine error={error} />
      <button className="bb-btn bb-btn-primary bb-btn-big bb-auth-submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function PairScreen({ onBack }: { onBack(): void }) {
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get("code") ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authApi.claimDevice(code, name.trim() || undefined);
      enterApp();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Set up this tablet"
      subtitle="A parent can make a code in BookBandit under Devices. Type it here and this tablet stays signed in to your family."
    >
      <form className="bb-auth-form" onSubmit={submit}>
        <label className="bb-field">
          <span>Pairing code</span>
          <input
            className="bb-input bb-auth-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="K7QM-4XPA"
            required
            autoFocus
            autoComplete="one-time-code"
            autoCapitalize="characters"
          />
        </label>
        <label className="bb-field">
          <span>
            Name for this tablet <span className="bb-muted">(optional)</span>
          </span>
          <input className="bb-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Living room tablet" />
        </label>
        <ErrorLine error={error} />
        <button className="bb-btn bb-btn-primary bb-btn-big bb-auth-submit" disabled={busy}>
          {busy ? "Connecting…" : "Connect tablet"}
        </button>
      </form>
      <div className="bb-auth-links">
        <button type="button" className="bb-link-btn" onClick={onBack}>
          Back to sign in
        </button>
      </div>
    </AuthShell>
  );
}

// ---------------------------------------------------------------------------
// Who's reading? (paired family tablet, or switching profiles)
// ---------------------------------------------------------------------------

function ProfileFace({ profile, size = "big" }: { profile: Profile; size?: "big" | "small" }) {
  return (
    <span className={`bb-face is-${size}${profile.role === "kid" ? " is-kid" : ""}`} aria-hidden>
      {profile.avatar || profile.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}

function WhoIsReading({
  profiles,
  status,
  onGrownUp,
  canCancel,
}: {
  profiles: Profile[];
  status: AuthStatus;
  onGrownUp(): void;
  canCancel: boolean;
}) {
  const [picked, setPicked] = useState<Profile | null>(null);

  if (picked) {
    return (
      <AuthShell title={`Hi, ${picked.displayName}!`} wide={picked.role === "kid"}>
        <div className="bb-auth-picked">
          <ProfileFace profile={picked} />
        </div>
        {picked.signIn === "pin" && <PinPad profile={picked} limits={status.limits.pin} />}
        {picked.signIn === "picture" && <PicturePad profile={picked} limits={status.limits.pictures} />}
        {picked.signIn === "password" && <PasswordForm profile={picked} />}
        {picked.signIn === "google" && (
          <>
            <p className="bb-auth-note">{picked.displayName} signs in with {status.sso?.label ?? "Google"}.</p>
            {/* On a browser already signed in to Google through Tinyauth, ending the profile session is enough. */}
            {(!status.sso || status.google) && <button
              type="button"
              className="bb-btn bb-btn-primary bb-btn-big bb-auth-submit"
              onClick={() => void authApi.signOut().finally(() => enterApp())}
            >
              Continue with Google
            </button>}
            {status.sso && <SsoButton sso={status.sso} />}
            {status.google && <GoogleButton url={status.google.url} />}
          </>
        )}
        {picked.signIn === "none" && (
          <p className="bb-auth-note">
            {picked.role === "kid"
              ? "Ask a grown-up to set up your secret PIN or pictures first."
              : "This profile doesn't have a password yet. An admin can set one."}
          </p>
        )}
        <div className="bb-auth-links">
          <button type="button" className="bb-btn bb-btn-big" onClick={() => setPicked(null)}>
            <span aria-hidden>←</span> Not me
          </button>
        </div>
      </AuthShell>
    );
  }

  const kids = profiles.filter((p) => p.role === "kid");
  const grownUps = profiles.filter((p) => p.role !== "kid");
  return (
    <div className="bb-auth bb-who">
      <div className="bb-who-head">
        <BarnabyLogo size={56} />
        <h1 className="bb-who-title">Who's reading?</h1>
      </div>
      {kids.length > 0 && (
        <ul className="bb-who-grid" aria-label="Kids">
          {kids.map((p) => (
            <li key={p.id}>
              <button type="button" className="bb-who-tile is-kid" onClick={() => setPicked(p)}>
                <ProfileFace profile={p} />
                <span className="bb-who-name">{p.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {grownUps.length > 0 && (
        <>
          <h2 className="bb-who-sub">Grown-ups</h2>
          <ul className="bb-who-grid is-small" aria-label="Grown-ups">
            {grownUps.map((p) => (
              <li key={p.id}>
                <button type="button" className="bb-who-tile" onClick={() => setPicked(p)}>
                  <ProfileFace profile={p} size="small" />
                  <span className="bb-who-name">{p.displayName}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="bb-auth-links">
        <button type="button" className="bb-link-btn" onClick={onGrownUp}>
          Sign in with a username
        </button>
        {canCancel && (
          <button type="button" className="bb-link-btn" onClick={() => enterApp()}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function useKidSubmit(profile: Profile) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  async function submit(body: { pin: string } | { pictures: SignInPicture[] }, reset: () => void) {
    setBusy(true);
    setError(null);
    try {
      await authApi.kidSignIn({ userId: profile.id, ...body } as Parameters<typeof authApi.kidSignIn>[0]);
      enterApp();
    } catch (err) {
      setError(messageOf(err));
      setShake((n) => n + 1);
      reset();
      setBusy(false);
    }
  }
  return { busy, error, shake, submit };
}

function PinPad({ profile, limits }: { profile: Profile; limits: { min: number; max: number } }) {
  const [pin, setPin] = useState("");
  const { busy, error, shake, submit } = useKidSubmit(profile);
  const press = (d: string) => setPin((p) => (p.length < limits.max ? p + d : p));
  const go = () => pin.length >= limits.min && void submit({ pin }, () => setPin(""));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Enter") go();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="bb-kidpad">
      <p className="bb-kidpad-say">Type your secret number</p>
      <div key={shake} className={`bb-pin-dots${shake ? " is-shake" : ""}`} aria-label={`${pin.length} digits typed`}>
        {Array.from({ length: Math.max(limits.min, pin.length) }, (_, i) => (
          <i key={i} className={i < pin.length ? "is-on" : ""} />
        ))}
      </div>
      <ErrorLine error={error} />
      <div className="bb-pin-keys">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" className="bb-pin-key" onClick={() => press(d)} disabled={busy}>
            {d}
          </button>
        ))}
        <button type="button" className="bb-pin-key is-soft" aria-label="Delete" onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy}>
          ⌫
        </button>
        <button type="button" className="bb-pin-key" onClick={() => press("0")} disabled={busy}>
          0
        </button>
        <button type="button" className="bb-pin-key is-go" aria-label="Go" onClick={go} disabled={busy || pin.length < limits.min}>
          ➜
        </button>
      </div>
    </div>
  );
}

function PicturePad({ profile, limits }: { profile: Profile; limits: { min: number; max: number } }) {
  const [seq, setSeq] = useState<SignInPicture[]>([]);
  const { busy, error, shake, submit } = useKidSubmit(profile);
  const go = () => seq.length >= limits.min && void submit({ pictures: seq }, () => setSeq([]));

  return (
    <div className="bb-kidpad">
      <p className="bb-kidpad-say">Tap your secret pictures in order</p>
      <div key={shake} className={`bb-pic-slots${shake ? " is-shake" : ""}`} aria-label={`${seq.length} pictures picked`}>
        {Array.from({ length: Math.max(limits.min, seq.length) }, (_, i) => (
          <span key={i} className={`bb-pic-slot${seq[i] ? " is-on" : ""}`}>
            {seq[i] ? PICTURE_EMOJI[seq[i]!].emoji : ""}
          </span>
        ))}
      </div>
      <ErrorLine error={error} />
      <div className="bb-pic-keys">
        {SIGN_IN_PICTURES.map((p) => (
          <button
            key={p}
            type="button"
            className="bb-pic-key"
            aria-label={PICTURE_EMOJI[p].label}
            disabled={busy || seq.length >= limits.max}
            onClick={() => setSeq((s) => [...s, p])}
          >
            <span aria-hidden>{PICTURE_EMOJI[p].emoji}</span>
          </button>
        ))}
      </div>
      <div className="bb-pic-actions">
        <button type="button" className="bb-btn bb-btn-big" onClick={() => setSeq((s) => s.slice(0, -1))} disabled={busy || !seq.length}>
          <span aria-hidden>↩</span> Undo
        </button>
        <button type="button" className="bb-btn bb-btn-primary bb-btn-big" onClick={go} disabled={busy || seq.length < limits.min}>
          Let's read! <span aria-hidden>➜</span>
        </button>
      </div>
    </div>
  );
}

