import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@0xwh1sker/mantle-aa-cli", () => {
  it("exposes its entry point", () => {
    expect(PACKAGE_NAME).toBe("@0xwh1sker/mantle-aa-cli");
  });
});
