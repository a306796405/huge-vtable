# 1 亿行性能与内存人工验收

## 1. 本次能证明什么

本轮验证当前 v22-lite 的前端窗口架构：

- 总行数为 1 亿时，前端内存不随总行数线性增长。
- VTable 只接收当前最多 1,000 条 records。
- runtime 活跃缓存不超过三个窗口。
- compressed scrollbar、Go To、滚轮和末行可持续工作。
- 编辑、Paste、Undo/Redo 不破坏窗口和 revision。

当前 Demo 固定为 12 个 Signal。该结果不能替代未来真实 Signal 数量、
C++ ICE 传输和 `.pat` 解码测试。真实 backend 接入后应复用本指南再测一次。

## 2. 浏览器性能探针

启动：

```bash
pnpm dev
```

使用以下 URL：

```text
http://127.0.0.1:5173/?rows=100000000&delay=0&perf=1
http://127.0.0.1:5173/?rows=100000000&delay=20&perf=1
http://127.0.0.1:5173/?rows=100000000&delay=100&perf=1
http://127.0.0.1:5173/?rows=100000000&delay=300&perf=1
```

`perf=1` 只在浏览器调试入口加载性能探针，正式 Webview bundle 不包含它。
打开开发者工具 Console 后可使用：

```js
patternPerf.reset()
patternPerf.print()
patternPerf.report()
```

报告只保存耗时、请求数、返回窗口行数和 heap，不保存任何行或单元格内容。
Chrome 支持 `performance.memory` 时会返回 heap；不支持时报告中没有 heap 字段。

## 3. 测试场景

每个 delay 档位重新加载页面，保持浏览器尺寸和 zoom 不变。

### 场景 P1：首次打开

1. 打开 URL。
2. 等待首个窗口完整显示。
3. 执行 `patternPerf.print()`。

记录：

- 首屏出现时间。
- `getMetadata`、`getWindow` 耗时。
- long task 最大值。
- 首屏 heap。

### 场景 P2：随机 Go To

执行以下 Offset，每次等待状态栏稳定：

```text
0
1234567
49999999
76543210
99999999
500
99950000
```

执行前 `patternPerf.reset()`，完成后 `patternPerf.print()`。

通过标准：

- 目标位置正确。
- 旧窗口在新窗口完成前保持可见。
- 迟到响应不覆盖最后一次目标。
- cache 状态始终不超过 `3/3`。

### 场景 P3：连续滚动

1. `patternPerf.reset()`。
2. 连续滚轮滚动 2 分钟。
3. 混合 PageUp、PageDown、Home、End。
4. 拖动纵向 scrollbar 做 20 次大跨度跳转。
5. 横向滚到中间，继续纵向滚动。
6. `patternPerf.print()`。

记录：

- `getWindow` P50、P95、max。
- long task P95、max。
- frame gap P95、max。
- 横向位置是否归零。

### 场景 P4：Mutation 和历史

1. `patternPerf.reset()`。
2. 修改 10 个单元格。
3. 插入和删除各 3 次。
4. 执行 3 次范围内 Paste 和 1 次末尾越界 Paste。
5. Undo 到不可撤销，再 Redo 到不可重做。
6. `patternPerf.print()`。

通过标准：

- 每个业务动作对应一个 mutation/history 请求。
- revision 单调推进。
- 结构操作期间不白屏。
- 缓存没有超过三个窗口。

### 场景 P5：15 分钟内存稳定性

1. 关闭其他占用较大的标签页。
2. 重新打开 `delay=20&perf=1`。
3. 等首屏稳定后，在 DevTools Memory 中执行一次 GC。
4. `patternPerf.reset()`。
5. 交替执行随机 Go To、连续滚动、编辑和 Undo/Redo 15 分钟。
6. 再执行一次 GC，运行 `patternPerf.print()`。

通过标准：

- GC 后 heap 不随访问过的逻辑行数量持续线性增长。
- 报告中的 heap growth 目标不超过 20%。
- cache 始终最多三个窗口。
- 没有持续增长的 pending 请求。

heap 超过 20% 不能直接判定泄漏；需再用 DevTools Heap Snapshot 对比
VTable、React listener、Promise 和 Pattern rows 的 retained path。

## 4. VS Code 插件最终确认

浏览器测试通过后，在 Extension Development Host 打开：

```text
examples/acceptance/04-compressed-100m.pat
```

使用 VS Code 的 `Developer: Open Process Explorer` 和 Webview Developer
Tools，重复 P2、P3、P4，并额外检查：

- Cmd/Ctrl+A、C、V。
- VS Code 原生 Undo/Redo。
- zoom 80%、100%、125%。
- Go To 99,999,999 和 End。
- 关闭/重新打开文档后资源能够释放。

插件阶段主要看 Electron/Webview 集成差异；浏览器探针数据不能冒充插件数据。

## 5. 判定规则

当前 12 Signal 基线建议：

| 指标 | 目标 |
| --- | --- |
| VTable records | 不超过 1,000 |
| 活跃窗口 cache | 不超过 3 |
| 无后端延迟时 `getWindow` P95 | 不超过 50ms |
| 交互过程长任务 P95 | 不超过 200ms |
| 15 分钟 GC 后 heap 增长 | 不超过 20% |
| 空白 Canvas / 错误窗口覆盖 | 0 次 |
| 纵向或横向非预期跳动 | 0 次 |

如果 request 很快但 long task 很长，优先检查 VTable `setRecords`、列布局和
Canvas 绘制；如果 request 本身慢，优先检查 backend 解码、ICE 传输和窗口
payload。总行数本身不是前端绘制成本，当前窗口的行数、列数和对象大小才是。

## 6. 结果记录

将每次 `patternPerf.print()` 返回的对象复制到验收记录，并填写
[performance-results-template.csv](./performance-results-template.csv)。

结论必须标注：

```text
结论范围：Synthetic / 12 Signals / Browser 或 VS Code
是否证明 1 亿逻辑行窗口架构：
是否已验证真实 C++ ICE：
是否已验证真实最大 Signal 数：
阻塞问题：
验收人：
日期：
```
