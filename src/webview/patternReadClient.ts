/**
 * 阅读等级：A 业务必读
 * 是否迁移：按真实插件桥接方式复用
 * 前置阅读：shared/protocol.ts
 * 建议只关注：三条 DocumentClient 方法与请求 id 配对
 * 可以跳过：dispose 时拒绝 pending 的样板
 */

import type {
  ExtensionToWebviewMessage,
  PatternCommand,
  PatternDocumentClient,
  PatternDocumentStateEvent,
  PatternHistoryDirection,
  PatternMetadata,
  PatternMutationRequest,
  PatternMutationResponse,
  PatternRequestError,
  PatternRequestPayloadMap,
  PatternWindowRequest,
  PatternWindowResponse,
  WebviewRequestMessage,
  WebviewToExtensionMessage
} from "../shared/protocol";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

type PendingRequest = {
  command: PatternCommand;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeoutId?: number;
};

const SAFE_READ_TIMEOUT_MS = 15_000;

export class PatternRequestFailedError extends Error {
  constructor(
    readonly detail: PatternRequestError,
    readonly command: PatternCommand
  ) {
    super(detail.message);
    this.name = "PatternRequestFailedError";
  }
}

export function createVsCodePatternClient(): PatternDocumentClient {
  const vscode = acquireVsCodeApi();
  const pending = new Map<number, PendingRequest>();
  const documentStateListeners = new Set<
    (event: PatternDocumentStateEvent) => void
  >();
  let nextId = 1;
  let disposed = false;

  const handleMessage = (
    event: MessageEvent<ExtensionToWebviewMessage>
  ) => {
    const message = event.data;

    if (message?.kind === "documentState") {
      for (const listener of documentStateListeners) {
        listener(message.event);
      }

      return;
    }

    if (
      !message ||
      message.kind !== "response" ||
      !pending.has(message.id)
    ) {
      return;
    }

    const request = pending.get(message.id)!;
    pending.delete(message.id);
    if (request.timeoutId !== undefined) {
      window.clearTimeout(request.timeoutId);
    }

    if (message.ok) {
      request.resolve(message.payload);
      return;
    }

    request.reject(
      new PatternRequestFailedError(message.error, request.command)
    );
  };

  window.addEventListener("message", handleMessage);

  function request<T>(
    command: PatternCommand,
    payload?: PatternRequestPayloadMap[PatternCommand]
  ): Promise<T> {
    if (disposed) {
      return Promise.reject(
        new Error("Pattern read client has been disposed.")
      );
    }

    return new Promise<T>((resolve, reject) => {
      const id = nextId++;
      const message: WebviewRequestMessage = {
        kind: "request",
        id,
        command,
        payload
      };

      const pendingRequest: PendingRequest = {
        command,
        resolve: value => resolve(value as T),
        reject
      };

      if (command === "getMetadata" || command === "getWindow") {
        pendingRequest.timeoutId = window.setTimeout(() => {
          if (pending.get(id) !== pendingRequest) {
            return;
          }

          pending.delete(id);
          reject(
            new Error(
              `${command} timed out after ${SAFE_READ_TIMEOUT_MS} ms.`
            )
          );
        }, SAFE_READ_TIMEOUT_MS);
      }

      pending.set(id, pendingRequest);
      vscode.postMessage(message);
    });
  }

  return {
    getMetadata() {
      return request<PatternMetadata>("getMetadata");
    },
    getWindow(windowRequest) {
      return request<PatternWindowResponse>(
        "getWindow",
        windowRequest
      );
    },
    applyMutation(mutationRequest: PatternMutationRequest) {
      return request<PatternMutationResponse>(
        "applyMutation",
        mutationRequest
      );
    },
    runHistory(direction: PatternHistoryDirection) {
      return request<PatternMetadata>(
        "runHistory",
        direction
      );
    },
    reportClientLog(entry) {
      const message: WebviewToExtensionMessage = {
        kind: "clientLog",
        entry
      };
      vscode.postMessage(message);
    },
    onDidChangeDocumentState(listener) {
      documentStateListeners.add(listener);
      return () => documentStateListeners.delete(listener);
    },
    dispose() {
      disposed = true;
      window.removeEventListener("message", handleMessage);

      for (const request of pending.values()) {
        if (request.timeoutId !== undefined) {
          window.clearTimeout(request.timeoutId);
        }
        request.reject(
          new Error("Pattern read client was disposed.")
        );
      }

      pending.clear();
      documentStateListeners.clear();
    }
  };
}
