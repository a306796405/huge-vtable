/**
 * 阅读等级：B 接口必读
 * 是否迁移：是
 * 前置阅读：core/logicalViewportMath.ts
 * 建议只关注：PatternTableAdapter 接口
 * 可以跳过：VTable tableRow 与 recordIndex 的转换
 *
 * 这是项目中唯一允许接触 VTable imperative API 的文件。即使将来 VTable
 * 的度量方法发生变化，也只在这里兼容，业务组件和逻辑滚动不需要跟着修改。
 */

import type { ListTable } from "@visactor/vtable";
import type { PatternRenderRow } from "../shared/protocol";

export type VTableListTableInstance = ListTable;

/**
 * 横向滚动条使用 always 模式，会覆盖 Canvas 底部而不是扩大 DOM 高度。
 * adapter 的 body 测量和表格主题必须共用同一个值，避免末行被覆盖。
 */
export const VTABLE_HORIZONTAL_SCROLLBAR_HEIGHT = 8;
export const VTABLE_HEADER_ROW_HEIGHT = 32;
export const PATTERN_HEADER_ROW_COUNT = 2;
export const VTABLE_END_PADDING_HEIGHT = 32;
export const VTABLE_END_PADDING_ROW_KEY =
  "__pattern_vtable_end_padding__";

export interface PatternTableAdapter {
  setRecords(rows: PatternRenderRow[]): void;
  setScrollTop(scrollTop: number): void;
  getScrollTop(): number;
  setScrollLeft(scrollLeft: number): void;
  getScrollLeft(): number;
  resize(): void;
  whenLayoutReady(): Promise<void>;
  getBodyHeight(): number;
  getVisibleRecordRange(): { start: number; end: number } | null;
  getElement(): HTMLElement;
}

export function createVTableAdapter(
  table: VTableListTableInstance
): PatternTableAdapter {
  return {
    setRecords(rows) {
      table.setRecords(rows, { sortState: null });

      if (
        rows.at(-1)?.rowKey ===
        VTABLE_END_PADDING_ROW_KEY
      ) {
        const tableRow = table.getTableIndexByRecordIndex(
          rows.length - 1
        );
        table.setRowHeight(
          tableRow,
          VTABLE_END_PADDING_HEIGHT
        );
      }
    },
    setScrollTop(scrollTop) {
      table.setScrollTop(scrollTop);
    },
    getScrollTop() {
      return table.getScrollTop();
    },
    setScrollLeft(scrollLeft) {
      table.setScrollLeft(scrollLeft);
    },
    getScrollLeft() {
      return table.getScrollLeft();
    },
    resize() {
      table.resize();
    },
    async whenLayoutReady() {
      await table.renderAsync();
      await nextFrame();
    },
    getBodyHeight() {
      /*
       * tableY、tableNoFrameHeight 和冻结区域高度在当前锁定的 VTable
       * 1.22.2 类型中公开，但不让它们越过 adapter 边界。tableY 参与同一
       * 相对坐标系的上下边界计算，二者之差就是真实 body 高度。
       */
      const tableTop = table.tableY;
      const headerLevelCount = Math.max(
        0,
        table.columnHeaderLevelCount
      );
      const columnHeaderHeight =
        headerLevelCount > 0
          ? table.getRowsHeight(0, headerLevelCount - 1)
          : 0;
      /*
       * 分组列会产生两层表头。VTable 1.22.2 在部分 webview 缩放比下，
       * getFrozenRowsHeight() 可能只返回一层高度，所以取它与显式表头
       * 层高度中的较大值。否则逻辑 viewport 会高估一行，末行无法完全
       * 滚入画面。
       */
      const topFrozenHeight = Math.max(
        table.getFrozenRowsHeight(),
        columnHeaderHeight,
        PATTERN_HEADER_ROW_COUNT * VTABLE_HEADER_ROW_HEIGHT
      );
      const bodyTop =
        tableTop + topFrozenHeight;
      const bodyBottom =
        tableTop +
        table.tableNoFrameHeight -
        table.getBottomFrozenRowsHeight();
      /*
       * tableNoFrameHeight 已经扣除了非 hover 横向滚动条，不在这里
       * 重复相减。VS Code webview 的底部安全区由 Surface CSS 预留，
       * adapter 仍只返回 VTable 自己的真实 body 高度。
       */
      const measuredHeight = bodyBottom - bodyTop;

      if (Number.isFinite(measuredHeight) && measuredHeight > 0) {
        return measuredHeight;
      }

      return Math.max(1, table.getElement().clientHeight);
    },
    getVisibleRecordRange() {
      const range = table.getBodyVisibleCellRange();

      if (!range) {
        return null;
      }

      const start = table.getRecordShowIndexByCell(
        range.colStart,
        range.rowStart
      );
      const end = table.getRecordShowIndexByCell(
        range.colStart,
        range.rowEnd
      );

      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return null;
      }

      return { start, end };
    },
    getElement() {
      return table.getElement();
    }
  };
}

function nextFrame(): Promise<void> {
  return new Promise(resolve =>
    requestAnimationFrame(() => resolve())
  );
}
