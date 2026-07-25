/**
 * 阅读等级：A 业务必读
 * 是否迁移：是
 * 前置阅读：patternReadClient.ts、PatternTable.tsx
 * 建议只关注：公开返回值中的导航和四个 mutation 动作
 * 可以跳过：VTable 乐观值回退、订阅清理和 staged reload 细节
 *
 * 这是 Webview 的统一 controller。React 组件只显示状态和转发用户动作；
 * revision、事务提交、缓存迁移、失败回退和窗口重载都集中在这里，避免业务
 * 页面为每个按钮重复实现容易遗漏的异常分支。
 *
 * 重要边界：React state 只保存元数据、菜单和状态栏摘要，不保存窗口 rows。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject
} from "react";
import {
  LogicalViewport,
  type LogicalViewportState
} from "../core/logicalViewport";
import {
  type TableCellEditEvent,
  type TableContextMenuEvent,
  type TablePasteEvent
} from "../core/vtableAdapter";
import {
  replacePatternCellValue,
  toPatternEditableColumnId,
  toPatternEditableColumnIds,
  type PatternTableAdapter
} from "../pattern-domain/patternTableBinding";
import type {
  PatternDocumentClient,
  PatternMetadata,
  PatternMutationOperation,
  PatternRenderRow
} from "../shared/protocol";
import { parseClipboardTsv } from "./clipboardTsv";

const INITIAL_STATE: LogicalViewportState = {
  totalVectors: 0,
  revision: 0,
  logicalScrollTopPx: 0,
  firstVisibleVectorIndex: 0,
  lastVisibleVectorIndex: 0,
  windowStartVectorIndex: 0,
  windowEndVectorIndex: 0,
  isLoading: true,
  cacheEntries: 0,
  errorMessage: null
};

export type PatternTableBindings = {
  logicalScrollRef: RefObject<HTMLDivElement>;
  spacerRef: RefObject<HTMLDivElement>;
  interactionRef: RefObject<HTMLDivElement>;
  handleTableReady(
    table: PatternTableAdapter,
    isInitial: boolean
  ): void;
  handleSurfaceContextMenu(
    event: ReactMouseEvent<HTMLDivElement>
  ): void;
};

export type PatternContextMenuState = {
  clientX: number;
  clientY: number;
  targetVectorIndex: number | null;
  selectedRowKeys: string[];
};

type MutationOptions = {
  optimisticPreviousRow?: PatternRenderRow;
  preferLocalCacheUpdate?: boolean;
};

export function usePatternViewport(client: PatternDocumentClient) {
  const logicalScrollRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<LogicalViewport | null>(null);
  const revisionRef = useRef(0);
  const mutationPendingRef = useRef(false);
  const [metadata, setMetadata] =
    useState<PatternMetadata | null>(null);
  const [tableAdapter, setTableAdapter] =
    useState<PatternTableAdapter | null>(null);
  const [state, setState] =
    useState<LogicalViewportState>(INITIAL_STATE);
  const [isDirty, setIsDirty] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [actionMessage, setActionMessage] = useState(
    "双击可编辑；右键可插入或删除；Ctrl/Cmd+V 可粘贴。"
  );
  const [contextMenu, setContextMenu] =
    useState<PatternContextMenuState | null>(null);

  useEffect(() => {
    let cancelled = false;

    void client
      .getMetadata()
      .then(nextMetadata => {
        if (cancelled) {
          return;
        }

        revisionRef.current = nextMetadata.revision;
        setIsDirty(nextMetadata.isDirty);
        setMetadata(nextMetadata);
        setState(current => ({
          ...current,
          totalVectors: nextMetadata.totalVectors,
          revision: nextMetadata.revision,
          isLoading: true
        }));
      })
      .catch(error => {
        if (!cancelled) {
          setState(current => ({
            ...current,
            isLoading: false,
            errorMessage: toErrorMessage(error)
          }));
        }
      });

    return () => {
      cancelled = true;
      client.dispose?.();
    };
  }, [client]);

  useEffect(() => {
    const scrollElement = logicalScrollRef.current;
    const spacerElement = spacerRef.current;
    const interactionElement = interactionRef.current;

    if (
      !metadata ||
      !tableAdapter ||
      !scrollElement ||
      !spacerElement ||
      !interactionElement
    ) {
      return;
    }

    const viewport = new LogicalViewport({
      client,
      table: tableAdapter,
      scrollElement,
      spacerElement,
      interactionElement,
      totalVectors: metadata.totalVectors,
      revision: metadata.revision,
      onStateChange: nextState => {
        revisionRef.current = nextState.revision;
        setState(nextState);
      },
      onError: error => {
        console.error(
          "[Pattern Editor Lite] window read failed",
          error
        );
      }
    });

    viewportRef.current = viewport;
    void viewport.start().catch(error => {
      setState(current => ({
        ...current,
        isLoading: false,
        errorMessage: toErrorMessage(error)
      }));
    });

    return () => {
      viewport.dispose();

      if (viewportRef.current === viewport) {
        viewportRef.current = null;
      }
    };
  }, [client, metadata, tableAdapter]);

  useEffect(() => {
    return client.onDidChangeDocumentState?.(event => {
      revisionRef.current = event.metadata.revision;
      setIsDirty(event.metadata.isDirty);

      if (event.action === "saved") {
        setActionMessage("已保存到磁盘。");
        return;
      }

      const viewport = viewportRef.current;

      if (!viewport) {
        return;
      }

      const snapshot = viewport.captureViewportSnapshot();
      setIsMutating(true);
      void viewport
        .replaceDataset({
          totalVectors: event.metadata.totalVectors,
          revision: event.metadata.revision,
          snapshot
        })
        .then(() => {
          setActionMessage("已从磁盘恢复。");
        })
        .catch(error => {
          console.error(
            "[Pattern Editor Lite] revert reload failed",
            error
          );
          setActionMessage(
            `恢复显示失败：${toErrorMessage(error)}`
          );
        })
        .finally(() => {
          setIsMutating(false);
        });
    });
  }, [client]);

  const runMutation = useCallback(
    async (
      operation: PatternMutationOperation,
      options: MutationOptions = {}
    ) => {
      const viewport = viewportRef.current;

      if (!viewport || mutationPendingRef.current) {
        if (options.optimisticPreviousRow) {
          viewport?.restoreOptimisticRow(
            options.optimisticPreviousRow
          );
        }

        setActionMessage(
          viewport
            ? "上一项修改仍在提交，请稍后重试。"
            : "表格尚未准备完成。"
        );
        return;
      }

      mutationPendingRef.current = true;
      setIsMutating(true);
      setContextMenu(null);
      const snapshot = viewport.captureViewportSnapshot();
      const baseRevision = revisionRef.current;

      try {
        const response = await client.applyMutation({
          baseRevision,
          operation
        });

        /*
         * 后端已经原子提交后，revision 必须立即推进。即使随后本地 Canvas
         * 同步失败，也不能再用旧 revision 发起第二次写操作。
         */
        revisionRef.current = response.revision;

        if (
          response.revision !== response.previousRevision &&
          options.preferLocalCacheUpdate &&
          response.updatedRows?.length
        ) {
          try {
            await viewport.applyCommittedRows({
              previousRevision: response.previousRevision,
              revision: response.revision,
              rows: response.updatedRows
            });
          } catch (cacheError) {
            console.warn(
              "[Pattern Editor Lite] local cache update failed; staging authoritative window",
              cacheError
            );
            await viewport.replaceDataset({
              totalVectors: response.totalVectors,
              revision: response.revision,
              effects: response.effects,
              snapshot
            });
          }
        } else if (
          response.revision !== response.previousRevision
        ) {
          await viewport.replaceDataset({
            totalVectors: response.totalVectors,
            revision: response.revision,
            effects: response.effects,
            snapshot
          });
        }

        setIsDirty(response.isDirty);
        setActionMessage(response.message);
      } catch (error) {
        if (options.optimisticPreviousRow) {
          viewport.restoreOptimisticRow(
            options.optimisticPreviousRow
          );
        }

        console.error(
          `[Pattern Editor Lite] ${operation.kind} failed`,
          error
        );
        setActionMessage(`操作失败：${toErrorMessage(error)}`);
      } finally {
        mutationPendingRef.current = false;
        setIsMutating(false);
      }
    },
    [client]
  );

  useEffect(() => {
    if (!tableAdapter) {
      return;
    }

    const stopEdit = tableAdapter.observeCellEdits(event => {
      handleCellEdit(event, runMutation);
    });
    const stopContextMenu = tableAdapter.observeContextMenu(
      event => {
        setContextMenu(toContextMenuState(event));
      }
    );
    const stopPaste = tableAdapter.observePaste(event => {
      handlePaste(event, tableAdapter, runMutation, setActionMessage);
    });

    return () => {
      stopEdit();
      stopContextMenu();
      stopPaste();
    };
  }, [runMutation, tableAdapter]);

  const handleTableReady = useCallback(
    (adapter: PatternTableAdapter) => {
      setTableAdapter(adapter);
    },
    []
  );

  const goToVectorIndex = useCallback(
    async (vectorIndex: number) => {
      setContextMenu(null);
      await viewportRef.current?.goToVectorIndex(vectorIndex);
    },
    []
  );

  const handleSurfaceContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();

      if (state.totalVectors === 0) {
        setContextMenu({
          clientX: event.clientX,
          clientY: event.clientY,
          targetVectorIndex: null,
          selectedRowKeys: []
        });
      }
    },
    [state.totalVectors]
  );

  const insertRows = useCallback(
    (position: "above" | "below", count: number) => {
      const targetVectorIndex =
        contextMenu?.targetVectorIndex ?? 0;
      const atVectorIndex =
        position === "below" &&
        contextMenu?.targetVectorIndex !== null
          ? targetVectorIndex + 1
          : targetVectorIndex;

      void runMutation({
        kind: "insertRows",
        atVectorIndex,
        count
      });
    },
    [contextMenu, runMutation]
  );

  const deleteSelectedRows = useCallback(() => {
    if (!contextMenu?.selectedRowKeys.length) {
      return;
    }

    void runMutation({
      kind: "deleteRows",
      rowKeys: contextMenu.selectedRowKeys
    });
  }, [contextMenu, runMutation]);

  return {
    metadata,
    state,
    ready: metadata !== null && viewportRef.current !== null,
    isDirty,
    isMutating,
    actionMessage,
    contextMenu,
    goToVectorIndex,
    insertRows,
    deleteSelectedRows,
    closeContextMenu: () => setContextMenu(null),
    bindings: {
      logicalScrollRef,
      spacerRef,
      interactionRef,
      handleTableReady,
      handleSurfaceContextMenu
    } satisfies PatternTableBindings
  };
}

