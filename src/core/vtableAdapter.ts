/**
 * 阅读等级：B 接口必读
 * 是否迁移：是
 * 前置阅读：core/logicalViewportMath.ts
 * 建议只关注：VTableAdapter 接口
 * 可以跳过：VTable tableRow 与 recordIndex 的转换
 *
 * 这是项目中唯一允许接触 VTable imperative API 的文件。即使将来 VTable
 * 的度量方法发生变化，也只在这里兼容，业务组件和逻辑滚动不需要跟着修改。
 */

import type { ListTable } from "@visactor/vtable";

export type VTableListTableInstance = ListTable;
export type TableRow = { rowKey: string };
export type TableField = string | readonly string[];

/**
 * 横向滚动条使用 always 模式，会覆盖 Canvas 底部而不是扩大 DOM 高度。
 * adapter 的 body 测量和表格主题必须共用同一个值，避免末行被覆盖。
 */
export const VTABLE_HORIZONTAL_SCROLLBAR_HEIGHT = 12;
export const VTABLE_HEADER_ROW_HEIGHT = 32;

export type VTableAdapterOptions = {
  /**
   * 某些分组表头版本的冻结高度测量会偏小。调用方可按自己的列配置提供
   * 最小表头高度；adapter 只负责测量，不知道 Pattern 有几层表头。
   */
  minimumHeaderHeightPx?: number;
};

export interface VTableAdapter<Row extends TableRow> {
  setRecords(rows: Row[]): void;
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
    listener: (event: TableCellEditEvent<Row>) => void
  ): () => void;
  observeContextMenu(
    listener: (event: TableContextMenuEvent<Row>) => void
  ): () => void;
  observePaste(
    listener: (event: TablePasteEvent<Row>) => void
  ): () => void;
  getColumnFields(
    startCol: number,
    columnCount: number,
    tableRow: number
  ): TableField[] | null;
}

export type TableCellEditEvent<Row extends TableRow> = {
  record: Row;
  field: TableField | null;
  rawValue: string;
  changedValue: string;
};

export type TableContextMenuEvent<Row extends TableRow> = {
  clientX: number;
  clientY: number;
  targetRow: Row;
  selectedRows: Row[];
};

export type TablePasteEvent<Row extends TableRow> = {
  startCol: number;
  startTableRow: number;
  startRow: Row;
  clipboardText: string;
};

export function createVTableAdapter<Row extends TableRow>(
  table: VTableListTableInstance,
  options: VTableAdapterOptions = {}
): VTableAdapter<Row> {
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
        options.minimumHeaderHeightPx ?? 0
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
          ) as Row | undefined;
          const field = getColumnField(
            table,
            event.col,
            event.row
          );

          if (record) {
            listener({
              record,
              field,
              rawValue: toCellString(event.rawValue),
              changedValue: toCellString(event.changedValue)
            });
          }
        }
      );

      return () => table.off(listenerId);
    },
    observeContextMenu(listener) {
      const element = table.getElement();
      const handleContextMenu = (event: MouseEvent) => {
        event.preventDefault();
        const bounds = element.getBoundingClientRect();
        const cell = table.getCellAtRelativePosition(
          event.clientX - bounds.left,
          event.clientY - bounds.top
        );
        const targetRow = table.getCellOriginRecord(
          cell.col,
          cell.row
        ) as Row | undefined;

        /*
         * VTable 的 `contextmenu_cell` 依赖 VRender 的 rightdown 事件；
         * 在 Electron/自动化环境中可能只收到原生 contextmenu。这里直接
         * 使用 VTable 公开的坐标命中 API，浏览器与 VS Code 走同一条路径。
         */
        if (!targetRow) {
          return;
        }

        const ranges = table.getSelectedCellRanges();
        const targetInsideSelection = ranges.some(range =>
          cellInsideRange(cell.col, cell.row, range)
        );
        const selectedRows = targetInsideSelection
          ? collectSelectedRows<Row>(table, ranges, cell.col)
          : [targetRow];

        listener({
          clientX: event.clientX,
          clientY: event.clientY,
          targetRow,
          selectedRows
        });
      };

      element.addEventListener(
        "contextmenu",
        handleContextMenu
      );
      return () =>
        element.removeEventListener(
          "contextmenu",
          handleContextMenu
        );
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
        ) as Row | undefined;

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
    getColumnFields(startCol, columnCount, tableRow) {
      const fields: TableField[] = [];

      for (let index = 0; index < columnCount; index += 1) {
        const field = getColumnField(
          table,
          startCol + index,
          tableRow
        );

        if (!field) {
          return null;
        }

        fields.push(field);
      }

      return fields;
    }
  };
}

function getColumnField(
  table: VTableListTableInstance,
  col: number,
  row: number
): TableField | null {
  const field = table.getHeaderField(col, row);

  if (typeof field === "string") {
    return field;
  }

  if (
    Array.isArray(field) &&
    field.every(item => typeof item === "string")
  ) {
    return field;
  }

  return null;
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

function collectSelectedRows<Row extends TableRow>(
  table: VTableListTableInstance,
  ranges: ReturnType<VTableListTableInstance["getSelectedCellRanges"]>,
  fallbackCol: number
): Row[] {
  const rows = new Map<string, Row>();

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
      ) as Row | undefined;

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
