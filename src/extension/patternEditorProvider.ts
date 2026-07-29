/**
 * 阅读等级：A 业务必读
 * 是否迁移：是
 * 前置阅读：patternBackend.ts、shared/protocol.ts
 * 建议只关注：请求路由、VS Code 历史、Save/Revert/Backup
 * 可以跳过：CSP nonce 和 HTML 模板
 *
 * 一个 .pat 只对应一个 PatternEditableDocument 和一个 webview panel。
 * provider 负责 VS Code 文件生命周期，字段校验和事务仍属于 backend。
 */

import * as vscode from "vscode";
import type { EditorDiagnostics } from "../diagnostics";
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
  WebviewToExtensionMessage
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
    private readonly diagnostics: EditorDiagnostics
  ) {}

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken
  ): Promise<PatternEditableDocument> {
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
      SyntheticPatternBackend.fromBytes(bytes)
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
          rawMessage as WebviewToExtensionMessage
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
  }

  async saveCustomDocumentAs(
    document: PatternEditableDocument,
    destination: vscode.Uri,
    token: vscode.CancellationToken
  ): Promise<void> {
    await this.writeDocument(document, destination, token);
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
  }

  private async handleMessage(
    document: PatternEditableDocument,
    webview: vscode.Webview,
    message: WebviewToExtensionMessage
  ): Promise<void> {
    if (message?.kind === "diagnostic") {
      this.diagnostics.record(message.entry);
      return;
    }

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

          if (result.revision !== result.previousRevision) {
            /*
             * 后端提交成功后先登记 VS Code 历史，再回复 Webview。即使回复
             * 通道随后失败，这次写入仍可 Undo，前端则通过只读恢复确认
             * 权威 revision；绝不重新发送同一 mutation。
             */
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

          await respond(webview, {
            kind: "response",
            id: message.id,
            ok: true,
            payload: result
          });

          return;
        }
      }
    } catch (error) {
      let currentRevision = 0;

      try {
        currentRevision = (
          await document.backend.getMetadata()
        ).revision;
      } catch (metadataError) {
        this.diagnostics.report({
          area: "provider",
          operation: message.command,
          phase: "readMetadataAfterError",
          requestId: message.id,
          error: metadataError
        });
      }

      const responseError = toPatternRequestError(
        error,
        currentRevision
      );

      this.diagnostics.report({
        area: "provider",
        operation: message.command,
        phase: "request",
        requestId: message.id,
        error
      });
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
      this.diagnostics.report({
        area: "provider",
        operation: direction,
        phase: "history",
        error
      });
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
