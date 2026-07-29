/**
 * 阅读等级：E 开发验证
 * 是否迁移：否
 * 前置阅读：无
 * 建议只关注：浏览器控制台的 patternPerf API
 * 可以跳过：分位数和浏览器兼容代码
 *
 * 该探针只包装 DocumentClient 的耗时，并使用浏览器 Performance API 观察
 * 长任务、帧间隔和可用的 JS heap。它不读取 rows 内容，也不会进入正式
 * VS Code Webview bundle。
 */

import type {
  PatternCommand,
  PatternDocumentClient
} from "../shared/protocol";

type MeasuredCommand = PatternCommand;

type RequestSample = {
  command: MeasuredCommand;
  durationMs: number;
  succeeded: boolean;
  rowCount?: number;
};

type Distribution = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

export type PatternPerformanceReport = {
  startedAt: string;
  elapsedMs: number;
  requests: Record<string, Distribution>;
  requestFailures: number;
  returnedWindowRows: number;
  longTasks: Distribution;
  frameGaps: Distribution;
  heap?: {
    startBytes: number;
    currentBytes: number;
    peakBytes: number;
    growthPercent: number;
  };
  notes: string[];
};

type PerformanceMemory = {
  usedJSHeapSize: number;
};

type PerformanceWithMemory = Performance & {
  memory?: PerformanceMemory;
};

type PatternPerfApi = {
  reset(): void;
  report(): PatternPerformanceReport;
  print(): PatternPerformanceReport;
};

declare global {
  interface Window {
    patternPerf?: PatternPerfApi;
  }
}

export function installPatternPerformanceProbe(
  client: PatternDocumentClient
): PatternDocumentClient {
  const probe = new BrowserPerformanceProbe();
  window.patternPerf = probe.api;
  console.info(
    "[Pattern Perf] 已启用。使用 patternPerf.reset()、patternPerf.print()。"
  );

  return {
    getMetadata: () =>
      probe.measure("getMetadata", () =>
        client.getMetadata()
      ),
    getWindow: request =>
      probe.measure(
        "getWindow",
        () => client.getWindow(request),
        response => response.rows.length
      ),
    applyMutation: request =>
      probe.measure("applyMutation", () =>
        client.applyMutation(request)
      ),
    onDidChangeDocumentState:
      client.onDidChangeDocumentState?.bind(client),
    reportDiagnostic: client.reportDiagnostic?.bind(client),
    dispose() {
      probe.dispose();
      client.dispose?.();
    }
  };
}

class BrowserPerformanceProbe {
  private startedAt = new Date();
  private startTimeMs = performance.now();
  private requestSamples: RequestSample[] = [];
  private longTaskDurations: number[] = [];
  private frameGapDurations: number[] = [];
  private previousFrameTimeMs = performance.now();
  private frameRequestId = 0;
  private heapTimerId = 0;
  private startHeapBytes = readHeapBytes();
  private currentHeapBytes = this.startHeapBytes;
  private peakHeapBytes = this.startHeapBytes;
  private readonly longTaskObserver:
    | PerformanceObserver
    | undefined;

  readonly api: PatternPerfApi = {
    reset: () => this.reset(),
    report: () => this.createReport(),
    print: () => {
      const report = this.createReport();
      console.table(report.requests);
      console.info("[Pattern Perf] report", report);
      return report;
    }
  };

  constructor() {
    this.longTaskObserver = this.observeLongTasks();
    this.startFrameSampling();
    this.heapTimerId = window.setInterval(
      () => this.sampleHeap(),
      1_000
    );
  }

  async measure<T>(
    command: MeasuredCommand,
    operation: () => Promise<T>,
    getRowCount?: (value: T) => number
  ): Promise<T> {
    const start = performance.now();

    try {
      const value = await operation();
      this.requestSamples.push({
        command,
        durationMs: performance.now() - start,
        succeeded: true,
        rowCount: getRowCount?.(value)
      });
      this.sampleHeap();
      return value;
    } catch (error) {
      this.requestSamples.push({
        command,
        durationMs: performance.now() - start,
        succeeded: false
      });
      this.sampleHeap();
      throw error;
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.frameRequestId);
    window.clearInterval(this.heapTimerId);
    this.longTaskObserver?.disconnect();

    if (window.patternPerf === this.api) {
      delete window.patternPerf;
    }
  }

