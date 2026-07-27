# v22-lite VS Code 人工验收指南

本指南由项目提供测试数据、操作场景和通过标准，最终结果由验收人填写。
它验证的是 VS Code Custom Editor 产品入口；浏览器页面只用于快速定位布局
问题，不能代替插件验收。

本轮不要求新增或运行单元测试。修改代码后只检查：

```bash
pnpm build:webview
pnpm build:extension
```

## 1. 验收准备

1. 用 VS Code 打开项目根目录。
2. 按 `F5` 启动 Extension Development Host。
3. 从 `examples/acceptance` 选择测试文件。
4. 如果文件以文本打开，执行
   `Reopen With... -> Pattern Editor Lite Editable (.pat)`。
5. 打开 `View -> Output`，选择 `Pattern Editor Lite`，用于核对错误日志。
6. 涉及 Save、Delete 或 Paste 时先复制测试文件，不修改验收基准。

记录以下环境：

```text
验收日期：
操作系统：
VS Code 版本：
显示分辨率 / 缩放：
VS Code zoom：
项目 commit：
```

测试数据说明见
[examples/acceptance/README.md](./examples/acceptance/README.md)。
1 亿行性能和内存按
[docs/acceptance/PERFORMANCE_ACCEPTANCE_GUIDE.md](./docs/acceptance/PERFORMANCE_ACCEPTANCE_GUIDE.md)
单独执行。

## 2. 紧凑布局、滚动和末行

使用 `02-window-boundary-1999.pat`、`03-direct-pixel-4000.pat` 和
`04-compressed-100m.pat`。

### 场景 2.1：表格区域

1. 最大化和缩小编辑器区域。
2. 确认工具栏和状态栏保持单行，VTable 占据中间全部剩余高度。
3. 确认页面本身没有额外纵向滚动条。
4. 缩小高度后确认表格仍可滚动，没有只剩表头。

通过标准：

- 表格不白屏、不溢出 Custom Editor。
- 原生纵向 scrollbar 和 VTable 横向 scrollbar 都可见、可拖动。
- 横向 scrollbar 不遮挡最后一行。

### 场景 2.2：全局定位和最后一行

分别执行：

| 文件 | Go To Offset |
| --- | ---: |
| `02-window-boundary-1999.pat` | `1998` |
| `03-direct-pixel-4000.pat` | `3999` |
| `04-compressed-100m.pat` | `99999999` |
| `05-capacity-300m.pat` | `299999999` |

每个文件再执行 End、拖动纵向 scrollbar 到底和水平拖到最右。

通过标准：

- 最后一个 Vector 与表中目标一致。
- 最后一行文字、行高和底部网格线完整。
- 不存在 padding record 或额外空白数据行。
- compressed 模式拖动后仍可用滚轮逐行附近移动。
- 横向位置不因纵向窗口切换归零。

## 3. 编辑和统一 Mutation

使用 `01-small-100.pat` 的副本。

### 场景 3.1：单元格编辑

1. 双击 Instruction、Comment 和 Signal。
2. 分别输入普通文本、空字符串、`0`、`1` 和 `X`。
3. 尝试双击 Vector 和 Cycle。

通过标准：

- 可编辑列提交后保持新值，状态栏出现 `Modified`。
- 每次编辑只对应一次历史操作。
- Vector、Cycle 不进入编辑。
- 编辑框中的方向键、Home、End 不触发表格滚动。

### 场景 3.2：插入和删除

1. 在 Vector 10 上方插入 5 行。
2. 确认原 Vector 10 的数据下移，新增行字段为空。
3. 选择连续 3 行并删除。
4. 在选区外右键另一行，确认菜单只针对右键行。
5. 使用 `00-empty.pat` 插入 3 行，再删除到 0 行。

通过标准：

