# 人工验收数据

这些 `.pat` 文件只保存 synthetic 行数或一次性故障开关，不会物化全部行。
请在 Extension Development Host 中通过 Pattern Editor Lite 打开。涉及保存、
删除或粘贴时，先复制文件再操作，避免污染下次验收的基准。

| 文件 | 用途 |
| --- | --- |
| `00-empty.pat` | 空文档插入和空表生命周期 |
| `01-small-100.pat` | 编辑、粘贴、Undo/Redo 和视口锚定 |
| `02-window-boundary-1999.pat` | 单/多窗口边界与末行 |
| `03-direct-pixel-4000.pat` | 中等数据滚动与窗口切换 |
| `04-compressed-100m.pat` | 1 亿逻辑行和 compressed scrollbar |
| `05-capacity-300m.pat` | 当前 synthetic 上限容量检查 |
| `90-fault-window-once.pat` | 首次窗口读取失败，随后可“重新同步” |
| `91-fault-mutation-once.pat` | 首次写操作失败并自动权威恢复 |

`debugFaults` 只由 `src/dev-only/syntheticPatternBackend.ts` 识别，并且每项
在当前打开会话中最多触发一次。保存后不会把故障开关写回正式 synthetic
快照，未来 C++ ICE backend 也不需要实现它。

完整步骤见根目录
[MANUAL_TEST_GUIDE.md](../../MANUAL_TEST_GUIDE.md)。
