/**
 * 阅读等级：E 开发验证
 * 是否迁移：否
 * 前置阅读：shared/protocol.ts
 * 建议只关注：亿级基础段不会物化，只有插入行和修改值占用内存
 * 可以跳过：piece 的 split/merge 实现
 */

import {
  SIGNAL_IDS,
  type PatternCellChange,
  type PatternEditableColumnId,
  type PatternMutationEffect,
  type PatternRenderRow,
  type SignalId
} from "../shared/protocol";

type StoredPayload = {
  instruction: string;
  comment: string;
  signalValues: Record<SignalId, string>;
};

type BasePiece = {
  kind: "base";
  sourceStart: number;
  count: number;
};

type InsertedRow = {
  id: number;
  payload: StoredPayload;
};

type InsertedPiece = {
  kind: "inserted";
  rows: InsertedRow[];
};

type Piece = BasePiece | InsertedPiece;

export type SyntheticPatternStoreSnapshot = {
  pieces: Array<
    | {
        kind: "base";
        sourceStart: number;
        count: number;
      }
    | {
        kind: "inserted";
        rows: Array<{
          id: number;
          payload: StoredPayload;
        }>;
      }
  >;
  baseOverrides: Array<[number, StoredPayload]>;
  nextInsertedId: number;
};

type ResolvedRow = {
  pieceIndex: number;
  localIndex: number;
  vectorIndex: number;
  rowKey: string;
  payload: StoredPayload;
  sourceIndex?: number;
  insertedId?: number;
};

export type StoreMutationResult = {
  effects: PatternMutationEffect[];
  updatedRows?: PatternRenderRow[];
};

export class SyntheticPatternStore {
  private pieces: Piece[];
  private readonly baseOverrides = new Map<
    number,
    StoredPayload
  >();
  private nextInsertedId = 1;
  private rowCount: number;

  constructor(totalVectors: number) {
    this.rowCount = totalVectors;
    this.pieces =
      totalVectors > 0
        ? [{ kind: "base", sourceStart: 0, count: totalVectors }]
        : [];
  }

  static fromSnapshot(
    input: SyntheticPatternStoreSnapshot
  ): SyntheticPatternStore {
    const snapshot = validateSnapshot(input);
    const store = new SyntheticPatternStore(0);

    store.pieces = snapshot.pieces;
    store.rowCount = snapshot.pieces.reduce(
      (total, piece) => total + pieceRowCount(piece),
      0
    );
    store.nextInsertedId = snapshot.nextInsertedId;

    for (const [sourceIndex, payload] of snapshot.baseOverrides) {
      store.baseOverrides.set(sourceIndex, payload);
    }

    return store;
  }

  get totalVectors(): number {
    return this.rowCount;
  }

  getWindow(
    startVectorIndex: number,
    vectorCount: number
  ): PatternRenderRow[] {
    if (this.rowCount === 0 || vectorCount <= 0) {
      return [];
    }

    const start = Math.min(
      Math.max(0, startVectorIndex),
      this.rowCount
    );
    const end = Math.min(this.rowCount, start + vectorCount);
    const result: PatternRenderRow[] = [];
    let pieceStart = 0;

    for (
      let pieceIndex = 0;
      pieceIndex < this.pieces.length;
      pieceIndex += 1
    ) {
      const piece = this.pieces[pieceIndex];
      const pieceLength = pieceRowCount(piece);
      const pieceEnd = pieceStart + pieceLength;

      if (pieceEnd <= start) {
        pieceStart = pieceEnd;
        continue;
      }

      if (pieceStart >= end) {
        break;
      }

      const localStart = Math.max(0, start - pieceStart);
      const localEnd = Math.min(pieceLength, end - pieceStart);

      for (
        let localIndex = localStart;
        localIndex < localEnd;
        localIndex += 1
      ) {
        result.push(
          this.materialize(
            this.resolvePieceRow(
              piece,
              pieceIndex,
              localIndex,
              pieceStart + localIndex
            )
          )
        );
      }

      pieceStart = pieceEnd;
    }

    return result;
  }

  getVectorIndex(rowKey: string): number {
    return this.resolveRow(rowKey).vectorIndex;
  }

