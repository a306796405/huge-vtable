/**
 * 浏览器调试入口，只用于快速检查滚动和布局。
 * 生产插件 bundle 使用 webview/webviewMain.tsx，不会引用此文件。
 */

import { createRoot } from "react-dom/client";
import { PatternEditorApp } from "../webview/PatternEditorApp";
import {
  DEFAULT_TOTAL_VECTORS,
  MAX_TOTAL_VECTORS,
  MIN_TOTAL_VECTORS,
  SyntheticPatternBackend
} from "./syntheticPatternBackend";
import { installPatternPerformanceProbe } from "./performanceProbe";

const root = document.querySelector("#app");

if (!root) {
  throw new Error("#app was not found.");
}

const params = new URLSearchParams(window.location.search);
const totalVectors = clampInteger(
  Number(params.get("rows") ?? DEFAULT_TOTAL_VECTORS),
  MIN_TOTAL_VECTORS,
  MAX_TOTAL_VECTORS
);
const delayMs = clampInteger(
  Number(params.get("delay") ?? 12),
  0,
  5_000
);
const backend = new SyntheticPatternBackend({
  totalVectors,
  delayMs
});
const client =
  params.get("perf") === "1"
    ? installPatternPerformanceProbe(backend)
    : backend;

document.title = `Pattern Editor Lite · ${totalVectors} rows`;
createRoot(root).render(<PatternEditorApp client={client} />);

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
