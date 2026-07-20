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
  type KeyboardEvent
} from "react";
import type { PatternReadClient } from "../shared/protocol";
import { PatternTable } from "./PatternTable";
import { usePatternViewport } from "./usePatternViewport";
import "./styles.css";

export function PatternEditorApp({
  client
}: {
  client: PatternReadClient;
}) {
  const controller = usePatternViewport(client);
  const [offsetValue, setOffsetValue] = useState("0");

  const goToOffset = useCallback(async () => {
    const totalVectors =
      controller.metadata?.totalVectors ?? 0;
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
    await controller.goToOffset(target);
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
    <main className="page">
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
              (controller.metadata?.totalVectors ?? 1) - 1
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
      </section>

      <PatternTable bindings={controller.bindings} />

      <footer
        className={
          controller.state.errorMessage
            ? "status-bar has-error"
            : "status-bar"
        }
      >
        <span className="status-main">
          Rows {formatNumber(controller.state.totalVectors)}
          {" · "}
          Offset {formatNumber(controller.state.visibleStart)}
        </span>
        <span className="status-detail">
          {controller.state.errorMessage ??
            `visible ${formatNumber(
              controller.state.visibleStart
            )}–${formatNumber(
              controller.state.visibleEnd
            )} · window ${formatNumber(
              controller.state.windowStart
            )}–${formatNumber(
              controller.state.windowEnd
            )} · cache ${controller.state.cacheEntries}/3`}
        </span>
        {controller.state.isLoading ? (
          <span className="status-loading">Loading…</span>
        ) : null}
      </footer>
    </main>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}
