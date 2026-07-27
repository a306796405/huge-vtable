/**
 * 阅读等级：B 接口必读
 * 是否迁移：是
 * 前置阅读：无
 * 建议只关注：createEditorDiagnostics 和类型导出
 * 可以跳过：实现细节
 *
 * 浏览器安全入口。VS Code Extension 请从 vscodeEditorDiagnostics.ts 导入
 * 宿主实现，避免 Webview bundle 引入 `vscode` 模块。
 */

export {
  createEditorDiagnostics,
  sanitizeDiagnosticText,
  type EditorDiagnosticContext,
  type EditorDiagnosticEntry,
  type EditorDiagnosticIssue,
  type EditorDiagnosticLevel,
  type EditorDiagnosticSink,
  type EditorDiagnostics
} from "./editorDiagnostics";
