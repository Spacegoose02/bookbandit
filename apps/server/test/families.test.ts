import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bookRequests, families, parentLinks, userIdentities, users } from "../src/db/schema.js";
import { family, type Family } from "./helpers.js";

/**
 * Two families on one server: "Home" (Admin, Dad, Aunt, Emma) and "Cousins" (Leo, plus Uncle added
 * here as their parent). Parents run their own family; only the admin runs the server.
 */
let f: Family;
let uncle: string;

const call = (headers: Record<string, string>, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  f.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const asUncle = { "remote-email": "uncle@example.com" };

beforeEach(async () => {
  f = await family();
  const home = f.db.select().from(users).where(eq(users.id, f.ids.admin)).get()!.householdId;
  uncle = f.db.insert(users).values({ householdId: home, familyId: f.ids.cousins, displayName: "Uncle", role: "parent" }).returning().get().id;
  f.db.insert(userIdentities).values({ userId: uncle, provider: "tinyauth", subject: "uncle@example.com" }).run();
  f.db.insert(parentLinks).values({ parentId: uncle, kidId: f.ids.otherKid }).run();
});

afterEach(async () => {
  await f.close();
});

describe("families", () => {
  it("lets each family's parents manage their own kids and nobody else's", async () => {
    expect((await call(asUncle, "PATCH", `/api/users/${f.ids.otherKid}`, { birthYear: 2016 })).statusCode).toBe(200);
    expect((await call(asUncle, "PATCH", `/api/users/${f.ids.kid}`, { birthYear: 2010 })).statusCode).toBe(404);
    expect((await call(asUncle, "GET", `/api/users/${f.ids.kid}`)).statusCode).toBe(404);
    expect((await call(f.as("parent"), "PATCH", `/api/users/${f.ids.otherKid}`, { birthYear: 2010 })).statusCode).toBe(404);
    expect((await call(f.as("admin"), "PATCH", `/api/users/${f.ids.otherKid}`, { birthYear: 2015 })).statusCode).toBe(200);
  });

  it("makes a parent a parent of every kid in their family, linked or not", async () => {
    f.db.delete(parentLinks).where(eq(parentLinks.kidId, f.ids.otherKid)).run();
    expect((await call(asUncle, "PATCH", `/api/users/${f.ids.otherKid}`, { displayName: "Leo B" })).statusCode).toBe(200);
  });

  it("adds a parent's new kid to their own family, and only links parents from that family", async () => {
    const res = await call(asUncle, "POST", "/api/users", { displayName: "Mia", role: "kid", birthYear: 2019 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ familyId: f.ids.cousins, parentIds: [uncle] });
    expect((await call(asUncle, "POST", "/api/users", { displayName: "X", role: "kid", birthYear: 2019, familyId: f.ids.home })).statusCode).toBe(403);
    expect((await call(asUncle, "POST", `/api/users/${res.json().id}/parents`, { parentId: f.ids.parent })).statusCode).toBe(400);
  });

  it("keeps the people list and the family dashboard to your own family", async () => {
    const list = (await call(asUncle, "GET", "/api/users")).json();
    expect(list.users.map((u: { id: string }) => u.id).sort()).toEqual([uncle, f.ids.otherKid].sort());
    expect(list.household.map((u: { id: string }) => u.id).sort()).toEqual([uncle, f.ids.otherKid].sort());
    const dash = (await call(asUncle, "GET", "/api/family/kids")).json();
    expect(dash.kids.map((k: { id: string }) => k.id)).toEqual([f.ids.otherKid]);
    const admin = (await call(f.as("admin"), "GET", "/api/family/kids")).json();
    expect(admin.kids.map((k: { id: string }) => k.id).sort()).toEqual([f.ids.kid, f.ids.otherKid].sort());
    expect(admin.families.map((x: { name: string }) => x.name)).toEqual(["Cousins", "Home"]);
  });

  it("shows admins every family and who's waiting; parents only their own; kids nothing", async () => {
    const home = f.db.select().from(users).where(eq(users.id, f.ids.admin)).get()!.householdId;
    const waiting = f.db.insert(users).values({ householdId: home, displayName: "New person", role: "adult" }).returning().get().id;
    const admin = (await call(f.as("admin"), "GET", "/api/families")).json();
    expect(admin.families.map((x: { name: string }) => x.name)).toEqual(["Cousins", "Home"]);
    expect(admin.unassigned.map((u: { id: string }) => u.id)).toEqual([waiting]);
    const mine = (await call(asUncle, "GET", "/api/families")).json();
    expect(mine.families.map((x: { id: string }) => x.id)).toEqual([f.ids.cousins]);
    expect(mine.unassigned).toEqual([]);
    expect((await call(asUncle, "GET", `/api/families/${f.ids.home}`)).statusCode).toBe(404);
    expect((await call(f.as("kid"), "GET", "/api/families")).statusCode).toBe(403);
  });

  it("lets a parent rename their own family, but only the admin creates, moves and removes", async () => {
    expect((await call(asUncle, "PATCH", `/api/families/${f.ids.cousins}`, { name: "The Bandits" })).json().name).toBe("The Bandits");
    expect((await call(asUncle, "PATCH", `/api/families/${f.ids.home}`, { name: "Mine now" })).statusCode).toBe(404);
    expect((await call(f.as("adult"), "PATCH", `/api/families/${f.ids.home}`, { name: "Aunt's" })).statusCode).toBe(403);
    expect((await call(asUncle, "POST", "/api/families", { name: "Another" })).statusCode).toBe(403);
    expect((await call(asUncle, "PATCH", `/api/users/${uncle}`, { familyId: f.ids.home })).statusCode).toBe(403);
    expect((await call(asUncle, "PATCH", `/api/users/${f.ids.otherKid}`, { familyId: f.ids.home })).statusCode).toBe(403);

    const created = await call(f.as("admin"), "POST", "/api/families", { name: "Grandparents" });
    expect(created.statusCode).toBe(201);
    expect((await call(f.as("admin"), "DELETE", `/api/families/${f.ids.cousins}`)).statusCode).toBe(409);
    expect((await call(f.as("admin"), "DELETE", `/api/families/${created.json().id}`)).statusCode).toBe(200);
  });

  it("keeps parents out of server settings", async () => {
    for (const url of ["/api/admin/settings/sso", "/api/admin/backups", "/api/admin/inbox", "/api/admin/family-apps", "/api/admin/integrations/smtp", "/api/admin/ai/settings"]) {
      expect((await call(f.as("admin"), "GET", url)).statusCode, url).toBe(200);
      expect((await call(asUncle, "GET", url)).statusCode, url).toBe(403);
    }
  });

  it("moves people between families and drops parent links that would cross", async () => {
    // Leo can't move away from his only parent's family...
    expect((await call(f.as("admin"), "PATCH", `/api/users/${f.ids.otherKid}`, { familyId: f.ids.home })).statusCode).toBe(400);
    // ...but can once a Home parent is linked too; Uncle's link is dropped.
    f.db.insert(parentLinks).values({ parentId: f.ids.parent, kidId: f.ids.otherKid }).run();
    const moved = await call(f.as("admin"), "PATCH", `/api/users/${f.ids.otherKid}`, { familyId: f.ids.home });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().parentIds).toEqual([f.ids.parent]);
    // Dad can't leave Emma with no parent.
    expect((await call(f.as("admin"), "PATCH", `/api/users/${f.ids.parent}`, { familyId: f.ids.cousins })).statusCode).toBe(400);
    // A new SSO account with no family is placed by the admin.
    const home = f.db.select().from(users).where(eq(users.id, f.ids.admin)).get()!.householdId;
    const waiting = f.db.insert(users).values({ householdId: home, displayName: "Aunt Jo", role: "adult" }).returning().get().id;
    expect((await call(f.as("admin"), "PATCH", `/api/users/${waiting}`, { familyId: f.ids.cousins, role: "parent" })).json()).toMatchObject({
      familyId: f.ids.cousins,
      role: "parent",
    });
  });

  it("sends a kid's requests to their own family's parents", async () => {
    const r = f.db.insert(bookRequests).values({ requestedBy: f.ids.otherKid, title: "Dragons" }).returning().get();
    const uncleSees = (await call(asUncle, "GET", "/api/requests?scope=approvals")).json();
    expect(uncleSees.items.map((x: { id: string }) => x.id)).toEqual([r.id]);
    const dadSees = (await call(f.as("parent"), "GET", "/api/requests?scope=approvals")).json();
    expect(dadSees.items).toEqual([]);
    expect((await call(f.as("parent"), "POST", `/api/requests/${r.id}/approve`, {})).statusCode).toBe(404);
    expect((await call(asUncle, "POST", `/api/requests/${r.id}/approve`, {})).statusCode).toBe(200);
  });

  it("keeps a family's tablet to that family", async () => {
    const start = await call(asUncle, "POST", "/api/devices/pairings", { name: "Cousins tablet" });
    expect(start.statusCode).toBe(201);
    const claim = await f.app.inject({ method: "POST", url: "/api/devices/claim", payload: { code: start.json().code } });
    const token = { authorization: `Bearer ${claim.json().deviceToken}` };
    expect(claim.json().device.familyId).toBe(f.ids.cousins);
    const profiles = (await call(token, "GET", "/api/auth/profiles")).json().profiles.map((p: { id: string }) => p.id);
    expect(profiles.sort()).toEqual([uncle, f.ids.otherKid].sort());
    // Dad doesn't see the cousins' tablet; the admin does.
    expect((await call(f.as("parent"), "GET", "/api/devices")).json().devices).toEqual([]);
    expect((await call(f.as("admin"), "GET", "/api/devices")).json().devices).toHaveLength(1);
    // Emma can't sign in on it, even with the right PIN.
    await call(f.as("parent"), "PUT", `/api/users/${f.ids.kid}/secret`, { pin: "1234" });
    expect((await call(token, "POST", "/api/auth/kid-sign-in", { userId: f.ids.kid, pin: "1234" })).statusCode).toBe(401);
  });

  it("asks a parent with no family to wait for the admin", async () => {
    f.db.update(users).set({ familyId: null }).where(eq(users.id, uncle)).run();
    expect((await call(asUncle, "POST", "/api/users", { displayName: "Mia", role: "kid", birthYear: 2019 })).statusCode).toBe(403);
    expect((await call(asUncle, "PATCH", `/api/users/${f.ids.otherKid}`, { displayName: "L" })).statusCode).toBe(404);
    expect((await call(asUncle, "POST", "/api/devices/pairings", { name: "T" })).statusCode).toBe(403);
  });

  it("removing a family leaves nobody stranded", async () => {
    const empty = f.db.insert(families).values({ householdId: f.db.select().from(families).get()!.householdId, name: "Empty" }).returning().get();
    expect((await call(f.as("admin"), "DELETE", `/api/families/${empty.id}`)).statusCode).toBe(200);
    expect(f.db.select().from(families).where(eq(families.id, empty.id)).get()).toBeUndefined();
  });

  describe("parent approved", () => {
    const shelfOf = async (headers: Record<string, string>) => {
      const res = await call(headers, "GET", "/api/shelves");
      const kid = res.json().items.find((x: { kind: string }) => x.kind === "kid");
      return kid ? { name: kid.name as string, titles: (kid.books as { title: string }[]).map((b) => b.title).sort() } : null;
    };

    it("shows a book approved for the whole family to every kid in it, within each kid's limit", async () => {
      const picture = f.book("Picture Book", "kids");
      const teen = f.book("Teen Book", "teen");
      const home = await call(f.as("parent"), "PUT", `/api/families/${f.ids.home}/approved/${picture}`);
      expect(home.json()).toEqual({ ok: true, hiddenFrom: [] });
      const tooOld = await call(f.as("parent"), "PUT", `/api/families/${f.ids.home}/approved/${teen}`);
      expect(tooOld.json().hiddenFrom).toEqual(["Emma"]);

      expect(await shelfOf(f.as("kid"))).toEqual({ name: "Parent approved", titles: ["Picture Book"] });
      const paged = await call(f.as("kid"), "GET", "/api/books?shelf=kid");
      expect(paged.json().items.map((b: { title: string }) => b.title)).toEqual(["Picture Book"]);
      const kidView = await call(f.as("kid"), "GET", "/api/shelves/kids/me");
      expect(kidView.json().items.map((x: { book: { title: string }; familyPick: boolean }) => [x.book.title, x.familyPick])).toEqual([["Picture Book", true]]);
      // The cousins' family doesn't get the Home family's picks.
      const leo = await call(asUncle, "GET", `/api/shelves/kids/${f.ids.otherKid}`);
      expect(leo.json().items).toEqual([]);
    });

    it("mixes per-kid picks with family picks", async () => {
      const a = f.book("Just For Emma", "kids");
      const b = f.book("For Everyone", "kids");
      expect((await call(f.as("parent"), "PUT", `/api/shelves/kids/${f.ids.kid}/books/${a}`)).statusCode).toBe(204);
      await call(f.as("parent"), "PUT", `/api/families/${f.ids.home}/approved/${b}`);
      expect((await shelfOf(f.as("kid")))?.titles).toEqual(["For Everyone", "Just For Emma"]);
      await call(f.as("parent"), "DELETE", `/api/families/${f.ids.home}/approved/${b}`);
      expect((await shelfOf(f.as("kid")))?.titles).toEqual(["Just For Emma"]);
    });

    it("only lets that family's parents (or the admin) approve for it", async () => {
      const b = f.book("Picture Book", "kids");
      expect((await call(asUncle, "PUT", `/api/families/${f.ids.home}/approved/${b}`)).statusCode).toBe(404);
      expect((await call(f.as("adult"), "PUT", `/api/families/${f.ids.home}/approved/${b}`)).statusCode).toBe(403);
      expect((await call(f.as("kid"), "PUT", `/api/families/${f.ids.home}/approved/${b}`)).statusCode).toBe(403);
      expect((await call(f.as("admin"), "PUT", `/api/families/${f.ids.cousins}/approved/${b}`)).statusCode).toBe(200);
      const inbox = f.book("Not approved yet", "kids", { approved: false });
      expect((await call(f.as("admin"), "PUT", `/api/families/${f.ids.home}/approved/${inbox}`)).statusCode).toBe(422);
    });

    it("tells the book page who it's approved for", async () => {
      const b = f.book("Middle Grade", "middle_grade");
      await call(f.as("parent"), "PUT", `/api/families/${f.ids.home}/approved/${b}`);
      const res = (await call(f.as("parent"), "GET", `/api/books/${b}/approvals`)).json();
      expect(res.family).toMatchObject({ id: f.ids.home, approved: true });
      expect(res.kids).toEqual([expect.objectContaining({ id: f.ids.kid, approved: false, canSee: false })]);
      expect((await call(f.as("adult"), "GET", `/api/books/${b}/approvals`)).statusCode).toBe(403);
    });
  });
});
