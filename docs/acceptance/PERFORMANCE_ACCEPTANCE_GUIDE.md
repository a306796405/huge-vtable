# 1 亿行性能与内存人工验收

本指南只验证 VS Code Custom Editor 产品入口，不使用浏览器 Demo 或浏览器
专用性能探针。验收人负责执行并填写结果，项目不自动运行性能测试。

## 1. 本次能证明什么

- 总行数为 1 亿时，前端内存不随总行数线性增长。
- VTable 同时只接收当前最多 1,000 条 records。
- runtime 活跃缓存不超过三个窗口。
- compressed scrollbar、Go To、滚轮和末行可持续工作。
- 编辑、Paste、Undo/Redo 不破坏窗口和 revision。
- 隐藏并重新显示页面时，`retainContextWhenHidden` 保持交互状态。

当前参考后端固定为 12 个 Signal。结果不能替代真实 Signal 数量、C++ ICE
传输和 `.pat` 解码测试。真实 backend 接入后必须复用本指南再测一次。

## 2. 验收准备

1. 用 VS Code 打开项目目录。
2. 按 `F5` 启动 Extension Development Host。
3. 打开：

```text
examples/acceptance/04-compressed-100m.pat
```

4. 打开 `Developer: Open Process Explorer`。
5. 执行 `Developer: Open Webview Developer Tools`。
6. 记录操作系统、VS Code 版本、显示缩放、VS Code zoom 和项目 commit。

性能记录以 Process Explorer、Webview Performance/Memory 面板、操作录像和状态栏
为准。不要记录行内容、单元格内容或 Paste 文本。

## 3. 测试场景

### P1：首次打开

1. 关闭当前 Pattern 页面。
2. 重新打开 1 亿行验收文件。
3. 等待首个窗口完整显示。
4. 记录从打开到首屏可交互的时间。
5. 记录 Extension Host 和 Webview 进程内存。

通过标准：

- 没有创建 1 亿行前端数组。
- 首屏为真实窗口数据。
- cache 状态不超过 `3/3`。
- 页面没有空白或长时间冻结。

### P2：随机 Go To

依次定位，每次等待状态栏稳定：

```text
0
1234567
49999999
76543210
99999999
500
99950000
```

通过标准：

- 目标位置正确。
- 旧窗口在新窗口完成前保持可见。
- 迟到响应不覆盖最后一次目标。
- cache 始终不超过三个窗口。
- 横向位置没有意外归零。

### P3：连续滚动和键盘

1. 连续滚轮滚动 2 分钟。
2. 混合使用方向键、PageUp、PageDown、Home 和 End。
3. 拖动纵向 scrollbar 做 20 次大跨度跳转。
4. 横向滚到中间后继续纵向滚动。
5. 使用不同 VS Code zoom 重复一次。

通过标准：

- 方向键越过可见边缘后，原生纵向 scrollbar 同步变化。
- VTable 横向 scrollbar 正常。
- 没有空白 Canvas、明显闪动或位置跳跃。
- 最后一行完整显示。

### P4：Mutation 和历史

1. 修改 10 个单元格。
2. 插入和删除各 3 次。
3. 执行 3 次范围内 Paste 和 1 次末尾越界 Paste。
4. 使用 VS Code 原生 Undo/Redo 往返恢复。
5. 执行 Save，再 Undo 和 Redo。

通过标准：

- 每个用户写动作只执行一次 mutation。
- revision 单调推进。
- Paste 更新和新增只产生一次历史。
- Save 后 VS Code dirty 圆点消失，继续编辑或 Undo 后按 VS Code 语义恢复。
- 结构操作期间不白屏。

### P5：15 分钟内存稳定性

1. 关闭其他占用较大的应用和标签页。
2. 记录首屏稳定后的进程内存。
3. 交替执行随机 Go To、滚动、编辑、Paste 和 Undo/Redo 15 分钟。
4. 在 Webview DevTools Memory 中手动 GC。
5. 记录 GC 后 Webview 和 Extension Host 内存。

通过标准：

- GC 后内存不随访问过的逻辑行数量持续线性增长。
- 当前参考目标：GC 后 Webview heap 相对基线增长不超过 20%。
- cache 始终最多三个窗口。
- 没有持续增长的 pending 请求、listener 或 Pattern rows。

超过 20% 不能直接判定泄漏，需要用 Heap Snapshot 对比 VTable、React listener、
Promise 和 Pattern rows 的 retained path。

### P6：多个隐藏 Pattern 页面

1. 分别打开 5 个不同的 Pattern 验收文件。
2. 每个页面滚动到不同位置并选择一个单元格。
3. 在页面间反复切换 5 分钟。
4. 记录每增加一个页面后的 Webview 进程内存。
5. 回到每个页面确认滚动位置和选区。

通过标准：

- `retainContextWhenHidden` 保持页面交互状态。
- 单个页面仍只缓存最多三个窗口。
- 内存增量与打开页面数相关，但不与每个文件的总行数线性相关。
- 关闭页面后对应资源可以释放。

## 4. 建议判定指标

当前 12 Signal 基线：

| 指标 | 目标 |
| --- | --- |
| VTable records | 不超过 1,000 |
| 活跃窗口 cache | 不超过 3 |
| 无后端延迟时窗口切换 | 无可感知长期冻结 |
| 交互长任务 P95 | 不超过 200ms |
| 15 分钟 GC 后 Webview heap 增长 | 不超过 20% |
| 空白 Canvas / 错误窗口覆盖 | 0 次 |
| 纵向或横向非预期跳动 | 0 次 |

如果后端请求很快但主线程长时间卡顿，优先检查 VTable `setRecords`、列布局和
Canvas 绘制；如果请求本身慢，优先检查 backend 解码、ICE 传输和窗口 payload。

## 5. 结果记录

填写 [performance-results-template.csv](./performance-results-template.csv)，并在
结论中注明：

```text
结论范围：Synthetic / 12 Signals / VS Code Custom Editor
是否证明 1 亿逻辑行窗口架构：
是否验证多个 retainContextWhenHidden 页面：
是否已验证真实 C++ ICE：
是否已验证真实最大 Signal 数：
阻塞问题：
验收人：
日期：
```
