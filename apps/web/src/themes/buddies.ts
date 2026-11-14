/**
 * Buddies: the picture (an emoji) that stands for a person in the top bar, on "Who's reading?",
 * and on the kid home. Everyone may change their own (`PATCH /api/users/me { avatar }`), kids
 * included: it isn't one of the limits only a parent can change.
 */
import { isDemo, request } from "../api/client";
import type { Theme } from "./themes";

export interface BuddyGroup {
  id: string;
  name: string;
  buddies: string[];
}

export const BUDDY_GROUPS: BuddyGroup[] = [
  { id: "animals", name: "Animals", buddies: ["🐶", "🐱", "🐰", "🦊", "🐼", "🐨", "🐸", "🐢", "🦉", "🐧", "🦔", "🐝"] },
  { id: "wild", name: "Wild ones", buddies: ["🦖", "🦕", "🐉", "🦁", "🐯", "🐘", "🦒", "🐙", "🦈", "🐳", "🦜", "🦋"] },
  { id: "magic", name: "Magic", buddies: ["🦄", "🧚", "🧙", "🧜", "👸", "🤴", "🌈", "⭐"] },
  { id: "go", name: "Things that go", buddies: ["🚀", "🛸", "🚜", "🚒", "🚂", "🏎️", "🚁", "⛵"] },
  { id: "fun", name: "Just for fun", buddies: ["🤖", "👽", "🎨", "⚽", "🎸", "🍕", "🌻", "🍦"] },
];

/** The buddies to offer first: the current theme's own, then the rest without repeats. */
export function buddyGroupsFor(theme: Theme): BuddyGroup[] {
  if (!theme.buddies?.length) return BUDDY_GROUPS;
  const themed: BuddyGroup = { id: "theme", name: `${theme.name} buddies`, buddies: theme.buddies };
  const taken = new Set(theme.buddies);
  const rest = BUDDY_GROUPS.map((g) => ({ ...g, buddies: g.buddies.filter((b) => !taken.has(b)) })).filter((g) => g.buddies.length);
  return [themed, ...rest];
}

export async function saveAvatar(meId: string, avatar: string | null): Promise<void> {
  if (isDemo) {
    try {
      localStorage.setItem(`bb-demo-avatar-${meId}`, avatar ?? "");
    } catch {
      /* ignore */
    }
    return;
  }
  await request("/api/users/me", { method: "PATCH", body: JSON.stringify({ avatar }) });
}