  toSnapshot(): SyntheticPatternStoreSnapshot {
    return {
      pieces: this.pieces.map(piece =>
        piece.kind === "base"
          ? { ...piece }
          : {
              kind: "inserted",
              rows: piece.rows.map(row => ({
                id: row.id,
                payload: clonePayload(row.payload)
              }))
            }
      ),
      baseOverrides: [...this.baseOverrides].map(
        ([sourceIndex, payload]) => [
          sourceIndex,
          clonePayload(payload)
        ]
      ),
      nextInsertedId: this.nextInsertedId
    };
  }

  insertBlankRows(
    atVectorIndex: number,
    count: number
  ): StoreMutationResult & { rowKeys: string[] } {
    const insertionIndex = this.splitAt(atVectorIndex);
    const rows = Array.from({ length: count }, () => ({
      id: this.nextInsertedId++,
      payload: createBlankPayload()
    }));

    this.pieces.splice(insertionIndex, 0, {
      kind: "inserted",
      rows
    });
    this.rowCount += rows.length;
    this.normalizePieces();

    return {
      rowKeys: rows.map(row => insertedRowKey(row.id)),
      effects: [
        {
          kind: "rowsInserted",
          startVectorIndex: atVectorIndex,
          count: rows.length
        }
      ]
    };
  }

  deleteRows(rowKeys: readonly string[]): StoreMutationResult {
    const positions = [
      ...new Set(rowKeys.map(rowKey => this.resolveRow(rowKey).vectorIndex))
    ].sort((left, right) => left - right);

    if (positions.length === 0) {
      return { effects: [] };
    }

    const ranges = toContiguousRanges(positions);

    for (const range of [...ranges].reverse()) {
      this.removeRange(range.startVectorIndex, range.count);
    }

    return {
      effects: ranges.map(range => ({
        kind: "rowsDeleted" as const,
        ...range
      }))
    };
  }

  updateCells(
    changes: readonly PatternCellChange[]
  ): StoreMutationResult {
    const planned = new Map<
      string,
      {
        resolved: ResolvedRow;
        before: StoredPayload;
        after: StoredPayload;
      }
    >();

    for (const change of changes) {
      const existing = planned.get(change.rowKey);
      const resolved =
        existing?.resolved ?? this.resolveRow(change.rowKey);
      const before =
        existing?.before ?? clonePayload(resolved.payload);
      const after =
        existing?.after ?? clonePayload(resolved.payload);

      setColumnValue(after, change.columnId, change.value);
      planned.set(change.rowKey, { resolved, before, after });
    }

    const changed = [...planned.values()].filter(
      item => !payloadEquals(item.before, item.after)
    );

    if (changed.length === 0) {
      return { effects: [] };
    }

    for (const item of changed) {
      this.writeResolvedPayload(item.resolved, item.after);
    }

    const vectorIndexes = changed.map(
      item => item.resolved.vectorIndex
    );
    const updatedRows = changed.map(item =>
      this.materialize({
        ...item.resolved,
        payload: item.after
      })
    );

    return {
      updatedRows,
      effects: [
        {
          kind: "cellsUpdated",
          startVectorIndex: Math.min(...vectorIndexes),
          endVectorIndex: Math.max(...vectorIndexes),
          changedCellCount: countChangedCells(changed)
        }
      ]
    };
  }

  paste(options: {
    startRowKey: string;
    columns: readonly PatternEditableColumnId[];
    values: readonly string[][];
  }): StoreMutationResult {
    const startVectorIndex =
      this.resolveRow(options.startRowKey).vectorIndex;
    const existingRowCount = Math.min(
      options.values.length,
      this.rowCount - startVectorIndex
    );
    const changes: PatternCellChange[] = [];

    for (let rowIndex = 0; rowIndex < existingRowCount; rowIndex += 1) {
      const row = this.readRowAt(startVectorIndex + rowIndex);

      for (
        let columnIndex = 0;
        columnIndex < options.columns.length;
        columnIndex += 1
      ) {
        changes.push({
          rowKey: row.rowKey,
          columnId: options.columns[columnIndex],
          value: options.values[rowIndex][columnIndex]
        });
      }
    }

    const updateResult = this.updateCells(changes);
    const appendCount = options.values.length - existingRowCount;

    if (appendCount <= 0) {
      return {
        effects: updateResult.effects
      };
    }

    const inserted = this.insertBlankRows(
      this.rowCount,
      appendCount
    );
    const appendedChanges: PatternCellChange[] = [];

    for (let rowIndex = 0; rowIndex < appendCount; rowIndex += 1) {
      for (
        let columnIndex = 0;
        columnIndex < options.columns.length;
        columnIndex += 1
      ) {
        appendedChanges.push({
          rowKey: inserted.rowKeys[rowIndex],
          columnId: options.columns[columnIndex],
          value:
            options.values[existingRowCount + rowIndex][
              columnIndex
            ]
        });
      }
    }

    const appendedUpdate = this.updateCells(appendedChanges);

    return {
      effects: [
        ...updateResult.effects,
        ...inserted.effects,
        ...appendedUpdate.effects
      ]
    };
  }

