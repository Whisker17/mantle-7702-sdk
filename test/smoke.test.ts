import { describe, expect, it } from "vitest";

describe("toolchain", () => {
  it("runs on the pinned Node major", () => {
    const major = Number(process.versions.node.split(".")[0]);
    expect(major).toBe(24);
  });
});
