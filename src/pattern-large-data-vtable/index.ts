/**
 * 阅读等级：B 接口必读
 * 是否迁移：是
 * 前置阅读：无
 * 建议只关注：本文件导出的稳定入口
 * 可以跳过：各实现文件中的内部算法
 *
 * Pattern 亿级 VTable 基础模块的唯一公共入口。真实 Pattern 项目迁移时，
 * 应从这里导入 Surface、adapter 和逻辑 viewport，避免依赖内部文件布局。
 *
 * 这个目录只服务 Pattern 超大数据场景，不承诺成为 Timing 等普通规模表格
 * 的通用 runtime，也不包含 Pattern 字段、Cycle、mutation 或 backend。
 */

export {
  DocumentTableSurface,
  createDocumentTableOption,
  type DocumentTableSurfaceProps
} from "./DocumentTableSurface";
export {
  VTABLE_HEADER_ROW_HEIGHT,
  VTABLE_HORIZONTAL_SCROLLBAR_HEIGHT,
  createVTableAdapter,
  type TableCellEditEvent,
  type TableContextMenuEvent,
  type TableField,
  type TablePasteEvent,
  type TableRow,
  type TableSelection,
  type VTableAdapter,
  type VTableAdapterOptions,
  type VTableListTableInstance
} from "./vtableAdapter";
export {
  DEFAULT_VIEWPORT_CONFIG,
  LogicalViewport,
  ReadWindowCache,
  type LogicalViewportOptions,
  type LogicalViewportState,
  type ViewportSnapshot
} from "./logicalViewport";
export {
  MAX_SPACER_HEIGHT_PX,
  clampGoToVectorIndex,
  clampInteger,
  clampNumber,
  computeNeighborWindowStartVectorIndexes,
  computeVisibleRange,
  computeWindowStartVectorIndex,
  createScrollGeometry,
  logicalToScrollbarScrollTop,
  normalizeWheelDelta,
  scrollbarToLogicalScrollTop,
  type ScrollGeometry,
  type VisibleRange
} from "./logicalViewportMath";
