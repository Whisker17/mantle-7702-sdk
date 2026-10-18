import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@mantle-aa/sponsor", () => {
  it("exposes its entry point", () => {
    expect(PACKAGE_NAME).toBe("@mantle-aa/sponsor");
  });
});
