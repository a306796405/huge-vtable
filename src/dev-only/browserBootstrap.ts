/**
 * 浏览器调试页的最小启动器。
 *
 * 生产插件不会引用此文件。动态导入的唯一目的，是在开发入口初始化失败时
 * 把具体错误显示出来，避免只看到一张无法排查的空白页面。
 */

void import("./browserMain").catch(error => {
  const root = document.querySelector("#app");

  if (root) {
    const message =
      error instanceof Error
        ? `${error.message}\n\n${error.stack ?? ""}`
        : String(error);

    root.innerHTML = `<pre class="bootstrap-error"></pre>`;
    const output = root.querySelector(".bootstrap-error");

    if (output) {
      output.textContent = message;
    }
  }

  console.error("[Pattern Editor Lite] browser bootstrap failed", error);
});