  private readRowAt(vectorIndex: number): ResolvedRow {
    if (
      !Number.isInteger(vectorIndex) ||
      vectorIndex < 0 ||
      vectorIndex >= this.rowCount
    ) {
      throw new RangeError(`Vector ${vectorIndex} does not exist.`);
    }

    let pieceStart = 0;

    for (
      let pieceIndex = 0;
      pieceIndex < this.pieces.length;
      pieceIndex += 1
    ) {
      const piece = this.pieces[pieceIndex];
      const length = pieceRowCount(piece);

      if (vectorIndex < pieceStart + length) {
        return this.resolvePieceRow(
          piece,
          pieceIndex,
          vectorIndex - pieceStart,
          vectorIndex
        );
      }

      pieceStart += length;
    }

    throw new RangeError(`Vector ${vectorIndex} does not exist.`);
  }

  private resolveRow(rowKey: string): ResolvedRow {
    const baseSourceIndex = parseRowKey(rowKey, "synthetic");
    const insertedId = parseRowKey(rowKey, "inserted");
    let pieceStart = 0;

    for (
      let pieceIndex = 0;
      pieceIndex < this.pieces.length;
      pieceIndex += 1
    ) {
      const piece = this.pieces[pieceIndex];

      if (
        piece.kind === "base" &&
        baseSourceIndex !== null &&
        baseSourceIndex >= piece.sourceStart &&
        baseSourceIndex < piece.sourceStart + piece.count
      ) {
        const localIndex = baseSourceIndex - piece.sourceStart;
        return this.resolvePieceRow(
          piece,
          pieceIndex,
          localIndex,
          pieceStart + localIndex
        );
      }

      if (piece.kind === "inserted" && insertedId !== null) {
        const localIndex = piece.rows.findIndex(
          row => row.id === insertedId
        );

        if (localIndex >= 0) {
          return this.resolvePieceRow(
            piece,
            pieceIndex,
            localIndex,
            pieceStart + localIndex
          );
        }
      }

      pieceStart += pieceRowCount(piece);
    }

    throw new RangeError(`Row ${rowKey} does not exist.`);
  }

  private resolvePieceRow(
    piece: Piece,
    pieceIndex: number,
    localIndex: number,
    vectorIndex: number
  ): ResolvedRow {
    if (piece.kind === "base") {
      const sourceIndex = piece.sourceStart + localIndex;
      return {
        pieceIndex,
        localIndex,
        vectorIndex,
        sourceIndex,
        rowKey: baseRowKey(sourceIndex),
        payload:
          this.baseOverrides.get(sourceIndex) ??
          createBasePayload(sourceIndex)
      };
    }

    const row = piece.rows[localIndex];
    return {
      pieceIndex,
      localIndex,
      vectorIndex,
      insertedId: row.id,
      rowKey: insertedRowKey(row.id),
      payload: row.payload
    };
  }

  private materialize(resolved: ResolvedRow): PatternRenderRow {
    return {
      rowKey: resolved.rowKey,
      vectorIndex: resolved.vectorIndex,
      cycleText: String(resolved.vectorIndex),
      ...clonePayload(resolved.payload)
    };
  }

  private writeResolvedPayload(
    resolved: ResolvedRow,
    payload: StoredPayload
  ): void {
    if (resolved.sourceIndex !== undefined) {
      this.baseOverrides.set(
        resolved.sourceIndex,
        clonePayload(payload)
      );
      return;
    }

    const piece = this.pieces[resolved.pieceIndex];

    if (piece?.kind !== "inserted") {
      throw new Error("Inserted row piece changed during mutation.");
    }

    piece.rows[resolved.localIndex].payload = clonePayload(payload);
  }

