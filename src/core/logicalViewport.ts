/**
 * 阅读等级：C 稳定核心
 * 是否迁移：是
 * 前置阅读：logicalViewportMath.ts、vtableAdapter.ts
 * 建议只关注：start、goToOffset、refreshLayout、dispose
 * 可以跳过：滚动事件抑制、缓存淘汰和 rAF 合并
 *
 * 这个 controller 只做四件事：
 * 1. 在有限的原生 scrollbar 像素与真实逻辑位置之间映射；
 * 2. 请求前/当前/后三个小窗口；
 * 3. 只把当前窗口交给 VTable；
 * 4. 丢弃旧请求，并在新窗口成功前保留旧 Canvas。
 */

import {
  SIGNAL_IDS,
  type PatternReadClient,
  type PatternRenderRow,
  type PatternWindowResponse
} from "../shared/protocol";
import type { PatternTableAdapter } from "./vtableAdapter";
import {
  VTABLE_END_PADDING_HEIGHT,
  VTABLE_END_PADDING_ROW_KEY
} from "./vtableAdapter";
import {
  clampGoToOffset,
  clampNumber,
  computeNeighborWindowStarts,
  computeVisibleRange,
  computeWindowStart,
  createScrollGeometry,
  logicalToVisual,
  normalizeWheelDelta,
  visualToLogical,
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
  logicalOffset: number;
  visibleStart: number;
  visibleEnd: number;
  windowStart: number;
  windowEnd: number;
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
  private readonly rowHeight: number;
  private readonly windowSize: number;
  private readonly windowShift: number;
  private readonly guardRows: number;
  private readonly cache: ReadWindowCache;
  private geometry: ScrollGeometry;
  private logicalOffset = 0;
  private currentWindowStart = -1;
  private currentWindowLength = 0;
  private currentRenderStart = -1;
  private currentRenderHeight = 0;
  private hasEndPadding = false;
  private isLoading = false;
  private errorMessage: string | null = null;
  private disposed = false;
  private activeSwitchId = 0;
  private syncRafId = 0;
  private stateRafId = 0;
  private resizeRafId = 0;
  private expectedOuterScrollTop: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly options: LogicalViewportOptions) {
    this.rowHeight =
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

  async goToOffset(offset: number): Promise<void> {
    const target = clampGoToOffset(
      offset,
      this.options.totalVectors
    );

    this.setLogicalOffset(target * this.rowHeight, true);
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
    this.logicalOffset = clampNumber(
      this.logicalOffset,
      0,
      this.geometry.maxLogicalOffset
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
    if (this.expectedOuterScrollTop !== null) {
      const matchesProgrammaticWrite =
        Math.abs(
          actualScrollTop - this.expectedOuterScrollTop
        ) <= 2;

      this.expectedOuterScrollTop = null;

      if (matchesProgrammaticWrite) {
        return;
      }
    }

    this.logicalOffset = visualToLogical(
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
        this.rowHeight,
        this.geometry.bodyHeight
      );

      this.setLogicalOffset(this.logicalOffset + delta, true);
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
    let nextOffset: number | null = null;

    switch (event.key) {
      case "ArrowDown":
        nextOffset = this.logicalOffset + this.rowHeight;
        break;
      case "ArrowUp":
        nextOffset = this.logicalOffset - this.rowHeight;
        break;
      case "PageDown":
        nextOffset =
          this.logicalOffset + this.geometry.bodyHeight;
        break;
      case "PageUp":
        nextOffset =
          this.logicalOffset - this.geometry.bodyHeight;
        break;
      case "Home":
        nextOffset = 0;
        break;
      case "End":
        nextOffset = this.geometry.maxLogicalOffset;
        break;
      default:
        return;
    }

    event.preventDefault();
    this.setLogicalOffset(nextOffset, true);
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
      this.logicalOffset,
      this.geometry
    );
    const desiredWindowStart = computeWindowStart({
      firstVisibleRow: visible.start,
      totalVectors: this.options.totalVectors,
      windowSize: this.windowSize,
      windowShift: this.windowShift,
      guardRows: this.guardRows
    });

    if (
      desiredWindowStart === this.currentWindowStart &&
      this.currentWindowLength > 0
    ) {
      this.applyLocalScroll();
      this.prepareAndPrefetch(desiredWindowStart);
      this.emitState();
      return;
    }

    await this.switchWindow(desiredWindowStart);
  }

  private async switchWindow(windowStart: number): Promise<void> {
    const switchId = ++this.activeSwitchId;

    this.isLoading = true;
    this.errorMessage = null;
    this.prepareCache(windowStart);
    this.emitState();

    try {
      const response = await this.requestWindow(windowStart);

      if (this.disposed || switchId !== this.activeSwitchId) {
        return;
      }

      this.validateResponse(response, windowStart);
      const renderWindow = this.createRenderWindow(response);
      this.options.table.setRecords(renderWindow.rows);
      await this.options.table.whenLayoutReady();

      if (this.disposed || switchId !== this.activeSwitchId) {
        return;
      }

      this.currentWindowStart = response.offset;
      this.currentWindowLength = response.rows.length;
      this.currentRenderStart = renderWindow.offset;
      this.currentRenderHeight = renderWindow.height;
      this.hasEndPadding = renderWindow.hasEndPadding;
      this.geometry = this.measureGeometry();
      this.updateSpacer();
      this.applyLocalScroll();
      this.isLoading = false;
      this.errorMessage = null;
      this.prepareAndPrefetch(response.offset);
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

  private prepareAndPrefetch(windowStart: number): void {
    const offsets = this.prepareCache(windowStart);

    for (const offset of offsets) {
      if (offset === windowStart) {
        continue;
      }

      void this.requestWindow(offset).catch(error => {
        if (!this.disposed) {
          this.options.onError?.(error);
        }
      });
    }
  }

  private prepareCache(windowStart: number): number[] {
    const offsets = computeNeighborWindowStarts({
      currentWindowStart: windowStart,
      totalVectors: this.options.totalVectors,
      windowSize: this.windowSize,
      windowShift: this.windowShift
    });
    this.cache.retain(
      offsets.map(offset => this.cacheKey(offset))
    );

    return offsets;
  }

  private requestWindow(
    offset: number
  ): Promise<PatternWindowResponse> {
    const key = this.cacheKey(offset);

    return this.cache.request(key, () =>
      this.options.client.getWindow({
        offset,
        limit: this.windowSize,
        expectedRevision: this.options.revision
      })
    );
  }

  private cacheKey(offset: number): string {
    return `${this.options.revision}:${offset}`;
  }

  private validateResponse(
    response: PatternWindowResponse,
    requestedOffset: number
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

    if (response.offset !== requestedOffset) {
      throw new Error(
        `Window offset ${response.offset} does not match requested ${requestedOffset}.`
      );
    }

    if (response.rows.length > this.windowSize) {
      throw new Error("Backend returned more than one render window.");
    }
  }

  private applyLocalScroll(): void {
    if (
      this.currentRenderStart < 0 ||
      this.currentRenderHeight <= 0
    ) {
      return;
    }

    const maxLocalOffset = Math.max(
      0,
      this.currentRenderHeight - this.geometry.bodyHeight
    );
    const localOffset = clampNumber(
      this.logicalOffset -
        this.currentRenderStart * this.rowHeight,
      0,
      maxLocalOffset
    );
    const isAtDatasetEnd =
      this.logicalOffset >=
      this.geometry.maxLogicalOffset - 0.5;
    /*
     * 只有到达整个数据集末尾时，才进入下面那条纯渲染 padding。
     * VTable 会按自己的真实上限钳位，因此末行完整出现，而中间位置
     * 仍严格使用逻辑 offset 对应的局部像素。
     */
    const tableOffset =
      isAtDatasetEnd && this.hasEndPadding
      ? localOffset + VTABLE_END_PADDING_HEIGHT
      : localOffset;

    if (
      Math.abs(
        this.options.table.getScrollTop() - tableOffset
      ) >= 0.5
    ) {
      this.options.table.setScrollTop(tableOffset);
    }
  }

  private createRenderWindow(
    response: PatternWindowResponse
  ): {
    offset: number;
    height: number;
    hasEndPadding: boolean;
    rows: PatternRenderRow[];
  } {
    const reachesDatasetEnd =
      response.offset + response.rows.length >=
      this.options.totalVectors;
    const canDropGuardRow =
      response.offset > 0 &&
      response.rows.length === this.windowSize;

    if (!reachesDatasetEnd || !canDropGuardRow) {
      return {
        offset: response.offset,
        height: response.rows.length * this.rowHeight,
        hasEndPadding: false,
        rows: response.rows
      };
    }

    /*
     * VTable 1.22.2 在 VS Code webview 的部分缩放比下，最后一条 record
     * 无法滚过 Canvas 裁剪边界。最终窗口进入时，最前面的 guard row
     * 已不可能可见，所以用一个纯渲染 padding 替换它：VTable 仍只有
     * 1000 条 records，后端窗口/cache 仍保持完整的 1000 条权威数据。
     */
    const rows = [
      ...response.rows.slice(1),
      createEndPaddingRow()
    ];

    return {
      offset: response.offset + 1,
      height:
        (rows.length - 1) * this.rowHeight +
        VTABLE_END_PADDING_HEIGHT,
      hasEndPadding: true,
      rows
    };
  }

  private setLogicalOffset(
    logicalOffset: number,
    syncOuterScroll: boolean
  ): void {
    this.logicalOffset = clampNumber(
      logicalOffset,
      0,
      this.geometry.maxLogicalOffset
    );

    if (syncOuterScroll) {
      this.writeOuterScroll();
    }
  }

  private writeOuterScroll(): void {
    const visualOffset = logicalToVisual(
      this.logicalOffset,
      this.geometry
    );

    if (
      Math.abs(
        this.options.scrollElement.scrollTop - visualOffset
      ) < 0.5
    ) {
      return;
    }

    this.expectedOuterScrollTop = visualOffset;
    this.options.scrollElement.scrollTop = visualOffset;
    this.expectedOuterScrollTop =
      this.options.scrollElement.scrollTop;
  }

  private updateSpacer(): void {
    this.options.spacerElement.style.height =
      `${this.geometry.spacerHeight}px`;
  }

  private measureGeometry(): ScrollGeometry {
    return createScrollGeometry({
      totalVectors: this.options.totalVectors,
      rowHeight: this.rowHeight,
      bodyHeight: this.options.table.getBodyHeight(),
      outerViewportHeight:
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
        this.logicalOffset,
        this.geometry
      );

      this.options.onStateChange?.({
        totalVectors: this.options.totalVectors,
        revision: this.options.revision,
        logicalOffset: this.logicalOffset,
        visibleStart: visible.start,
        visibleEnd: visible.end,
        windowStart: Math.max(0, this.currentWindowStart),
        windowEnd:
          this.currentWindowLength > 0
            ? this.currentWindowStart +
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

function createEndPaddingRow(): PatternRenderRow {
  return {
    rowKey: VTABLE_END_PADDING_ROW_KEY,
    /*
     * 该 record 永远位于真实末行之后，且只提供滚动空间。undefined
     * 让 VTable 保持空白，不会伪装成一个真实 Vector。
     */
    vectorNo: undefined as unknown as number,
    cycleText: "",
    instruction: "",
    comment: "",
    signalValues: Object.fromEntries(
      SIGNAL_IDS.map(signalId => [signalId, ""])
    ) as PatternRenderRow["signalValues"]
  };
}
