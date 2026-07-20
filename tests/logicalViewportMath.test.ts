import { describe, expect, it } from "vitest";
import {
  MAX_SPACER_HEIGHT_PX,
  clampGoToOffset,
  computeNeighborWindowStarts,
  computeVisibleRange,
  computeWindowStart,
  createScrollGeometry,
  logicalToVisual,
  normalizeWheelDelta,
  visualToLogical
} from "../src/core/logicalViewportMath";

describe("logical viewport math", () => {
  it.each([
    100_000_000,
    200_000_000,
    300_000_000
  ])("maps %,d vectors into one bounded scrollbar", totalVectors => {
    const geometry = createScrollGeometry({
      totalVectors,
      rowHeight: 28,
      bodyHeight: 560,
      outerViewportHeight: 640
    });

    expect(geometry.spacerHeight).toBe(
      MAX_SPACER_HEIGHT_PX
    );
    expect(geometry.maxLogicalOffset).toBe(
      totalVectors * 28 - 560
    );

    for (const logicalOffset of [
      0,
      geometry.maxLogicalOffset * 0.25,
      geometry.maxLogicalOffset * 0.5,
      geometry.maxLogicalOffset
    ]) {
      const roundTrip = visualToLogical(
        logicalToVisual(logicalOffset, geometry),
        geometry
      );

      expect(roundTrip).toBeCloseTo(logicalOffset, 5);
    }
  });

  it("keeps the final vector fully reachable", () => {
    const totalVectors = 300_000_000;
    const geometry = createScrollGeometry({
      totalVectors,
      rowHeight: 28,
      bodyHeight: 560,
      outerViewportHeight: 640
    });
    const visible = computeVisibleRange(
      geometry.maxLogicalOffset,
      geometry
    );

    expect(visible.start).toBe(totalVectors - 20);
    expect(visible.end).toBe(totalVectors - 1);
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
      computeWindowStart({
        firstVisibleRow: 0,
        totalVectors: 100_000_000,
        windowSize: 1_000,
        windowShift: 500,
        guardRows: 150
      })
    ).toBe(0);
    expect(
      computeWindowStart({
        firstVisibleRow: 650,
        totalVectors: 100_000_000,
        windowSize: 1_000,
        windowShift: 500,
        guardRows: 150
      })
    ).toBe(500);
    expect(
      computeWindowStart({
        firstVisibleRow: 99_999_999,
        totalVectors: 100_000_000,
        windowSize: 1_000,
        windowShift: 500,
        guardRows: 150
      })
    ).toBe(99_999_000);
    expect(
      computeNeighborWindowStarts({
        currentWindowStart: 99_999_000,
        totalVectors: 100_000_000,
        windowSize: 1_000,
        windowShift: 500
      })
    ).toEqual([99_999_000, 99_998_500]);
  });

  it("clamps Go To Offset to the document", () => {
    expect(clampGoToOffset(-10, 100)).toBe(0);
    expect(clampGoToOffset(40, 100)).toBe(40);
    expect(clampGoToOffset(1000, 100)).toBe(99);
  });
});