- Insert/Delete 经过一次 `applyMutation()` 和一次 revision。
- 未删除行的 `rowKey` 稳定；显示 Vector 按新位置重算。
- 删除到 0 行后仍可重新插入。
- 操作过程中不先清空 Canvas。

## 4. VS Code Clipboard

本节必须在 Extension Development Host 中执行，不能只在普通浏览器执行。

### 场景 4.1：Cmd/Ctrl+A 和 Copy

1. 点击一个可编辑单元格。
2. 按 Cmd/Ctrl+A。
3. 按 Cmd/Ctrl+C。
4. 粘贴到外部纯文本编辑器，检查 TSV 行列。
5. 再拖选一个小矩形并复制。

通过标准：

- 快捷键焦点留在表格时生效。
- 复制内容与选区一致，不包含隐藏窗口以外的伪造行。
- Cmd/Ctrl+A 不触发 VS Code 外层全选。

### 场景 4.2：范围内 Paste

复制以下 3×3 TSV，从 Instruction 列某行开始按 Cmd/Ctrl+V；第二行中间
是一个真实空单元格：

```text
LOAD	first row	1
WAIT		X
STORE	third row	0
```

通过标准：

- 空单元格覆盖为空字符串。
- 3×3 矩阵一次提交、一次 revision、一次 Undo。
- VTable 不在后端成功前自行截断或永久修改 records。

### 场景 4.3：越界 Paste

1. 跳到 `01-small-100.pat` 的 Vector 98。
2. 从 Instruction 开始粘贴上面的 3×3 TSV。

通过标准：

- Vector 98、99 被更新。
- 自动新增 Vector 100。
- 更新和新增同成同败。
- 新增行获得新 `rowKey`，未覆盖字段为空。

### 场景 4.4：非法 Paste

1. 从 Vector 或 Cycle 开始粘贴。
2. 从最后一个 Signal 开始粘贴两列。
3. 尝试不规则矩阵。

通过标准：

- 整次拒绝，不截断、不部分写入。
- revision 和总行数不变化。
- 状态栏显示具体原因和错误 ID。
- Output 日志不包含剪贴板文本或单元格内容。

## 5. 结构变化后保持当前看到的数据

使用 `01-small-100.pat` 的新副本。

### 场景 5.1：首行之前插入/删除

1. 让首个可见数据行为 Vector 5，并记住该行内容。
2. 在 Vector 5 之前插入 5 行。
3. 再删除刚插入的 5 行。

通过标准：

- 插入后原先可见的那条数据仍停留在相同屏幕位置，其显示 Vector 由 5
  变为 10。
- 删除后同一条数据仍停留在相同屏幕位置，其显示 Vector 恢复为 5。
- 纵向 scrollbar 会按结构变化补偿，但用户原来看到的那条数据不跳动。
- 横向 `scrollLeft` 始终保持。

### 场景 5.2：删除后数据不足一屏

1. 恢复为 100 行，让首个可见数据行为 Vector 4（第 5 行）。
2. 保留前 5 行，删除其余 95 行。

通过标准：

- 新文档只有 5 行。
- 前端重新请求可填满视口的最合理窗口；由于总数据不足一屏，显示
  Vector 0～4，而不是保留一块从 Vector 4 开始的空白区域。
- 没有伪造 Vector 5 以后的空 record。

## 6. Undo/Redo

使用 `01-small-100.pat` 的新副本。

依次执行：

1. 编辑一个单元格。
2. 插入 2 行。
3. 删除 1 行。
4. 执行一次包含更新和越界新增的 Paste。
5. 连续使用工具栏 Undo，直到 `canUndo=false`。
6. 连续使用工具栏 Redo，直到 `canRedo=false`。
7. 重复使用 Cmd/Ctrl+Z 和 Cmd/Ctrl+Shift+Z。

通过标准：

