# Pattern VTable v22-lite：亿级渲染与基础编辑

这是 v22-lite 只读版的可编辑延伸。它保留轻量窗口滚动，只增加迁移真实
Pattern 前必须验证的基础写入：

- 右键在选中行上方或下方插入 1～10,000 行。
- 右键删除选区涉及的行。
- 双击编辑 Instruction、Comment 和 Signal。
- Copy 后从一个单元格 Paste；越过文档末尾的部分自动追加空白行。
- VS Code dirty、Save、Save As、Backup 和 Revert。

本目录独立维护，原 v22/v23 和只读 v22-lite 均未修改。本版不实现
Undo/Redo、Cycle 重算、搜索、Failure、Annotation、Sync Marker 或
Configure Layout。

## 架构结论

- 不使用 `DataSource/CachedDataSource` 或 TanStack Virtual。
- VTable 同时最多接收 1,000 行，cache 最多保留三个窗口。
- React state 不保存窗口 rows。
- 亿级基础数据不物化；synthetic backend 只保存基础段、插入段和稀疏修改。
- Insert、Delete、Update、Paste 共用一个 `applyMutation()`。
- Paste 的更新与越界追加是一次 revision、一次事务。
- 结构修改在新窗口准备好前保留旧 Canvas，不先清空表格。
- 正式入口是 Editable VS Code Custom Editor；浏览器只用于快速调试。

## 运行

```bash
pnpm install
pnpm dev
```

浏览器调试：

- `http://127.0.0.1:5173/?rows=0`
- `http://127.0.0.1:5173/?rows=10000`
- `http://127.0.0.1:5173/?rows=100000000`
- 可附加 `&delay=100` 模拟窗口延迟。

插件调试：

1. 用 VS Code 打开本目录。
2. 按 `F5`，选择对应的 v22-lite Launch 配置。
3. 若 `.pat` 被文本编辑器打开，执行
   `Reopen With... -> Pattern Editor Lite Editable (.pat)`。
4. 按 [MANUAL_TEST_GUIDE.md](./MANUAL_TEST_GUIDE.md) 验证。

构建和现有四个自动测试：

```bash
pnpm build
```

## 页面交互

- `Go To Offset` 保留 v22 已确认的尺寸和 0-based 语义。
- 拖动右侧原生 scrollbar 浏览全局位置，滚轮按真实逻辑像素移动。
- 横向滚动由 VTable 负责。
- 双击可编辑列；Vector、Cycle 始终只读。
- 右键旧选区内任意单元格会处理整个选区涉及的行；右键选区外只处理当前行。
- VTable 处理 Copy，原始 DOM Paste 被转换为一次后端事务。
- 底部 `Modified` 同时对应 backend dirty 与 VS Code Custom Editor dirty。
- 本轮不实现 Undo/Redo；可使用 `File: Revert File` 放弃未保存修改。

## 推荐阅读顺序

业务迁移按顺序看，不要先进入滚动内部：

1. `src/shared/protocol.ts`：行模型、统一 mutation 和 revision。
2. `src/webview/patternReadClient.ts`：Webview 与 Extension 请求配对。
3. `src/webview/usePatternViewport.ts`：公开 controller 和统一失败回退。
4. `src/webview/PatternEditorApp.tsx`：Go To、菜单、表格、状态栏。
5. `src/webview/PatternTable.tsx`：列定义、双击 editor 和 Surface。
6. `src/extension/patternBackend.ts`：未来 C++ ICE 替换合同。
7. `src/extension/patternEditorProvider.ts`：dirty、Save、Backup、Revert。
8. `src/core/logicalViewport.ts`：窗口、缓存和 staged reload 黑盒。
9. `src/core/logicalViewportMath.ts`：逻辑像素映射。
10. `src/core/vtableAdapter.ts`：VTable imperative API 唯一隔离点。

真实业务通常重点理解前七项。第 8～10 项可以先作为稳定核心；尤其
`tableY`、冻结高度和 `renderAsync()` 只允许出现在 adapter。

## 写入数据流

```text
右键 / 双击 / Paste
          ↓
usePatternViewport（统一事务、失败回退、视口快照）
          ↓ applyMutation(baseRevision, operation)
PatternDocumentClient → Provider → PatternBackend
          ↓
局部 Update：迁移重叠 cache
结构/Paste：后台取权威窗口，再一次性替换 Canvas
```

真实 C++ 接入时替换字段模型、列、client 和 backend；不要复制
`src/dev-only`。具体文件差异见
[CHANGES_FROM_READONLY.md](./CHANGES_FROM_READONLY.md)。
