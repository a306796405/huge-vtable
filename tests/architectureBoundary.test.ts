import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SIGNAL_IDS } from "../src/shared/protocol";

const projectRoot = join(__dirname, "..");

describe("v22-lite architecture boundary", () => {
  it("keeps VTable internal measurement APIs inside the adapter", () => {
    const files = collectFiles(join(projectRoot, "src"))
      .filter(path => /\.(ts|tsx)$/.test(path))
      .filter(path => !path.endsWith("/core/vtableAdapter.ts"));
    const source = files
      .map(path => readFileSync(path, "utf8"))
      .join("\n");

    expect(source).not.toMatch(
      /tableNoFrameHeight|tableY|getFrozenRowsHeight|getBottomFrozenRowsHeight|renderAsync/
    );
  });

  it("does not import CachedDataSource or TanStack", () => {
    const files = collectFiles(join(projectRoot, "src"))
      .filter(path => /\.(ts|tsx)$/.test(path));
    const source = files
      .map(path => readFileSync(path, "utf8"))
      .join("\n");

    expect(source).not.toMatch(
      /from\s+["']@tanstack\/virtual-core["']/
    );
    expect(source).not.toMatch(
      /new\s+VTable\.data\.CachedDataSource|new\s+CachedDataSource/
    );
  });

  it("keeps twelve stable synthetic Signal ids", () => {
    expect(SIGNAL_IDS).toHaveLength(12);
    expect(new Set(SIGNAL_IDS).size).toBe(12);
  });

  it("registers a single editor per document", () => {
    const source = readFileSync(
      join(projectRoot, "src", "extension.ts"),
      "utf8"
    );

    expect(source).toContain(
      "supportsMultipleEditorsPerDocument: false"
    );
  });

  it("does not put Pattern rows into React state", () => {
    const webviewSource = collectFiles(
      join(projectRoot, "src", "webview")
    )
      .filter(path => /\.(ts|tsx)$/.test(path))
      .map(path => readFileSync(path, "utf8"))
      .join("\n");

    expect(webviewSource).not.toMatch(
      /useState\s*<\s*PatternRenderRow/
    );
    expect(webviewSource).not.toMatch(
      /setRows\s*\(/
    );
  });
});

function collectFiles(directory: string): string[] {
  const result: string[] = [];

  for (const name of readdirSync(directory)) {
    const path = join(directory, name);

    if (statSync(path).isDirectory()) {
      result.push(...collectFiles(path));
    } else {
      result.push(path);
    }
  }

  return result;
}