- 工具栏与快捷键共用 VS Code CustomDocumentEditEvent 历史链。
- 每个业务操作只撤销一次；Paste 的更新和新增一起撤销。
- Undo/Redo 后 revision 单调推进，不回退旧 revision 数字。
- 行结构、单元格、总行数、dirty 和按钮状态一致。
- 视口与横向位置合理保持，不白屏。

## 7. 错误日志和无闪动恢复

### 场景 7.1：首次窗口失败

1. 打开 `90-fault-window-once.pat`。
2. 确认状态栏显示“正在自动恢复”，当前表格区域不白屏。
3. 不进行点击，等待自动重试完成。
4. 在 Output 中搜索同一次失败和恢复的关联 ID。

通过标准：

- 首次失败可定位到 `getWindow/viewportStart`。
- 自动读取成功后显示 10,000 行元数据和表格。
- Output 使用同一关联 ID 记录失败和 `RECOVERED`。
- 日志不包含行数据或单元格内容。

### 场景 7.2：首次 Mutation 失败

1. 打开 `91-fault-mutation-once.pat`。
2. 修改一个单元格。
3. 观察失败后的表格、状态栏和 Output。
4. 再修改一次。

通过标准：

- 第一次后端写入没有提交。
- controller 自动读取 metadata 和权威窗口。
- 旧 Canvas 在同步完成前保持，没有白屏或 loading 遮罩。
- 首次乐观值最终恢复为权威值；第二次修改成功。
- 错误 ID能关联 `applyMutation` 失败和恢复结果。

### 场景 7.3：本地校验错误

执行只读列 Paste。

通过标准：

- 只显示本地错误，不进行窗口重载。
- 当前 records、纵向和横向位置不变化。
- 日志级别为 warning，并带错误 ID。

## 8. Save、Revert、Backup 和关闭

使用 `01-small-100.pat` 的副本。

### 场景 8.1：Save 和 dirty 基线

1. 修改单元格，确认编辑器标签和状态栏都显示 dirty。
2. Cmd/Ctrl+S，确认 dirty 清除。
3. 再修改一次，然后 Undo 回到保存内容。
4. Redo，再次离开保存内容。

通过标准：

- 只有宿主写盘成功后 backend 才推进保存基线。
- 回到保存内容时 dirty 与真实后端状态一致。
- 保存不会清空当前表格或滚动位置。

### 场景 8.2：Save As

1. 编辑后执行 Save As。
2. 关闭并打开目标文件。

通过标准：

- 目标文件包含 mutation 结果。
- 原文件不会被意外覆盖。
- 保存失败时 dirty 不能被错误清除。

### 场景 8.3：Revert

1. 编辑、插入和 Paste，但不保存。
2. 执行 `File: Revert File`。

通过标准：

- 磁盘内容重新成为真源。
- 未保存修改被放弃，dirty 清除。
- 新窗口准备好前旧 Canvas 保持，纵横位置尽量恢复。

### 场景 8.4：关闭和 Backup

1. 干净状态关闭页面。
2. 修改后关闭，检查 VS Code 的保存确认。
3. 修改后执行 `Developer: Reload Window`。
4. 等待 Custom Editor backup 恢复。
5. 在窗口读取或 mutation 延迟期间关闭页面。

通过标准：

- 干净页面不产生多余提示。
- dirty 页面不会静默丢失修改。
- backup 恢复后显示 Modified。
- dispose 后迟到响应不能重新更新已关闭 Webview。
- Output 中没有未处理 Promise rejection。

## 9. 验收结果模板

每个失败场景复制一份：

```text
场景编号：
测试文件：
操作前 Rows / Offset / revision：
具体操作：
期望：
实际：
是否白屏或跳动：
错误 ID：
Output 摘要：
截图路径：
结论：通过 / 不通过 / 待确认
```

最终结论：

```text
功能与快捷键：
视口锚定：
Undo/Redo：
错误恢复与日志：
Save/Revert/Backup：
1 亿行末行：
阻塞问题：
验收人：
日期：
```
