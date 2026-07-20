/**
 * 阅读等级：A 业务必读
 * 是否迁移：按真实 Pattern 字段调整
 * 前置阅读：README.md
 * 建议只关注：PatternRenderRow、PatternReadClient 和两条只读请求
 * 可以跳过：Webview 请求配对消息
 *
 * 第一版协议刻意只描述“元数据 + 小窗口读取”。rowKey、revision 和 signalId
 * 现在就保留，是为了以后增加编辑时不推翻行身份和请求一致性；这里没有提前
 * 定义 mutation、history、Cycle 重算或 Annotation。
 */

export const SIGNAL_IDS = [
  "SIG_A",
  "SIG_B",
  "SIG_C",
  "SIG_D",
  "SIG_E",
  "SIG_F",
  "SIG_G",
  "SIG_H",
  "SIG_I",
  "SIG_J",
  "SIG_K",
  "SIG_L"
] as const;

export type SignalId = (typeof SIGNAL_IDS)[number];

export type PatternRenderRow = {
  /** 当前打开会话内稳定身份；Webview 只能比较和回传，不能解析。 */
  rowKey: string;
  /** 当前 0-based 逻辑 Vector，与第一版 Go To Offset 的输入一致。 */
  vectorIndex: number;
  /** 后端提供的显示文本；前端不负责计算 Cycle。 */
  cycleText: string;
  instruction: string;
  comment: string;
  signalValues: Record<SignalId, string>;
};

export type PatternMetadata = {
  totalVectors: number;
  revision: number;
};

export type PatternWindowRequest = {
  /** 请求窗口第一条 Vector 的 0-based 逻辑位置。 */
  startVectorIndex: number;
  /** 希望读取的 Vector 数量，不是结束位置。 */
  vectorCount: number;
  expectedRevision: number;
};

export type PatternWindowResponse = PatternMetadata & {
  startVectorIndex: number;
  rows: PatternRenderRow[];
};

export interface PatternReadClient {
  getMetadata(): Promise<PatternMetadata>;
  getWindow(request: PatternWindowRequest): Promise<PatternWindowResponse>;
  dispose?(): void;
}

export type PatternReadCommand = "getMetadata" | "getWindow";

export type WebviewRequestMessage = {
  kind: "request";
  id: number;
  command: PatternReadCommand;
  payload?: PatternWindowRequest;
};

export type ReadRequestError = {
  code: "REVISION_CONFLICT" | "VALIDATION_ERROR" | "INTERNAL_ERROR";
  message: string;
  currentRevision?: number;
};

export type ExtensionResponseMessage =
  | {
      kind: "response";
      id: number;
      ok: true;
      payload: PatternMetadata | PatternWindowResponse;
    }
  | {
      kind: "response";
      id: number;
      ok: false;
      error: ReadRequestError;
    };
