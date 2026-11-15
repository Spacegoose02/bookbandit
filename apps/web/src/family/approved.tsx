/**
 * "Parent approved": books a parent picks for one kid or for the whole family. Kids see them on
 * their home in a Parent approved row, each kid only within their own limit (the server filters).
 *
 * - <ApproveForKids> on the book page (parents and admins): toggle the whole family or each kid.
 * - <ApprovedCard> on the family dashboard's kid page: what's on a kid's row, with Remove.
 *
 * Server: /api/books/:id/approvals, /api/families/:id/approved/:bookId (whole family) and
 * /api/shelves/kids/:kidId/books/:bookId (one kid). See docs/admin-api.md#parent-approved.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { isDemo, request } from "../api/client";
import { Card, Cover, ErrorNote, useAction, useLoad } from "../admin/ui";
import { adminApi } from "../admin/api";
import "./approved.css";

export interface Approvals {
  family: { id: string; name: string; approved: boolean } | null;
  kids: { id: string; displayName: string; avatar: string | null; approved: boolean; canSee: boolean }[];
}

export interface ApprovedItem {
  book: { id: string; title: string; coverPath: string | null };
  familyPick: boolean;
  addedAt: number;
}

export interface ApprovedApi {
  approvals(bookId: string): Promise<Approvals>;
  setFamily(familyId: string, bookId: string, on: boolean): Promise<{ hiddenFrom: string[] }>;
  setKid(kidId: string, bookId: string, on: boolean): Promise<void>;
  kidShelf(kidId: string): Promise<{ familyId: string | null; items: ApprovedItem[] }>;
}

const enc = encodeURIComponent;

const httpApprovedApi: ApprovedApi = {
  approvals: (bookId) => request(`/api/books/${enc(bookId)}/approvals`),
  setFamily: async (familyId, bookId, on) => {
    const res = await request<{ hiddenFrom?: string[] }>(`/api/families/${enc(familyId)}/approved/${enc(bookId)}`, { method: on ? "PUT" : "DELETE" });
    return { hiddenFrom: res?.hiddenFrom ?? [] };
  },
  setKid: async (kidId, bookId, on) => {
    await request(`/api/shelves/kids/${enc(kidId)}/books/${enc(bookId)}`, on ? { method: "PUT", body: JSON.stringify({}) } : { method: "DELETE" });
  },
  kidShelf: (kidId) =>
    request<{ kid: { familyId: string | null }; items: ApprovedItem[] }>(`/api/shelves/kids/${enc(kidId)}`).then((r) => ({
      familyId: r.kid.familyId,
      items: r.items,
    })),
};

/** Demo mode: Mia and Theo in "The Bandits", nothing saved. */
function demoApprovedApi(): ApprovedApi {
  const family = new Set<string>(["b1"]);
  const perKid = new Map<string, Set<string>>([["u-kid", new Set(["b3"])]]);
  const kids = [
    { id: "u-kid", displayName: "Mia", avatar: "🦖", maxKids: true },
    { id: "u-kid2", displayName: "Theo", avatar: "🚀", maxKids: false },
  ];
  const wait = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 120));
  const titles: Record<string, string> = { b1: "The Dinosaur Who Loved Books", b3: "Barnaby and the Missing Page" };
  return {
    approvals: (bookId) =>
      wait({
        family: { id: "f-home", name: "The Bandits", approved: family.has(bookId) },
        kids: kids.map((k) => ({ id: k.id, displayName: k.displayName, avatar: k.avatar, approved: !!perKid.get(k.id)?.has(bookId), canSee: true })),
      }),
    async setFamily(_f, bookId, on) {
      if (on) family.add(bookId);
      else family.delete(bookId);
      return wait({ hiddenFrom: [] });
    },
    async setKid(kidId, bookId, on) {
      const s = perKid.get(kidId) ?? new Set<string>();
      if (on) s.add(bookId);
      else s.delete(bookId);
      perKid.set(kidId, s);
      await wait(null);
    },
    kidShelf: (kidId) =>
      wait({
        familyId: "f-home",
        items: [
          ...[...(perKid.get(kidId) ?? [])].map((id) => ({ book: { id, title: titles[id] ?? id, coverPath: null }, familyPick: false, addedAt: Date.now() - 86_400_000 })),
          ...[...family].map((id) => ({ book: { id, title: titles[id] ?? id, coverPath: null }, familyPick: true, addedAt: Date.now() - 3 * 86_400_000 })),
        ],
      }),
  };
}

