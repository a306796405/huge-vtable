/**
 * 阅读等级：B 接口必读
 * 是否迁移：是
 * 前置阅读：shared/protocol.ts
 * 建议只关注：createScrollGeometry、logicalToScrollbarScrollTop、computeWindowStartVectorIndex
 * 可以跳过：基础 clamp 函数
 *
 * 这里全部是无副作用计算。把“亿级逻辑像素”和“浏览器可承受的滚动像素”
 * 分开后，DOM、VTable 和后端都不需要知道总数据对应几十亿像素。
 */

export const MAX_SPACER_HEIGHT_PX = 16_000_000;

export type ScrollGeometry = {
  totalVectors: number;
  rowHeightPx: number;
  bodyViewportHeightPx: number;
  scrollbarViewportHeightPx: number;
  maxLogicalScrollTopPx: number;
  spacerHeightPx: number;
  maxScrollbarScrollTopPx: number;
};

export type VisibleRange = {
  startVectorIndex: number;
  endVectorIndex: number;
};

export function createScrollGeometry(options: {
  totalVectors: number;
  rowHeightPx: number;
  bodyViewportHeightPx: number;
  scrollbarViewportHeightPx: number;
}): ScrollGeometry {
  const totalVectors = Math.max(0, Math.trunc(options.totalVectors));
  const rowHeightPx = Math.max(1, options.rowHeightPx);
  const bodyViewportHeightPx = Math.max(
    1,
    options.bodyViewportHeightPx
  );
  const scrollbarViewportHeightPx = Math.max(
    1,
    options.scrollbarViewportHeightPx
  );
  const maxLogicalScrollTopPx = Math.max(
    0,
    totalVectors * rowHeightPx - bodyViewportHeightPx
  );
  const spacerHeightPx =
    maxLogicalScrollTopPx === 0
      ? scrollbarViewportHeightPx
      : Math.min(
          MAX_SPACER_HEIGHT_PX,
          scrollbarViewportHeightPx + maxLogicalScrollTopPx
        );

  return {
    totalVectors,
    rowHeightPx,
    bodyViewportHeightPx,
    scrollbarViewportHeightPx,
    maxLogicalScrollTopPx,
    spacerHeightPx,
    maxScrollbarScrollTopPx: Math.max(
      0,
      spacerHeightPx - scrollbarViewportHeightPx
    )
  };
}

export function logicalToScrollbarScrollTop(
  logicalScrollTopPx: number,
  geometry: ScrollGeometry
): number {
  if (
    geometry.maxLogicalScrollTopPx <= 0 ||
    geometry.maxScrollbarScrollTopPx <= 0
  ) {
    return 0;
  }

  const safeLogicalScrollTopPx = clampNumber(
    logicalScrollTopPx,
    0,
    geometry.maxLogicalScrollTopPx
  );

  return (
    (safeLogicalScrollTopPx / geometry.maxLogicalScrollTopPx) *
    geometry.maxScrollbarScrollTopPx
  );
}

export function scrollbarToLogicalScrollTop(
  scrollbarScrollTopPx: number,
  geometry: ScrollGeometry
): number {
  if (
    geometry.maxLogicalScrollTopPx <= 0 ||
    geometry.maxScrollbarScrollTopPx <= 0
  ) {
    return 0;
  }

  const safeScrollbarScrollTopPx = clampNumber(
    scrollbarScrollTopPx,
    0,
    geometry.maxScrollbarScrollTopPx
  );

  return (
    (safeScrollbarScrollTopPx /
      geometry.maxScrollbarScrollTopPx) *
    geometry.maxLogicalScrollTopPx
  );
}

export function computeVisibleRange(
  logicalScrollTopPx: number,
  geometry: Pick<
    ScrollGeometry,
    | "totalVectors"
    | "rowHeightPx"
    | "bodyViewportHeightPx"
    | "maxLogicalScrollTopPx"
  >
): VisibleRange {
  if (geometry.totalVectors <= 0) {
    return { startVectorIndex: 0, endVectorIndex: 0 };
  }

  const safeLogicalScrollTopPx = clampNumber(
    logicalScrollTopPx,
    0,
    geometry.maxLogicalScrollTopPx
  );
  const startVectorIndex = clampInteger(
    Math.floor(
      safeLogicalScrollTopPx / geometry.rowHeightPx
    ),
    0,
    geometry.totalVectors - 1
  );
  const endVectorIndex = clampInteger(
    Math.ceil(
      (safeLogicalScrollTopPx +
        geometry.bodyViewportHeightPx) /
        geometry.rowHeightPx
    ) - 1,
    startVectorIndex,
    geometry.totalVectors - 1
  );

  return { startVectorIndex, endVectorIndex };
}

/**
 * 窗口在首可见行之前保留 guardRows，并按 windowShift 对齐。
 * 这让切窗发生在用户到达边缘前，同时保证任意时刻只需要相邻三窗。
 */
export function computeWindowStartVectorIndex(options: {
  firstVisibleVectorIndex: number;
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
    Math.trunc(options.firstVisibleVectorIndex) -
      Math.max(0, Math.trunc(options.guardRows))
  );
  const alignedStart =
    Math.floor(desiredStart / windowShift) * windowShift;

  return clampInteger(alignedStart, 0, maxWindowStart);
}

export function computeNeighborWindowStartVectorIndexes(options: {
  currentWindowStartVectorIndex: number;
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
    options.currentWindowStartVectorIndex,
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

export function clampGoToVectorIndex(
  vectorIndex: number,
  totalVectors: number
): number {
  if (totalVectors <= 0) {
    return 0;
  }

  return clampInteger(vectorIndex, 0, totalVectors - 1);
}

export function normalizeWheelDelta(
  event: Pick<WheelEvent, "deltaY" | "deltaMode">,
  rowHeightPx: number,
  bodyViewportHeightPx: number
): number {
  switch (event.deltaMode) {
    case 1:
      return event.deltaY * rowHeightPx;
    case 2:
      return event.deltaY * bodyViewportHeightPx;
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
