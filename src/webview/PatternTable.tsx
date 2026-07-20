/**
 * 阅读等级：A 业务必读
 * 是否迁移：按真实 Pattern 列调整
 * 前置阅读：usePatternViewport.ts
 * 建议只关注：列定义和三层 Surface
 * 可以跳过：React-VTable memo 薄封装
 */

import { memo, useMemo } from "react";
import { ListTable } from "@visactor/react-vtable";
import type {
  ColumnsDefine,
  ListTableConstructorOptions
} from "@visactor/vtable";
import { SIGNAL_IDS } from "../shared/protocol";
import {
  VTABLE_HEADER_ROW_HEIGHT,
  VTABLE_HORIZONTAL_SCROLLBAR_HEIGHT,
  type VTableListTableInstance
} from "../core/vtableAdapter";
import type { PatternTableBindings } from "./usePatternViewport";

export function PatternTable({
  bindings
}: {
  bindings: PatternTableBindings;
}) {
  const option = useMemo(createTableOption, []);

  return (
    <section className="table-shell" aria-label="Pattern vectors">
      <div
        ref={bindings.logicalScrollRef}
        className="logical-scroll"
        aria-hidden="true"
      >
        <div
          ref={bindings.spacerRef}
          className="virtual-spacer"
        />
      </div>
      <div
        ref={bindings.interactionRef}
        className="table-overlay"
        tabIndex={0}
        aria-label="Pattern vector table"
      >
        <MemoVTable
          option={option}
          onReady={bindings.handleTableReady}
        />
      </div>
    </section>
  );
}

function createTableOption(): ListTableConstructorOptions {
  return {
    records: [],
    columns: createColumns(),
    widthMode: "standard",
    defaultRowHeight: 28,
    defaultHeaderRowHeight: VTABLE_HEADER_ROW_HEIGHT,
    frozenColCount: 4,
    autoFillWidth: false,
    overscrollBehavior: "none",
    keyboardOptions: {
      copySelected: true,
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

function createColumns(): ColumnsDefine {
  return [
    {
      field: "vectorIndex",
      title: "Vector",
      width: 92
    },
    {
      field: "cycleText",
      title: "Cycle",
      width: 110
    },
    {
      field: "instruction",
      title: "Instruction",
      width: 160
    },
    {
      field: "comment",
      title: "Comment",
      width: 170
    },
    {
      title: "Signals",
      columns: SIGNAL_IDS.map(signalId => ({
        key: `signal:${signalId}`,
        field: ["signalValues", signalId],
        title: signalId,
        width: 76
      }))
    }
  ];
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
