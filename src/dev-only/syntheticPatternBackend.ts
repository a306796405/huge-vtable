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
  type PatternDocumentStateEvent,
  type PatternHistoryDirection,
  type PatternHistoryResponse,
  type PatternMetadata,
  type PatternMutationEffect,
  type PatternMutationOperation,
  type PatternMutationRequest,
  type PatternMutationResponse,
  type PatternWindowRequest,
  type PatternWindowResponse
} from "../shared/protocol";
import {
  SyntheticPatternStore,
  type SyntheticPatternStoreSnapshot,
  type StoreMutationResult
} from "./syntheticPatternStore";

export const MIN_TOTAL_VECTORS = 0;
export const MAX_TOTAL_VECTORS = 300_000_000;
export const DEFAULT_TOTAL_VECTORS = 100_000_000;
export const MAX_WINDOW_LIMIT = 1_000;
export const MAX_MUTATION_ROWS = 10_000;
export const MAX_PASTE_CELLS = 100_000;

export type SyntheticDebugFault =
  | "getWindowOnce"
  | "applyMutationOnce";

export type SyntheticPatternOptions = {
  totalVectors?: number;
  revision?: number;
  delayMs?: number;
  storeSnapshot?: SyntheticPatternStoreSnapshot;
  isDirty?: boolean;
  /**
   * 仅供人工验收统一恢复流程；每种故障最多触发一次。
   * 正式 PatternBackend/C++ ICE 不实现这项开发能力。
   */
  debugFaults?: readonly SyntheticDebugFault[];
};

type SyntheticPatternFile = {
  format: "pattern-vtable-v22-lite-synthetic";
  version: 1;
  revision: number;
  totalVectors: number;
  store: SyntheticPatternStoreSnapshot;
};

type ContentState = {
  id: number;
  store: SyntheticPatternStoreSnapshot;
};

type HistoryEntry = {
  before: ContentState;
  after: ContentState;
  forwardEffects: PatternMutationEffect[];
  inverseEffects: PatternMutationEffect[];
};

export class SyntheticPatternBackend implements PatternBackend {
  private store: SyntheticPatternStore;
  private revision: number;
  private readonly delayMs: number;
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  private readonly documentStateListeners = new Set<
    (event: PatternDocumentStateEvent) => void
  >();
  private currentContentStateId = 0;
  private savedContentStateId = 0;
  private nextContentStateId = 1;
  private readonly debugFaults: Set<SyntheticDebugFault>;

  constructor(options: SyntheticPatternOptions = {}) {
    const totalVectors = clampInteger(
      options.totalVectors ?? DEFAULT_TOTAL_VECTORS,
      MIN_TOTAL_VECTORS,
      MAX_TOTAL_VECTORS
    );

    this.store = options.storeSnapshot
      ? SyntheticPatternStore.fromSnapshot(options.storeSnapshot)
      : new SyntheticPatternStore(totalVectors);

    if (this.store.totalVectors > MAX_TOTAL_VECTORS) {
      throw new RangeError(
        `Pattern cannot exceed ${MAX_TOTAL_VECTORS} vectors.`
      );
    }

    this.revision = clampInteger(
      options.revision ?? 0,
      0,
      Number.MAX_SAFE_INTEGER
    );
    this.delayMs = clampInteger(options.delayMs ?? 0, 0, 5_000);
    this.savedContentStateId = options.isDirty ? -1 : 0;
    this.debugFaults = new Set(options.debugFaults);
  }

  static fromBytes(
    bytes: Uint8Array,
    options: { isDirty?: boolean } = {}
  ): SyntheticPatternBackend {
    const text = new TextDecoder().decode(bytes).trim();

    if (!text) {
      return new SyntheticPatternBackend({
        totalVectors: DEFAULT_TOTAL_VECTORS,
        isDirty: options.isDirty
      });
    }

    const parsed = JSON.parse(text) as unknown;

    if (
      isObjectRecord(parsed) &&
      "format" in parsed &&
      parsed.format === "pattern-vtable-v22-lite-synthetic" &&
      "version" in parsed &&
      parsed.version === 1 &&
      "store" in parsed &&
      parsed.store
    ) {
      return new SyntheticPatternBackend({
        revision:
          typeof parsed.revision === "number"
            ? parsed.revision
            : 0,
        storeSnapshot:
          parsed.store as SyntheticPatternStoreSnapshot,
        isDirty: options.isDirty
      });
    }

    return new SyntheticPatternBackend({
      totalVectors:
        isObjectRecord(parsed) &&
        typeof parsed.totalVectors === "number"
          ? parsed.totalVectors
          : DEFAULT_TOTAL_VECTORS,
      isDirty: options.isDirty,
      debugFaults: readDebugFaults(parsed)
    });
  }

  async getMetadata(): Promise<PatternMetadata> {
    return this.createMetadata();
  }

