/**
 * 阅读等级：A 业务必读
 * 是否迁移：按真实 Pattern 字段调整
 * 前置阅读：shared/protocol.ts、pattern-large-data-vtable/vtableAdapter.ts
 * 建议只关注：列定义、字段映射和乐观单元格回退
 * 可以跳过：无
 *
 * 这个文件是 VTable 通用字段与 Pattern 业务字段之间的唯一翻译层。
 * core/editor-shell 不允许导入 PatternEditableColumnId 或 SIGNAL_IDS。
 */

import type { ColumnsDefine } from "@visactor/vtable";
import { InputEditor } from "@visactor/vtable-editors";
import type {
  TableField,
  VTableAdapter
} from "../pattern-large-data-vtable";
import {
  SIGNAL_IDS,
  isPatternEditableColumnId,
  type PatternEditableColumnId,
  type PatternRenderRow
} from "../shared/protocol";

export type PatternTableAdapter =
  VTableAdapter<PatternRenderRow>;

export function createPatternColumns(): ColumnsDefine {
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
      width: 160,
      editor: new InputEditor()
    },
    {
      field: "comment",
      title: "Comment",
      width: 170,
      editor: new InputEditor()
    },
    {
      title: "Signals",
      columns: SIGNAL_IDS.map(signalId => ({
        key: `signal:${signalId}`,
        field: ["signalValues", signalId],
        title: signalId,
        width: 76,
        editor: new InputEditor()
      }))
    }
  ];
}

export function toPatternEditableColumnId(
  field: TableField | null
): PatternEditableColumnId | null {
  const candidate = Array.isArray(field)
    ? field.at(-1)
    : field;

  return isPatternEditableColumnId(candidate)
    ? candidate
    : null;
}

export function toPatternEditableColumnIds(
  fields: readonly TableField[] | null
): PatternEditableColumnId[] | null {
  if (!fields) {
    return null;
  }

  const columns: PatternEditableColumnId[] = [];

  for (const field of fields) {
    const columnId = toPatternEditableColumnId(field);

    if (!columnId) {
      return null;
    }

    columns.push(columnId);
  }

  return columns;
}

export function replacePatternCellValue(
  row: PatternRenderRow,
  columnId: PatternEditableColumnId,
  value: string
): PatternRenderRow {
  if (columnId === "instruction") {
    return { ...row, instruction: value };
  }

  if (columnId === "comment") {
    return { ...row, comment: value };
  }

  return {
    ...row,
    signalValues: {
      ...row.signalValues,
      [columnId]: value
    }
  };
}
