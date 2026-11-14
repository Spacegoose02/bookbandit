import { useEffect, useState, type FormEvent } from "react";
import { useSession } from "../app/session";
import { isKindleAddress, kindleApi, type KindleMe } from "./api";
import "./kindle.css";

/** Settings section: this profile's Send to Kindle address. Hidden until an admin sets up email. */
export function KindleSettings() {
  const { me } = useSession();
  const [info, setInfo] = useState<KindleMe | null>(null);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    kindleApi.me().then((i) => (setInfo(i), setEmail(i.email ?? "")), () => setInfo(null));
  }, []);

  if (!me || !info?.available) return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!me) return;
    try {
      if (!email.trim()) {
        await kindleApi.removeAddress(me.id);
        setStatus({ ok: true, text: "Removed." });
        return;
      }
      if (!isKindleAddress(email)) throw new Error("Use your Kindle's address, ending in @kindle.com");
      await kindleApi.setAddress(me.id, email);
      setStatus({ ok: true, text: "Saved." });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <section className="bb-settings-section bb-kindle-settings">
      <h2>Send to Kindle</h2>
      {info.canEdit ? (
        <form onSubmit={save}>
          <label className="bb-field">
            <span>Kindle email address</span>
            <input
              className="bb-input"
              type="email"
              placeholder="name_1234@kindle.com"
              value={email}
              onChange={(e) => (setEmail(e.target.value), setStatus(null))}
            />
          </label>
          {info.fromAddress && (
            <p className="bb-muted bb-small">
              On Amazon, add <b>{info.fromAddress}</b> to your approved personal document senders.
            </p>
          )}
          <button className="bb-btn bb-btn-primary">Save</button>
          {status && <p className={status.ok ? "bb-kindle-ok" : "bb-error"}>{status.text}</p>}
        </form>
      ) : (
        <p className="bb-muted">{info.email ? `Books go to ${info.email}.` : "Ask a grown-up to add your Kindle."}</p>
      )}
    </section>
  );
}
