/**
 * 阅读等级：C 稳定核心
 * 是否迁移：是
 * 前置阅读：logicalViewportMath.ts、vtableAdapter.ts
 * 建议只关注：start、goToVectorIndex、refreshLayout、dispose
 * 可以跳过：滚动事件抑制、缓存淘汰和 rAF 合并
 *
 * 这个 controller 只做四件事：
 * 1. 在有限的原生 scrollbar 像素与真实逻辑位置之间映射；
 * 2. 请求前/当前/后三个小窗口；
 * 3. 只把当前窗口交给 VTable；
 * 4. 丢弃旧请求，并在新窗口成功前保留旧 Canvas。
 */

import {
  type PatternReadClient,
  type PatternWindowResponse
} from "../shared/protocol";
import type { PatternTableAdapter } from "./vtableAdapter";
import {
  clampGoToVectorIndex,
  clampNumber,
  computeNeighborWindowStartVectorIndexes,
  computeVisibleRange,
  computeWindowStartVectorIndex,
  createScrollGeometry,
  logicalToScrollbarScrollTop,
  normalizeWheelDelta,
  scrollbarToLogicalScrollTop,
  type ScrollGeometry
} from "./logicalViewportMath";

export const DEFAULT_VIEWPORT_CONFIG = Object.freeze({
  rowHeight: 28,
  windowSize: 1_000,
  windowShift: 500,
  guardRows: 150,
  cacheWindowLimit: 3
});

export type LogicalViewportState = {
  totalVectors: number;
  revision: number;
  logicalScrollTopPx: number;
  firstVisibleVectorIndex: number;
  lastVisibleVectorIndex: number;
  windowStartVectorIndex: number;
  windowEndVectorIndex: number;
  isLoading: boolean;
  cacheEntries: number;
  errorMessage: string | null;
};

export type LogicalViewportOptions = {
  client: PatternReadClient;
  table: PatternTableAdapter;
  scrollElement: HTMLDivElement;
  spacerElement: HTMLDivElement;
  interactionElement: HTMLDivElement;
  totalVectors: number;
  revision: number;
  rowHeight?: number;
  windowSize?: number;
  windowShift?: number;
  guardRows?: number;
  cacheWindowLimit?: number;
  onStateChange?(state: LogicalViewportState): void;
  onError?(error: unknown): void;
};

type CacheEntry = {
  promise: Promise<PatternWindowResponse>;
  response?: PatternWindowResponse;
  touchedAt: number;
};

/**
 * 独立导出是为了对 pending 去重和硬上限做单元测试；业务代码不需要直接使用。
 */
export class ReadWindowCache {
  private readonly entries = new Map<string, CacheEntry>();
  private retainedKeys = new Set<string>();
  private clock = 0;

  constructor(private readonly limit: number) {}

  retain(keys: Iterable<string>): void {
    this.retainedKeys = new Set(keys);

    for (const key of this.entries.keys()) {
      if (!this.retainedKeys.has(key)) {
        this.entries.delete(key);
      }
    }

    this.enforceLimit();
  }

  request(
    key: string,
    load: () => Promise<PatternWindowResponse>
  ): Promise<PatternWindowResponse> {
    const cached = this.entries.get(key);

    if (cached) {
      cached.touchedAt = ++this.clock;
      return cached.promise;
    }

    const entry: CacheEntry = {
      touchedAt: ++this.clock,
      promise: Promise.resolve().then(load)
    };

    entry.promise = entry.promise
      .then(response => {
        if (this.entries.get(key) === entry) {
          entry.response = response;
        }

        return response;
      })
      .catch(error => {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
        }

        throw error;
      });

    this.entries.set(key, entry);
    this.enforceLimit();

    return entry.promise;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  clear(): void {
    this.entries.clear();
    this.retainedKeys.clear();
  }

