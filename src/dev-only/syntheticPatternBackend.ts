/**
 * 阅读等级：E 开发验证
 * 是否迁移：否
 * 前置阅读：shared/protocol.ts、syntheticPatternStore.ts
 * 建议只关注：窗口读取和所有写操作共用 applyMutation
 * 可以跳过：延迟模拟与错误文本
 */

import type { PatternBackend } from "../extension/patternBackend";
import {
  isPatternEditableColumnId,
  type PatternMetadata,
  type PatternMutationOperation,
  type PatternMutationRequest,
  type PatternMutationResponse,
  type PatternWindowRequest,
  type PatternWindowResponse
} from "../shared/protocol";
import {
  SyntheticPatternStore,
  type StoreMutationResult
} from "./syntheticPatternStore";

export const MIN_TOTAL_VECTORS = 0;
export const MAX_TOTAL_VECTORS = 300_000_000;
export const DEFAULT_TOTAL_VECTORS = 100_000_000;
export const MAX_WINDOW_LIMIT = 1_000;
export const MAX_MUTATION_ROWS = 10_000;
export const MAX_PASTE_CELLS = 100_000;

export type SyntheticPatternOptions = {
  totalVectors?: number;
  revision?: number;
  delayMs?: number;
};

export class SyntheticPatternBackend implements PatternBackend {
  private readonly store: SyntheticPatternStore;
  private revision: number;
  private dirty = false;
  private readonly delayMs: number;

  constructor(options: SyntheticPatternOptions = {}) {
    const totalVectors = clampInteger(
      options.totalVectors ?? DEFAULT_TOTAL_VECTORS,
      MIN_TOTAL_VECTORS,
      MAX_TOTAL_VECTORS
    );

    this.store = new SyntheticPatternStore(totalVectors);
    this.revision = clampInteger(
      options.revision ?? 0,
      0,
      Number.MAX_SAFE_INTEGER
    );
    this.delayMs = clampInteger(options.delayMs ?? 0, 0, 5_000);
  }

  async getMetadata(): Promise<PatternMetadata> {
    return this.createMetadata();
  }

  async getWindow(
    request: PatternWindowRequest
  ): Promise<PatternWindowResponse> {
    validateWindowRequest(request, this.createMetadata());
    await this.waitForDelay();

    if (this.store.totalVectors === 0) {
      return {
        ...this.createMetadata(),
        startVectorIndex: 0,
        rows: []
      };
    }

    const startVectorIndex = clampInteger(
      request.startVectorIndex,
      0,
      this.store.totalVectors - 1
    );

    return {
      ...this.createMetadata(),
      startVectorIndex,
      rows: this.store.getWindow(
        startVectorIndex,
        request.vectorCount
      )
    };
  }

  async applyMutation(
    request: PatternMutationRequest
  ): Promise<PatternMutationResponse> {
    this.assertRevision(request.baseRevision);
    validateOperation(request.operation, this.store.totalVectors);
    this.validateStoreSpecificOperation(request.operation);
    await this.waitForDelay();
    this.assertRevision(request.baseRevision);

    const previousRevision = this.revision;
    const result = this.execute(request.operation);
    const changed = result.effects.length > 0;

    if (changed) {
      this.revision += 1;
      this.dirty = true;
    }

    return {
      ...this.createMetadata(),
      operationKind: request.operation.kind,
      previousRevision,
      effects: result.effects,
      updatedRows: result.updatedRows,
      message: mutationMessage(request.operation, result)
    };
  }

  private execute(
    operation: PatternMutationOperation
  ): StoreMutationResult {
    switch (operation.kind) {
      case "insertRows":
        return this.store.insertBlankRows(
          operation.atVectorIndex,
          operation.count
        );
      case "deleteRows":
        return this.store.deleteRows(operation.rowKeys);
      case "updateCells":
        return this.store.updateCells(operation.changes);
      case "paste":
        return this.store.paste(operation);
    }
  }

  private validateStoreSpecificOperation(
    operation: PatternMutationOperation
  ): void {
    if (operation.kind !== "paste") {
      return;
    }

    const startVectorIndex = this.store.getVectorIndex(
      operation.startRowKey
    );
    const existingRowCount = Math.min(
      operation.values.length,
      this.store.totalVectors - startVectorIndex
    );
    const appendCount =
      operation.values.length - existingRowCount;

    if (
      this.store.totalVectors + appendCount >
      MAX_TOTAL_VECTORS
    ) {
      throw new RangeError(
        `Pattern cannot exceed ${MAX_TOTAL_VECTORS} vectors.`
      );
    }
  }

