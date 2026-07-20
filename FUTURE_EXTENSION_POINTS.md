# v22-lite 后续扩展边界

本文只记录尚未实现的能力应该接在哪里，不为后续需求提前生成代码。

## 必须保持的边界

- 前端仍只持有小窗口，不能把完整 Pattern 放回 React state。
- `rowKey`、`signalId`、run id 和搜索 cursor 都是 opaque。
- C++ ICE 文档会话负责真源、mutation、revision、history 和保存。
- VTable 继续只是当前窗口 renderer。
- 写操作必须是后端事务，前端不能把一次业务操作拆成多次猜测性修改。

## 后续功能放置

| 功能 | 后端职责 | 前端接入点 |
| --- | --- | --- |
| C++ Mutation 接入 | C++ 文档结构和一次 revision | 替换当前 synthetic `applyMutation()` 实现 |
| Undo/Redo | C++ 会话历史和逆向 effects | Provider 改用 `CustomDocumentEditEvent` |
| 动态 Signal | Signal Catalog、稳定 signalId、projection | `PatternTable` 根据当前 Layout 创建 columns |
| Configure Layout | 不修改文档 | 保存到 VS Code 用户/workspace state |
| 静态 Cycle | 显式重新计算派生数据 | 过期时灰显并禁用静态 Cycle 搜索 |
| 动态 Cycle | 绑定 `runId + sourceRevision` | Debug 编辑后保留旧值并显示 stale |
| Find/Replace | 后端全局查询和事务 Replace All | 只替换 Instruction、Comment、Signal 源值 |
| Failure | run 级 Failure Index | 当前窗口红色单元格 + 分桶 overview |
| 四周错误轨 | 行/列聚合和目标解析 | 表格四周 DOM overlay，不放进 VTable records |
| Sync Marker | `rowKey + signalId` 持久化和 history | 独立箭头/三角，不与 Failure 视觉混用 |
| 修改角标 | 相对最近保存基线计算 | 人工修改与 Runtime 差异使用不同位置或形状 |

## 后端结构何时引入

第一版只有只读窗口，因此不需要 piece table、span tree 或 history。

开始实现结构性 mutation 时，C++ 可以先采用：

```text
base blocks + inserted blocks + piece/span array + prefix row counts
```

增删只拆分少量 piece，不移动后续几千万行。只有 piece 数量和定位成本达到
实测阈值后，才升级为平衡树；不要在只读阶段提前实现。

## 动态 Cycle 的固定语义

真实运行数据绑定 `runId + sourceRevision`。Debug 编辑后：

- 旧 Run 仍可查看；
- 明确显示 stale；
- 不把推算值覆盖为“真实动态 Cycle”；
- 只有重新运行才能产生新的实测结果。

matchLoop 下同一源 Vector 可能有多个 runtime occurrence，未来搜索必须返回
具体 occurrence，不能假设一行只有一个动态 Cycle。
