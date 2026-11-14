export const ROLES = ["admin", "parent", "adult", "kid"] as const;
export type Role = (typeof ROLES)[number];

export const KID_SIGN_IN_METHODS = ["google", "pin", "picture"] as const;
export type KidSignInMethod = (typeof KID_SIGN_IN_METHODS)[number];

export function isAdminRole(role: Role): boolean {
  return role === "admin";
}

export function canManageKids(role: Role): boolean {
  return role === "admin" || role === "parent";
}
