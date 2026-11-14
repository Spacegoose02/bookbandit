/**
 * Linked family apps: Den Duty (chores) and Nighttime Ninja (kitchen).
 * Server side: apps/server/src/family-apps/. Same request helper and demo switch as the rest of the app.
 */
import { isDemo, request } from "../api/client";

const json = (body: unknown) => JSON.stringify(body);

export interface KidLinkRow {
  userId: string;
  kidId: string;
  habitId: string;
}

export interface FamilyAppsSettings {
  publicUrl: string | null;
  denDuty: { url: string; homeId: string; hasToken: boolean; enabled: boolean; kids: KidLinkRow[] } | null;
  kitchen: { url: string; homeId: string; hasToken: boolean } | null;
  /** BookBandit kids in this household. */
  kids: { id: string; displayName: string; avatar: string | null }[];
  lastReport: { at: number; ok: boolean; error?: string; sent: number } | null;
}

export interface DenDutyKids {
  home: { name: string; timezone: string; today: string };
  kids: { id: string; name: string; avatar: string | null; color: string | null; habits: { id: string; title: string; icon: string; minutes: number | null }[] }[];
  /** Den Duty is too old to list habits over its API. */
  habitsMissing: boolean;
}

export interface SentRecipe {
  id: string;
  url: string;
  title: string;
  ingredients: number;
  steps: number;
}

export interface RecipeBlock {
  type: "heading" | "text" | "item";
  text: string;
  list?: "ol" | "ul";
}

export interface FamilyAppsApi {
  settings(): Promise<FamilyAppsSettings>;
  saveDenDuty(body: { url: string; homeId: string; token?: string; enabled: boolean; kids: KidLinkRow[] }): Promise<unknown>;
  unlinkDenDuty(): Promise<unknown>;
  denDutyKids(): Promise<DenDutyKids>;
  reportNow(): Promise<{ ok: boolean; sent: number }>;
  saveKitchen(body: { url: string; homeId: string; token?: string }): Promise<unknown>;
  unlinkKitchen(): Promise<unknown>;
  checkKitchen(): Promise<{ ok: boolean }>;
  savePublicUrl(publicUrl: string | null): Promise<unknown>;
  linked(): Promise<{ kitchen: boolean; denDuty?: boolean }>;
  sendRecipe(body: { bookId: string; title: string; href?: string; blocks: RecipeBlock[] }): Promise<SentRecipe>;
}

const httpFamilyApps: FamilyAppsApi = {
  settings: () => request("/api/admin/family-apps"),
  saveDenDuty: (body) => request("/api/admin/family-apps/den-duty", { method: "PUT", body: json(body) }),
  unlinkDenDuty: () => request("/api/admin/family-apps/den-duty", { method: "DELETE" }),
  denDutyKids: () => request("/api/admin/family-apps/den-duty/kids"),
  reportNow: () => request("/api/admin/family-apps/den-duty/report", { method: "POST" }),
  saveKitchen: (body) => request("/api/admin/family-apps/kitchen", { method: "PUT", body: json(body) }),
  unlinkKitchen: () => request("/api/admin/family-apps/kitchen", { method: "DELETE" }),
  checkKitchen: () => request("/api/admin/family-apps/kitchen/check", { method: "POST" }),
  savePublicUrl: (publicUrl) => request("/api/admin/family-apps/public-url", { method: "PUT", body: json({ publicUrl }) }),
  linked: () => request("/api/family-apps"),
  sendRecipe: (body) => request("/api/family-apps/kitchen/recipes", { method: "POST", body: json(body) }),
};

/** Demo: both apps linked, Emma matched to her Reading habit. */
const demoState: FamilyAppsSettings = {
  publicUrl: null,
  denDuty: { url: "http://192.168.1.20:8090", homeId: "den-home", hasToken: true, enabled: true, kids: [{ userId: "kid-1", kidId: "dd-emma", habitId: "hab-read" }] },
  kitchen: { url: "http://192.168.1.20:8080", homeId: "kitchen-home", hasToken: true },
  kids: [
    { id: "kid-1", displayName: "Emma", avatar: null },
    { id: "kid-2", displayName: "Leo", avatar: null },
  ],
  lastReport: { at: Date.now() - 3 * 60_000, ok: true, sent: 1 },
};
const wait = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 150));

const demoFamilyApps: FamilyAppsApi = {
  settings: () => wait(structuredClone(demoState)),
  saveDenDuty: async (b) => {
    demoState.denDuty = { url: b.url, homeId: b.homeId, hasToken: true, enabled: b.enabled, kids: b.kids };
    return wait(null);
  },
  unlinkDenDuty: async () => wait((demoState.denDuty = null)),
  denDutyKids: () =>
    wait({
      home: { name: "The Den", timezone: "America/New_York", today: new Date().toISOString().slice(0, 10) },
      kids: [
        { id: "dd-emma", name: "Emma", avatar: "fox", color: "#f97316", habits: [{ id: "hab-read", title: "Reading", icon: "📚", minutes: 20 }, { id: "hab-piano", title: "Piano", icon: "🎹", minutes: 15 }] },
        { id: "dd-leo", name: "Leo", avatar: "panda", color: "#22c55e", habits: [{ id: "hab-leo-read", title: "Reading time", icon: "📖", minutes: 15 }] },
      ],
      habitsMissing: false,
    }),
  reportNow: () => wait({ ok: true, sent: 2 }),
  saveKitchen: async (b) => wait((demoState.kitchen = { url: b.url, homeId: b.homeId, hasToken: true })),
  unlinkKitchen: async () => wait((demoState.kitchen = null)),
  checkKitchen: () => wait({ ok: true }),
  savePublicUrl: async (u) => wait((demoState.publicUrl = u)),
  linked: () => wait({ kitchen: true, denDuty: true }),
  sendRecipe: (b) => wait({ id: "demo", url: "#", title: b.title, ingredients: b.blocks.filter((x) => x.type === "item").length || 6, steps: 4 }),
};

export const familyAppsApi: FamilyAppsApi = isDemo ? demoFamilyApps : httpFamilyApps;
