import { useState, type FormEvent } from "react";
import {
  isValidPin,
  maxAllowedRating,
  RATING_LABELS,
  SIGN_IN_PICTURES,
  type KidSignInMethod,
  type Role,
  type SignInPicture,
} from "@bookbandit/shared";
import { useSession } from "../app/session";
import { adminApi, type Device, type FamiliesView, type Pairing, type ProfileCard, type UserView } from "./api";
import { Card, ErrorNote, timeAgo, useAction, useLoad } from "./ui";

export const PICTURE_EMOJI: Record<SignInPicture, string> = {
  cat: "🐱",
  dog: "🐶",
  fox: "🦊",
  owl: "🦉",
  frog: "🐸",
  fish: "🐟",
  bear: "🐻",
  bee: "🐝",
  star: "⭐",
};
const AVATARS = ["🦖", "🚀", "🦄", "🐼", "🦊", "🐙", "🌈", "⚽", "🎨", "🐉", "🦝", "🌻", "🧸", "🐢"];
const SIGN_IN_LABEL: Record<string, string> = {
  picture: "Picture password",
  pin: "PIN",
  google: "Google",
  password: "Password",
  none: "Not set up",
};
const ROLE_LABEL: Record<Role, string> = { admin: "Admin", parent: "Parent", adult: "Grown-up", kid: "Kid" };

const thisYear = new Date().getFullYear();

/**
 * People and paired devices. Admins manage every family and everyone; parents manage their own
 * family's kids (the server enforces both, see server/src/routes/families.ts).
 */
export function PeoplePage() {
  const { me } = useSession();
  const people = useLoad(() => adminApi.people());
  const fams = useLoad(() => adminApi.families());
  const isAdmin = me?.role === "admin";
  const users = people.data?.users ?? [];
  const household = people.data?.household ?? [];
  const families = fams.data?.families ?? [];
  const myFamily = fams.data?.mine ?? null;
  const kids = users.filter((u) => u.role === "kid");
  const grownUps = users.filter((u) => u.role !== "kid");
  const parentsToPick = household.filter((p) => p.role === "parent" || p.role === "admin");
  const familyName = (id: string | null) => families.find((f) => f.id === id)?.name ?? null;
  const update = (u: UserView) => people.setData((d) => (d ? { ...d, users: d.users.map((x) => (x.id === u.id ? u : x)) } : d));
  const add = (u: UserView) => {
    people.setData((d) => (d ? { users: [...d.users, u], household: [...d.household, u] } : d));
    fams.reload();
  };
  /** After someone moves family, parent links may have changed too: reload both lists. */
  const moved = () => {
    people.reload();
    fams.reload();
  };
  const grouped = isAdmin && families.length > 1;
  const kidGroups = grouped
    ? [
        ...families.map((f) => ({ id: f.id, name: f.name as string | null, kids: kids.filter((k) => k.familyId === f.id) })),
        { id: "none", name: "Not in a family yet", kids: kids.filter((k) => !families.some((f) => f.id === k.familyId)) },
      ].filter((g) => g.kids.length > 0)
    : [{ id: "all", name: null as string | null, kids }];

  return (
    <>
      <h1 className="bb-h1">People &amp; devices</h1>
      <ErrorNote error={people.error ?? fams.error} />

      {fams.data && <FamiliesCard view={fams.data} isAdmin={isAdmin} onChange={moved} />}

      <Card title="Kids" className="bb-people-kids">
        {kids.length === 0 && people.data ? <p className="bb-muted">No kids yet. Add one below.</p> : null}
        {kidGroups.map((g) => (
          <div key={g.id} className="bb-family-group">
            {g.name && <h3 className="bb-family-group-title">{g.name}</h3>}
            <ul className="bb-people">
              {g.kids.map((k) => (
                <KidRow
                  key={k.id}
                  kid={k}
                  parents={parentsToPick.filter((p) => p.familyId === k.familyId)}
                  families={isAdmin ? families : []}
                  onChange={update}
                  onMoved={moved}
                />
              ))}
            </ul>
          </div>
        ))}
        {people.data && fams.data && (isAdmin || myFamily) && (
          <AddKid parents={parentsToPick} me={me?.id ?? null} myFamily={myFamily} families={isAdmin ? families : []} onAdded={add} />
        )}
        {people.data && fams.data && !isAdmin && !myFamily && (
          <p className="bb-muted">You're not in a family yet. Ask the admin to put you in one, then you can add your kids.</p>
        )}
      </Card>

      {isAdmin && (
        <Card title="Grown-ups">
          <ul className="bb-people">
            {grownUps.map((u) => (
              <GrownUpRow
                key={u.id}
                user={u}
                isMe={u.id === me?.id}
                others={grownUps.filter((o) => o.id !== u.id)}
                families={families}
                familyName={familyName(u.familyId)}
                onChange={update}
                onMoved={moved}
              />
            ))}
          </ul>
          <AddGrownUp families={families} myFamily={myFamily} onAdded={add} />
        </Card>
      )}

      <DevicesCard people={household} families={isAdmin ? families : []} />
    </>
  );
}

