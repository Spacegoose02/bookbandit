/** Sign-in calls (server: apps/server/src/auth/routes.ts and routes/devices.ts). */
import type { ProfileSignIn, Role, SignInPicture } from "@bookbandit/shared";
import { request } from "../api/client";

export interface AuthStatus {
  setupRequired: boolean;
  signedIn: boolean;
  device: { id: string; name: string; lockedTo: string | null } | null;
  /** Set when the server knows the Tinyauth login page. */
  google: { url: string } | null;
  /** Signed in to Google through the proxy, but nobody here has that email yet. */
  unlinkedEmail: string | null;
  limits: {
    pin: { min: number; max: number };
    pictures: { min: number; max: number };
    passwordMin: number;
  };
}

export interface Profile {
  id: string;
  displayName: string;
  avatar: string | null;
  role: Role;
  signIn: ProfileSignIn;
}

export interface SetupInput {
  householdName: string;
  displayName: string;
  username: string;
  password: string;
  email?: string;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const authApi = {
  status: () => request<AuthStatus>("/api/auth/status"),
  setup: (input: SetupInput) => post("/api/auth/setup", input),
  login: (body: { username: string; password: string } | { userId: string; password: string }) => post("/api/auth/login", body),
  kidSignIn: (body: { userId: string; pin: string } | { userId: string; pictures: SignInPicture[] }) =>
    post("/api/auth/kid-sign-in", body),
  profiles: () => request<{ profiles: Profile[] }>("/api/auth/profiles").then((r) => r.profiles),
  signOut: () => post("/api/auth/sign-out", {}),
  claimDevice: (code: string, name?: string) => post("/api/devices/claim", { code, ...(name ? { name } : {}) }),
};

/** The emoji each sign-in picture is drawn with. Ids come from SIGN_IN_PICTURES in shared. */
export const PICTURE_EMOJI: Record<SignInPicture, { emoji: string; label: string }> = {
  cat: { emoji: "🐱", label: "Cat" },
  dog: { emoji: "🐶", label: "Dog" },
  fox: { emoji: "🦊", label: "Fox" },
  owl: { emoji: "🦉", label: "Owl" },
  frog: { emoji: "🐸", label: "Frog" },
  fish: { emoji: "🐟", label: "Fish" },
  bear: { emoji: "🐻", label: "Bear" },
  bee: { emoji: "🐝", label: "Bee" },
  star: { emoji: "⭐", label: "Star" },
};

/** Go to the app fresh so the session, theme and shelves all load for the new person. */
export function enterApp(path = "/"): void {
  window.location.assign(path);
}
