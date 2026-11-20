import { describe, expect, it } from "vitest";
import { HARNESS_VERSION } from "../src/version.ts";

describe("scaffold", () => {
  it("has a version number", () => {
    expect(HARNESS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});