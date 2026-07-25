/**
 * 阅读等级：B 接口必读
 * 是否迁移：是
 * 前置阅读：core/vtableAdapter.ts
 * 建议只关注：DocumentTableSurface props 和 createDocumentTableOption
 * 可以跳过：React-VTable memo 薄封装
 *
 * 这是可整体迁移的通用表格外壳，只处理 DOM、VTable 和逻辑滚动三层装配。
 * 它不知道 Pattern 行字段、mutation、revision 或后端协议。
 */

import {
  memo,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject
} from "react";
import { ListTable } from "@visactor/react-vtable";
import type {
  ColumnsDefine,
  ListTableConstructorOptions
} from "@visactor/vtable";
import {
  VTABLE_HEADER_ROW_HEIGHT,
  VTABLE_HORIZONTAL_SCROLLBAR_HEIGHT,
  type VTableListTableInstance
} from "../core/vtableAdapter";

export type DocumentTableSurfaceProps = {
  option: ListTableConstructorOptions;
  logicalScrollRef: RefObject<HTMLDivElement>;
  spacerRef: RefObject<HTMLDivElement>;
  interactionRef: RefObject<HTMLDivElement>;
  onReady(
    table: VTableListTableInstance,
    isInitial: boolean
  ): void;
  onContextMenu(event: ReactMouseEvent<HTMLDivElement>): void;
};

export function DocumentTableSurface({
  option,
  logicalScrollRef,
  spacerRef,
  interactionRef,
  onReady,
  onContextMenu
}: DocumentTableSurfaceProps) {
  const focusSurface = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    if (isTextEditingTarget(event.target)) {
      return;
    }

    event.currentTarget.focus({ preventScroll: true });
  };

  return (
    <section className="table-shell" aria-label="Document table">
      <div
        ref={logicalScrollRef}
        className="logical-scroll"
        aria-hidden="true"
      >
        <div ref={spacerRef} className="virtual-spacer" />
      </div>
      <div
        ref={interactionRef}
        className="table-overlay"
        tabIndex={0}
        aria-label="Document data table"
        onPointerDownCapture={focusSurface}
        onContextMenu={onContextMenu}
      >
        <MemoVTable option={option} onReady={onReady} />
      </div>
    </section>
  );
}

function isTextEditingTarget(
  target: EventTarget | null
): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement &&
      target.isContentEditable)
  );
}

export function createDocumentTableOption(
  columns: ColumnsDefine
): ListTableConstructorOptions {
  return {
    records: [],
    columns,
    widthMode: "standard",
    defaultRowHeight: 28,
    defaultHeaderRowHeight: VTABLE_HEADER_ROW_HEIGHT,
    frozenColCount: 4,
    autoFillWidth: false,
    overscrollBehavior: "none",
    editCellTrigger: "doubleclick",
    keyboardOptions: {
      /*
       * VTable 当前只持有一个窗口，因此 Ctrl/Cmd+A 不会选择或物化亿级
       * 全量数据。复制由 adapter 的同步 ClipboardEvent 路径负责。
       */
      selectAllOnCtrlA: true,
      copySelected: false,
      pasteValueToCell: false,
      showCopyCellBorder: true
    },
    hover: {
      highlightMode: "row"
    },
    theme: {
      headerStyle: {
        bgColor: "#eef2f6",
        color: "#263247",
        fontSize: 12,
        fontWeight: 600
      },
      bodyStyle: {
        color: "#263247",
        fontSize: 12
      },
      scrollStyle: {
        visible: "always",
        horizontalVisible: "always",
        verticalVisible: "none",
        barToSide: true,
        hoverOn: false,
        width: VTABLE_HORIZONTAL_SCROLLBAR_HEIGHT,
        scrollRailColor: "rgba(226, 232, 240, 0.72)",
        scrollSliderColor: "rgba(100, 116, 139, 0.82)",
        scrollSliderCornerRadius: 6
      }
    }
  };
}

const MemoVTable = memo(function MemoVTable({
  option,
  onReady
}: {
  option: ListTableConstructorOptions;
  onReady(
    table: VTableListTableInstance,
    isInitial: boolean
  ): void;
}) {
  return (
    <ListTable
      option={option}
      className="vtable-instance"
      width="100%"
      height="100%"
      onReady={(table, isInitial) =>
        onReady(
          table as VTableListTableInstance,
          isInitial
        )
      }
    />
  );
});