  private splitAt(vectorIndex: number): number {
    if (vectorIndex === this.rowCount) {
      return this.pieces.length;
    }

    let pieceStart = 0;

    for (
      let pieceIndex = 0;
      pieceIndex < this.pieces.length;
      pieceIndex += 1
    ) {
      const piece = this.pieces[pieceIndex];
      const length = pieceRowCount(piece);

      if (vectorIndex === pieceStart) {
        return pieceIndex;
      }

      if (
        vectorIndex > pieceStart &&
        vectorIndex < pieceStart + length
      ) {
        const localIndex = vectorIndex - pieceStart;
        const [left, right] = splitPiece(piece, localIndex);
        this.pieces.splice(pieceIndex, 1, left, right);
        return pieceIndex + 1;
      }

      pieceStart += length;
    }

    throw new RangeError(
      `Insertion vectorIndex ${vectorIndex} is out of range.`
    );
  }

  private removeRange(startVectorIndex: number, count: number): void {
    const endVectorIndex = startVectorIndex + count;
    const next: Piece[] = [];
    let pieceStart = 0;

    for (const piece of this.pieces) {
      const length = pieceRowCount(piece);
      const pieceEnd = pieceStart + length;

      if (
        pieceEnd <= startVectorIndex ||
        pieceStart >= endVectorIndex
      ) {
        next.push(piece);
      } else {
        const leftCount = Math.max(
          0,
          startVectorIndex - pieceStart
        );
        const rightCount = Math.max(
          0,
          pieceEnd - endVectorIndex
        );

        if (leftCount > 0) {
          next.push(slicePiece(piece, 0, leftCount));
        }

        if (rightCount > 0) {
          next.push(
            slicePiece(piece, length - rightCount, length)
          );
        }
      }

      pieceStart = pieceEnd;
    }

    this.pieces = next;
    this.rowCount -= count;
    this.normalizePieces();
  }

  private normalizePieces(): void {
    const normalized: Piece[] = [];

    for (const piece of this.pieces) {
      if (pieceRowCount(piece) === 0) {
        continue;
      }

      const previous = normalized.at(-1);

      if (
        previous?.kind === "base" &&
        piece.kind === "base" &&
        previous.sourceStart + previous.count === piece.sourceStart
      ) {
        previous.count += piece.count;
      } else if (
        previous?.kind === "inserted" &&
        piece.kind === "inserted"
      ) {
        previous.rows.push(...piece.rows);
      } else {
        normalized.push(piece);
      }
    }

    this.pieces = normalized;
  }
}

function pieceRowCount(piece: Piece): number {
  return piece.kind === "base" ? piece.count : piece.rows.length;
}

function splitPiece(piece: Piece, at: number): [Piece, Piece] {
  if (piece.kind === "base") {
    return [
      { ...piece, count: at },
      {
        kind: "base",
        sourceStart: piece.sourceStart + at,
        count: piece.count - at
      }
    ];
  }

  return [
    { kind: "inserted", rows: piece.rows.slice(0, at) },
    { kind: "inserted", rows: piece.rows.slice(at) }
  ];
}

function slicePiece(piece: Piece, start: number, end: number): Piece {
  if (piece.kind === "base") {
    return {
      kind: "base",
      sourceStart: piece.sourceStart + start,
      count: end - start
    };
  }

  return {
    kind: "inserted",
    rows: piece.rows.slice(start, end)
  };
}

function toContiguousRanges(
  positions: readonly number[]
): Array<{ startVectorIndex: number; count: number }> {
  const ranges: Array<{
    startVectorIndex: number;
    count: number;
  }> = [];

  for (const position of positions) {
    const previous = ranges.at(-1);

    if (
      previous &&
      previous.startVectorIndex + previous.count === position
    ) {
      previous.count += 1;
    } else {
      ranges.push({ startVectorIndex: position, count: 1 });
    }
  }

  return ranges;
}

function createBasePayload(sourceIndex: number): StoredPayload {
  const signalValues = {} as Record<SignalId, string>;

  for (let index = 0; index < SIGNAL_IDS.length; index += 1) {
    const selector = (sourceIndex + index * 7) % 13;
    signalValues[SIGNAL_IDS[index]] =
      selector === 0 ? "X" : selector < 6 ? "0" : "1";
  }

  return {
    instruction:
      sourceIndex > 0 && sourceIndex % 1_000 === 0
        ? "repeat 100"
        : "",
    comment:
      sourceIndex % 250 === 0
        ? `Vector ${sourceIndex}`
        : "",
    signalValues
  };
}

function createBlankPayload(): StoredPayload {
  return {
    instruction: "",
    comment: "",
    signalValues: Object.fromEntries(
      SIGNAL_IDS.map(signalId => [signalId, ""])
    ) as Record<SignalId, string>
  };
}

