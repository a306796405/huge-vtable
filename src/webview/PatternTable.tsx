/**
 * 阅读等级：A 业务必读
 * 是否迁移：按真实 Pattern 列调整
 * 前置阅读：pattern-domain/patternTableBinding.ts
 * 建议只关注：Pattern 配置如何注入公共 Surface
 * 可以跳过：公共 Surface 内部实现
 */

import { useCallback, useMemo } from "react";
import {
  createVTableAdapter,
  VTABLE_HEADER_ROW_HEIGHT,
  type VTableListTableInstance
} from "../core/vtableAdapter";
import {
  createDocumentTableOption,
  DocumentTableSurface
} from "../editor-shell/DocumentTableSurface";
import {
  createPatternColumns,
  type PatternTableAdapter
} from "../pattern-domain/patternTableBinding";
import type { PatternRenderRow } from "../shared/protocol";
import type { PatternTableBindings } from "./usePatternViewport";

const PATTERN_HEADER_ROW_COUNT = 2;

export function PatternTable({
  bindings
}: {
  bindings: PatternTableBindings;
}) {
  const option = useMemo(
    () => createDocumentTableOption(createPatternColumns()),
    []
  );
  const handleReady = useCallback(
    (
      table: VTableListTableInstance,
      isInitial: boolean
    ) => {
      const adapter = createVTableAdapter<PatternRenderRow>(
        table,
        {
          minimumHeaderHeightPx:
            PATTERN_HEADER_ROW_COUNT *
            VTABLE_HEADER_ROW_HEIGHT,
          interactionElement:
            bindings.interactionRef.current ?? undefined
        }
      );
      bindings.handleTableReady(adapter, isInitial);
    },
    [bindings]
  );

  return (
    <DocumentTableSurface
      option={option}
      logicalScrollRef={bindings.logicalScrollRef}
      spacerRef={bindings.spacerRef}
      interactionRef={bindings.interactionRef}
      onReady={handleReady}
      onContextMenu={bindings.handleSurfaceContextMenu}
    />
  );
}
