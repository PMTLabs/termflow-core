import { test, expect } from "bun:test";

// Sanity check that the `bun test` harness runs. Real suites live alongside
// in this directory (see *.test.ts).
test("test harness runs", () => {
    expect(1 + 1).toBe(2);
});