function clonePayload(payload: StoredPayload): StoredPayload {
  return {
    instruction: payload.instruction,
    comment: payload.comment,
    signalValues: { ...payload.signalValues }
  };
}

function payloadEquals(
  left: StoredPayload,
  right: StoredPayload
): boolean {
  return (
    left.instruction === right.instruction &&
    left.comment === right.comment &&
    SIGNAL_IDS.every(
      signalId =>
        left.signalValues[signalId] ===
        right.signalValues[signalId]
    )
  );
}

function setColumnValue(
  payload: StoredPayload,
  columnId: PatternEditableColumnId,
  value: string
): void {
  if (columnId === "instruction") {
    payload.instruction = value;
  } else if (columnId === "comment") {
    payload.comment = value;
  } else {
    payload.signalValues[columnId] = value;
  }
}

function countChangedCells(
  changed: Array<{ before: StoredPayload; after: StoredPayload }>
): number {
  let count = 0;

  for (const item of changed) {
    if (item.before.instruction !== item.after.instruction) count += 1;
    if (item.before.comment !== item.after.comment) count += 1;

    for (const signalId of SIGNAL_IDS) {
      if (
        item.before.signalValues[signalId] !==
        item.after.signalValues[signalId]
      ) {
        count += 1;
      }
    }
  }

  return count;
}

function baseRowKey(sourceIndex: number): string {
  /*
   * 保留只读版已经对外可见的 rowKey。增加编辑能力不能让所有基础行
   * 换身份，否则选区、日志和后续锚点都会出现不必要的迁移成本。
   */
  return `synthetic:${sourceIndex}`;
}

function insertedRowKey(id: number): string {
  return `inserted:${id}`;
}

function parseRowKey(
  rowKey: string,
  prefix: "synthetic" | "inserted"
): number | null {
  const marker = `${prefix}:`;

  if (!rowKey.startsWith(marker)) {
    return null;
  }

  const value = Number(rowKey.slice(marker.length));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validateSnapshot(
  input: SyntheticPatternStoreSnapshot
): SyntheticPatternStoreSnapshot {
  if (!input || !Array.isArray(input.pieces)) {
    throw new RangeError("Synthetic store snapshot is invalid.");
  }

  const insertedIds = new Set<number>();
  const pieces: Piece[] = input.pieces.map(piece => {
    if (
      piece?.kind === "base" &&
      isNonNegativeInteger(piece.sourceStart) &&
      isPositiveInteger(piece.count)
    ) {
      return {
        kind: "base",
        sourceStart: piece.sourceStart,
        count: piece.count
      };
    }

    if (piece?.kind !== "inserted" || !Array.isArray(piece.rows)) {
      throw new RangeError(
        "Synthetic store contains an invalid piece."
      );
    }

    return {
      kind: "inserted",
      rows: piece.rows.map(row => {
        if (
          !isPositiveInteger(row?.id) ||
          insertedIds.has(row.id)
        ) {
          throw new RangeError(
            "Synthetic store contains an invalid inserted row id."
          );
        }

        insertedIds.add(row.id);
        return {
          id: row.id,
          payload: validatePayload(row.payload)
        };
      })
    };
  });
  const baseOverrides = Array.isArray(input.baseOverrides)
    ? input.baseOverrides.map(entry => {
        if (
          !Array.isArray(entry) ||
          !isNonNegativeInteger(entry[0])
        ) {
          throw new RangeError(
            "Synthetic store contains an invalid base override."
          );
        }

        return [
          entry[0],
          validatePayload(entry[1])
        ] as [number, StoredPayload];
      })
    : [];
  let highestInsertedId = 0;

  for (const insertedId of insertedIds) {
    highestInsertedId = Math.max(
      highestInsertedId,
      insertedId
    );
  }
  const nextInsertedId = Math.max(
    highestInsertedId + 1,
    isPositiveInteger(input.nextInsertedId)
      ? input.nextInsertedId
      : 1
  );

  return { pieces, baseOverrides, nextInsertedId };
}

function validatePayload(input: StoredPayload): StoredPayload {
  if (
    !input ||
    typeof input.instruction !== "string" ||
    typeof input.comment !== "string" ||
    !input.signalValues ||
    SIGNAL_IDS.some(
      signalId => typeof input.signalValues[signalId] !== "string"
    )
  ) {
    throw new RangeError(
      "Synthetic store contains an invalid row payload."
    );
  }

  return clonePayload(input);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
