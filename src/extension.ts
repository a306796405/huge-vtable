/**
 * 阅读等级：A 业务必读
 * 是否迁移：是
 * 前置阅读：extension/patternEditorProvider.ts
 * 建议只关注：supportsMultipleEditorsPerDocument=false
 * 可以跳过：activate/deactivate 样板
 */

import * as vscode from "vscode";
import { PatternEditorProvider } from "./extension/patternEditorProvider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(
    "Pattern Editor Lite",
    { log: true }
  );
  const provider = new PatternEditorProvider(
    context.extensionUri,
    output
  );

  context.subscriptions.push(
    output,
    provider,
    vscode.window.registerCustomEditorProvider(
      PatternEditorProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        },
        supportsMultipleEditorsPerDocument: false
      }
    )
  );
}

export function deactivate(): void {}
