/**
 * 阅读等级：B 接口必读
 * 是否迁移：是
 * 前置阅读：无
 * 建议只关注：EditorDiagnostics.report / recovered / record
 * 可以跳过：文本清理和关联 ID 生成
 *
 * 与 React、VTable、Pattern 字段和 VS Code 无关的诊断核心。业务只提交
 * “哪里、什么操作、哪个阶段、发生了什么错误”，本模块统一生成关联 ID、
 * 时间、错误码和安全文本；调用方不得把行、单元格或剪贴板载荷传进来。
 */

export type EditorDiagnosticLevel = "info" | "warn" | "error";

export type EditorDiagnosticEntry = {
  correlationId: string;
  timestamp: string;
  level: EditorDiagnosticLevel;
  area: string;
  operation: string;
  phase: string;
  revision?: number;
  windowStartVectorIndex?: number;
  requestId?: string | number;
  code: string;
  message: string;
  stack?: string;
  suppressedCount?: number;
};

export type EditorDiagnosticIssue = {
  area: string;
  operation: string;
  phase: string;
  error?: unknown;
  level?: EditorDiagnosticLevel;
  code?: string;
  message?: string;
  correlationId?: string;
  requestId?: string | number;
};

export type EditorDiagnosticContext = {
  revision?: number;
  windowStartVectorIndex?: number;
};

export interface EditorDiagnosticSink {
  write(entry: EditorDiagnosticEntry): void;
}

export interface EditorDiagnostics {
  report(issue: EditorDiagnosticIssue): string;
  recovered(options: {
    area: string;
    operation: string;
    phase: string;
    correlationId: string;
    message?: string;
  }): void;
  /** 接收另一个进程已经标准化的诊断，例如 Webview → Extension。 */
  record(entry: EditorDiagnosticEntry): void;
}

export function createEditorDiagnostics(options: {
  sink: EditorDiagnosticSink;
  getContext?(): EditorDiagnosticContext;
  idPrefix?: string;
}): EditorDiagnostics {
  let nextId = 1;

  const createCorrelationId = () =>
    `${options.idPrefix ?? "PE"}-${Date.now().toString(36)}-${nextId++}`;

  const report = (issue: EditorDiagnosticIssue): string => {
    const correlationId =
      issue.correlationId ?? createCorrelationId();
    const context = options.getContext?.() ?? {};
    const detail = toSafeErrorDetail(issue.error);
    const entry: EditorDiagnosticEntry = {
      correlationId,
      timestamp: new Date().toISOString(),
      level: issue.level ?? "error",
      area: sanitizeDiagnosticText(issue.area, 80),
      operation: sanitizeDiagnosticText(
        issue.operation,
        80
      ),
      phase: sanitizeDiagnosticText(issue.phase, 80),
      revision: context.revision,
      windowStartVectorIndex:
        context.windowStartVectorIndex,
      requestId: issue.requestId,
      code: sanitizeDiagnosticText(
        issue.code ?? detail.code,
        80
      ),
      message: sanitizeDiagnosticText(
        issue.message ?? detail.message,
        500
      ),
      stack: detail.stack
        ? sanitizeDiagnosticText(detail.stack, 2_000)
        : undefined
    };

    options.sink.write(entry);
    return correlationId;
  };

  return {
    report,
    recovered(recovery) {
      report({
        area: recovery.area,
        operation: recovery.operation,
        phase: recovery.phase,
        correlationId: recovery.correlationId,
        level: "info",
        code: "RECOVERED",
        message:
          recovery.message ??
          "Authoritative metadata and viewport synchronized."
      });
    },
    record(entry) {
      /*
       * 跨进程 entry 仍重新清理文本，不能假设 Webview 或未来 C++ 调用方
       * 已经正确脱敏。结构中没有 rows/cells/clipboard/payload 字段。
       */
      options.sink.write({
        ...entry,
        correlationId: sanitizeDiagnosticText(
          entry.correlationId,
          80
        ),
        area: sanitizeDiagnosticText(entry.area, 80),
        operation: sanitizeDiagnosticText(
          entry.operation,
          80
        ),
        phase: sanitizeDiagnosticText(entry.phase, 80),
        code: sanitizeDiagnosticText(entry.code, 80),
        message: sanitizeDiagnosticText(entry.message, 500),
        stack: entry.stack
          ? sanitizeDiagnosticText(entry.stack, 2_000)
          : undefined
      });
    }
  };
}

export function sanitizeDiagnosticText(
  value: unknown,
  maximumLength: number
): string {
  return String(value)
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
      ""
    )
    .replace(
      /\b(?:clipboard|paste|cell|row|value|content|payload|data)\s*[:=]\s*[^,;]*/gi,
      match => `${match.split(/[:=]/, 1)[0]}=<redacted>`
    )
    .slice(0, maximumLength);
}

function toSafeErrorDetail(error: unknown): {
  code: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      code: readErrorCode(error) ?? error.name ?? "CLIENT_ERROR",
      message: error.message || error.name,
      stack: error.stack
    };
  }

  return {
    code: readErrorCode(error) ?? "CLIENT_ERROR",
    message:
      typeof error === "string"
        ? error
        : "Editor operation failed."
  };
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate =
    "detail" in error &&
    error.detail &&
    typeof error.detail === "object" &&
    "code" in error.detail
      ? error.detail.code
      : "code" in error
        ? error.code
        : undefined;

  return typeof candidate === "string"
    ? candidate
    : undefined;
}