  private enforceLimit(): void {
    const safeLimit = Math.max(1, this.limit);

    while (this.entries.size > safeLimit) {
      const removable = [...this.entries.entries()]
        .filter(([key]) => !this.retainedKeys.has(key))
        .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];

      if (!removable) {
        /*
         * retainedKeys 本身由前/当前/后三窗生成，正常不会超过 limit。
         * 如果调用方传错，仍淘汰最早条目，保证硬上限优先成立。
         */
        const oldest = [...this.entries.entries()].sort(
          (left, right) =>
            left[1].touchedAt - right[1].touchedAt
        )[0];

        if (!oldest) {
          return;
        }

        this.entries.delete(oldest[0]);
        continue;
      }

      this.entries.delete(removable[0]);
    }
  }
}

export class LogicalViewport {
  private readonly rowHeightPx: number;
  private readonly windowSize: number;
  private readonly windowShift: number;
  private readonly guardRows: number;
  private readonly cache: ReadWindowCache;
  private geometry: ScrollGeometry;
  private logicalScrollTopPx = 0;
  private currentWindowStartVectorIndex = -1;
  private currentWindowLength = 0;
  private currentRenderStartVectorIndex = -1;
  private currentRenderHeightPx = 0;
  private isLoading = false;
  private errorMessage: string | null = null;
  private disposed = false;
  private activeSwitchId = 0;
  private syncRafId = 0;
  private stateRafId = 0;
  private resizeRafId = 0;
  private expectedScrollbarScrollTopPx: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly options: LogicalViewportOptions) {
    this.rowHeightPx =
      options.rowHeight ?? DEFAULT_VIEWPORT_CONFIG.rowHeight;
    this.windowSize =
      options.windowSize ?? DEFAULT_VIEWPORT_CONFIG.windowSize;
    this.windowShift =
      options.windowShift ?? DEFAULT_VIEWPORT_CONFIG.windowShift;
    this.guardRows =
      options.guardRows ?? DEFAULT_VIEWPORT_CONFIG.guardRows;
    this.cache = new ReadWindowCache(
      options.cacheWindowLimit ??
        DEFAULT_VIEWPORT_CONFIG.cacheWindowLimit
    );
    this.geometry = this.measureGeometry();
  }

  async start(): Promise<void> {
    this.bindEvents();
    this.updateSpacer();
    await this.syncNow();
  }

  async goToVectorIndex(vectorIndex: number): Promise<void> {
    const targetVectorIndex = clampGoToVectorIndex(
      vectorIndex,
      this.options.totalVectors
    );

    this.setLogicalScrollTopPx(
      targetVectorIndex * this.rowHeightPx,
      true
    );
    await this.syncNow();
  }

  async refreshLayout(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.options.table.resize();
    await this.options.table.whenLayoutReady();

    if (this.disposed) {
      return;
    }

    this.geometry = this.measureGeometry();
    this.logicalScrollTopPx = clampNumber(
      this.logicalScrollTopPx,
      0,
      this.geometry.maxLogicalScrollTopPx
    );
    this.updateSpacer();
    this.writeOuterScroll();
    await this.syncNow();
  }

  dispose(): void {
    this.disposed = true;
    this.activeSwitchId += 1;
    this.cache.clear();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.options.scrollElement.removeEventListener(
      "scroll",
      this.handleOuterScroll
    );
    this.options.interactionElement.removeEventListener(
      "wheel",
      this.handleWheel,
      true
    );
    this.options.interactionElement.removeEventListener(
      "keydown",
      this.handleKeyDown
    );

    for (const rafId of [
      this.syncRafId,
      this.stateRafId,
      this.resizeRafId
    ]) {
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
      }
    }
  }

  private bindEvents(): void {
    this.options.scrollElement.addEventListener(
      "scroll",
      this.handleOuterScroll,
      { passive: true }
    );
    this.options.interactionElement.addEventListener(
      "wheel",
      this.handleWheel,
      { passive: false, capture: true }
    );
    this.options.interactionElement.addEventListener(
      "keydown",
      this.handleKeyDown
    );
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeRafId !== 0) {
        return;
      }

      this.resizeRafId = requestAnimationFrame(() => {
        this.resizeRafId = 0;
        void this.refreshLayout().catch(this.reportError);
      });
    });
    this.resizeObserver.observe(this.options.interactionElement);
  }

  private readonly handleOuterScroll = (): void => {
    if (this.disposed) {
      return;
    }

    const actualScrollTop =
      this.options.scrollElement.scrollTop;

    /*
     * scrollTop 由 Go To、滚轮或键盘同步时，浏览器稍后仍会派发原生
     * scroll 事件。只忽略与本次写入值匹配的那一次；若值不匹配，
     * 说明用户已经拖动了 scrollbar，必须立即转回用户输入路径。
     *
     * 相比“忽略一帧”的做法，这个判断不依赖浏览器何时投递事件，
     * 因此在亿级压缩映射和 Vite 热更新下也不会把旧位置写回来。
     */
    if (this.expectedScrollbarScrollTopPx !== null) {
      const matchesProgrammaticWrite =
        Math.abs(
          actualScrollTop -
            this.expectedScrollbarScrollTopPx
        ) <= 2;

      this.expectedScrollbarScrollTopPx = null;

      if (matchesProgrammaticWrite) {
        return;
      }
    }

    this.logicalScrollTopPx = scrollbarToLogicalScrollTop(
      actualScrollTop,
      this.geometry
    );
    this.scheduleSync();
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (this.disposed) {
      return;
    }

    let handled = false;

    if (event.deltaY !== 0) {
      const delta = normalizeWheelDelta(
        event,
        this.rowHeightPx,
        this.geometry.bodyViewportHeightPx
      );

      this.setLogicalScrollTopPx(
        this.logicalScrollTopPx + delta,
        true
      );
      handled = true;
    }

    if (event.deltaX !== 0) {
      this.options.table.setScrollLeft(
        this.options.table.getScrollLeft() + event.deltaX
      );
      handled = true;
    }

    if (handled) {
      event.preventDefault();
      this.scheduleSync();
    }
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    let nextLogicalScrollTopPx: number | null = null;

    switch (event.key) {
      case "ArrowDown":
        nextLogicalScrollTopPx =
          this.logicalScrollTopPx + this.rowHeightPx;
        break;
      case "ArrowUp":
        nextLogicalScrollTopPx =
          this.logicalScrollTopPx - this.rowHeightPx;
        break;
      case "PageDown":
        nextLogicalScrollTopPx =
          this.logicalScrollTopPx +
          this.geometry.bodyViewportHeightPx;
        break;
      case "PageUp":
        nextLogicalScrollTopPx =
          this.logicalScrollTopPx -
          this.geometry.bodyViewportHeightPx;
        break;
      case "Home":
        nextLogicalScrollTopPx = 0;
        break;
      case "End":
        nextLogicalScrollTopPx =
          this.geometry.maxLogicalScrollTopPx;
        break;
      default:
        return;
    }

    event.preventDefault();
    this.setLogicalScrollTopPx(
      nextLogicalScrollTopPx,
      true
    );
    this.scheduleSync();
  };

  private scheduleSync(): void {
    this.emitState();

    if (this.syncRafId !== 0) {
      return;
    }

    this.syncRafId = requestAnimationFrame(() => {
      this.syncRafId = 0;
      void this.syncNow().catch(this.reportError);
    });
  }

  private async syncNow(): Promise<void> {
    if (this.disposed || this.options.totalVectors <= 0) {
      return;
    }

    const visible = computeVisibleRange(
      this.logicalScrollTopPx,
      this.geometry
    );
    const desiredWindowStartVectorIndex =
      computeWindowStartVectorIndex({
      firstVisibleVectorIndex: visible.startVectorIndex,
      totalVectors: this.options.totalVectors,
      windowSize: this.windowSize,
      windowShift: this.windowShift,
      guardRows: this.guardRows
    });

    if (
      desiredWindowStartVectorIndex ===
        this.currentWindowStartVectorIndex &&
      this.currentWindowLength > 0
    ) {
      this.applyLocalScroll();
      this.prepareAndPrefetch(
        desiredWindowStartVectorIndex
      );
      this.emitState();
      return;
    }

    await this.switchWindow(desiredWindowStartVectorIndex);
  }

  private async switchWindow(
    windowStartVectorIndex: number
  ): Promise<void> {
    const switchId = ++this.activeSwitchId;

    this.isLoading = true;
    this.errorMessage = null;
    this.prepareCache(windowStartVectorIndex);
    this.emitState();

    try {
      const response = await this.requestWindow(
        windowStartVectorIndex
      );

      if (this.disposed || switchId !== this.activeSwitchId) {
        return;
      }

      this.validateResponse(
        response,
        windowStartVectorIndex
      );
      this.options.table.setRecords(response.rows);
      await this.options.table.whenLayoutReady();

      if (this.disposed || switchId !== this.activeSwitchId) {
        return;
      }

      this.currentWindowStartVectorIndex =
        response.startVectorIndex;
      this.currentWindowLength = response.rows.length;
      this.currentRenderStartVectorIndex =
        response.startVectorIndex;
      this.currentRenderHeightPx =
        response.rows.length * this.rowHeightPx;
      this.geometry = this.measureGeometry();
      this.updateSpacer();
      this.applyLocalScroll();
      this.isLoading = false;
      this.errorMessage = null;
      this.prepareAndPrefetch(response.startVectorIndex);
      this.emitState();
    } catch (error) {
      if (this.disposed || switchId !== this.activeSwitchId) {
        return;
      }

      this.isLoading = false;
      this.errorMessage = errorMessage(error);
      this.emitState();
      this.options.onError?.(error);
      throw error;
    }
  }

  private prepareAndPrefetch(
    windowStartVectorIndex: number
  ): void {
    const startVectorIndexes = this.prepareCache(
      windowStartVectorIndex
    );

    for (const startVectorIndex of startVectorIndexes) {
      if (startVectorIndex === windowStartVectorIndex) {
        continue;
      }

      void this.requestWindow(startVectorIndex).catch(error => {
        if (!this.disposed) {
          this.options.onError?.(error);
        }
      });
    }
  }

  private prepareCache(
    windowStartVectorIndex: number
  ): number[] {
    const startVectorIndexes =
      computeNeighborWindowStartVectorIndexes({
      currentWindowStartVectorIndex: windowStartVectorIndex,
      totalVectors: this.options.totalVectors,
      windowSize: this.windowSize,
      windowShift: this.windowShift
    });
    this.cache.retain(
      startVectorIndexes.map(startVectorIndex =>
        this.cacheKey(startVectorIndex)
      )
    );

    return startVectorIndexes;
  }

  private requestWindow(
    startVectorIndex: number
  ): Promise<PatternWindowResponse> {
    const key = this.cacheKey(startVectorIndex);

    return this.cache.request(key, () =>
      this.options.client.getWindow({
        startVectorIndex,
        vectorCount: this.windowSize,
        expectedRevision: this.options.revision
      })
    );
  }

  private cacheKey(startVectorIndex: number): string {
    return `${this.options.revision}:${startVectorIndex}`;
  }

  private validateResponse(
    response: PatternWindowResponse,
    requestedStartVectorIndex: number
  ): void {
    if (response.revision !== this.options.revision) {
      throw new Error(
        `Window revision ${response.revision} does not match ${this.options.revision}.`
      );
    }

    if (response.totalVectors !== this.options.totalVectors) {
      throw new Error(
        "Window totalVectors changed during the read-only session."
      );
    }

    if (
      response.startVectorIndex !==
      requestedStartVectorIndex
    ) {
      throw new Error(
        `Window startVectorIndex ${response.startVectorIndex} does not match requested ${requestedStartVectorIndex}.`
      );
    }

    if (response.rows.length > this.windowSize) {
      throw new Error("Backend returned more than one render window.");
    }
  }

  private applyLocalScroll(): void {
    if (
      this.currentRenderStartVectorIndex < 0 ||
      this.currentRenderHeightPx <= 0
    ) {
      return;
    }

    const maxLocalScrollTopPx = Math.max(
      0,
      this.currentRenderHeightPx -
        this.geometry.bodyViewportHeightPx
    );
    const localScrollTopPx = clampNumber(
      this.logicalScrollTopPx -
        this.currentRenderStartVectorIndex *
          this.rowHeightPx,
      0,
      maxLocalScrollTopPx
    );
    const isAtDatasetEnd =
      this.logicalScrollTopPx >=
      this.geometry.maxLogicalScrollTopPx - 0.5;
    /*
     * 到达整个数据集末尾时，直接把一个极大值交给 VTable，由其按照
     * 当前真实 records/body 高度钳位到内部最大 scrollTop。这样最后一行
     * 能完整进入 body，又不需要向 records 注入一条伪造的 padding 行。
     */
    const tableScrollTopPx = isAtDatasetEnd
      ? Number.MAX_SAFE_INTEGER
      : localScrollTopPx;

    if (
      Math.abs(
        this.options.table.getScrollTop() -
          tableScrollTopPx
      ) >= 0.5
    ) {
      this.options.table.setScrollTop(tableScrollTopPx);
    }
  }

  private setLogicalScrollTopPx(
    logicalScrollTopPx: number,
    syncOuterScroll: boolean
  ): void {
    this.logicalScrollTopPx = clampNumber(
      logicalScrollTopPx,
      0,
      this.geometry.maxLogicalScrollTopPx
    );

    if (syncOuterScroll) {
      this.writeOuterScroll();
    }
  }

  private writeOuterScroll(): void {
    const scrollbarScrollTopPx =
      logicalToScrollbarScrollTop(
      this.logicalScrollTopPx,
      this.geometry
    );

    if (
      Math.abs(
        this.options.scrollElement.scrollTop -
          scrollbarScrollTopPx
      ) < 0.5
    ) {
      return;
    }

    this.expectedScrollbarScrollTopPx =
      scrollbarScrollTopPx;
    this.options.scrollElement.scrollTop =
      scrollbarScrollTopPx;
    this.expectedScrollbarScrollTopPx =
      this.options.scrollElement.scrollTop;
  }

  private updateSpacer(): void {
    this.options.spacerElement.style.height =
      `${this.geometry.spacerHeightPx}px`;
  }

  private measureGeometry(): ScrollGeometry {
    return createScrollGeometry({
      totalVectors: this.options.totalVectors,
      rowHeightPx: this.rowHeightPx,
      bodyViewportHeightPx:
        this.options.table.getBodyHeight(),
      scrollbarViewportHeightPx:
        this.options.scrollElement.clientHeight || 1
    });
  }

  private emitState(): void {
    if (!this.options.onStateChange || this.stateRafId !== 0) {
      return;
    }

    this.stateRafId = requestAnimationFrame(() => {
      this.stateRafId = 0;
      const visible = computeVisibleRange(
        this.logicalScrollTopPx,
        this.geometry
      );

      this.options.onStateChange?.({
        totalVectors: this.options.totalVectors,
        revision: this.options.revision,
        logicalScrollTopPx: this.logicalScrollTopPx,
        firstVisibleVectorIndex:
          visible.startVectorIndex,
        lastVisibleVectorIndex: visible.endVectorIndex,
        windowStartVectorIndex: Math.max(
          0,
          this.currentWindowStartVectorIndex
        ),
        windowEndVectorIndex:
          this.currentWindowLength > 0
            ? this.currentWindowStartVectorIndex +
              this.currentWindowLength -
              1
            : 0,
        isLoading: this.isLoading,
        cacheEntries: this.cache.size,
        errorMessage: this.errorMessage
      });
    });
  }

  private readonly reportError = (error: unknown): void => {
    if (this.disposed) {
      return;
    }

    this.errorMessage = errorMessage(error);
    this.isLoading = false;
    this.emitState();
    this.options.onError?.(error);
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Pattern window request failed.";
}
