/**
 * 阅读等级：A 业务必读
 * 是否迁移：是
 * 前置阅读：shared/protocol.ts
 * 建议只关注：文本如何转换成不规则即拒绝的二维矩阵
 * 可以跳过：换行符兼容细节
 */

/**
 * 把系统剪贴板中的 TSV 转成 Paste 事务矩阵。
 *
 * Excel、VTable 等表格复制时通常会在最后附加一个换行符。这个换行符
 * 表示复制结束，不代表额外的空白行，因此只移除末尾产生的空数组项；
 * 行内连续制表符仍会保留为空字符串，用于明确覆盖目标单元格。
 */
export function parseClipboardTsv(text: string): string[][] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  while (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }

  const values = lines.map(line => line.split("\t"));
  const columnCount = values[0]?.length ?? 0;

  if (
    columnCount === 0 ||
    values.some(row => row.length !== columnCount)
  ) {
    throw new Error("粘贴内容必须是规则的行列矩阵。");
  }

  return values;
}
