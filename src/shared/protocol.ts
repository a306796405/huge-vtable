/**
 * 阅读等级：A 业务必读
 * 是否迁移：按真实 Pattern 字段调整
 * 前置阅读：README.md
 * 建议只关注：PatternRenderRow、PatternDocumentClient 和 applyMutation
 * 可以跳过：Webview 请求配对消息
 *
 * 窗口读取与写事务共用 rowKey/revision：前端只回传稳定身份，所有新增、
 * 删除、更新和 Paste 都由后端在一个 applyMutation 边界内提交。Undo/Redo
 * 与写事务分开，由 VS Code Custom Editor 历史栈触发后端会话历史。
 */

import type { EditorDiagnosticEntry } from "../diagnostics";

export const SIGNAL_IDS = [
  "SIG_A",
  "SIG_B",
  "SIG_C",
  "SIG_D",
  "SIG_E",
  "SIG_F",
  "SIG_G",
  "SIG_H",
  "SIG_I",
  "SIG_J",
  "SIG_K",
  "SIG_L"
] as const;

export type SignalId = (typeof SIGNAL_IDS)[number];

export type PatternRenderRow = {
  /** 当前打开会话内稳定身份；Webview 只能比较和回传，不能解析。 */
  rowKey: string;
  /** 当前 0-based 逻辑 Vector，与第一版 Go To Offset 的输入一致。 */
  vectorIndex: number;
  /** 后端提供的显示文本；前端不负责计算 Cycle。 */
  cycleText: string;
  instruction: string;
  comment: string;
  signalValues: Record<SignalId, string>;
};

export type PatternMetadata = {
  totalVectors: number;
  revision: number;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

export type PatternWindowRequest = {
  /** 请求窗口第一条 Vector 的 0-based 逻辑位置。 */
  startVectorIndex: number;
  /** 希望读取的 Vector 数量，不是结束位置。 */
  vectorCount: number;
  expectedRevision: number;
};

export type PatternWindowResponse = PatternMetadata & {
  startVectorIndex: number;
  rows: PatternRenderRow[];
};

export type PatternEditableColumnId =
  | "instruction"
  | "comment"
  | SignalId;

export function isPatternEditableColumnId(
  value: unknown
): value is PatternEditableColumnId {
  return (
    value === "instruction" ||
    value === "comment" ||
    (typeof value === "string" &&
      (SIGNAL_IDS as readonly string[]).includes(value))
  );
}

export type PatternCellChange = {
  rowKey: string;
  columnId: PatternEditableColumnId;
  value: string;
};

export type PatternMutationOperation =
  | {
      kind: "insertRows";
      atVectorIndex: number;
      count: number;
    }
  | {
      kind: "deleteRows";
      rowKeys: string[];
    }
  | {
      kind: "updateCells";
      changes: PatternCellChange[];
    }
  | {
      kind: "paste";
      startRowKey: string;
      columns: PatternEditableColumnId[];
      values: string[][];
    };

export type PatternMutationRequest = {
  baseRevision: number;
  operation: PatternMutationOperation;
};

export type PatternMutationEffect =
  | {
      kind: "rowsInserted";
      startVectorIndex: number;
      count: number;
    }
  | {
      kind: "rowsDeleted";
      startVectorIndex: number;
      count: number;
    }
  | {
      kind: "cellsUpdated";
      startVectorIndex: number;
      endVectorIndex: number;
      changedCellCount: number;
    };

export type PatternMutationResponse = PatternMetadata & {
  operationKind: PatternMutationOperation["kind"];
  previousRevision: number;
  effects: PatternMutationEffect[];
  updatedRows?: PatternRenderRow[];
  message: string;
};

export type PatternHistoryDirection = "undo" | "redo";

export type PatternHistoryResponse = PatternMetadata & {
  previousRevision: number;
  effects: PatternMutationEffect[];
  message: string;
};

export interface PatternDocumentClient {
  getMetadata(): Promise<PatternMetadata>;
  getWindow(request: PatternWindowRequest): Promise<PatternWindowResponse>;
  applyMutation(
    request: PatternMutationRequest
  ): Promise<PatternMutationResponse>;
  runHistory(
    direction: PatternHistoryDirection
  ): Promise<PatternMetadata>;
  onDidChangeDocumentState?(
    listener: (event: PatternDocumentStateEvent) => void
  ): () => void;
  /**
   * Webview 只上报诊断上下文，不上报行、单元格或剪贴板内容。
   * 浏览器 Demo 可以不实现；VS Code client 会转发到 LogOutputChannel。
   */
  reportDiagnostic?(entry: EditorDiagnosticEntry): void;
  dispose?(): void;
}

export type PatternDocumentStateEvent = {
  action: "saved" | "reverted" | "undone" | "redone";
  metadata: PatternMetadata;
  effects?: PatternMutationEffect[];
  message?: string;
};

export type PatternCommand =
  | "getMetadata"
  | "getWindow"
  | "applyMutation"
  | "runHistory";

export type PatternRequestPayloadMap = {
  getMetadata: undefined;
  getWindow: PatternWindowRequest;
  applyMutation: PatternMutationRequest;
  runHistory: PatternHistoryDirection;
};

export type PatternResponsePayloadMap = {
  getMetadata: PatternMetadata;
  getWindow: PatternWindowResponse;
  applyMutation: PatternMutationResponse;
  runHistory: PatternMetadata;
};

export type WebviewRequestMessage = {
  kind: "request";
  id: number;
  command: PatternCommand;
  payload?: PatternRequestPayloadMap[PatternCommand];
};

export type PatternRequestError = {
  code: "REVISION_CONFLICT" | "VALIDATION_ERROR" | "INTERNAL_ERROR";
  message: string;
  currentRevision?: number;
};

export type ExtensionResponseMessage =
  | {
      kind: "response";
      id: number;
      ok: true;
      payload: PatternResponsePayloadMap[PatternCommand];
    }
  | {
      kind: "response";
      id: number;
      ok: false;
      error: PatternRequestError;
    };

export type ExtensionDocumentStateMessage = {
  kind: "documentState";
  event: PatternDocumentStateEvent;
};

export type ExtensionToWebviewMessage =
  | ExtensionResponseMessage
  | ExtensionDocumentStateMessage;

export type WebviewDiagnosticMessage = {
  kind: "diagnostic";
  entry: EditorDiagnosticEntry;
};

export type WebviewToExtensionMessage =
  | WebviewRequestMessage
  | WebviewDiagnosticMessage;
