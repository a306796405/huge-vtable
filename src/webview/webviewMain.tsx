import { createRoot } from "react-dom/client";
import { PatternEditorApp } from "./PatternEditorApp";
import { createVsCodePatternReadClient } from "./patternReadClient";

const root = document.querySelector("#app");

if (!root) {
  throw new Error("#app was not found.");
}

createRoot(root).render(
  <PatternEditorApp client={createVsCodePatternReadClient()} />
);
