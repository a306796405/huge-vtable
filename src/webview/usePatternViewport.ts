/**
 * 阅读等级：A 业务必读
 * 是否迁移：是
 * 前置阅读：patternReadClient.ts、PatternTable.tsx
 * 建议只关注：metadata → adapter → LogicalViewport 的装配顺序
 * 可以跳过：React effect 清理样板
 *
 * React state 只保存元数据和状态栏摘要。窗口 rows 始终位于
 * LogicalViewport/ReadWindowCache/VTable 内部，不经过 useState。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import type { RefObject } from "react";
import {
  LogicalViewport,
  type LogicalViewportState
} from "../core/logicalViewport";
import {
  createVTableAdapter,
  type PatternTableAdapter,
  type VTableListTableInstance
} from "../core/vtableAdapter";
import type {
  PatternMetadata,
  PatternReadClient
} from "../shared/protocol";

const INITIAL_STATE: LogicalViewportState = {
  totalVectors: 0,
  revision: 0,
  logicalOffset: 0,
  visibleStart: 0,
  visibleEnd: 0,
  windowStart: 0,
  windowEnd: 0,
  isLoading: true,
  cacheEntries: 0,
  errorMessage: null
};

export type PatternTableBindings = {
  logicalScrollRef: RefObject<HTMLDivElement>;
  spacerRef: RefObject<HTMLDivElement>;
  interactionRef: RefObject<HTMLDivElement>;
  handleTableReady(
    table: VTableListTableInstance,
    isInitial: boolean
  ): void;
};

export function usePatternViewport(client: PatternReadClient) {
  const logicalScrollRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<LogicalViewport | null>(null);
  const [metadata, setMetadata] =
    useState<PatternMetadata | null>(null);
  const [tableAdapter, setTableAdapter] =
    useState<PatternTableAdapter | null>(null);
  const [state, setState] =
    useState<LogicalViewportState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;

    void client
      .getMetadata()
      .then(nextMetadata => {
        if (!cancelled) {
          setMetadata(nextMetadata);
          setState(current => ({
            ...current,
            ...nextMetadata,
            isLoading: true
          }));
        }
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
      onStateChange: setState,
      onError: error => {
        console.error("[Pattern Editor Lite] window read failed", error);
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

  const handleTableReady = useCallback(
    (table: VTableListTableInstance) => {
      setTableAdapter(createVTableAdapter(table));
    },
    []
  );

  const goToOffset = useCallback(async (offset: number) => {
    await viewportRef.current?.goToOffset(offset);
  }, []);

  return {
    metadata,
    state,
    ready: metadata !== null && viewportRef.current !== null,
    goToOffset,
    bindings: {
      logicalScrollRef,
      spacerRef,
      interactionRef,
      handleTableReady
    } satisfies PatternTableBindings
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Pattern metadata request failed.";
}
