import { useEffect, useState, type FormEvent } from "react";
import { Card, ErrorNote, timeAgo, useAction, useLoad } from "../admin/ui";
import { familyAppsApi, type DenDutyKids, type FamilyAppsSettings, type KidLinkRow } from "./api";
import "./family-apps.css";

function Status({ on, label }: { on: boolean; label: string }) {
  return <span className={`bb-status${on ? " is-on" : ""}`}>{label}</span>;
}

/** Admin → Connections: Den Duty (reading earns chore points) and Nighttime Ninja (Send to kitchen). */
export function FamilyAppsCards() {
  const loaded = useLoad(() => familyAppsApi.settings());
  return (
    <>
      <DenDutyCard s={loaded.data} error={loaded.error} onSaved={loaded.reload} />
      <KitchenCard s={loaded.data} onSaved={loaded.reload} />
    </>
  );
}

function DenDutyCard({ s, error, onSaved }: { s: FamilyAppsSettings | null; error: string | null; onSaved: () => void }) {
  const [url, setUrl] = useState("");
  const [homeId, setHomeId] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [rows, setRows] = useState<KidLinkRow[]>([]);
  const [den, setDen] = useState<DenDutyKids | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const action = useAction();
  const d = s?.denDuty ?? null;

  useEffect(() => {
    if (!d) return;
    setUrl(d.url);
    setHomeId(d.homeId);
    setEnabled(d.enabled);
    setRows(d.kids);
  }, [d]);

  // Once linked, load Den Duty's kids and habits for the matching rows.
  useEffect(() => {
    if (!d?.hasToken) return;
    let live = true;
    familyAppsApi
      .denDutyKids()
      .then((k) => live && setDen(k))
      .catch((e: unknown) => live && action.setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.hasToken, d?.url, d?.homeId]);

  const save = (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    void action.run(async () => {
      await familyAppsApi.saveDenDuty({ url: url.trim(), homeId: homeId.trim(), enabled, kids: rows, ...(token ? { token: token.trim() } : {}) });
      setToken("");
      const k = await familyAppsApi.denDutyKids();
      setDen(k);
      setMsg(`Connected to ${k.home.name}. ${rows.length ? "Saved." : "Now match each kid to a practice habit."}`);
      onSaved();
    });
  };

  const sendNow = () =>
    void action.run(async () => {
      const r = await familyAppsApi.reportNow();
      setMsg(`Sent ${r.sent} ${r.sent === 1 ? "day" : "days"} of reading to Den Duty.`);
      onSaved();
    });

  const unlink = () =>
    void action.run(async () => {
      await familyAppsApi.unlinkDenDuty();
      setDen(null);
      setRows([]);
      setMsg("Den Duty unlinked.");
      onSaved();
    });

  const setRow = (userId: string, kidId: string, habitId: string) => {
    const rest = rows.filter((r) => r.userId !== userId);
    setRows(kidId && habitId ? [...rest, { userId, kidId, habitId }] : rest);
  };

  return (
    <Card
      title="Den Duty"
      actions={s ? <Status on={!!d?.hasToken && d.enabled} label={d?.hasToken ? (d.enabled ? "Linked" : "Off") : "Not linked"} /> : null}
    >
      <p className="bb-muted bb-small">
        Reading and listening time counts as a kid's Den Duty practice: their reading habit ticks itself off and pays its
        points, and finished books can pay a bonus. Only minutes and finished books are sent.
      </p>
      <form onSubmit={save}>
        <label className="bb-field">
          Den Duty address
          <input className="bb-input" type="url" placeholder="http://192.168.1.20:8090" value={url} onChange={(e) => setUrl(e.target.value)} required />
        </label>
        <label className="bb-field">
          Home id
          <input className="bb-input" placeholder="Shown under the token box in Den Duty" value={homeId} onChange={(e) => setHomeId(e.target.value)} required />
        </label>
        <label className="bb-field">
          Control token
          <input
            className="bb-input"
            type="password"
            autoComplete="off"
            placeholder={d?.hasToken ? "Saved. Paste a new one to replace it" : "Den Duty → Settings → API tokens (control)"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required={!d?.hasToken}
          />
        </label>

        {den && s && (
          <fieldset className="bb-field">
            <legend>Match kids</legend>
            {den.habitsMissing && <p className="bb-error bb-small">This Den Duty is too old to list habits. Update it, then reload this page.</p>}
            {s.kids.length === 0 && <p className="bb-muted bb-small">No kids in BookBandit yet.</p>}
            <div className="bb-family-apps-kids">
              {s.kids.map((k) => {
                const row = rows.find((r) => r.userId === k.id);
                const denKid = den.kids.find((x) => x.id === row?.kidId);
                return (
                  <div className="bb-family-apps-kid" key={k.id}>
                    <strong>{k.displayName}</strong>
                    <select
                      className="bb-input"
                      aria-label={`${k.displayName} in Den Duty`}
                      value={row?.kidId ?? ""}
                      onChange={(e) => {
                        const dk = den.kids.find((x) => x.id === e.target.value);
                        const habit = dk?.habits.find((h) => /read|book/i.test(h.title)) ?? dk?.habits[0];
                        setRow(k.id, e.target.value, habit?.id ?? "");
                      }}
                    >
                      <option value="">Not linked</option>
                      {den.kids.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                    <select
                      className="bb-input"
                      aria-label={`${k.displayName}'s reading habit`}
                      value={row?.habitId ?? ""}
                      disabled={!denKid}
                      onChange={(e) => setRow(k.id, row!.kidId, e.target.value)}
                    >
                      {!denKid?.habits.length && <option value="">{denKid ? "Add a practice habit in Den Duty" : "Pick a kid first"}</option>}
                      {denKid?.habits.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.icon} {h.title}
                          {h.minutes ? `, ${h.minutes} min` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </fieldset>
        )}

        <label className="bb-field bb-field-inline">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Send reading time every few minutes
        </label>
        {s?.lastReport && (
          <p className={`bb-small ${s.lastReport.ok ? "bb-muted" : "bb-error"}`}>
            Last sent {timeAgo(s.lastReport.at)}
            {s.lastReport.ok ? "" : `: ${s.lastReport.error}`}
          </p>
        )}
        <ErrorNote error={error ?? action.error} />
        {msg && <p className="bb-ok">{msg}</p>}
        <div className="bb-form-actions">
          <button className="bb-btn bb-btn-primary" disabled={action.busy}>
            Save and test
          </button>
          {d?.hasToken && rows.length > 0 && (
            <button type="button" className="bb-btn" onClick={sendNow} disabled={action.busy}>
              Send now
            </button>
          )}
          {d && (
            <button type="button" className="bb-btn" onClick={unlink} disabled={action.busy}>
              Unlink
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

function KitchenCard({ s, onSaved }: { s: FamilyAppsSettings | null; onSaved: () => void }) {
  const [url, setUrl] = useState("");
  const [homeId, setHomeId] = useState("");
  const [token, setToken] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const action = useAction();
  const k = s?.kitchen ?? null;

  useEffect(() => {
    if (k) {
      setUrl(k.url);
      setHomeId(k.homeId);
    }
    setPublicUrl(s?.publicUrl ?? "");
  }, [k, s?.publicUrl]);

  const save = (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    void action.run(async () => {
      await familyAppsApi.saveKitchen({ url: url.trim(), homeId: homeId.trim(), ...(token ? { token: token.trim() } : {}) });
      await familyAppsApi.savePublicUrl(publicUrl.trim() || null);
      setToken("");
      await familyAppsApi.checkKitchen();
      setMsg("Connected. Cookbooks in Cook mode now have a Send to kitchen button.");
      onSaved();
    });
  };

  const unlink = () =>
    void action.run(async () => {
      await familyAppsApi.unlinkKitchen();
      setMsg("Nighttime Ninja unlinked.");
      onSaved();
    });

  return (
    <Card title="Nighttime Ninja" actions={s ? <Status on={!!k?.hasToken} label={k?.hasToken ? "Linked" : "Not linked"} /> : null}>
      <p className="bb-muted bb-small">
        Grown-ups can send a recipe from a cookbook in Cook mode to your kitchen app, with a link back to the page. Recipes
        from books are kept off Nighttime Ninja's public share links.
      </p>
      <form onSubmit={save}>
        <label className="bb-field">
          Nighttime Ninja address
          <input className="bb-input" type="url" placeholder="http://192.168.1.20:8080" value={url} onChange={(e) => setUrl(e.target.value)} required />
        </label>
        <label className="bb-field">
          Home id
          <input className="bb-input" placeholder="Shown under the token box in Nighttime Ninja" value={homeId} onChange={(e) => setHomeId(e.target.value)} required />
        </label>
        <label className="bb-field">
          Home token
          <input
            className="bb-input"
            type="password"
            autoComplete="off"
            placeholder={k?.hasToken ? "Saved. Paste a new one to replace it" : "Settings → Home → Home Assistant and automations"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required={!k?.hasToken}
          />
        </label>
        <label className="bb-field">
          BookBandit's address for links back (optional)
          <input className="bb-input" type="url" placeholder="https://books.example.com" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} />
        </label>
        <ErrorNote error={action.error} />
        {msg && <p className="bb-ok">{msg}</p>}
        <div className="bb-form-actions">
          <button className="bb-btn bb-btn-primary" disabled={action.busy}>
            Save and test
          </button>
          {k && (
            <button type="button" className="bb-btn" onClick={unlink} disabled={action.busy}>
              Unlink
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}