/**
 * Families on this server. Admins add, rename and remove families and place people who are
 * waiting (e.g. a new single sign-on account); a parent sees and renames their own family.
 */
function FamiliesCard({ view, isAdmin, onChange }: { view: FamiliesView; isAdmin: boolean; onChange: () => void }) {
  const action = useAction();
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [place, setPlace] = useState<Record<string, { familyId: string; role: Role }>>({});
  const mine = view.families.find((f) => f.id === view.mine);

  if (!isAdmin && !mine)
    return (
      <Card title="Your family">
        <p className="bb-muted">You're not in a family yet. The admin puts new people in a family under People.</p>
      </Card>
    );

  const rename = (id: string) =>
    action.run(async () => {
      await adminApi.renameFamily(id, name.trim());
      setRenaming(null);
      onChange();
    });

  return (
    <Card title={isAdmin ? "Families" : "Your family"} className="bb-families">
      <p className="bb-muted bb-small">
        {isAdmin
          ? "Each family has its own parents and kids. Parents look after their own family's kids, limits, requests and tablets; only an admin can change the server, the library and other families."
          : "You look after your family's kids, their limits, requests and tablets. Server settings and other families stay with the admin."}
      </p>
      <ul className="bb-people">
        {(isAdmin ? view.families : [mine!]).map((f) => (
          <li key={f.id} className="bb-person">
            <div className="bb-person-head">
              <span className="bb-person-avatar" aria-hidden>
                🏠
              </span>
              <div className="bb-person-main">
                {renaming === f.id ? (
                  <form
                    className="bb-inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename(f.id);
                    }}
                  >
                    <input className="bb-input" aria-label="Family name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus />
                    <button className="bb-btn bb-btn-primary" disabled={!name.trim() || action.busy}>
                      Save
                    </button>
                    <button type="button" className="bb-btn bb-btn-ghost" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <strong>{f.name}</strong> {f.id === view.mine && <span className="bb-tag">Yours</span>}
                    <div className="bb-muted bb-small">
                      {f.parents} {f.parents === 1 ? "parent" : "parents"} · {f.kids} {f.kids === 1 ? "kid" : "kids"}
                      {f.members.length ? ` · ${f.members.map((m) => m.displayName).join(", ")}` : ""}
                    </div>
                  </>
                )}
              </div>
              {renaming !== f.id && (
                <button
                  className="bb-btn bb-btn-ghost"
                  onClick={() => {
                    setName(f.name);
                    setRenaming(f.id);
                  }}
                >
                  Rename
                </button>
              )}
              {isAdmin && f.members.length === 0 && (
                <button className="bb-btn bb-btn-ghost" disabled={action.busy} onClick={() => action.run(async () => (await adminApi.deleteFamily(f.id), onChange()))}>
                  Remove
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {isAdmin && view.unassigned.length > 0 && (
        <div className="bb-waiting">
          <h3>Waiting for a family</h3>
          <p className="bb-muted bb-small">New single sign-on accounts land here. They can read, but can't manage anyone until you place them.</p>
          <ul className="bb-people">
            {view.unassigned.map((p) => {
              const choice = place[p.id] ?? { familyId: view.families[0]?.id ?? "", role: p.role === "kid" ? "kid" : "parent" };
              const set = (c: Partial<typeof choice>) => setPlace((s) => ({ ...s, [p.id]: { ...choice, ...c } }));
              return (
                <li key={p.id} className="bb-person">
                  <div className="bb-person-head">
                    <span className="bb-person-avatar" aria-hidden>
                      {p.avatar ?? "🙂"}
                    </span>
                    <div className="bb-person-main">
                      <strong>{p.displayName}</strong>
                      <div className="bb-muted bb-small">{ROLE_LABEL[p.role]}</div>
                    </div>
                    <select className="bb-input" aria-label={`Family for ${p.displayName}`} value={choice.familyId} onChange={(e) => set({ familyId: e.target.value })}>
                      {view.families.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                    {p.role !== "kid" && p.role !== "admin" && (
                      <select className="bb-input" aria-label={`Role for ${p.displayName}`} value={choice.role} onChange={(e) => set({ role: e.target.value as Role })}>
                        <option value="parent">Parent</option>
                        <option value="adult">Grown-up</option>
                      </select>
                    )}
                    <button
                      className="bb-btn bb-btn-primary"
                      disabled={!choice.familyId || action.busy}
                      onClick={() =>
                        action.run(async () => {
                          await adminApi.updatePerson(p.id, { familyId: choice.familyId, ...(p.role !== "kid" && p.role !== "admin" ? { role: choice.role } : {}) });
                          onChange();
                        })
                      }
                    >
                      Put in family
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {isAdmin && (
        <form
          className="bb-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await adminApi.createFamily(newName.trim());
              setNewName("");
              onChange();
            });
          }}
        >
          <input className="bb-input" placeholder="New family, e.g. Uncle Jay's family" aria-label="New family name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} />
          <button className="bb-btn" disabled={!newName.trim() || action.busy}>
            + Add a family
          </button>
        </form>
      )}
      <ErrorNote error={action.error} />
    </Card>
  );
}

/** Admin-only: which family someone is in. Moving drops parent links that would cross families. */
function FamilySelect({ user, families, onMoved }: { user: UserView; families: FamiliesView["families"]; onMoved: () => void }) {
  const action = useAction();
  if (families.length === 0) return null;
  return (
    <>
      <select
        className="bb-input"
        aria-label={`${user.displayName}'s family`}
        value={user.familyId ?? ""}
        disabled={action.busy}
        onChange={(e) =>
          action.run(async () => {
            await adminApi.updatePerson(user.id, { familyId: e.target.value || null });
            onMoved();
          })
        }
      >
        <option value="">No family</option>
        {families.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <ErrorNote error={action.error} />
    </>
  );
}

function KidRow({
  kid,
  parents,
  families,
  onChange,
  onMoved,
}: {
  kid: UserView;
  parents: ProfileCard[];
  families: FamiliesView["families"];
  onChange: (u: UserView) => void;
  onMoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const age = kid.birthYear ? thisYear - kid.birthYear : null;
  const max = maxAllowedRating({ birthYear: kid.birthYear, isKid: true, explicitOptIn: false });
  const parentNames = kid.parentIds.map((id) => parents.find((p) => p.id === id)?.displayName ?? "someone").join(", ");
  return (
    <li className={`bb-person${kid.disabled ? " is-disabled" : ""}`}>
      <div className="bb-person-head">
        <span className="bb-person-avatar" aria-hidden>
          {kid.avatar ?? "🙂"}
        </span>
        <div className="bb-person-main">
          <strong>{kid.displayName}</strong>
          {kid.disabled ? <span className="bb-tag">Paused</span> : null}
          <div className="bb-muted bb-small">
            {age != null ? `${age} years old · ` : ""}sees books up to {RATING_LABELS[max]} · signs in with {SIGN_IN_LABEL[kid.signIn] ?? kid.signIn}
          </div>
          <div className="bb-muted bb-small">Parents: {parentNames}</div>
        </div>
        <button className="bb-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Close" : "Edit"}
        </button>
      </div>
      {open && <KidEditor kid={kid} parents={parents} families={families} onChange={onChange} onMoved={onMoved} />}
    </li>
  );
}

function KidEditor({
  kid,
  parents,
  families,
  onChange,
  onMoved,
}: {
  kid: UserView;
  parents: ProfileCard[];
  families: FamiliesView["families"];
  onChange: (u: UserView) => void;
  onMoved: () => void;
}) {
  const [name, setName] = useState(kid.displayName);
  const [avatar, setAvatar] = useState(kid.avatar);
  const [birthYear, setBirthYear] = useState(kid.birthYear?.toString() ?? "");
  const action = useAction();
  const secret = useAction();
  const [method, setMethod] = useState<KidSignInMethod>(kid.kidSignInMethod ?? "picture");
  const [pin, setPin] = useState("");
  const [pictures, setPictures] = useState<SignInPicture[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  const save = (e: FormEvent) => {
    e.preventDefault();
    setSaved(null);
    void action.run(async () => {
      const u = await adminApi.updatePerson(kid.id, { displayName: name.trim(), avatar, birthYear: Number(birthYear) });
      onChange(u);
      setSaved("Saved.");
    });
  };

  const saveSecret = () =>
    secret.run(async () => {
      setSaved(null);
      let u: UserView;
      if (method === "pin") u = await adminApi.setSecret(kid.id, { pin });
      else if (method === "picture") u = await adminApi.setSecret(kid.id, { pictures });
      else u = await adminApi.updatePerson(kid.id, { kidSignInMethod: "google" });
      onChange(u);
      setPin("");
      setPictures([]);
      setSaved("Sign-in updated.");
    });

  const toggleParent = (p: ProfileCard, linked: boolean) =>
    action.run(async () => onChange(linked ? await adminApi.unlinkParent(kid.id, p.id) : await adminApi.linkParent(kid.id, p.id)));

  return (
    <div className="bb-person-editor">
      <form onSubmit={save}>
        <div className="bb-form-row">
          <label className="bb-field">
            Name
            <input className="bb-input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          </label>
          <label className="bb-field">
            Birth year
            <input
              className="bb-input"
              type="number"
              min={thisYear - 25}
              max={thisYear}
              value={birthYear}
              onChange={(e) => setBirthYear(e.target.value)}
              required
            />
          </label>
        </div>
        <AvatarPicker value={avatar} onChange={setAvatar} />
        <div className="bb-form-actions">
          <button className="bb-btn bb-btn-primary" disabled={action.busy}>
            Save
          </button>
          <button
            type="button"
            className="bb-btn"
            disabled={action.busy}
            onClick={() => action.run(async () => onChange(await adminApi.updatePerson(kid.id, { disabled: !kid.disabled })))}
          >
            {kid.disabled ? "Let them sign in again" : "Pause sign-in"}
          </button>
        </div>
      </form>

      <fieldset className="bb-field">
        <legend>Sign-in</legend>
        <SignInPicker method={method} setMethod={setMethod} pin={pin} setPin={setPin} pictures={pictures} setPictures={setPictures} />
        <div className="bb-form-actions">
          <button
            type="button"
            className="bb-btn"
            disabled={secret.busy || (method === "pin" && !isValidPin(pin)) || (method === "picture" && pictures.length < 3)}
            onClick={saveSecret}
          >
            {method === "google" ? "Use Google sign-in" : method === "pin" ? "Set new PIN" : "Set new pictures"}
          </button>
        </div>
        <ErrorNote error={secret.error} />
      </fieldset>

      <fieldset className="bb-field">
        <legend>Parents</legend>
        <div className="bb-chips">
          {parents.map((p) => {
            const linked = kid.parentIds.includes(p.id);
            return (
              <button key={p.id} type="button" className="bb-chip" aria-pressed={linked} disabled={action.busy} onClick={() => toggleParent(p, linked)}>
                {p.avatar ? `${p.avatar} ` : ""}
                {p.displayName}
              </button>
            );
          })}
        </div>
        <p className="bb-muted bb-small">
          A kid always keeps at least one parent from their family. Every parent in the family can look after them on the family dashboard.
        </p>
      </fieldset>
      {families.length > 0 && (
        <fieldset className="bb-field">
          <legend>Family</legend>
          <FamilySelect user={kid} families={families} onMoved={onMoved} />
          <p className="bb-muted bb-small">Link a parent from the new family first; parents from the old family are unlinked.</p>
        </fieldset>
      )}
      <ErrorNote error={action.error} />
      {saved && <p className="bb-ok">{saved}</p>}
    </div>
  );
}

function AvatarPicker({ value, onChange }: { value: string | null; onChange: (a: string | null) => void }) {
  return (
    <fieldset className="bb-field">
      <legend>Picture</legend>
      <div className="bb-avatar-picker">
        {AVATARS.map((a) => (
          <button key={a} type="button" className="bb-avatar-choice" aria-pressed={value === a} aria-label={a} onClick={() => onChange(a)}>
            {a}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function SignInPicker(props: {
  method: KidSignInMethod;
  setMethod: (m: KidSignInMethod) => void;
  pin: string;
  setPin: (p: string) => void;
  pictures: SignInPicture[];
  setPictures: (p: SignInPicture[]) => void;
  email?: string;
  setEmail?: (e: string) => void;
}) {
  const { method, pictures } = props;
  return (
    <>
      <div className="bb-chips" role="radiogroup" aria-label="Sign-in method">
        {(["picture", "pin", "google"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={method === m} className="bb-chip" aria-pressed={method === m} onClick={() => props.setMethod(m)}>
            {m === "picture" ? "🐱 Pictures" : m === "pin" ? "🔢 PIN" : "Google"}
          </button>
        ))}
      </div>
      {method === "pin" && (
        <label className="bb-field">
          PIN (4 to 6 digits)
          <input
            className="bb-input bb-pin"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={props.pin}
            onChange={(e) => props.setPin(e.target.value.replace(/\D/g, ""))}
          />
        </label>
      )}
      {method === "picture" && (
        <div className="bb-field">
          <span>
            Tap 3 to 5 pictures in order{" "}
            <span className="bb-picture-seq" aria-live="polite">
              {pictures.map((p) => PICTURE_EMOJI[p]).join(" ") || "…"}
            </span>
            {pictures.length > 0 && (
              <button type="button" className="bb-btn bb-btn-ghost bb-btn-small" onClick={() => props.setPictures([])}>
                Clear
              </button>
            )}
          </span>
          <div className="bb-picture-grid">
            {SIGN_IN_PICTURES.map((p) => (
              <button
                key={p}
                type="button"
                className="bb-picture"
                aria-label={p}
                disabled={pictures.length >= 5}
                onClick={() => props.setPictures([...pictures, p])}
              >
                {PICTURE_EMOJI[p]}
              </button>
            ))}
          </div>
        </div>
      )}
      {method === "google" && props.setEmail && (
        <label className="bb-field">
          Their Google email
          <input className="bb-input" type="email" value={props.email ?? ""} onChange={(e) => props.setEmail!(e.target.value)} />
        </label>
      )}
      {method === "google" && !props.setEmail && (
        <p className="bb-muted bb-small">Signs in with a Google account linked by an admin.</p>
      )}
    </>
  );
}

function AddKid({
  parents: allParents,
  me,
  myFamily,
  families,
  onAdded,
}: {
  parents: ProfileCard[];
  me: string | null;
  myFamily: string | null;
  families: FamiliesView["families"];
  onAdded: (u: UserView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [familyId, setFamilyId] = useState<string>(myFamily ?? families[0]?.id ?? "");
  const inMyFamily = familyId === myFamily;
  const parents = allParents.filter((p) => p.familyId === familyId && p.id !== me);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<string | null>("🦖");
  const [birthYear, setBirthYear] = useState("");
  const [method, setMethod] = useState<KidSignInMethod>("picture");
  const [pin, setPin] = useState("");
  const [pictures, setPictures] = useState<SignInPicture[]>([]);
  const [email, setEmail] = useState("");
  const [coParents, setCoParents] = useState<string[]>(allParents.filter((p) => p.familyId === familyId && p.id !== me).map((p) => p.id));
  const action = useAction();

  if (!open)
    return (
      <button className="bb-btn bb-btn-primary" onClick={() => setOpen(true)}>
        + Add a kid
      </button>
    );

  const ready =
    name.trim() &&
    birthYear &&
    (inMyFamily || coParents.some((id) => parents.some((p) => p.id === id))) &&
    (method === "pin" ? isValidPin(pin) : method === "picture" ? pictures.length >= 3 : /.+@.+/.test(email));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const u = await adminApi.addPerson({
        displayName: name.trim(),
        role: "kid",
        birthYear: Number(birthYear),
        avatar,
        kidSignInMethod: method,
        ...(method === "pin" ? { pin } : method === "picture" ? { pictures } : { email: email.trim() }),
        parentIds: coParents.filter((id) => parents.some((p) => p.id === id)),
        ...(families.length ? { familyId } : {}),
      });
      onAdded(u);
      setOpen(false);
      setName("");
      setBirthYear("");
      setPin("");
      setPictures([]);
      setEmail("");
    });
  };

  return (
    <form className="bb-person-editor bb-add-form" onSubmit={submit}>
      <h3>Add a kid</h3>
      {families.length > 1 && (
        <label className="bb-field">
          Family
          <select
            className="bb-input"
            value={familyId}
            onChange={(e) => {
              setFamilyId(e.target.value);
              setCoParents(allParents.filter((p) => p.familyId === e.target.value && p.id !== me).map((p) => p.id));
            }}
          >
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="bb-form-row">
        <label className="bb-field">
          Name
          <input className="bb-input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus />
        </label>
        <label className="bb-field">
          Birth year
          <input className="bb-input" type="number" min={thisYear - 25} max={thisYear} value={birthYear} onChange={(e) => setBirthYear(e.target.value)} required />
        </label>
      </div>
      {birthYear && (
        <p className="bb-muted bb-small">
          They'll see books rated up to {RATING_LABELS[maxAllowedRating({ birthYear: Number(birthYear), isKid: true, explicitOptIn: false })]}. This moves up
          on its own as they grow.
        </p>
      )}
      <AvatarPicker value={avatar} onChange={setAvatar} />
      <fieldset className="bb-field">
        <legend>How they sign in</legend>
        <SignInPicker
          method={method}
          setMethod={setMethod}
          pin={pin}
          setPin={setPin}
          pictures={pictures}
          setPictures={setPictures}
          email={email}
          setEmail={setEmail}
        />
      </fieldset>
      {parents.length > 0 && (
        <fieldset className="bb-field">
          <legend>{inMyFamily ? "Other parents" : "Parents"}</legend>
          <div className="bb-chips">
            {parents.map((p) => {
              const on = coParents.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  className="bb-chip"
                  aria-pressed={on}
                  onClick={() => setCoParents(on ? coParents.filter((x) => x !== p.id) : [...coParents, p.id])}
                >
                  {p.displayName}
                </button>
              );
            })}
          </div>
          <p className="bb-muted bb-small">{inMyFamily ? "You're always linked as a parent." : "Pick at least one parent from that family."}</p>
        </fieldset>
      )}
      <ErrorNote error={action.error} />
      <div className="bb-form-actions">
        <button className="bb-btn bb-btn-primary" disabled={!ready || action.busy}>
          Add {name.trim() || "kid"}
        </button>
        <button type="button" className="bb-btn bb-btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function GrownUpRow({
  user,
  isMe,
  others,
  families,
  familyName,
  onChange,
  onMoved,
}: {
  user: UserView;
  isMe: boolean;
  others: UserView[];
  families: FamiliesView["families"];
  familyName: string | null;
  onChange: (u: UserView) => void;
  onMoved: () => void;
}) {
  const action = useAction();
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [showEmails, setShowEmails] = useState(false);
  const logins = user.identities.map((i) => (i.provider === "tinyauth" ? i.subject : `username ${i.subject}`)).join(", ");
  return (
    <li className={`bb-person${user.disabled ? " is-disabled" : ""}`}>
      <div className="bb-person-head">
        <span className="bb-person-avatar" aria-hidden>
          {user.avatar ?? "🙂"}
        </span>
        <div className="bb-person-main">
          <strong>{user.displayName}</strong> {isMe && <span className="bb-tag">You</span>}
          {user.disabled ? <span className="bb-tag">Disabled</span> : null}
          <div className="bb-muted bb-small">
            {familyName ?? "Waiting for a family"} · {logins || "No sign-in linked"}
          </div>
        </div>
        <FamilySelect user={user} families={families} onMoved={onMoved} />
        <select
          className="bb-input"
          aria-label={`${user.displayName}'s role`}
          value={user.role}
          disabled={isMe || action.busy}
          onChange={(e) => action.run(async () => onChange(await adminApi.updatePerson(user.id, { role: e.target.value as Role })))}
        >
          {(["admin", "parent", "adult"] as const).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        {!isMe && (
          <button
            className="bb-btn"
            disabled={action.busy}
            onClick={() => action.run(async () => onChange(await adminApi.updatePerson(user.id, { disabled: !user.disabled })))}
          >
            {user.disabled ? "Enable" : "Disable"}
          </button>
        )}
        <button className="bb-btn bb-btn-ghost" aria-expanded={showEmails} onClick={() => setShowEmails((s) => !s)}>
          Sign-in emails
        </button>
        {user.identities.some((i) => i.provider === "local") && (
          <button className="bb-btn bb-btn-ghost" onClick={() => setShowPw((s) => !s)}>
            Reset password
          </button>
        )}
      </div>
      {showEmails && <SignInEmails user={user} others={others} onChange={onChange} />}
      {showPw && (
        <form
          className="bb-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              onChange(await adminApi.setSecret(user.id, { password }));
              setPassword("");
              setShowPw(false);
            });
          }}
        >
          <input className="bb-input" type="password" autoComplete="new-password" minLength={8} placeholder="New password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="bb-btn" disabled={password.length < 8 || action.busy}>
            Set password
          </button>
        </form>
      )}
      <ErrorNote error={action.error} />
    </li>
  );
}

/** Emails that sign this person in with single sign-on (Tinyauth / Google). */
function SignInEmails({ user, others, onChange }: { user: UserView; others: UserView[]; onChange: (u: UserView) => void }) {
  const action = useAction();
  const [email, setEmail] = useState("");
  const emails = user.identities.filter((i) => i.provider === "tinyauth");
  return (
    <div className="bb-inline-form bb-signin-emails">
      <p className="bb-muted bb-small">
        Signing in with Tinyauth (or Google through Tinyauth) with one of these emails opens {user.displayName}'s library.
        If single sign-on made a separate account for someone who already has a profile, use Move to… there to merge
        the email into the right profile; the leftover account is turned off.
      </p>
      {emails.length > 0 && (
        <ul className="bb-chip-list">
          {emails.map((i) => (
            <li key={i.id} className="bb-chip">
              {i.subject}
              {others.length > 0 && (
                <select
                  className="bb-input bb-input-small"
                  aria-label={`Move ${i.subject} to someone else`}
                  value=""
                  disabled={action.busy}
                  onChange={(e) => {
                    const to = e.target.value;
                    if (!to) return;
                    void action.run(async () => {
                      const r = await adminApi.moveEmail(user.id, i.id, to);
                      onChange(r.from);
                      onChange(r.to);
                    });
                  }}
                >
                  <option value="">Move to…</option>
                  {others.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.displayName}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="bb-link-btn"
                aria-label={`Remove ${i.subject}`}
                disabled={action.busy}
                onClick={() => action.run(async () => onChange(await adminApi.removeIdentity(user.id, i.id)))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="bb-form-row"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            onChange(await adminApi.linkEmail(user.id, email));
            setEmail("");
          });
        }}
      >
        <input
          className="bb-input"
          type="email"
          aria-label={`Add an email for ${user.displayName}`}
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <button className="bb-btn" disabled={!/.+@.+/.test(email) || action.busy}>
          Link email
        </button>
      </form>
      <ErrorNote error={action.error} />
    </div>
  );
}

function AddGrownUp({
  families,
  myFamily,
  onAdded,
}: {
  families: FamiliesView["families"];
  myFamily: string | null;
  onAdded: (u: UserView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [familyId, setFamilyId] = useState(myFamily ?? "");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("parent");
  const [how, setHow] = useState<"google" | "password">("google");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const action = useAction();
  if (!open)
    return (
      <button className="bb-btn" onClick={() => setOpen(true)}>
        + Add a grown-up
      </button>
    );
  return (
    <form
      className="bb-person-editor bb-add-form"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          onAdded(
            await adminApi.addPerson({
              displayName: name.trim(),
              role,
              familyId: familyId || null,
              ...(how === "google" ? { email: email.trim() } : { username: username.trim(), password }),
            }),
          );
          setOpen(false);
        });
      }}
    >
      <h3>Add a grown-up</h3>
      <div className="bb-form-row">
        <label className="bb-field">
          Name
          <input className="bb-input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        </label>
        <label className="bb-field">
          Role
          <select className="bb-input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="parent">Parent (manages kids)</option>
            <option value="adult">Grown-up (just reads)</option>
            <option value="admin">Admin (everything)</option>
          </select>
        </label>
        <label className="bb-field">
          Family
          <select className="bb-input" value={familyId} onChange={(e) => setFamilyId(e.target.value)}>
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
            <option value="">No family yet</option>
          </select>
        </label>
      </div>
      <div className="bb-chips" role="radiogroup" aria-label="Sign-in">
        <button type="button" className="bb-chip" aria-pressed={how === "google"} onClick={() => setHow("google")}>
          Google / family login
        </button>
        <button type="button" className="bb-chip" aria-pressed={how === "password"} onClick={() => setHow("password")}>
          Username and password
        </button>
      </div>
      {how === "google" ? (
        <label className="bb-field">
          Email
          <input className="bb-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
      ) : (
        <div className="bb-form-row">
          <label className="bb-field">
            Username
            <input className="bb-input" value={username} onChange={(e) => setUsername(e.target.value)} required pattern="[a-zA-Z0-9._\-]{2,40}" />
          </label>
          <label className="bb-field">
            Password
            <input className="bb-input" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
        </div>
      )}
      <ErrorNote error={action.error} />
      <div className="bb-form-actions">
        <button className="bb-btn bb-btn-primary" disabled={action.busy}>
          Add
        </button>
        <button type="button" className="bb-btn bb-btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DevicesCard({ people, families }: { people: ProfileCard[]; families: FamiliesView["families"] }) {
  const list = useLoad(() => adminApi.devices());
  const [pairing, setPairing] = useState<(Pairing & { name: string }) | null>(null);
  const [name, setName] = useState("");
  const [lockTo, setLockTo] = useState("");
  /** Admins: whose tablet a new shared device is ("" = their own family, "*" = every family). */
  const [forFamily, setForFamily] = useState("");
  const familyOf = (d: Device) => (families.length ? (d.familyId ? (families.find((f) => f.id === d.familyId)?.name ?? null) : "every family") : null);
  const action = useAction();
  const devices = list.data ?? [];
  const active = devices.filter((d) => !d.revokedAt);
  const revoked = devices.filter((d) => d.revokedAt);
  const who = (id: string | null) => (id ? (people.find((p) => p.id === id)?.displayName ?? "someone") : null);
  const replace = (d: Device) => list.setData((ds) => (ds ? ds.map((x) => (x.id === d.id ? d : x)) : ds));

  return (
    <Card title="Paired devices" className="bb-devices">
      <span id="devices" />
      <p className="bb-muted bb-small">
        Tablets and e-readers signed in with a device code. A family's tablet only shows that family on "Who's reading?". Lock a
        device to one kid so it always opens their books. Revoking a device signs it out at once.
      </p>
      <ErrorNote error={list.error ?? action.error} />
      <ul className="bb-device-list">
        {active.map((d) => (
          <li key={d.id} className="bb-device">
            <span className="bb-device-icon" aria-hidden>
              📱
            </span>
            <div className="bb-person-main">
              <strong>{d.name}</strong>
              <div className="bb-muted bb-small">
                {d.lastSeenAt ? `Last used ${timeAgo(d.lastSeenAt)}` : "Waiting to be paired"} · {who(d.userId) ? `locked to ${who(d.userId)}` : "shared"}
                {familyOf(d) ? ` · ${familyOf(d)}` : ""}
              </div>
            </div>
            <select
              className="bb-input"
              aria-label={`Who uses ${d.name}`}
              value={d.userId ?? ""}
              disabled={action.busy}
              onChange={(e) => action.run(async () => replace(await adminApi.updateDevice(d.id, { userId: e.target.value || null })))}
            >
              <option value="">Shared (anyone signs in)</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  Only {p.displayName}
                </option>
              ))}
            </select>
            <button className="bb-btn bb-btn-ghost" disabled={action.busy} onClick={() => action.run(async () => replace(await adminApi.revokeDevice(d.id)))}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
      {revoked.length > 0 && (
        <details className="bb-scan-details">
          <summary>{revoked.length} revoked</summary>
          <ul>
            {revoked.map((d) => (
              <li key={d.id}>
                {d.name}, revoked {timeAgo(d.revokedAt)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {pairing ? (
        <div className="bb-pairing" role="status">
          <p>
            On <strong>{pairing.name}</strong>, open BookBandit and enter this code (or scan the QR code in the app):
          </p>
          <p className="bb-pair-code">{pairing.code}</p>
          <p className="bb-muted bb-small">
            Works once, until {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Link:{" "}
            <code>{pairing.qr}</code>
          </p>
          <button
            className="bb-btn"
            onClick={() => {
              setPairing(null);
              list.reload();
            }}
          >
            Done
          </button>
        </div>
      ) : (
        <form
          className="bb-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const fam = lockTo || !families.length || !forFamily ? undefined : forFamily === "*" ? null : forFamily;
              const p = await adminApi.startPairing(name.trim(), lockTo || null, fam);
              setPairing({ ...p, name: name.trim() });
              setName("");
            });
          }}
        >
          <input className="bb-input" placeholder="Device name, e.g. Mia's tablet" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          <select className="bb-input" value={lockTo} onChange={(e) => setLockTo(e.target.value)} aria-label="Who will use it">
            <option value="">Shared</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                Only {p.displayName}
              </option>
            ))}
          </select>
          {families.length > 1 && !lockTo && (
            <select className="bb-input" value={forFamily} onChange={(e) => setForFamily(e.target.value)} aria-label="Whose tablet">
              <option value="">Your family's</option>
              {families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
              <option value="*">Every family's</option>
            </select>
          )}
          <button className="bb-btn bb-btn-primary" disabled={!name.trim() || action.busy}>
            Pair a device
          </button>
        </form>
      )}
    </Card>
  );
}
