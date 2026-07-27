/**
 * 阅读等级：A 业务必读
 * 是否迁移：是
 * 前置阅读：PatternTable.tsx、usePatternViewport.ts
 * 建议只关注：Go To Offset、表格和状态栏的装配
 * 可以跳过：数字格式化
 */

import {
  useCallback,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent
} from "react";
import type { PatternDocumentClient } from "../shared/protocol";
import { PatternTable } from "./PatternTable";
import { usePatternViewport } from "./usePatternViewport";
import "./styles.css";

export function PatternEditorApp({
  client
}: {
  client: PatternDocumentClient;
}) {
  const controller = usePatternViewport(client);
  const [offsetValue, setOffsetValue] = useState("0");

  const goToOffset = useCallback(async () => {
    const totalVectors = controller.state.totalVectors;
    const parsed = Number(offsetValue);
    const target =
      totalVectors <= 0
        ? 0
        : Math.min(
            Math.max(
              Number.isFinite(parsed) ? Math.trunc(parsed) : 0,
              0
            ),
            totalVectors - 1
          );

    setOffsetValue(String(target));
    await controller.goToVectorIndex(target);
  }, [controller, offsetValue]);

  const handleKeyDown = (
    event: KeyboardEvent<HTMLInputElement>
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void goToOffset();
    }
  };

  return (
    <main
      className="page"
      onPointerDown={() => controller.closeContextMenu()}
    >
      <section
        className="goto-toolbar"
        aria-label="Pattern navigation"
      >
        <label className="goto-field">
          <span className="sr-only">
            Go To Offset (0-based)
          </span>
          <input
            aria-label="Go To Offset"
            title="Go To Offset (0-based)"
            type="number"
            min="0"
            max={Math.max(
              0,
              controller.state.totalVectors - 1
            )}
            step="1"
            value={offsetValue}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setOffsetValue(event.target.value)
            }
            onKeyDown={handleKeyDown}
          />
        </label>
        <button
          type="button"
          disabled={!controller.metadata}
          onClick={() => void goToOffset()}
        >
          Go To
        </button>
        <span className="toolbar-spacer" />
        <button
          type="button"
          className="secondary"
          disabled={
            !controller.canUndo || controller.isMutating
          }
          title="Undo (Ctrl/Cmd+Z)"
          onClick={() => void controller.undo()}
        >
          Undo
        </button>
        <button
          type="button"
          className="secondary"
          disabled={
            !controller.canRedo || controller.isMutating
          }
          title="Redo (Ctrl/Cmd+Shift+Z)"
          onClick={() => void controller.redo()}
        >
          Redo
        </button>
      </section>

      <PatternTable bindings={controller.bindings} />

      {controller.contextMenu ? (
        <MutationContextMenu
          key={`${controller.contextMenu.clientX}:${controller.contextMenu.clientY}`}
          menu={controller.contextMenu}
          disabled={controller.isMutating}
          onInsert={controller.insertRows}
          onDelete={controller.deleteSelectedRows}
          onPointerDown={event => event.stopPropagation()}
        />
      ) : null}

      <footer
        className={
          controller.state.errorMessage ||
          controller.isRecovering
            ? "status-bar has-error"
            : "status-bar"
        }
      >
        <span className="status-main">
          Rows {formatNumber(controller.state.totalVectors)}
          {" · "}
          Offset {formatNumber(
            controller.state.firstVisibleVectorIndex
          )}
          {controller.isDirty ? " · Modified" : ""}
        </span>
        <span className="status-detail">
          {controller.state.errorMessage ??
            `${controller.actionMessage} · visible ${formatNumber(
              controller.state.firstVisibleVectorIndex
            )}–${formatNumber(
              controller.state.lastVisibleVectorIndex
            )} · window ${formatNumber(
              controller.state.windowStartVectorIndex
            )}–${formatNumber(
              controller.state.windowEndVectorIndex
            )} · cache ${controller.state.cacheEntries}/3`}
        </span>
        {controller.state.isLoading ||
        controller.isMutating ? (
          <span className="status-loading">Loading…</span>
        ) : null}
      </footer>
    </main>
  );
}

function MutationContextMenu({
  menu,
  disabled,
  onInsert,
  onDelete,
  onPointerDown
}: {
  menu: NonNullable<
    ReturnType<typeof usePatternViewport>["contextMenu"]
  >;
  disabled: boolean;
  onInsert(position: "above" | "below", count: number): void;
  onDelete(): void;
  onPointerDown(event: PointerEvent<HTMLDivElement>): void;
}) {
  const [countValue, setCountValue] = useState("1");
  const count = clampInteger(Number(countValue), 1, 10_000);
  const hasTarget = menu.targetVectorIndex !== null;
  const left = Math.max(
    6,
    Math.min(menu.clientX, window.innerWidth - 224)
  );
  const top = Math.max(
    6,
    Math.min(menu.clientY, window.innerHeight - 190)
  );

  return (
    <div
      className="mutation-menu"
      role="menu"
      style={{ left, top }}
      onPointerDown={onPointerDown}
    >
      <label className="mutation-count">
        <span>行数</span>
        <input
          type="number"
          min="1"
          max="10000"
          value={countValue}
          onChange={event => setCountValue(event.target.value)}
        />
      </label>
      {hasTarget ? (
        <>
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => onInsert("above", count)}
          >
            在上方插入
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => onInsert("below", count)}
          >
            在下方插入
          </button>
        </>
      ) : (
        <button
          type="button"
          role="menuitem"
          disabled={disabled}
          onClick={() => onInsert("above", count)}
        >
          插入空白行
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className="danger"
        disabled={
          disabled || menu.selectedRowKeys.length === 0
        }
        onClick={onDelete}
      >
        删除选中行（{menu.selectedRowKeys.length}）
      </button>
    </div>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function clampInteger(
  value: number,
  min: number,
  max: number
): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}
