import { describe, expect, it } from "vitest";
import { ReadWindowCache } from "../src/core/logicalViewport";
import type { PatternWindowResponse } from "../src/shared/protocol";

describe("ReadWindowCache", () => {
  it("deduplicates a pending request for the same revision and window start", async () => {
    const cache = new ReadWindowCache(3);
    let loadCount = 0;
    const key = "0:500";

    cache.retain([key]);
    const first = cache.request(key, async () => {
      loadCount += 1;
      return response(500);
    });
    const second = cache.request(key, async () => {
      loadCount += 1;
      return response(500);
    });

    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({
      startVectorIndex: 500
    });
    expect(loadCount).toBe(1);
  });

  it("enforces the three-window hard limit", async () => {
    const cache = new ReadWindowCache(3);
    const keys = ["0:0", "0:500", "0:1000"];

    cache.retain(keys);
    await Promise.all(
      keys.map((key, index) =>
        cache.request(key, async () => response(index * 500))
      )
    );

    expect(cache.size).toBe(3);

    const nextKeys = ["0:500", "0:1000", "0:1500"];
    cache.retain(nextKeys);
    await cache.request("0:1500", async () => response(1500));

    expect(cache.size).toBe(3);
    expect(cache.has("0:0")).toBe(false);
    expect(cache.has("0:1500")).toBe(true);
  });

  it("does not let an evicted late response re-enter the cache", async () => {
    const cache = new ReadWindowCache(1);
    let resolveOld!: (value: PatternWindowResponse) => void;
    const oldPromise = new Promise<PatternWindowResponse>(
      resolve => {
        resolveOld = resolve;
      }
    );

    cache.retain(["0:0"]);
    const oldRequest = cache.request("0:0", () => oldPromise);
    cache.retain(["0:500"]);
    await cache.request("0:500", async () => response(500));
    resolveOld(response(0));
    await oldRequest;

    expect(cache.size).toBe(1);
    expect(cache.has("0:0")).toBe(false);
    expect(cache.has("0:500")).toBe(true);
  });
});

function response(
  startVectorIndex: number
): PatternWindowResponse {
  return {
    startVectorIndex,
    totalVectors: 10_000,
    revision: 0,
    rows: []
  };
}