  private createMetadata(): PatternMetadata {
    return {
      totalVectors: this.store.totalVectors,
      revision: this.revision,
      isDirty: this.dirty
    };
  }

  private assertRevision(expectedRevision: number): void {
    if (expectedRevision !== this.revision) {
      throw new Error(
        `REVISION_CONFLICT: expected ${expectedRevision}, current ${this.revision}`
      );
    }
  }

  private async waitForDelay(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise(resolve =>
        setTimeout(resolve, this.delayMs)
      );
    }
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

  if (
    !Number.isInteger(request.startVectorIndex) ||
    request.startVectorIndex < 0
  ) {
    throw new RangeError(
      "Window startVectorIndex must be a non-negative integer."
    );
  }

  if (
    !Number.isInteger(request.vectorCount) ||
    request.vectorCount < 1 ||
    request.vectorCount > MAX_WINDOW_LIMIT
  ) {
    throw new RangeError(
      `Window limit must be between 1 and ${MAX_WINDOW_LIMIT}.`
    );
  }
}

function validateOperation(
  operation: PatternMutationOperation,
  totalVectors: number
): void {
  switch (operation.kind) {
    case "insertRows":
      assertMutationCount(operation.count);

      if (
        !Number.isInteger(operation.atVectorIndex) ||
        operation.atVectorIndex < 0 ||
        operation.atVectorIndex > totalVectors
      ) {
        throw new RangeError(
          "Insert atVectorIndex is outside the document."
        );
      }

      if (totalVectors + operation.count > MAX_TOTAL_VECTORS) {
        throw new RangeError(
          `Pattern cannot exceed ${MAX_TOTAL_VECTORS} vectors.`
        );
      }
      return;
    case "deleteRows":
      if (
        operation.rowKeys.length < 1 ||
        operation.rowKeys.length > MAX_MUTATION_ROWS
      ) {
        throw new RangeError(
          `Delete must contain 1-${MAX_MUTATION_ROWS} rowKeys.`
        );
      }
      return;
    case "updateCells":
      if (
        operation.changes.length < 1 ||
        operation.changes.length > MAX_PASTE_CELLS
      ) {
        throw new RangeError(
          `Update must contain 1-${MAX_PASTE_CELLS} changes.`
        );
      }

      if (
        operation.changes.some(
          change =>
            typeof change.rowKey !== "string" ||
            typeof change.value !== "string" ||
            !isPatternEditableColumnId(change.columnId)
        )
      ) {
        throw new RangeError(
          "Update contains an invalid row, column or value."
        );
      }
      return;
    case "paste": {
      const rowCount = operation.values.length;
      const columnCount = operation.columns.length;

      if (
        rowCount < 1 ||
        rowCount > MAX_MUTATION_ROWS ||
        columnCount < 1 ||
        rowCount * columnCount > MAX_PASTE_CELLS
      ) {
        throw new RangeError(
          `Paste is limited to ${MAX_MUTATION_ROWS} rows and ${MAX_PASTE_CELLS} cells.`
        );
      }

      if (
        operation.values.some(
          row =>
            row.length !== columnCount ||
            row.some(value => typeof value !== "string")
        )
      ) {
        throw new RangeError(
          "Paste values must form a rectangular matrix."
        );
      }

      if (
        operation.columns.some(
          columnId => !isPatternEditableColumnId(columnId)
        )
      ) {
        throw new RangeError(
          "Paste contains a read-only or unknown column."
        );
      }
      return;
    }
  }
}

function assertMutationCount(count: number): void {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_MUTATION_ROWS
  ) {
    throw new RangeError(
      `Mutation count must be between 1 and ${MAX_MUTATION_ROWS}.`
    );
  }
}

function mutationMessage(
  operation: PatternMutationOperation,
  result: StoreMutationResult
): string {
  if (result.effects.length === 0) {
    return "数据没有变化。";
  }

  switch (operation.kind) {
    case "insertRows":
      return `已插入 ${operation.count.toLocaleString("zh-CN")} 行。`;
    case "deleteRows":
      return `已删除 ${operation.rowKeys.length.toLocaleString("zh-CN")} 行。`;
    case "updateCells":
      return "单元格已更新。";
    case "paste":
      return "粘贴事务已提交。";
  }
}

function clampInteger(
  value: number,
  min: number,
  max: number
): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}
