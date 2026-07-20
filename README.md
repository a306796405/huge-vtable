# Pattern VTable v22-lite：只读亿级渲染

这是 v22 的轻量延伸版。它只验证一件事：

> 在 VS Code Custom Editor 中，让 VTable 只渲染当前小窗口，同时用一根
> 全局纵向滚动条浏览 1 亿～3 亿个逻辑 Vector。

现有 v22/v23 没有被修改。本目录不实现编辑、Paste、Undo/Redo、Cycle
重算、搜索、Failure、Annotation、Sync Marker 或 Configure Layout。

## 先看结论

- 不使用 `DataSource/CachedDataSource`。
- 不使用 TanStack Virtual。
- 不在前端或 React state 中创建全量 rows。
- VTable 同时最多接收 1,000 行。
- cache 最多保留前窗、当前窗、后窗，共 3,000 条记录。
- synthetic backend 根据 `startVectorIndex` 即时生成窗口，1 亿和 3 亿的内存量相同。
- 浏览器页面只是调试壳；正式验收环境是 VS Code Custom Editor。

## 运行

```bash
pnpm install
pnpm dev
```

浏览器调试地址：

- `http://127.0.0.1:5173/?rows=100000000`
- `http://127.0.0.1:5173/?rows=200000000`
- `http://127.0.0.1:5173/?rows=300000000`
- 可附加 `&delay=100` 模拟 100ms 窗口延迟。

插件调试：

1. 用 VS Code 打开本目录。
2. 按 `F5`，选择 `Run V22 Lite - 100M` 或 `Run V22 Lite - 300M`。
3. 如果 `.pat` 被文本编辑器打开，执行
   `Reopen With... -> Pattern Editor Lite (.pat)`。

构建与测试：

```bash
pnpm build
```

## 页面交互

- `Go To Offset` 沿用 v22 主插件页面的 `220px × 32px` 输入框和
  `32px` 按钮。
- Offset 为 0-based，Enter 与按钮都能跳转。
- 拖动右侧原生 scrollbar 用于快速跨越全局区域。
- 鼠标滚轮按真实逻辑像素移动，不受亿级压缩比例放大。
- 表格获得焦点后支持方向键、PageUp、PageDown、Home、End。
- 横向滚动继续由 VTable 自己负责。

## 代码阅读顺序

第一次按以下顺序阅读，不要先进入滚动内部：

1. `src/shared/protocol.ts`：只有 metadata 和 getWindow。
2. `src/webview/patternReadClient.ts`：Webview 如何请求插件。
3. `src/webview/usePatternViewport.ts`：React 如何装配稳定核心。
4. `src/webview/PatternEditorApp.tsx`：Go To、表格、状态栏。
5. `src/webview/PatternTable.tsx`：固定列和三层 Surface。
6. `src/core/logicalViewport.ts`：只先看四个公开方法。
7. `src/core/logicalViewportMath.ts`：逻辑像素与浏览器像素映射。
8. `src/core/vtableAdapter.ts`：VTable API 隔离。
9. `src/extension/patternBackend.ts`：未来 C++ ICE 替换点。
10. `src/extension/patternEditorProvider.ts`：只读 Custom Editor。

日常业务接入通常只需理解前五项。`logicalViewport` 和 adapter 可以作为
稳定黑盒。

## 运行时数据流

```text
Go To / wheel / scrollbar
          ↓
LogicalViewport（逻辑滚动像素、三窗 cache、旧请求丢弃）
          ↓ getWindow(startVectorIndex=..., vectorCount=1000)
PatternReadClient
          ↓
VS Code Provider
          ↓
PatternBackend（当前 synthetic，未来 C++ ICE）
```

窗口返回成功前不会清空旧 records。失败时保留当前 Canvas，并在状态栏和
日志中报告具体错误。

## 当前固定参数

```text
rowHeight = 28
windowSize = 1000
windowShift = 500
guardRows = 150
cacheWindowLimit = 3
maxSpacerHeight = 16,000,000px
```

12 个 Signal 只是为了验证横向滚动。真实动态 Signal、字段编辑和运行结果
不属于第一版；后续边界见
[FUTURE_EXTENSION_POINTS.md](./FUTURE_EXTENSION_POINTS.md)。
