import { describe, expect, it } from "vitest";
import { SIGN_IN_PICTURES } from "@bookbandit/shared";
import { PICTURE_EMOJI } from "./api";

describe("sign-in pictures", () => {
  it("draws every picture the server accepts", () => {
    for (const p of SIGN_IN_PICTURES) expect(PICTURE_EMOJI[p]?.emoji).toBeTruthy();
    expect(Object.keys(PICTURE_EMOJI).sort()).toEqual([...SIGN_IN_PICTURES].sort());
  });
});
