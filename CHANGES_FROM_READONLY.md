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

## 实际代码量

完成实现并检查重复逻辑后，实际 TypeScript/TSX 行数为：

| 版本 | `src` 行数 | 与本版关系 |
| --- | ---: | --- |
| 原 v22 performance validation | 9,169 | 本版约少 45% |
| v22-lite readonly | 2,395 | 本版的只读基线 |
| v22-lite editable | 5,043 | 当前结果 |

当前版本比只读版增加 2,648 个物理代码行，超过了实施前
1,200～1,600 行的估算。检查后没有发现值得保留的重复组件体系；主要偏差来自：

- `src/dev-only/syntheticPatternStore.ts` 约 925 行。它为了在 1 亿基础行上
  演示插入、删除、Paste 和持久化，实现了可校验的稀疏 piece store；真实
  Pattern 迁移时由 C++ backend 替换，不进入产品 Webview。
- `logicalViewport.ts` 和 `usePatternViewport.ts` 合计增加约 690 行，用于
  staged reload、视口补偿、局部更新和写入失败回退。
- Editable Custom Editor 的 Save、Save As、Backup、Revert 生命周期不能由
  浏览器 Demo 代替。

因此没有为了达到预估数字删除事务校验或把逻辑重新糅进 React 组件。即便包含
开发专用 synthetic store，本版仍明显小于原 v22，也没有引入 DocumentSession、
span tree、history 或 command executor。

## 三个阶段

| 阶段 | 内容 | 阅读建议 |
| --- | --- | --- |
| baseline | 原只读版快照 | 用来确认没有改原项目 |
| viewport fix | 删除末尾 padding、统一 Index/Px 命名 | 重点看 viewport 和 adapter |
| editable mutations | 右键、双击、Paste、统一事务 | 重点看 protocol 和 controller |
| persistence | Editable Provider、Save/Revert、文档 | 真实插件接入必读 |

## 新增文件

| 文件 | 原因 | 迁移真实业务 |
| --- | --- | --- |
| `src/webview/clipboardTsv.ts` | 剪贴板 TSV 解析 | 是 |
| `src/dev-only/syntheticPatternStore.ts` | 亿级 synthetic 的稀疏可编辑存储 | 否，C++ 替换 |
| `MANUAL_TEST_GUIDE.md` | 浏览器与插件手工验收 | 按需 |
| `CHANGES_FROM_READONLY.md` | 分阶段代码对比 | 否 |

## 主要修改文件

| 文件 | 修改原因 | 迁移真实业务 |
| --- | --- | --- |
| `shared/protocol.ts` | 新增统一 `applyMutation()` | 按 Pattern 字段替换 |
| `usePatternViewport.ts` | 统一提交、回退和 staged reload | 是 |
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

- 没有搬回旧 v22 的 DocumentSession、span tree、history 或 command executor。
- 没有新增测试文件；只调整原架构边界断言。
- 没有把窗口 rows 放入 React state。
- 没有移除 VTable 1.22.2 内部度量 API；它们仍只在 adapter。
- 没有实现 Undo/Redo 和后续 Pattern 业务功能。
