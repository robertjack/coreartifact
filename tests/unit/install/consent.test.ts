// Unit coverage for src/install/consent.ts (docs/issues/ISS-0023.md
// "Test-harness contract": "The TTY ask is unit-covered through an
// injected tty/answer seam in tests/unit/install/consent.test.ts
// (default-no on empty answer, explicit yes, non-TTY auto-no)"). Never
// touches real process.stdin — only askConsent + a hand-rolled ConsentIO.
import { describe, it, expect } from "vitest";
import { askConsent, isYesAnswer, CONSENT_QUESTION, type ConsentIO } from "../../../src/install/consent.js";

function fakeIO(isTTY: boolean, answer: string): { io: ConsentIO; askedWith: string[] } {
  const askedWith: string[] = [];
  return {
    askedWith,
    io: {
      isTTY,
      ask: async (prompt) => {
        askedWith.push(prompt);
        return answer;
      },
    },
  };
}

describe("consent (askConsent)", () => {
  it("non-TTY: records no without ever asking (the fleet lane never blocks)", async () => {
    const { io, askedWith } = fakeIO(false, "yes");

    const consent = await askConsent(io);

    expect(consent).toBe(false);
    expect(askedWith).toHaveLength(0);
  });

  it("TTY, empty answer (bare Enter): default no", async () => {
    const { io } = fakeIO(true, "");

    expect(await askConsent(io)).toBe(false);
  });

  it("TTY, explicit yes: consent recorded", async () => {
    const { io, askedWith } = fakeIO(true, "yes");

    expect(await askConsent(io)).toBe(true);
    expect(askedWith[0]).toBe(CONSENT_QUESTION);
    expect(CONSENT_QUESTION).toMatch(/anonymous weekly ping/i);
    expect(CONSENT_QUESTION).toMatch(/version/i);
    expect(CONSENT_QUESTION).toMatch(/install id/i);
  });

  it("TTY, short-form 'y': consent recorded", async () => {
    const { io } = fakeIO(true, "y");
    expect(await askConsent(io)).toBe(true);
  });

  it("TTY, anything but an explicit yes/y: default no", async () => {
    for (const answer of ["no", "n", "sure", "YESSS", "  ", "maybe"]) {
      const { io } = fakeIO(true, answer);
      expect(await askConsent(io), `answer ${JSON.stringify(answer)} must record no`).toBe(false);
    }
  });

  it("isYesAnswer is case- and whitespace-tolerant for exactly y/yes", () => {
    expect(isYesAnswer("YES")).toBe(true);
    expect(isYesAnswer("  yes  ")).toBe(true);
    expect(isYesAnswer("Y")).toBe(true);
    expect(isYesAnswer("yep")).toBe(false);
    expect(isYesAnswer("")).toBe(false);
  });
});
