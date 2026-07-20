import { describe, expect, it } from "vitest";
import {
  MAX_SPACER_HEIGHT_PX,
  clampGoToVectorIndex,
  computeNeighborWindowStartVectorIndexes,
  computeVisibleRange,
  computeWindowStartVectorIndex,
  createScrollGeometry,
  logicalToScrollbarScrollTop,
  normalizeWheelDelta,
  scrollbarToLogicalScrollTop
} from "../src/core/logicalViewportMath";

describe("logical viewport math", () => {
  it.each([
    100_000_000,
    200_000_000,
    300_000_000
  ])("maps %,d vectors into one bounded scrollbar", totalVectors => {
    const geometry = createScrollGeometry({
      totalVectors,
      rowHeightPx: 28,
      bodyViewportHeightPx: 560,
      scrollbarViewportHeightPx: 640
    });

    expect(geometry.spacerHeightPx).toBe(
      MAX_SPACER_HEIGHT_PX
    );
    expect(geometry.maxLogicalScrollTopPx).toBe(
      totalVectors * 28 - 560
    );

    for (const logicalScrollTopPx of [
      0,
      geometry.maxLogicalScrollTopPx * 0.25,
      geometry.maxLogicalScrollTopPx * 0.5,
      geometry.maxLogicalScrollTopPx
    ]) {
      const roundTrip = scrollbarToLogicalScrollTop(
        logicalToScrollbarScrollTop(
          logicalScrollTopPx,
          geometry
        ),
        geometry
      );

      expect(roundTrip).toBeCloseTo(
        logicalScrollTopPx,
        5
      );
    }
  });

  it("keeps the final vector fully reachable", () => {
    const totalVectors = 300_000_000;
    const geometry = createScrollGeometry({
      totalVectors,
      rowHeightPx: 28,
      bodyViewportHeightPx: 560,
      scrollbarViewportHeightPx: 640
    });
    const visible = computeVisibleRange(
      geometry.maxLogicalScrollTopPx,
      geometry
    );

    expect(visible.startVectorIndex).toBe(
      totalVectors - 20
    );
    expect(visible.endVectorIndex).toBe(
      totalVectors - 1
    );
  });

  it("moves wheel input in logical pixels instead of compressed pixels", () => {
    expect(
      normalizeWheelDelta(
        { deltaY: 3, deltaMode: 1 },
        28,
        560
      )
    ).toBe(84);
    expect(
      normalizeWheelDelta(
        { deltaY: 1, deltaMode: 2 },
        28,
        560
      )
    ).toBe(560);
    expect(
      normalizeWheelDelta(
        { deltaY: 120, deltaMode: 0 },
        28,
        560
      )
    ).toBe(120);
  });

  it("chooses aligned overlapping windows and trailing neighbors", () => {
    expect(
      computeWindowStartVectorIndex({
        firstVisibleVectorIndex: 0,
        totalVectors: 100_000_000,
        windowSize: 1_000,
        windowShift: 500,
        guardRows: 150
      })
    ).toBe(0);
    expect(
      computeWindowStartVectorIndex({
        firstVisibleVectorIndex: 650,
        totalVectors: 100_000_000,
        windowSize: 1_000,
        windowShift: 500,
        guardRows: 150
      })
    ).toBe(500);
    expect(
      computeWindowStartVectorIndex({
        firstVisibleVectorIndex: 99_999_999,
        totalVectors: 100_000_000,
        windowSize: 1_000,
        windowShift: 500,
        guardRows: 150
      })
    ).toBe(99_999_000);
    expect(
      computeNeighborWindowStartVectorIndexes({
        currentWindowStartVectorIndex: 99_999_000,
        totalVectors: 100_000_000,
        windowSize: 1_000,
        windowShift: 500
      })
    ).toEqual([99_999_000, 99_998_500]);
  });

  it("clamps Go To Offset to the document", () => {
    expect(clampGoToVectorIndex(-10, 100)).toBe(0);
    expect(clampGoToVectorIndex(40, 100)).toBe(40);
    expect(clampGoToVectorIndex(1000, 100)).toBe(99);
  });
});