export const approvedApi: ApprovedApi = isDemo ? demoApprovedApi() : httpApprovedApi;

/** Book page panel for parents and admins: approve this book for the family or for each kid. */
export function ApproveForKids({ bookId }: { bookId: string }) {
  const data = useLoad(() => approvedApi.approvals(bookId), [bookId]);
  const action = useAction();
  const [note, setNote] = useState<string | null>(null);
  const a = data.data;
  if (!a?.family) return null;
  const fam = a.family;

  const toggleFamily = () =>
    action.run(async () => {
      const { hiddenFrom } = await approvedApi.setFamily(fam.id, bookId, !fam.approved);
      setNote(!fam.approved && hiddenFrom.length ? `${hiddenFrom.join(" and ")} won't see it yet: it's above their age group.` : null);
      data.reload();
    });
  const toggleKid = (kidId: string, on: boolean) =>
    action.run(async () => {
      setNote(null);
      await approvedApi.setKid(kidId, bookId, on);
      data.reload();
    });

  return (
    <section className="bb-approve" aria-labelledby="bb-approve-title">
      <h2 id="bb-approve-title" className="bb-approve-title">
        <span aria-hidden>👍</span> Parent approved
      </h2>
      <p className="bb-muted bb-small">Approved books show up first on a kid's home, in their Parent approved row.</p>
      <div className="bb-chips">
        <button type="button" className="bb-chip" aria-pressed={fam.approved} disabled={action.busy} onClick={toggleFamily}>
          {fam.approved ? "✓ " : ""}Every kid in {fam.name}
        </button>
        {a.kids.map((k) => {
          const on = k.approved || fam.approved;
          return (
            <button
              key={k.id}
              type="button"
              className="bb-chip"
              aria-pressed={on}
              disabled={action.busy || !k.canSee || fam.approved}
              title={!k.canSee ? `Above ${k.displayName}'s age group` : fam.approved ? "Approved for the whole family" : undefined}
              onClick={() => toggleKid(k.id, !k.approved)}
            >
              {k.avatar ? `${k.avatar} ` : ""}
              {on && k.canSee ? "✓ " : ""}
              {k.displayName}
              {!k.canSee ? " (too young)" : ""}
            </button>
          );
        })}
      </div>
      {note && <p className="bb-muted bb-small">{note}</p>}
      <ErrorNote error={action.error ?? data.error} />
    </section>
  );
}

/** Family dashboard card: what's on a kid's Parent approved row. */
export function ApprovedCard({ kidId, kidName }: { kidId: string; kidName: string }) {
  const data = useLoad(() => approvedApi.kidShelf(kidId), [kidId]);
  const action = useAction();
  const items = data.data?.items ?? [];
  const familyId = data.data?.familyId ?? null;
  const remove = (it: ApprovedItem) =>
    action.run(async () => {
      if (it.familyPick && familyId) await approvedApi.setFamily(familyId, it.book.id, false);
      else await approvedApi.setKid(kidId, it.book.id, false);
      data.reload();
    });
  return (
    <Card title="👍 Parent approved" className="bb-approved-card">
      <p className="bb-muted bb-small">
        Books you picked for {kidName} or for the whole family, first on {kidName}'s home. Approve more from any book's page.
      </p>
      <ErrorNote error={data.error ?? action.error} />
      {data.data && items.length === 0 && <p className="bb-muted">Nothing yet.</p>}
      <ul className="bb-approved-list">
        {items.map((it) => (
          <li key={it.book.id} className="bb-approved-item">
            <Cover src={adminApi.coverUrl({ id: it.book.id, coverPath: it.book.coverPath })} title={it.book.title} size={40} />
            <div className="bb-person-main">
              <Link className="bb-link" to={`/book/${it.book.id}`}>
                {it.book.title}
              </Link>
              <div className="bb-muted bb-small">{it.familyPick ? "For the whole family" : `Just for ${kidName}`}</div>
            </div>
            <button className="bb-btn bb-btn-ghost" disabled={action.busy} onClick={() => remove(it)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
