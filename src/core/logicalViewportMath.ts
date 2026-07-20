/**
 * 阅读等级：B 接口必读
 * 是否迁移：是
 * 前置阅读：shared/protocol.ts
 * 建议只关注：createScrollGeometry、logicalToVisual、computeWindowStart
 * 可以跳过：基础 clamp 函数
 *
 * 这里全部是无副作用计算。把“亿级逻辑像素”和“浏览器可承受的滚动像素”
 * 分开后，DOM、VTable 和后端都不需要知道总数据对应几十亿像素。
 */

export const MAX_SPACER_HEIGHT_PX = 16_000_000;

export type ScrollGeometry = {
  totalVectors: number;
  rowHeight: number;
  bodyHeight: number;
  outerViewportHeight: number;
  maxLogicalOffset: number;
  spacerHeight: number;
  maxVisualOffset: number;
};

export type VisibleRange = {
  start: number;
  end: number;
};

export function createScrollGeometry(options: {
  totalVectors: number;
  rowHeight: number;
  bodyHeight: number;
  outerViewportHeight: number;
}): ScrollGeometry {
  const totalVectors = Math.max(0, Math.trunc(options.totalVectors));
  const rowHeight = Math.max(1, options.rowHeight);
  const bodyHeight = Math.max(1, options.bodyHeight);
  const outerViewportHeight = Math.max(1, options.outerViewportHeight);
  const maxLogicalOffset = Math.max(
    0,
    totalVectors * rowHeight - bodyHeight
  );
  const spacerHeight =
    maxLogicalOffset === 0
      ? outerViewportHeight
      : Math.min(
          MAX_SPACER_HEIGHT_PX,
          outerViewportHeight + maxLogicalOffset
        );

  return {
    totalVectors,
    rowHeight,
    bodyHeight,
    outerViewportHeight,
    maxLogicalOffset,
    spacerHeight,
    maxVisualOffset: Math.max(0, spacerHeight - outerViewportHeight)
  };
}

export function logicalToVisual(
  logicalOffset: number,
  geometry: ScrollGeometry
): number {
  if (
    geometry.maxLogicalOffset <= 0 ||
    geometry.maxVisualOffset <= 0
  ) {
    return 0;
  }

  const safeLogicalOffset = clampNumber(
    logicalOffset,
    0,
    geometry.maxLogicalOffset
  );

  return (
    (safeLogicalOffset / geometry.maxLogicalOffset) *
    geometry.maxVisualOffset
  );
}

export function visualToLogical(
  visualOffset: number,
  geometry: ScrollGeometry
): number {
  if (
    geometry.maxLogicalOffset <= 0 ||
    geometry.maxVisualOffset <= 0
  ) {
    return 0;
  }

  const safeVisualOffset = clampNumber(
    visualOffset,
    0,
    geometry.maxVisualOffset
  );

  return (
    (safeVisualOffset / geometry.maxVisualOffset) *
    geometry.maxLogicalOffset
  );
}

export function computeVisibleRange(
  logicalOffset: number,
  geometry: Pick<
    ScrollGeometry,
    "totalVectors" | "rowHeight" | "bodyHeight" | "maxLogicalOffset"
  >
): VisibleRange {
  if (geometry.totalVectors <= 0) {
    return { start: 0, end: 0 };
  }

  const safeOffset = clampNumber(
    logicalOffset,
    0,
    geometry.maxLogicalOffset
  );
  const start = clampInteger(
    Math.floor(safeOffset / geometry.rowHeight),
    0,
    geometry.totalVectors - 1
  );
  const end = clampInteger(
    Math.ceil(
      (safeOffset + geometry.bodyHeight) / geometry.rowHeight
    ) - 1,
    start,
    geometry.totalVectors - 1
  );

  return { start, end };
}

/**
 * 窗口在首可见行之前保留 guardRows，并按 windowShift 对齐。
 * 这让切窗发生在用户到达边缘前，同时保证任意时刻只需要相邻三窗。
 */
export function computeWindowStart(options: {
  firstVisibleRow: number;
  totalVectors: number;
  windowSize: number;
  windowShift: number;
  guardRows: number;
}): number {
  const totalVectors = Math.max(0, Math.trunc(options.totalVectors));
  const windowSize = Math.max(1, Math.trunc(options.windowSize));

  if (totalVectors <= windowSize) {
    return 0;
  }

  const maxWindowStart = totalVectors - windowSize;
  const windowShift = Math.max(1, Math.trunc(options.windowShift));
  const desiredStart = Math.max(
    0,
    Math.trunc(options.firstVisibleRow) -
      Math.max(0, Math.trunc(options.guardRows))
  );
  const alignedStart =
    Math.floor(desiredStart / windowShift) * windowShift;

  return clampInteger(alignedStart, 0, maxWindowStart);
}

export function computeNeighborWindowStarts(options: {
  currentWindowStart: number;
  totalVectors: number;
  windowSize: number;
  windowShift: number;
}): number[] {
  const maxWindowStart = Math.max(
    0,
    Math.trunc(options.totalVectors) -
      Math.max(1, Math.trunc(options.windowSize))
  );
  const current = clampInteger(
    options.currentWindowStart,
    0,
    maxWindowStart
  );
  const shift = Math.max(1, Math.trunc(options.windowShift));
  const starts = new Set<number>([current]);

  if (current > 0) {
    starts.add(Math.max(0, current - shift));
  }

  if (current < maxWindowStart) {
    starts.add(Math.min(maxWindowStart, current + shift));
  }

  return [...starts];
}

export function clampGoToOffset(
  offset: number,
  totalVectors: number
): number {
  if (totalVectors <= 0) {
    return 0;
  }

  return clampInteger(offset, 0, totalVectors - 1);
}

export function normalizeWheelDelta(
  event: Pick<WheelEvent, "deltaY" | "deltaMode">,
  rowHeight: number,
  bodyHeight: number
): number {
  switch (event.deltaMode) {
    case 1:
      return event.deltaY * rowHeight;
    case 2:
      return event.deltaY * bodyHeight;
    default:
      return event.deltaY;
  }
}

export function clampNumber(
  value: number,
  min: number,
  max: number
): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

export function clampInteger(
  value: number,
  min: number,
  max: number
): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}