function handleCellEdit(
  event: TableCellEditEvent<PatternRenderRow>,
  runMutation: (
    operation: PatternMutationOperation,
    options?: MutationOptions
  ) => Promise<void>
): void {
  const columnId = toPatternEditableColumnId(event.field);

  if (
    !columnId ||
    event.rawValue === event.changedValue
  ) {
    return;
  }

  const previousRow = replacePatternCellValue(
    event.record,
    columnId,
    event.rawValue
  );

  void runMutation(
    {
      kind: "updateCells",
      changes: [
        {
          rowKey: event.record.rowKey,
          columnId,
          value: event.changedValue
        }
      ]
    },
    {
      optimisticPreviousRow: previousRow,
      preferLocalCacheUpdate: true
    }
  );
}

function handlePaste(
  event: TablePasteEvent<PatternRenderRow>,
  table: PatternTableAdapter,
  runMutation: (
    operation: PatternMutationOperation,
    options?: MutationOptions
  ) => Promise<void>,
  showMessage: (message: string) => void
): void {
  try {
    const values = parseClipboardTsv(event.clipboardText);
    const fields = table.getColumnFields(
      event.startCol,
      values[0].length,
      event.startTableRow
    );
    const columns = toPatternEditableColumnIds(fields);

    if (!columns) {
      throw new Error(
        "粘贴目标包含 Vector、Cycle 或超出最后一个 Signal 列。"
      );
    }

    void runMutation({
      kind: "paste",
      startRowKey: event.startRow.rowKey,
      columns,
      values
    });
  } catch (error) {
    showMessage(`粘贴失败：${toErrorMessage(error)}`);
  }
}

function toContextMenuState(
  event: TableContextMenuEvent<PatternRenderRow>
): PatternContextMenuState {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
    targetVectorIndex: event.targetRow.vectorIndex,
    selectedRowKeys: [
      ...new Set(event.selectedRows.map(row => row.rowKey))
    ]
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Pattern request failed.";
}
