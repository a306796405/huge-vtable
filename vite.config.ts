import { defineConfig } from "vite";

export default defineConfig({
  esbuild: {
    jsx: "automatic"
  },
  build: {
    outDir: "dist/webview",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/webview/webviewMain.tsx",
      output: {
        entryFileNames: "index.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames(assetInfo) {
          return assetInfo.name?.endsWith(".css")
            ? "index.css"
            : "assets/[name]-[hash][extname]";
        }
      }
    }
  }
});
