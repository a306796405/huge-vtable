/**
 * 阅读等级：A 业务必读
 * 是否迁移：是，真实项目由 C++ ICE 实现
 * 前置阅读：shared/protocol.ts
 * 建议只关注：PatternBackend 的窗口读取和统一 mutation 边界
 * 可以跳过：无
 */

import type {
  PatternMetadata,
  PatternMutationRequest,
  PatternMutationResponse,
  PatternWindowRequest,
  PatternWindowResponse
} from "../shared/protocol";

/**
 * Extension Host 到数据真源的最小文档边界。
 *
 * 当前由 SyntheticPatternBackend 实现。接入 C++ ICE 时只替换此接口的实现，
 * Webview、逻辑滚动和 VTable adapter 不需要知道 ICE、UTD 或 .pat 的细节。
 */
export interface PatternBackend {
  getMetadata(): PatternMetadata | Promise<PatternMetadata>;
  getWindow(
    request: PatternWindowRequest
  ): PatternWindowResponse | Promise<PatternWindowResponse>;
  applyMutation(
    request: PatternMutationRequest
  ): PatternMutationResponse | Promise<PatternMutationResponse>;
  dispose?(): void;
}
