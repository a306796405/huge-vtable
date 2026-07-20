/**
 * 阅读等级：A 业务必读
 * 是否迁移：按真实插件桥接方式复用
 * 前置阅读：shared/protocol.ts
 * 建议只关注：getMetadata/getWindow 与请求 id 配对
 * 可以跳过：dispose 时拒绝 pending 的样板
 */

import type {
  ExtensionResponseMessage,
  PatternMetadata,
  PatternReadClient,
  PatternReadCommand,
  PatternWindowRequest,
  PatternWindowResponse,
  ReadRequestError,
  WebviewRequestMessage
} from "../shared/protocol";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

type PendingRequest = {
  command: PatternReadCommand;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export class PatternReadRequestError extends Error {
  constructor(
    readonly detail: ReadRequestError,
    readonly command: PatternReadCommand
  ) {
    super(detail.message);
    this.name = "PatternReadRequestError";
  }
}

export function createVsCodePatternReadClient(): PatternReadClient {
  const vscode = acquireVsCodeApi();
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let disposed = false;

  const handleMessage = (
    event: MessageEvent<ExtensionResponseMessage>
  ) => {
    const message = event.data;

    if (
      !message ||
      message.kind !== "response" ||
      !pending.has(message.id)
    ) {
      return;
    }

    const request = pending.get(message.id)!;
    pending.delete(message.id);

    if (message.ok) {
      request.resolve(message.payload);
      return;
    }

    request.reject(
      new PatternReadRequestError(message.error, request.command)
    );
  };

  window.addEventListener("message", handleMessage);

  function request<T>(
    command: PatternReadCommand,
    payload?: PatternWindowRequest
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

      pending.set(id, {
        command,
        resolve: value => resolve(value as T),
        reject
      });
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
    dispose() {
      disposed = true;
      window.removeEventListener("message", handleMessage);

      for (const request of pending.values()) {
        request.reject(
          new Error("Pattern read client was disposed.")
        );
      }

      pending.clear();
    }
  };
}