  async getWindow(
    request: PatternWindowRequest
  ): Promise<PatternWindowResponse> {
    validateWindowRequest(request, this.createMetadata());

    if (this.consumeDebugFault("getWindowOnce")) {
      throw new Error(
        "Synthetic one-shot getWindow failure for manual acceptance."
      );
    }

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

    if (this.consumeDebugFault("applyMutationOnce")) {
      throw new Error(
        "Synthetic one-shot applyMutation failure for manual acceptance."
      );
    }

    const previousRevision = this.revision;
    const before = this.captureContentState(
      this.currentContentStateId
    );
    const result = this.execute(request.operation);
    const changed = result.effects.length > 0;

    if (changed) {
      this.revision += 1;
      this.currentContentStateId = this.nextContentStateId++;
      const after = this.captureContentState(
        this.currentContentStateId
      );
      this.undoStack.push({
        before,
        after,
        forwardEffects: cloneEffects(result.effects),
        inverseEffects: invertEffects(result.effects)
      });
      this.redoStack.length = 0;
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

  serialize(): Uint8Array {
    const file: SyntheticPatternFile = {
      format: "pattern-vtable-v22-lite-synthetic",
      version: 1,
      revision: this.revision,
      totalVectors: this.store.totalVectors,
      store: this.store.toSnapshot()
    };

    return new TextEncoder().encode(
      `${JSON.stringify(file, null, 2)}\n`
    );
  }

  markSaved(): void {
    this.savedContentStateId = this.currentContentStateId;
  }

  undo(): PatternHistoryResponse {
    const entry = this.undoStack.pop();

    if (!entry) {
      return this.createHistoryResponse(
        this.revision,
        [],
        "没有可撤销的操作。"
      );
    }

    const previousRevision = this.revision;
    this.restoreContentState(entry.before);
    this.redoStack.push(entry);
    this.revision += 1;

    return this.createHistoryResponse(
      previousRevision,
      entry.inverseEffects,
      "已撤销上一项操作。"
    );
  }

  redo(): PatternHistoryResponse {
    const entry = this.redoStack.pop();

    if (!entry) {
      return this.createHistoryResponse(
        this.revision,
        [],
        "没有可重做的操作。"
      );
    }

    const previousRevision = this.revision;
    this.restoreContentState(entry.after);
    this.undoStack.push(entry);
    this.revision += 1;

    return this.createHistoryResponse(
      previousRevision,
      entry.forwardEffects,
      "已重做上一项操作。"
    );
  }

  async runHistory(
    direction: PatternHistoryDirection
  ): Promise<PatternMetadata> {
    const result =
      direction === "undo" ? this.undo() : this.redo();
    const event: PatternDocumentStateEvent = {
      action: direction === "undo" ? "undone" : "redone",
      metadata: this.createMetadata(),
      effects: result.effects,
      message: result.message
    };

    for (const listener of this.documentStateListeners) {
      listener(event);
    }

    return event.metadata;
  }

  onDidChangeDocumentState(
    listener: (event: PatternDocumentStateEvent) => void
  ): () => void {
    this.documentStateListeners.add(listener);
    return () => this.documentStateListeners.delete(listener);
  }

  dispose(): void {
    this.documentStateListeners.clear();
  }

  private consumeDebugFault(
    fault: SyntheticDebugFault
  ): boolean {
    return this.debugFaults.delete(fault);
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
      isDirty:
        this.currentContentStateId !==
        this.savedContentStateId,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0
    };
  }

  private captureContentState(id: number): ContentState {
    return {
      id,
      store: this.store.toSnapshot()
    };
  }

  private restoreContentState(state: ContentState): void {
    this.store = SyntheticPatternStore.fromSnapshot(state.store);
    this.currentContentStateId = state.id;
  }

  private createHistoryResponse(
    previousRevision: number,
    effects: PatternMutationEffect[],
    message: string
  ): PatternHistoryResponse {
    return {
      ...this.createMetadata(),
      previousRevision,
      effects: cloneEffects(effects),
      message
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

function cloneEffects(
  effects: readonly PatternMutationEffect[]
): PatternMutationEffect[] {
  return effects.map(effect => ({ ...effect }));
}

/**
 * effect 的 startVectorIndex 以事务开始时的数据集为坐标。这里先换算出
 * 每个结构操作实际落在提交后数据集的位置，再把 insert/delete 对调，
 * 使 Undo 仍可复用前端同一套视口锚点映射。
 */
function invertEffects(
  effects: readonly PatternMutationEffect[]
): PatternMutationEffect[] {
  let accumulatedShift = 0;
  const cellEffects: PatternMutationEffect[] = [];
  const structuralEffects: PatternMutationEffect[] = [];

  for (const effect of effects) {
    if (effect.kind === "cellsUpdated") {
      cellEffects.push({ ...effect });
      continue;
    }

    const appliedStartVectorIndex =
      effect.startVectorIndex + accumulatedShift;

    structuralEffects.push(
      effect.kind === "rowsInserted"
        ? {
            kind: "rowsDeleted",
            startVectorIndex: appliedStartVectorIndex,
            count: effect.count
          }
        : {
            kind: "rowsInserted",
            startVectorIndex: appliedStartVectorIndex,
            count: effect.count
          }
    );
    accumulatedShift +=
      effect.kind === "rowsInserted"
        ? effect.count
        : -effect.count;
  }

  structuralEffects.sort(
    (left, right) =>
      left.startVectorIndex - right.startVectorIndex
  );

  return [...cellEffects, ...structuralEffects];
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

function readDebugFaults(
  value: unknown
): SyntheticDebugFault[] {
  if (
    !isObjectRecord(value) ||
    !Array.isArray(value.debugFaults)
  ) {
    return [];
  }

  return value.debugFaults.filter(
    (fault): fault is SyntheticDebugFault =>
      fault === "getWindowOnce" ||
      fault === "applyMutationOnce"
  );
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

function isObjectRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
