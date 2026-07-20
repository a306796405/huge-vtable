/**
 * 阅读等级：E 开发验证
 * 是否迁移：否
 * 前置阅读：shared/protocol.ts
 * 建议只关注：它按 offset 生成窗口，从不创建 1～3 亿行数组
 * 可以跳过：字段示例值
 */

import type { PatternBackend } from "../extension/patternBackend";
import {
  SIGNAL_IDS,
  type PatternMetadata,
  type PatternRenderRow,
  type PatternWindowRequest,
  type PatternWindowResponse,
  type SignalId
} from "../shared/protocol";

export const MIN_TOTAL_VECTORS = 1;
export const MAX_TOTAL_VECTORS = 300_000_000;
export const DEFAULT_TOTAL_VECTORS = 100_000_000;
export const MAX_WINDOW_LIMIT = 1_000;

export type SyntheticPatternOptions = {
  totalVectors?: number;
  revision?: number;
  delayMs?: number;
};

export class SyntheticPatternBackend implements PatternBackend {
  private readonly metadata: PatternMetadata;
  private readonly delayMs: number;

  constructor(options: SyntheticPatternOptions = {}) {
    this.metadata = {
      totalVectors: clampInteger(
        options.totalVectors ?? DEFAULT_TOTAL_VECTORS,
        MIN_TOTAL_VECTORS,
        MAX_TOTAL_VECTORS
      ),
      revision: clampInteger(options.revision ?? 0, 0, Number.MAX_SAFE_INTEGER)
    };
    this.delayMs = clampInteger(options.delayMs ?? 0, 0, 5_000);
  }

  async getMetadata(): Promise<PatternMetadata> {
    return { ...this.metadata };
  }

  async getWindow(request: PatternWindowRequest): Promise<PatternWindowResponse> {
    validateWindowRequest(request, this.metadata);

    if (this.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }

    const offset = clampInteger(
      request.offset,
      0,
      Math.max(0, this.metadata.totalVectors - 1)
    );
    const count = Math.min(
      request.limit,
      this.metadata.totalVectors - offset
    );
    const rows = Array.from({ length: count }, (_, index) =>
      createSyntheticRow(offset + index)
    );

    return {
      ...this.metadata,
      offset,
      rows
    };
  }
}

function validateWindowRequest(
  request: PatternWindowRequest,
  metadata: PatternMetadata
): void {
  if (request.expectedRevision !== metadata.revision) {
    throw new Error(
      `REVISION_CONFLICT: expected ${request.expectedRevision}, current ${metadata.revision}`
    );
  }

  if (!Number.isInteger(request.offset) || request.offset < 0) {
    throw new RangeError("Window offset must be a non-negative integer.");
  }

  if (
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_WINDOW_LIMIT
  ) {
    throw new RangeError(
      `Window limit must be an integer between 1 and ${MAX_WINDOW_LIMIT}.`
    );
  }
}

function createSyntheticRow(vectorNo: number): PatternRenderRow {
  const signalValues = {} as Record<SignalId, string>;

  for (let index = 0; index < SIGNAL_IDS.length; index += 1) {
    const signalId = SIGNAL_IDS[index];
    const selector = (vectorNo + index * 7) % 13;

    signalValues[signalId] =
      selector === 0 ? "X" : selector < 6 ? "0" : "1";
  }

  return {
    rowKey: `synthetic:${vectorNo}`,
    vectorNo,
    cycleText: String(vectorNo),
    instruction: vectorNo > 0 && vectorNo % 1_000 === 0 ? "repeat 100" : "",
    comment: vectorNo % 250 === 0 ? `Vector ${vectorNo}` : "",
    signalValues
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}
