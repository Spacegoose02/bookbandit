/**
 * Sign-in rules the web and tablet apps need too (picture alphabet, PIN shape).
 * The server is the only place secrets are checked.
 */

/** Pictures a young kid picks from, in order, to sign in. Ids are stable; the apps map them to art. */
export const SIGN_IN_PICTURES = [
  "cat",
  "dog",
  "fox",
  "owl",
  "frog",
  "fish",
  "bear",
  "bee",
  "star",
] as const;
export type SignInPicture = (typeof SIGN_IN_PICTURES)[number];

export const PIN_LENGTH = { min: 4, max: 6 } as const;
export const PICTURE_SEQUENCE_LENGTH = { min: 3, max: 5 } as const;
export const PASSWORD_MIN_LENGTH = 8;

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH.min},${PIN_LENGTH.max}}$`).test(pin);
}

export function isValidPictureSequence(seq: readonly string[]): seq is SignInPicture[] {
  return (
    seq.length >= PICTURE_SEQUENCE_LENGTH.min &&
    seq.length <= PICTURE_SEQUENCE_LENGTH.max &&
    seq.every((p) => (SIGN_IN_PICTURES as readonly string[]).includes(p))
  );
}

/** How a profile signs in, as the profile picker shows it. */
export type ProfileSignIn = "pin" | "picture" | "password" | "google" | "none";
