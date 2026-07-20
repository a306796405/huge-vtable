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
import {
  isPatternEditableColumnId,
  type PatternEditableColumnId,
  type PatternRenderRow
} from "../shared/protocol";

export type VTableListTableInstance = ListTable;

/**
 * 横向滚动条使用 always 模式，会覆盖 Canvas 底部而不是扩大 DOM 高度。
 * adapter 的 body 测量和表格主题必须共用同一个值，避免末行被覆盖。
 */
export const VTABLE_HORIZONTAL_SCROLLBAR_HEIGHT = 12;
export const VTABLE_HEADER_ROW_HEIGHT = 32;
export const PATTERN_HEADER_ROW_COUNT = 2;

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
  observeCellEdits(
    listener: (event: PatternCellEditEvent) => void
  ): () => void;
  observeContextMenu(
    listener: (event: PatternContextMenuEvent) => void
  ): () => void;
  observePaste(
    listener: (event: PatternPasteEvent) => void
  ): () => void;
  getEditableColumnIds(
    startCol: number,
    columnCount: number,
    tableRow: number
  ): PatternEditableColumnId[] | null;
}

export type PatternCellEditEvent = {
  record: PatternRenderRow;
  columnId: PatternEditableColumnId;
  rawValue: string;
  changedValue: string;
};

export type PatternContextMenuEvent = {
  clientX: number;
  clientY: number;
  targetRow: PatternRenderRow;
  selectedRows: PatternRenderRow[];
};

export type PatternPasteEvent = {
  startCol: number;
  startTableRow: number;
  startRow: PatternRenderRow;
  clipboardText: string;
};

export function createVTableAdapter(
  table: VTableListTableInstance
): PatternTableAdapter {
  return {
    setRecords(rows) {
      table.setRecords(rows, { sortState: null });
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
    },
    observeCellEdits(listener) {
      const listenerId = table.on(
        "change_cell_value",
        event => {
          const record = table.getCellOriginRecord(
            event.col,
            event.row
          ) as PatternRenderRow | undefined;
          const columnId = getEditableColumnId(
            table,
            event.col,
            event.row
          );

          if (record && columnId) {
            listener({
              record,
              columnId,
              rawValue: toCellString(event.rawValue),
              changedValue: toCellString(event.changedValue)
            });
          }
        }
      );

      return () => table.off(listenerId);
    },
    observeContextMenu(listener) {
      const listenerId = table.on(
        "contextmenu_cell",
        event => {
          event.event?.preventDefault();
          const targetRow = table.getCellOriginRecord(
            event.col,
            event.row
          ) as PatternRenderRow | undefined;

          if (!targetRow) {
            return;
          }

          const ranges = table.getSelectedCellRanges();
          const targetInsideSelection = ranges.some(range =>
            cellInsideRange(event.col, event.row, range)
          );
          const selectedRows = targetInsideSelection
            ? collectSelectedRows(table, ranges, event.col)
            : [targetRow];
          const mouseEvent = event.event as
            | MouseEvent
            | PointerEvent
            | undefined;

          listener({
            clientX: mouseEvent?.clientX ?? 0,
            clientY: mouseEvent?.clientY ?? 0,
            targetRow,
            selectedRows
          });
        }
      );

      return () => table.off(listenerId);
    },
    observePaste(listener) {
      const element = table.getElement();
      const handlePaste = (event: ClipboardEvent) => {
        const range = table.getSelectedCellRanges().at(-1);

        if (!range || !event.clipboardData) {
          return;
        }

        const startCol = Math.min(
          range.start.col,
          range.end.col
        );
        const startTableRow = Math.min(
          range.start.row,
          range.end.row
        );
        const startRow = table.getCellOriginRecord(
          startCol,
          startTableRow
        ) as PatternRenderRow | undefined;

        if (!startRow) {
          return;
        }

        event.preventDefault();
        listener({
          startCol,
          startTableRow,
          startRow,
          clipboardText:
            event.clipboardData.getData("text/plain")
        });
      };

      element.addEventListener("paste", handlePaste);
      return () =>
        element.removeEventListener("paste", handlePaste);
    },
    getEditableColumnIds(startCol, columnCount, tableRow) {
      const columns: PatternEditableColumnId[] = [];

      for (let index = 0; index < columnCount; index += 1) {
        const columnId = getEditableColumnId(
          table,
          startCol + index,
          tableRow
        );

        if (!columnId) {
          return null;
        }

        columns.push(columnId);
      }

      return columns;
    }
  };
}

function getEditableColumnId(
  table: VTableListTableInstance,
  col: number,
  row: number
): PatternEditableColumnId | null {
  const field = table.getHeaderField(col, row);
  const candidate = Array.isArray(field)
    ? field.at(-1)
    : field;

  return isPatternEditableColumnId(candidate)
    ? candidate
    : null;
}

function cellInsideRange(
  col: number,
  row: number,
  range: {
    start: { col: number; row: number };
    end: { col: number; row: number };
  }
): boolean {
  return (
    col >= Math.min(range.start.col, range.end.col) &&
    col <= Math.max(range.start.col, range.end.col) &&
    row >= Math.min(range.start.row, range.end.row) &&
    row <= Math.max(range.start.row, range.end.row)
  );
}

function collectSelectedRows(
  table: VTableListTableInstance,
  ranges: ReturnType<VTableListTableInstance["getSelectedCellRanges"]>,
  fallbackCol: number
): PatternRenderRow[] {
  const rows = new Map<string, PatternRenderRow>();

  for (const range of ranges) {
    const startRow = Math.min(range.start.row, range.end.row);
    const endRow = Math.max(range.start.row, range.end.row);
    const col = Math.max(
      0,
      Math.min(
        fallbackCol,
        Math.max(range.start.col, range.end.col)
      )
    );

    for (let row = startRow; row <= endRow; row += 1) {
      const record = table.getCellOriginRecord(
        col,
        row
      ) as PatternRenderRow | undefined;

      if (record) {
        rows.set(record.rowKey, record);
      }
    }
  }

  return [...rows.values()];
}

function nextFrame(): Promise<void> {
  return new Promise(resolve =>
    requestAnimationFrame(() => resolve())
  );
}

function toCellString(value: unknown): string {
  return value === null || value === undefined
    ? ""
    : String(value);
}
