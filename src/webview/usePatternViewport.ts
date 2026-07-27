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
  type LogicalViewportState,
  type ViewportSnapshot
} from "../pattern-large-data-vtable";
import {
  type TableCellEditEvent,
  type TableContextMenuEvent,
  type TablePasteEvent
} from "../pattern-large-data-vtable";
import {
  replacePatternCellValue,
  toPatternEditableColumnId,
  toPatternEditableColumnIds,
  type PatternTableAdapter
} from "../pattern-domain/patternTableBinding";
import type {
  PatternClientLogEntry,
  PatternDocumentClient,
  PatternHistoryDirection,
  PatternMetadata,
  PatternMutationOperation,
  PatternRequestError,
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

type ClientIssue = {
  command: string;
  phase: string;
  error: unknown;
  level?: PatternClientLogEntry["level"];
  errorId?: string;
};

type AuthoritativeSyncOptions = {
  command: string;
  errorId: string;
  snapshot?: ViewportSnapshot;
};

export function usePatternViewport(client: PatternDocumentClient) {
  const logicalScrollRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<LogicalViewport | null>(null);
  const revisionRef = useRef(0);
  const windowStartRef = useRef(0);
  const mutationPendingRef = useRef(false);
  const historyPendingRef = useRef(false);
  const historyEventVersionRef = useRef(0);
  const recoveryPromiseRef = useRef<Promise<void> | null>(
    null
  );
  const syncBlockedRef = useRef(false);
  const nextErrorIdRef = useRef(1);
  const [metadata, setMetadata] =
    useState<PatternMetadata | null>(null);
  const [tableAdapter, setTableAdapter] =
    useState<PatternTableAdapter | null>(null);
  const [state, setState] =
    useState<LogicalViewportState>(INITIAL_STATE);
  const [isDirty, setIsDirty] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [isSyncBlocked, setIsSyncBlocked] =
    useState(false);
  const [actionMessage, setActionMessage] = useState(
    "双击可编辑；右键可插入或删除；Ctrl/Cmd+A/C/V 可全选、复制和粘贴。"
  );
  const [contextMenu, setContextMenu] =
    useState<PatternContextMenuState | null>(null);

  const applyMetadata = useCallback(
    (nextMetadata: PatternMetadata) => {
      revisionRef.current = nextMetadata.revision;
      /*
       * metadata state 只负责首次创建 viewport。后续 revision 由 runtime
       * 原地推进，不能替换这个对象，否则 React effect 会销毁并重建表格，
       * 造成闪动和滚动位置丢失。
       */
      setMetadata(current => current ?? nextMetadata);
      setIsDirty(nextMetadata.isDirty);
      setCanUndo(nextMetadata.canUndo);
      setCanRedo(nextMetadata.canRedo);
    },
    []
  );

  const reportClientIssue = useCallback(
    (issue: ClientIssue): string => {
      const errorId =
        issue.errorId ??
        `PE-${Date.now().toString(36)}-${nextErrorIdRef.current++}`;
      const detail = getRequestErrorDetail(issue.error);

      client.reportClientLog?.({
        errorId,
        level: issue.level ?? "error",
        command: issue.command,
        phase: issue.phase,
        revision: revisionRef.current,
        windowStartVectorIndex: windowStartRef.current,
        code: detail?.code ?? "CLIENT_ERROR",
        message: toErrorMessage(issue.error),
        stack:
          issue.error instanceof Error
            ? issue.error.stack
            : undefined
      });

      return errorId;
    },
    [client]
  );

  const syncAuthoritative = useCallback(
    (
      options: AuthoritativeSyncOptions
    ): Promise<void> => {
      const activeRecovery = recoveryPromiseRef.current;

      if (activeRecovery) {
        return activeRecovery;
      }

      syncBlockedRef.current = false;
      setIsSyncBlocked(false);
      setIsMutating(true);

      const recovery = (async () => {
        const nextMetadata = await client.getMetadata();
        const viewport = viewportRef.current;

        if (viewport) {
          await viewport.replaceDataset({
            totalVectors: nextMetadata.totalVectors,
            revision: nextMetadata.revision,
            snapshot:
              options.snapshot ??
              viewport.captureViewportSnapshot()
          });
        }

        applyMetadata(nextMetadata);
        setState(current => ({
          ...current,
          totalVectors: nextMetadata.totalVectors,
          revision: nextMetadata.revision,
          errorMessage: null
        }));
        setActionMessage(
          `已重新同步权威数据（错误 ID：${options.errorId}）。`
        );
        client.reportClientLog?.({
          errorId: options.errorId,
          level: "info",
          command: options.command,
          phase: "authoritativeSync",
          revision: nextMetadata.revision,
          windowStartVectorIndex: windowStartRef.current,
          code: "RECOVERED",
          message: "Authoritative metadata and viewport synchronized."
        });
      })()
        .catch(error => {
          syncBlockedRef.current = true;
          setIsSyncBlocked(true);
          reportClientIssue({
            command: options.command,
            phase: "authoritativeSync",
            error,
            errorId: options.errorId
          });
          setActionMessage(
            `重新同步失败，当前画面已保留（错误 ID：${options.errorId}）。`
          );
          throw error;
        })
        .finally(() => {
          recoveryPromiseRef.current = null;
          setIsMutating(false);
        });

      recoveryPromiseRef.current = recovery;
      return recovery;
    },
    [applyMetadata, client, reportClientIssue]
  );

  useEffect(() => {
    let cancelled = false;

    void client
      .getMetadata()
      .then(nextMetadata => {
        if (cancelled) {
          return;
        }

        applyMetadata(nextMetadata);
        setState(current => ({
          ...current,
          totalVectors: nextMetadata.totalVectors,
          revision: nextMetadata.revision,
          isLoading: true
        }));
      })
      .catch(error => {
        if (!cancelled) {
          const errorId = reportClientIssue({
            command: "getMetadata",
            phase: "initialLoad",
            error
          });
          syncBlockedRef.current = true;
          setIsSyncBlocked(true);
          setState(current => ({
            ...current,
            isLoading: false,
            errorMessage: toErrorMessage(error)
          }));
          setActionMessage(
            `文档初始化失败（错误 ID：${errorId}）。`
          );
        }
      });

    return () => {
      cancelled = true;
      client.dispose?.();
    };
  }, [applyMetadata, client, reportClientIssue]);

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
        windowStartRef.current =
          nextState.windowStartVectorIndex;
        setState(nextState);
      },
      onError: error => {
        reportClientIssue({
          command: "getWindow",
          phase: "viewportRead",
          error
        });
      }
    });

    viewportRef.current = viewport;
    void viewport.start().catch(error => {
      const errorId = reportClientIssue({
        command: "getWindow",
        phase: "viewportStart",
        error
      });
      syncBlockedRef.current = true;
      setIsSyncBlocked(true);
      setState(current => ({
        ...current,
        isLoading: false,
        errorMessage: toErrorMessage(error)
      }));
      setActionMessage(
        `初始窗口读取失败（错误 ID：${errorId}）。`
      );
    });

    return () => {
      viewport.dispose();

      if (viewportRef.current === viewport) {
        viewportRef.current = null;
      }
    };
  }, [client, metadata, reportClientIssue, tableAdapter]);

  useEffect(() => {
    return client.onDidChangeDocumentState?.(event => {
      applyMetadata(event.metadata);

      if (event.action === "saved") {
        setActionMessage("已保存到磁盘。");
        return;
      }

      if (
        event.action === "undone" ||
        event.action === "redone"
      ) {
        historyEventVersionRef.current += 1;
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
          effects: event.effects,
          snapshot
        })
        .then(() => {
          setActionMessage(
            event.message ??
              (event.action === "reverted"
                ? "已从磁盘恢复。"
                : event.action === "undone"
                  ? "已撤销上一项操作。"
                  : "已重做上一项操作。")
          );
        })
        .catch(error => {
          const errorId = reportClientIssue({
            command: event.action,
            phase: "documentStateApply",
            error
          });

          return syncAuthoritative({
            command: event.action,
            errorId,
            snapshot
          }).catch(() => undefined);
        })
        .finally(() => {
          setIsMutating(false);
        });
    });
  }, [
    applyMetadata,
    client,
    reportClientIssue,
    syncAuthoritative
  ]);

  const runMutation = useCallback(
    async (
      operation: PatternMutationOperation,
      options: MutationOptions = {}
    ) => {
      const viewport = viewportRef.current;

      if (
        !viewport ||
        mutationPendingRef.current ||
        historyPendingRef.current ||
        recoveryPromiseRef.current ||
        syncBlockedRef.current
      ) {
        if (options.optimisticPreviousRow) {
          viewport?.restoreOptimisticRow(
            options.optimisticPreviousRow
          );
        }

        setActionMessage(
          syncBlockedRef.current
            ? "当前视图需要重新同步后才能继续写入。"
            : viewport
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
      let responseCommitted = false;

      try {
        const response = await client.applyMutation({
          baseRevision,
          operation
        });
        responseCommitted =
          response.revision !== response.previousRevision;

        /*
         * 后端已经原子提交后，revision 必须立即推进。即使随后本地 Canvas
         * 同步失败，也不能再用旧 revision 发起第二次写操作。
         */
        revisionRef.current = response.revision;
        applyMetadata(response);

        if (
          responseCommitted &&
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
            reportClientIssue({
              command: operation.kind,
              phase: "localCacheApply",
              error: cacheError,
              level: "warn"
            });
            await viewport.replaceDataset({
              totalVectors: response.totalVectors,
              revision: response.revision,
              effects: response.effects,
              snapshot
            });
          }
        } else if (responseCommitted) {
          await viewport.replaceDataset({
            totalVectors: response.totalVectors,
            revision: response.revision,
            effects: response.effects,
            snapshot
          });
        }

        setActionMessage(response.message);
      } catch (error) {
        const detail = getRequestErrorDetail(error);
        const isLocalValidationFailure =
          !responseCommitted &&
          detail?.code === "VALIDATION_ERROR";

        if (
          isLocalValidationFailure &&
          options.optimisticPreviousRow
        ) {
          viewport.restoreOptimisticRow(
            options.optimisticPreviousRow
          );
        }

        const errorId = reportClientIssue({
          command: operation.kind,
          phase: responseCommitted
            ? "applyCommittedResult"
            : "execute",
          level: isLocalValidationFailure ? "warn" : "error",
          error
        });

        if (isLocalValidationFailure) {
          setActionMessage(
            `操作未提交：${toErrorMessage(error)}（错误 ID：${errorId}）`
          );
        } else {
          await syncAuthoritative({
            command: operation.kind,
            errorId,
            snapshot
          }).catch(() => undefined);
        }
      } finally {
        mutationPendingRef.current = false;
        setIsMutating(false);
      }
    },
    [
      applyMetadata,
      client,
      reportClientIssue,
      syncAuthoritative
    ]
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
      handlePaste(
        event,
        tableAdapter,
        runMutation,
        setActionMessage,
        reportClientIssue
      );
    });

    return () => {
      stopEdit();
      stopContextMenu();
      stopPaste();
    };
  }, [reportClientIssue, runMutation, tableAdapter]);

  const handleTableReady = useCallback(
    (adapter: PatternTableAdapter) => {
      setTableAdapter(adapter);
    },
    []
  );

  const goToVectorIndex = useCallback(
    async (vectorIndex: number) => {
      setContextMenu(null);
      try {
        await viewportRef.current?.goToVectorIndex(
          vectorIndex
        );
      } catch (error) {
        const errorId = reportClientIssue({
          command: "goToVectorIndex",
          phase: "execute",
          error
        });
        setActionMessage(
          `定位失败：${toErrorMessage(error)}（错误 ID：${errorId}）`
        );
      }
    },
    [reportClientIssue]
  );

  const runHistory = useCallback(
    async (direction: PatternHistoryDirection) => {
      if (
        mutationPendingRef.current ||
        historyPendingRef.current ||
        recoveryPromiseRef.current ||
        syncBlockedRef.current
      ) {
        setActionMessage(
          syncBlockedRef.current
            ? "当前视图需要重新同步后才能执行历史操作。"
            : "上一项修改仍在处理，请稍后重试。"
        );
        return;
      }

      historyPendingRef.current = true;
      setContextMenu(null);
      setIsMutating(true);
      const eventVersion =
        historyEventVersionRef.current;

      try {
        const nextMetadata =
          await client.runHistory(direction);
        setCanUndo(nextMetadata.canUndo);
        setCanRedo(nextMetadata.canRedo);
        setIsDirty(nextMetadata.isDirty);

        /*
         * 有真实历史变化时，Extension 会先发送 documentState，staged
         * replacement 的 finally 负责结束 loading。若没有历史项，则不会
         * 有事件，这里直接恢复按钮状态。
         */
        if (
          historyEventVersionRef.current === eventVersion
        ) {
          setActionMessage(
            direction === "undo"
              ? "没有可撤销的操作。"
              : "没有可重做的操作。"
          );
          setIsMutating(false);
        }
      } catch (error) {
        const errorId = reportClientIssue({
          command: direction,
          phase: "execute",
          error
        });
        const viewport = viewportRef.current;

        await syncAuthoritative({
          command: direction,
          errorId,
          snapshot: viewport?.captureViewportSnapshot()
        }).catch(() => undefined);
        setIsMutating(false);
      } finally {
        historyPendingRef.current = false;
      }
    },
    [client, reportClientIssue, syncAuthoritative]
  );

  const retrySync = useCallback(async () => {
    const error = new Error(
      "User requested authoritative synchronization."
    );
    const errorId = reportClientIssue({
      command: "retrySync",
      phase: "requested",
      error,
      level: "info"
    });

    await syncAuthoritative({
      command: "retrySync",
      errorId,
      snapshot:
        viewportRef.current?.captureViewportSnapshot()
    }).catch(() => undefined);
  }, [reportClientIssue, syncAuthoritative]);

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
    isMutating: isMutating || isSyncBlocked,
    isSyncBlocked,
    canUndo,
    canRedo,
    actionMessage,
    contextMenu,
    goToVectorIndex,
    undo: () => runHistory("undo"),
    redo: () => runHistory("redo"),
    retrySync,
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
  showMessage: (message: string) => void,
  reportIssue: (issue: ClientIssue) => string
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
    const errorId = reportIssue({
      command: "paste",
      phase: "parseSelection",
      error,
      level: "warn"
    });
    showMessage(
      `粘贴失败：${toErrorMessage(error)}（错误 ID：${errorId}）`
    );
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

function getRequestErrorDetail(
  error: unknown
): PatternRequestError | undefined {
  if (
    !error ||
    typeof error !== "object" ||
    !("detail" in error)
  ) {
    return undefined;
  }

  const detail = error.detail;

  if (
    !detail ||
    typeof detail !== "object" ||
    !("code" in detail) ||
    !("message" in detail)
  ) {
    return undefined;
  }

  const code = detail.code;

  if (
    code !== "REVISION_CONFLICT" &&
    code !== "VALIDATION_ERROR" &&
    code !== "INTERNAL_ERROR"
  ) {
    return undefined;
  }

  return detail as PatternRequestError;
}
