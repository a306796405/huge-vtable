/**
 * 阅读等级：B 接口必读
 * 是否迁移：是
 * 前置阅读：editorDiagnostics.ts
 * 建议只关注：createVscodeEditorDiagnostics
 * 可以跳过：30 秒重复限流和输出文本格式
 *
 * 这是 diagnostics 唯一依赖 VS Code API 的文件。日志写入 LogOutputChannel，
 * 不创建项目日志文件；正常滚动、绘制和 cache hit 不经过这里。
 */

import * as vscode from "vscode";
import {
  createEditorDiagnostics,
  type EditorDiagnosticEntry,
  type EditorDiagnosticSink,
  type EditorDiagnostics
} from "./editorDiagnostics";

const DUPLICATE_WINDOW_MS = 30_000;

type RateLimitState = {
  lastWrittenAt: number;
  suppressedCount: number;
};

export function createVscodeEditorDiagnostics(
  output: vscode.LogOutputChannel
): EditorDiagnostics {
  const states = new Map<string, RateLimitState>();
  const sink: EditorDiagnosticSink = {
    write(entry) {
      const now = Date.now();
      const key = duplicateKey(entry);
      const state = states.get(key);

      if (
        state &&
        now - state.lastWrittenAt < DUPLICATE_WINDOW_MS
      ) {
        state.suppressedCount += 1;
        return;
      }

      const suppressedCount = state?.suppressedCount ?? 0;
      states.set(key, {
        lastWrittenAt: now,
        suppressedCount: 0
      });
      if (states.size > 500) {
        const oldestKey = states.keys().next().value;

        if (oldestKey) {
          states.delete(oldestKey);
        }
      }
      writeToOutput(output, {
        ...entry,
        suppressedCount:
          suppressedCount > 0
            ? suppressedCount
            : entry.suppressedCount
      });
    }
  };

  return createEditorDiagnostics({
    sink,
    idPrefix: "PE-HOST"
  });
}

function duplicateKey(entry: EditorDiagnosticEntry): string {
  return [
    entry.level,
    entry.area,
    entry.operation,
    entry.phase,
    entry.code,
    entry.message
  ].join("|");
}

function writeToOutput(
  output: vscode.LogOutputChannel,
  entry: EditorDiagnosticEntry
): void {
  const request = entry.requestId
    ? ` request=${entry.requestId}`
    : "";
  const revision =
    entry.revision === undefined
      ? ""
      : ` revision=${entry.revision}`;
  const windowStart =
    entry.windowStartVectorIndex === undefined
      ? ""
      : ` window=${entry.windowStartVectorIndex}`;
  const suppressed = entry.suppressedCount
    ? ` suppressed=${entry.suppressedCount}`
    : "";
  const stack = entry.stack ? `\n${entry.stack}` : "";
  const line =
    `[${entry.correlationId}] ${entry.area}/` +
    `${entry.operation}/${entry.phase} ${entry.code}` +
    `${request}${revision}${windowStart}${suppressed}: ` +
    `${entry.message}${stack}`;

  if (entry.level === "error") {
    output.error(line);
  } else if (entry.level === "warn") {
    output.warn(line);
  } else {
    output.info(line);
  }
}
