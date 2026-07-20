import { describe, expect, it } from "vitest";
import {
  SyntheticPatternBackend
} from "../src/dev-only/syntheticPatternBackend";

describe("SyntheticPatternBackend", () => {
  it.each([
    100_000_000,
    200_000_000,
    300_000_000
  ])("materializes only the requested window for %,d rows", async totalVectors => {
    const backend = new SyntheticPatternBackend({
      totalVectors
    });
    const result = await backend.getWindow({
      offset: totalVectors - 1_000,
      limit: 1_000,
      expectedRevision: 0
    });

    expect(result.totalVectors).toBe(totalVectors);
    expect(result.rows).toHaveLength(1_000);
    expect(result.rows[0].vectorNo).toBe(
      totalVectors - 1_000
    );
    expect(result.rows.at(-1)?.vectorNo).toBe(
      totalVectors - 1
    );
    expect(result.rows.at(-1)?.rowKey).toBe(
      `synthetic:${totalVectors - 1}`
    );
  });

  it("rejects a stale revision and oversized window", async () => {
    const backend = new SyntheticPatternBackend({
      totalVectors: 100_000_000
    });

    await expect(
      backend.getWindow({
        offset: 0,
        limit: 1_000,
        expectedRevision: 1
      })
    ).rejects.toThrow("REVISION_CONFLICT");
    await expect(
      backend.getWindow({
        offset: 0,
        limit: 1_001,
        expectedRevision: 0
      })
    ).rejects.toThrow("Window limit");
  });
});
