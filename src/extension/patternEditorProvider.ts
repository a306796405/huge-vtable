/**
 * 阅读等级：A 业务必读
 * 是否迁移：是
 * 前置阅读：patternBackend.ts、shared/protocol.ts
 * 建议只关注：请求路由、dirty 事件、Save/Revert/Backup
 * 可以跳过：CSP nonce 和 HTML 模板
 *
 * 一个 .pat 只对应一个 PatternEditableDocument 和一个 webview panel。
 * provider 负责 VS Code 文件生命周期，字段校验和事务仍属于 backend。
 */

import * as vscode from "vscode";
import { SyntheticPatternBackend } from "../dev-only/syntheticPatternBackend";
import type {
  ExtensionResponseMessage,
  ExtensionToWebviewMessage,
  PatternDocumentStateEvent,
  PatternHistoryDirection,
  PatternHistoryResponse,
  PatternMutationRequest,
  PatternRequestError,
  PatternWindowRequest,
  WebviewRequestMessage
} from "../shared/protocol";
import type { PatternBackend } from "./patternBackend";

class PatternEditableDocument implements vscode.CustomDocument {
  panel: vscode.WebviewPanel | undefined;

  constructor(
    readonly uri: vscode.Uri,
    public backend: PatternBackend
  ) {}

  dispose(): void {
    this.backend.dispose?.();
    this.panel = undefined;
  }
}

export class PatternEditorProvider
  implements
    vscode.CustomEditorProvider<PatternEditableDocument>,
    vscode.Disposable
{
  static readonly viewType = "patternEditorLite.patEditor";

  private readonly changeEmitter =
    new vscode.EventEmitter<
      vscode.CustomDocumentEditEvent<PatternEditableDocument>
    >();

  readonly onDidChangeCustomDocument =
    this.changeEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.LogOutputChannel
  ) {}

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken
  ): Promise<PatternEditableDocument> {
    const restoredFromBackup = Boolean(openContext.backupId);
    const bytes =
      openContext.untitledDocumentData ??
      (await vscode.workspace.fs.readFile(
        openContext.backupId
          ? vscode.Uri.parse(openContext.backupId)
          : uri
      ));

    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    return new PatternEditableDocument(
      uri,
      SyntheticPatternBackend.fromBytes(bytes, {
        isDirty: restoredFromBackup
      })
    );
  }

  async resolveCustomEditor(
    document: PatternEditableDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const webviewRoot = vscode.Uri.joinPath(
      this.extensionUri,
      "dist",
      "webview"
    );

    document.panel = panel;
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
    panel.onDidDispose(() => {
      receiveDisposable.dispose();

      if (document.panel === panel) {
        document.panel = undefined;
      }
    });
    panel.webview.html = createWebviewHtml(
      panel.webview,
      this.extensionUri
    );
  }

  async saveCustomDocument(
    document: PatternEditableDocument,
    token: vscode.CancellationToken
  ): Promise<void> {
    await this.writeDocument(document, document.uri, token);
    await this.postDocumentState(document, "saved");
  }

  async saveCustomDocumentAs(
    document: PatternEditableDocument,
    destination: vscode.Uri,
    token: vscode.CancellationToken
  ): Promise<void> {
    await this.writeDocument(document, destination, token);
    await this.postDocumentState(document, "saved");
  }

  async revertCustomDocument(
    document: PatternEditableDocument,
    token: vscode.CancellationToken
  ): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(document.uri);

    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    const previousBackend = document.backend;
    document.backend = SyntheticPatternBackend.fromBytes(bytes);
    previousBackend.dispose?.();
    await this.postDocumentState(document, "reverted");
  }

  async backupCustomDocument(
    document: PatternEditableDocument,
    context: vscode.CustomDocumentBackupContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    const bytes = await document.backend.serialize();

    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    await vscode.workspace.fs.createDirectory(
      parentUri(context.destination)
    );
    await vscode.workspace.fs.writeFile(
      context.destination,
      bytes
    );

    return {
      id: context.destination.toString(),
      delete: () => {
        void vscode.workspace.fs.delete(context.destination).then(
          () => undefined,
          () => undefined
        );
      }
    };
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private async writeDocument(
    document: PatternEditableDocument,
    destination: vscode.Uri,
    token: vscode.CancellationToken
  ): Promise<void> {
    const bytes = await document.backend.serialize();

    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    await vscode.workspace.fs.writeFile(destination, bytes);
    document.backend.markSaved();
  }

  private async handleMessage(
    document: PatternEditableDocument,
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
        case "applyMutation": {
          if (!message.payload) {
            throw new RangeError(
              "applyMutation payload is required."
            );
          }

          const result = await document.backend.applyMutation(
            message.payload as PatternMutationRequest
          );
          await respond(webview, {
            kind: "response",
            id: message.id,
            ok: true,
            payload: result
          });

          if (result.revision !== result.previousRevision) {
            this.changeEmitter.fire({
              document,
              label: result.message,
              undo: async () => {
                await this.applyHistory(
                  document,
                  "undo"
                );
              },
              redo: async () => {
                await this.applyHistory(
                  document,
                  "redo"
                );
              }
            });
          }

          return;
        }
        case "runHistory": {
          if (
            message.payload !== "undo" &&
            message.payload !== "redo"
          ) {
            throw new RangeError(
              "runHistory payload must be undo or redo."
            );
          }

          /*
           * 工具栏也走 VS Code 原生命令，让它和 Cmd/Ctrl+Z 共用同一条
           * CustomDocumentEditEvent 历史链，避免 Webview 自建第二套栈。
           */
          await vscode.commands.executeCommand(
            message.payload as PatternHistoryDirection
          );
          await respond(webview, {
            kind: "response",
            id: message.id,
            ok: true,
            payload: await document.backend.getMetadata()
          });
          return;
        }
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

  private async postDocumentState(
    document: PatternEditableDocument,
    action: PatternDocumentStateEvent["action"],
    history?: PatternHistoryResponse
  ): Promise<void> {
    if (!document.panel) {
      return;
    }

    const message: ExtensionToWebviewMessage = {
      kind: "documentState",
      event: {
        action,
        metadata:
          history ?? (await document.backend.getMetadata()),
        effects: history?.effects,
        message: history?.message
      }
    };
    await document.panel.webview.postMessage(message);
  }

  private async applyHistory(
    document: PatternEditableDocument,
    direction: PatternHistoryDirection
  ): Promise<void> {
    try {
      const result =
        direction === "undo"
          ? await document.backend.undo()
          : await document.backend.redo();

      await this.postDocumentState(
        document,
        direction === "undo" ? "undone" : "redone",
        result
      );
    } catch (error) {
      this.output.error(
        `[history:${direction}] failed`,
        error
      );
      throw error;
    }
  }
}

function parentUri(uri: vscode.Uri): vscode.Uri {
  const separatorIndex = uri.path.lastIndexOf("/");

  return uri.with({
    path:
      separatorIndex > 0
        ? uri.path.slice(0, separatorIndex)
        : "/"
  });
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
