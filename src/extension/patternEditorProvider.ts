/**
 * 阅读等级：A 业务必读
 * 是否迁移：是
 * 前置阅读：patternBackend.ts、shared/protocol.ts
 * 建议只关注：打开文档、两条请求路由和单编辑器注册
 * 可以跳过：CSP nonce
 *
 * 第一版使用 CustomReadonlyEditorProvider，因此没有 save、backup、undo 或
 * dirty 生命周期。未来切到可编辑 provider 时，Webview 的只读窗口链路不变。
 */

import * as vscode from "vscode";
import { SyntheticPatternBackend } from "../dev-only/syntheticPatternBackend";
import type {
  ExtensionResponseMessage,
  PatternMutationRequest,
  PatternRequestError,
  PatternWindowRequest,
  WebviewRequestMessage
} from "../shared/protocol";
import type { PatternBackend } from "./patternBackend";

class PatternReadonlyDocument implements vscode.CustomDocument {
  constructor(
    readonly uri: vscode.Uri,
    readonly backend: PatternBackend
  ) {}

  dispose(): void {
    this.backend.dispose?.();
  }
}

export class PatternEditorProvider
  implements
    vscode.CustomReadonlyEditorProvider<PatternReadonlyDocument>
{
  static readonly viewType = "patternEditorLite.patEditor";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.LogOutputChannel
  ) {}

  async openCustomDocument(
    uri: vscode.Uri
  ): Promise<PatternReadonlyDocument> {
    const totalVectors = await readSyntheticTotalVectors(uri);

    return new PatternReadonlyDocument(
      uri,
      new SyntheticPatternBackend({ totalVectors })
    );
  }

  async resolveCustomEditor(
    document: PatternReadonlyDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const webviewRoot = vscode.Uri.joinPath(
      this.extensionUri,
      "dist",
      "webview"
    );

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot]
    };

    const receiveDisposable =
      panel.webview.onDidReceiveMessage(rawMessage => {
        void this.handleMessage(
          document,
          panel.webview,
          rawMessage as WebviewRequestMessage
        );
      });
    panel.onDidDispose(() => receiveDisposable.dispose());
    panel.webview.html = createWebviewHtml(
      panel.webview,
      this.extensionUri
    );
  }

  private async handleMessage(
    document: PatternReadonlyDocument,
    webview: vscode.Webview,
    message: WebviewRequestMessage
  ): Promise<void> {
    if (!message || message.kind !== "request") {
      return;
    }

    try {
      switch (message.command) {
        case "getMetadata":
          await respond(webview, {
            kind: "response",
            id: message.id,
            ok: true,
            payload: await document.backend.getMetadata()
          });
          return;
        case "getWindow":
          if (!message.payload) {
            throw new RangeError("getWindow payload is required.");
          }

          await respond(webview, {
            kind: "response",
            id: message.id,
            ok: true,
            payload: await document.backend.getWindow(
              message.payload as PatternWindowRequest
            )
          });
          return;
        case "applyMutation":
          if (!message.payload) {
            throw new RangeError(
              "applyMutation payload is required."
            );
          }

          await respond(webview, {
            kind: "response",
            id: message.id,
            ok: true,
            payload: await document.backend.applyMutation(
              message.payload as PatternMutationRequest
            )
          });
          return;
      }
    } catch (error) {
      const responseError = toPatternRequestError(
        error,
        (await document.backend.getMetadata()).revision
      );

      this.output.error(
        `[request:${message.id}] ${message.command} failed`,
        error
      );
      await respond(webview, {
        kind: "response",
        id: message.id,
        ok: false,
        error: responseError
      });
    }
  }
}

async function readSyntheticTotalVectors(
  uri: vscode.Uri
): Promise<number> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(
      new TextDecoder().decode(bytes)
    ) as { totalVectors?: unknown };

    return typeof parsed.totalVectors === "number"
      ? parsed.totalVectors
      : 100_000_000;
  } catch {
    return 100_000_000;
  }
}

function toPatternRequestError(
  error: unknown,
  currentRevision: number
): PatternRequestError {
  const message =
    error instanceof Error
      ? error.message
      : "Pattern request failed.";

  if (message.startsWith("REVISION_CONFLICT:")) {
    return {
      code: "REVISION_CONFLICT",
      message,
      currentRevision
    };
  }

  if (error instanceof RangeError || error instanceof TypeError) {
    return {
      code: "VALIDATION_ERROR",
      message,
      currentRevision
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message,
    currentRevision
  };
}

async function respond(
  webview: vscode.Webview,
  response: ExtensionResponseMessage
): Promise<void> {
  await webview.postMessage(response);
}

function createWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      extensionUri,
      "dist",
      "webview",
      "index.js"
    )
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      extensionUri,
      "dist",
      "webview",
      "index.css"
    )
  );
  const nonce = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
  /*
   * Extension Development Host 会缓存 vscode-webview 资源。给每个 panel
   * 的 bundle URL 增加版本参数，重新构建并 Reload Window 后就不会继续
   * 使用旧 Canvas 逻辑；正式插件中也只影响一次本地资源读取。
   */
  const assetVersion = Date.now().toString(36);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}?v=${assetVersion}" />
    <title>Pattern Editor Lite</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" type="module" src="${scriptUri}?v=${assetVersion}"></script>
  </body>
</html>`;
}
