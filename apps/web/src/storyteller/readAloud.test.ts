import { describe, expect, it } from "vitest";
import { ssmlToText } from "./readAloud";

describe("ssmlToText", () => {
  it("keeps the words and drops the marks", () => {
    const ssml =
      '<speak xmlns="http://www.w3.org/2001/10/synthesis"><mark name="0"/>The fox  yawned.<mark name="1"/> Goodnight, <emphasis>moon</emphasis>!</speak>';
    expect(ssmlToText(ssml)).toBe("The fox yawned. Goodnight, moon!");
  });
});
