# 相对 v22-lite 只读版的变化

## 如何比较

本目录有独立 Git 历史：

```bash
git log --oneline --decorate
git diff v22-lite-readonly-baseline..v22-lite-editable-final -- src
git show 4c39ad1 --stat
git show 5b27503 --stat
git show 5b27503
```

建议先看每次 `--stat`，再只打开关心的文件，不要从完整 diff 开始。

## 代码量为什么增加

不再记录容易随注释和验收工具失效的精确行数。相对只读版，主要增量来自：

- `src/dev-only/syntheticPatternStore.ts` 约 925 行。它为了在 1 亿基础行上
  演示插入、删除、Paste 和持久化，实现了可校验的稀疏 piece store；真实
  Pattern 迁移时由 C++ backend 替换，不进入产品 Webview。
- `logicalViewport.ts` 和 `usePatternViewport.ts` 用于 staged reload、视口
  补偿、局部更新、统一日志和权威失败恢复。
- Editable Custom Editor 的 Save、Save As、Backup、Revert 生命周期不能由
  普通网页代替。
- VS Code Clipboard 和 CustomDocumentEditEvent 历史需要插件宿主协作。

因此没有为了压缩物理行数删除事务校验或把逻辑重新糅进 React 组件。通用
Surface/adapter、Pattern binding、controller 和参考 backend 仍保持清楚边界。

## 演进阶段

| 阶段 | 内容 | 阅读建议 |
| --- | --- | --- |
| baseline | 原只读版快照 | 用来确认没有改原项目 |
| viewport fix | 删除末尾 padding、统一 Index/Px 命名 | 重点看 viewport 和 adapter |
| editable mutations | 右键、双击、Paste、统一事务 | 重点看 protocol 和 controller |
| persistence | Editable Provider、Save/Revert、文档 | 真实插件接入必读 |
| plugin input | VS Code Clipboard、单编辑器 | 重点看 adapter 和 provider |
| history | CustomDocumentEditEvent Undo/Redo | 前端不保存历史栈 |
| recovery | 错误 ID、日志、single-flight 同步 | 业务调用方无需补失败分支 |

## 新增文件

| 文件 | 原因 | 迁移真实业务 |
| --- | --- | --- |
| `src/webview/clipboardTsv.ts` | 剪贴板 TSV 解析 | 是 |
| `src/dev-only/syntheticPatternStore.ts` | 亿级 synthetic 的稀疏可编辑存储 | 否，C++ 替换 |
| `MANUAL_TEST_GUIDE.md` | 插件手工验收 | 按需 |
| `CHANGES_FROM_READONLY.md` | 分阶段代码对比 | 否 |

## 主要修改文件

| 文件 | 修改原因 | 迁移真实业务 |
| --- | --- | --- |
| `shared/protocol.ts` | 新增统一 `applyMutation()` | 按 Pattern 字段替换 |
| `usePatternViewport.ts` | 统一提交、日志、回退和 staged reload | 是 |
| `PatternTable.tsx` | 双击 editor、Copy/Paste 入口 | 按列调整 |
| `PatternEditorApp.tsx` | 紧凑右键菜单和状态 | 按产品 UI 调整 |
| `logicalViewport.ts` | mutation 后局部迁移或权威替换 | 是，作为黑盒 |
| `vtableAdapter.ts` | 选区、编辑、右键和原始 Paste | 是，作为黑盒 |
| `patternEditorProvider.ts` | Editable Custom Editor 生命周期 | 是 |
| `syntheticPatternBackend.ts` | 参考事务和稀疏保存 | 否 |

## 实机截图

- [VS Code 10,000 行末尾](./docs/qa/vscode-10k-last-row.jpeg)
- [VS Code 1 亿行末尾](./docs/qa/vscode-100m-last-row.jpeg)

两张截图中的最后一个 record 均为真实数据行，不包含 padding record。

## 明确未引入

- 没有搬回旧 v22 的 DocumentSession 或 span tree。
- 没有新增单元测试；人工验收数据和性能探针与生产入口隔离。
- 没有把窗口 rows 放入 React state。
- 没有移除 VTable 1.22.2 内部度量 API；它们仍只在 adapter。
- 没有在 Webview 维护 Undo/Redo 栈；历史由 Custom Editor/backend 负责。
- 没有实现 Cycle、Find/Replace、Failure 等后续 Pattern 业务功能。