  private reset(): void {
    this.startedAt = new Date();
    this.startTimeMs = performance.now();
    this.requestSamples = [];
    this.longTaskDurations = [];
    this.frameGapDurations = [];
    this.previousFrameTimeMs = performance.now();
    this.startHeapBytes = readHeapBytes();
    this.currentHeapBytes = this.startHeapBytes;
    this.peakHeapBytes = this.startHeapBytes;
    console.info("[Pattern Perf] samples reset.");
  }

  private createReport(): PatternPerformanceReport {
    this.sampleHeap();
    const groupedRequests = new Map<
      MeasuredCommand,
      number[]
    >();

    for (const sample of this.requestSamples) {
      const samples =
        groupedRequests.get(sample.command) ?? [];
      samples.push(sample.durationMs);
      groupedRequests.set(sample.command, samples);
    }

    const requests = Object.fromEntries(
      [...groupedRequests].map(([command, samples]) => [
        command,
        summarize(samples)
      ])
    );
    const report: PatternPerformanceReport = {
      startedAt: this.startedAt.toISOString(),
      elapsedMs: round(performance.now() - this.startTimeMs),
      requests,
      requestFailures: this.requestSamples.filter(
        sample => !sample.succeeded
      ).length,
      returnedWindowRows: this.requestSamples.reduce(
        (total, sample) => total + (sample.rowCount ?? 0),
        0
      ),
      longTasks: summarize(this.longTaskDurations),
      frameGaps: summarize(this.frameGapDurations),
      notes: [
        "Probe records timings and counts only; row/cell values are never retained.",
        "Current Pattern demo has 12 signal columns.",
        "Synthetic latency does not include C++ ICE or real .pat decoding."
      ]
    };

    if (
      this.startHeapBytes > 0 &&
      this.currentHeapBytes > 0
    ) {
      report.heap = {
        startBytes: this.startHeapBytes,
        currentBytes: this.currentHeapBytes,
        peakBytes: this.peakHeapBytes,
        growthPercent: round(
          ((this.currentHeapBytes - this.startHeapBytes) /
            this.startHeapBytes) *
            100
        )
      };
    }

    return report;
  }

  private observeLongTasks():
    | PerformanceObserver
    | undefined {
    if (
      typeof PerformanceObserver === "undefined" ||
      !PerformanceObserver.supportedEntryTypes.includes(
        "longtask"
      )
    ) {
      return undefined;
    }

    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        this.longTaskDurations.push(entry.duration);
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
    return observer;
  }

  private startFrameSampling(): void {
    const sample = (now: number) => {
      const gap = now - this.previousFrameTimeMs;

      if (gap >= 32) {
        this.frameGapDurations.push(gap);
      }

      this.previousFrameTimeMs = now;
      this.frameRequestId = requestAnimationFrame(sample);
    };

    this.frameRequestId = requestAnimationFrame(sample);
  }

  private sampleHeap(): void {
    const heapBytes = readHeapBytes();

    if (heapBytes <= 0) {
      return;
    }

    this.currentHeapBytes = heapBytes;
    this.peakHeapBytes = Math.max(
      this.peakHeapBytes,
      heapBytes
    );
  }
}

function readHeapBytes(): number {
  return (
    (performance as PerformanceWithMemory).memory
      ?.usedJSHeapSize ?? 0
  );
}

function summarize(values: readonly number[]): Distribution {
  if (values.length === 0) {
    return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }

  const sorted = [...values].sort(
    (left, right) => left - right
  );

  return {
    count: sorted.length,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0)
  };
}

function percentile(
  sortedValues: readonly number[],
  ratio: number
): number {
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * ratio) - 1)
  );
  return sortedValues[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
