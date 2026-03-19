#!/usr/bin/env node
/**
 * x402 MCP Gateway（付款侧网关）
 *
 * 角色定位：
 * 1) 对上游 Agent（如 Cursor）暴露一个统一的 MCP 服务入口（stdio）。
 * 2) 将工具调用转发给一个或多个下游 MCP 服务。
 * 3) 当下游返回 x402 支付挑战时，网关使用本地钱包自动支付。
 * 4) 在自动支付前，执行 KYC/KYT 合规检查，不满足则拒绝支付。
 *
 * 核心链路（简化）：
 * Agent -> gateway.call_service_tool -> downstream tool
 *      -> (如遇支付挑战) onPaymentRequested -> KYC/KYT -> allow/deny
 */
import { config } from "dotenv"; // 读取 .env 文件并注入 process.env
import { z } from "zod"; // 用于定义 MCP 工具入参的运行时校验
import { privateKeyToAccount } from "viem/accounts"; // 把 0x 私钥转换为可签名账户对象
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"; // MCP 服务端主对象
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"; // stdio 传输层（供 Cursor 以命令拉起）
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"; // 下游 SSE 客户端传输
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"; // 下游 Streamable HTTP 客户端传输
import { ExactEvmScheme } from "@x402/evm/exact/client"; // x402 EVM 精确支付客户端方案
import { createx402MCPClient } from "@x402/mcp"; // 创建具备 x402 支付能力的 MCP 客户端

config(); // 立刻加载环境变量，保证后续读取配置时可用

type JsonObject = Record<string, unknown>; // 通用 JSON 对象类型（工具参数透传时使用）
type DownstreamTransportMode = "auto" | "sse" | "streamable-http"; // 下游连接传输模式

type DownstreamMcpClient = ReturnType<typeof createx402MCPClient>; // x402 MCP 客户端实例类型

/**
 * 下游服务注册表记录。
 *
 * 字段说明：
 * - serviceId: 网关内部编号，便于在调用时指定目标下游。
 * - url: 下游 MCP 地址。
 * - transport: 实际连接成功使用的传输协议（streamable-http 或 sse）。
 * - client: 针对该下游的 x402 MCP 客户端实例。
 * - tools: 下游已发现的工具清单。
 */
interface DownstreamServiceRecord {
  serviceId: string;
  url: string;
  transport: Exclude<DownstreamTransportMode, "auto">;
  client: DownstreamMcpClient;
  tools: Array<{ name: string; description?: string }>;
}

/**
 * KYC 接口返回结构。
 *
 * 仅当：
 * - kycCompleted = true
 * - kycStatus = approved
 * 才视为 KYC 通过。
 */
interface KycCheckResponse {
  walletAddress: string;
  kycCompleted: boolean;
  kycStatus: "approved" | "pending" | "rejected" | null;
}

/**
 * KYT 接口返回结构。
 *
 * 业务放行关键字段：
 * - decision: pass / reject
 * - degraded: 如果为 true，表示上游服务降级，当前结果不可靠。
 */
interface KytCheckResponse {
  address: string;
  chain: string;
  riskLevel: string;
  riskScore: number;
  decision: "pass" | "reject";
  signals: string[];
  provider: string;
  checkedAt: string;
  cached: boolean;
  reportUrl?: string;
  degraded?: boolean;
}

/**
 * 合规检查决策对象。
 *
 * 设计目标：
 * - 不仅告诉“是否通过”，还告诉“为什么通过/不通过”；
 * - 让上游 Agent 可以把决策细节完整反馈给最终用户。
 */
interface ComplianceDecision {
  serviceId: string;
  toolName: string;
  counterparty: `0x${string}`;
  passed: boolean;
  reasonCode:
  | "COMPLIANCE_PASSED"
  | "KYC_NOT_APPROVED"
  | "KYT_REJECTED"
  | "KYT_DEGRADED"
  | "COMPLIANCE_CONFIG_MISSING"
  | "COMPLIANCE_API_ERROR";
  message: string;
  kycStatus?: KycCheckResponse["kycStatus"];
  kycCompleted?: boolean;
  kytDecision?: KytCheckResponse["decision"];
  riskLevel?: string;
  riskScore?: number;
  degraded?: boolean;
  checkedAt: string;
}

/**
 * 网关统一结果信封（成功/失败都使用同一结构）。
 *
 * 这样 AI 不需要猜测字符串语义，直接按字段解释即可。
 */
interface GatewayEnvelope<TDetail = JsonObject> {
  ok: boolean;
  stage:
  | "request_received"
  | "service_selected"
  | "tool_execution"
  | "payment_requested"
  | "compliance_check";
  code: string;
  message: string;
  traceId: string;
  timestamp: string;
  detail: TDetail;
}

const evmPrivateKey = requireHexPrivateKey("EVM_PRIVATE_KEY"); // 网关支付钱包私钥（必填）
const complianceBaseUrl = process.env.COMPLIANCE_BASE_URL; // KYC/KYT 接口域名（如 https://your-domain.com）
const complianceApiKey = process.env.COMPLIANCE_API_KEY; // 调用 KYC/KYT 接口的 API Key
const complianceChain = process.env.COMPLIANCE_CHAIN ?? "base"; // KYT 查询链，默认 base
const complianceMaxRetries = 5; // 合规接口最大重试次数（含首次）
const latestComplianceDecisionByService = new Map<string, ComplianceDecision>(); // 缓存每个 service 最近一次合规结果，供响应回传

/**
 * 支付上下文信息。
 *
 * 在 onPaymentRequested 回调中从下游挑战里提取，
 * 缓存后在 call_service_tool 响应中透传给上游 Agent，
 * 用于展示资金流向（付款方 -> 金额 -> 收款方）。
 */
interface PaymentContext {
  amount: string;      // 支付金额（来自 paymentRequired.accepts[0].amount）
  payTo: string;       // 收款方地址（来自 paymentRequired.accepts[0].payTo）
  network: string;     // 支付网络（如 eip155:84532）
}
const latestPaymentContextByService = new Map<string, PaymentContext>(); // 缓存每个 service 最近一次支付上下文，供响应透传资金流向

const rawDownstreamUrls = process.env.DOWNSTREAM_MCP_URLS ?? process.env.DOWNSTREAM_MCP_URL; // 支持多地址优先，单地址兜底
if (!rawDownstreamUrls) {
  console.error("❌ 缺少环境变量 DOWNSTREAM_MCP_URL 或 DOWNSTREAM_MCP_URLS，无法确定下游服务地址");
  process.exit(1);
}

const downstreamUrls = rawDownstreamUrls // 读取到的下游 URL 原始串
  .split(",") // 逗号分割成数组
  .map((url: string) => url.trim()) // 去除空白
  .filter(Boolean); // 过滤空字符串，避免无效 URL 进入连接流程

if (downstreamUrls.length === 0) {
  console.error("❌ 至少需要配置一个下游 MCP 地址");
  process.exit(1);
}

const transportMode = parseTransportMode(process.env.DOWNSTREAM_MCP_TRANSPORT); // 解析 transport 策略
const connectRetries = parseConnectRetries(process.env.DOWNSTREAM_CONNECT_RETRIES); // 解析连接重试次数

/**
 * 从环境变量读取十六进制私钥。
 *
 * 约束：
 * - 必须存在；
 * - 必须以 0x 开头；
 * 否则启动直接失败，避免网关处于“可接收请求但无法支付”的不一致状态。
 *
 * @param envName 环境变量名。
 * @returns 规范化的 0x 私钥字符串。
 */
function requireHexPrivateKey(envName: string): `0x${string}` {
  const value = process.env[envName]; // 从环境变量读取私钥字符串
  if (!value) {
    console.error(`❌ 缺少环境变量 ${envName}，网关无法启动`); // 缺少私钥配置，无法继续
    process.exit(1); // 直接退出，防止“无支付能力”状态运行
  }
  if (!value.startsWith("0x")) {
    throw new Error(`${envName} must start with 0x.`); // 私钥格式不正确，抛错阻断启动
  }
  return value as `0x${string}`; // 断言为 0x 前缀私钥类型
}

/**
 * 解析下游传输模式配置。
 *
 * - auto: 先尝试 streamable-http，失败回退 sse。
 * - streamable-http: 仅使用 streamable-http。
 * - sse: 仅使用 sse。
 *
 * @param value 环境变量值。
 * @returns 合法的传输模式。
 */
function parseTransportMode(value?: string): DownstreamTransportMode {
  if (!value) {
    return "auto"; // 未配置时默认自动模式（HTTP 优先，SSE 兜底）
  }

  if (value === "auto" || value === "sse" || value === "streamable-http") {
    return value; // 配置值合法，直接返回
  }

  throw new Error(
    `Invalid DOWNSTREAM_MCP_TRANSPORT: ${value}. Expected one of auto|sse|streamable-http.`,
  );
}

/**
 * 解析下游连接重试次数。
 *
 * 设计上限制在 [1, 10]，避免：
 * - 重试过少导致偶发网络抖动时频繁失败；
 * - 重试过多导致启动阶段阻塞过久。
 *
 * @param value 环境变量值。
 * @returns 重试次数。
 */
function parseConnectRetries(value?: string): number {
  if (!value) {
    return 3; // 未配置默认重试 3 次
  }

  const parsed = Number(value); // 字符串转数字
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error(`Invalid DOWNSTREAM_CONNECT_RETRIES: ${value}. Expected integer in [1,10].`); // 防止异常配置导致无限等待或过早失败
  }
  return parsed; // 返回合法重试次数
}

/**
 * 校验地址是否为合法 EVM 地址（0x + 40位十六进制）。
 *
 * @param value - 待校验地址字符串。
 * @returns 是否为合法 EVM 地址。
 */
function isValidEvmAddress(value: string): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(value); // EVM 地址固定 20 字节（40 hex）+ 0x
}

/**
 * 从下游 paymentRequired 中提取收款地址，作为对手方地址进行合规检查。
 *
 * @param payTo - 支付要求中的收款地址字段。
 * @returns 标准化后的小写地址，若无效则返回 null。
 */
function extractCounterpartyAddress(payTo: unknown): `0x${string}` | null {
  if (typeof payTo !== "string") {
    return null; // 非字符串直接判无效
  }
  const normalized = payTo.trim(); // 去除首尾空格，避免因格式导致误判
  if (!isValidEvmAddress(normalized)) {
    return null; // 地址格式非法，不允许支付
  }
  return normalized.toLowerCase() as `0x${string}`; // 统一小写，便于日志和合规接口一致处理
}

/**
 * 统一发起 JSON POST 请求，并做超时控制。
 *
 * @param url - 请求地址。
 * @param body - JSON 请求体。
 * @returns 解析后的 JSON 对象。
 */
async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  let lastError: Error | undefined; // 记录最后一次失败，重试耗尽后抛出

  for (let attempt = 1; attempt <= complianceMaxRetries; attempt += 1) {
    const controller = new AbortController(); // 每次尝试都创建独立超时控制器
    const timeout = setTimeout(() => controller.abort(), 8000); // 单次请求 8 秒超时，避免卡住

    try {
      const response = await fetch(url, { // 发起 POST JSON 请求
        method: "POST", // 明确使用 POST
        headers: { "Content-Type": "application/json" }, // 告知服务端为 JSON
        body: JSON.stringify(body), // 序列化请求体
        signal: controller.signal, // 绑定超时取消信号
      });

      if (!response.ok) {
        const text = await response.text(); // 读取错误响应体，方便排障
        throw new Error(
          `Compliance API request failed: ${response.status} ${response.statusText}. ${text}`,
        ); // 统一抛出含状态码的错误
      }

      return (await response.json()) as T; // 成功时按泛型返回解析对象
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error)); // 标准化错误对象
      console.error(
        `🔄 合规请求重试：第 ${attempt}/${complianceMaxRetries} 次，地址=${url}，错误=${lastError.message}`,
      ); // 输出重试日志，便于观察抖动和恢复情况
      if (attempt < complianceMaxRetries) {
        await sleep(300 * attempt); // 线性退避：300ms, 600ms, 900ms, 1200ms
      }
    } finally {
      clearTimeout(timeout); // 每次尝试结束都清理定时器，防止泄漏
    }
  }

  throw lastError ?? new Error("Compliance API request failed after retries."); // 所有重试失败后抛出最终错误
}

/**
 * 执行 KYC + KYT 双重校验。
 * 返回结构化决策，便于上游清晰解释“通过/失败原因”。
 *
 * @param serviceId 下游服务 ID。
 * @param toolName 当前工具名。
 * @param counterparty 对手方钱包地址。
 * @returns 合规决策对象（包含结果与原因码）。
 */
async function runComplianceChecks(
  serviceId: string,
  toolName: string,
  counterparty: `0x${string}`,
): Promise<ComplianceDecision> {
  const checkedAt = new Date().toISOString(); // 固定本次检查时间，便于日志和返回一致追踪
  if (!complianceBaseUrl || !complianceApiKey) {
    console.error("🛡️ 合规配置缺失：未设置 COMPLIANCE_BASE_URL 或 COMPLIANCE_API_KEY"); // 缺配置直接拒绝，安全优先
    return {
      serviceId,
      toolName,
      counterparty,
      passed: false,
      reasonCode: "COMPLIANCE_CONFIG_MISSING",
      message: "Compliance configuration is missing.",
      checkedAt,
    }; // fail-close：没有合规能力时不支付
  }

  const baseUrl = complianceBaseUrl.replace(/\/+$/, ""); // 去掉末尾斜杠，避免 URL 双斜杠
  try {
    const [kycResult, kytResult] = await Promise.all([ // 并发请求 KYC/KYT，缩短决策延迟
      postJson<KycCheckResponse>(`${baseUrl}/api/kyc/check`, {
        apiKey: complianceApiKey,
        walletAddress: counterparty,
      }),
      postJson<KytCheckResponse>(`${baseUrl}/api/compliance/kyt/check`, {
        apiKey: complianceApiKey,
        walletAddress: counterparty,
        chain: complianceChain,
      }),
    ]);

    console.error(
      `🛡️ 合规结果：对手方=${counterparty}，KYC状态=${String(kycResult.kycStatus)}（已完成=${String(kycResult.kycCompleted)}），KYT决策=${kytResult.decision}，风险等级=${kytResult.riskLevel}，风险评分=${kytResult.riskScore}，降级=${String(kytResult.degraded === true)}`,
    );

    const decisionBase = {
      serviceId,
      toolName,
      counterparty,
      kycStatus: kycResult.kycStatus,
      kycCompleted: kycResult.kycCompleted,
      kytDecision: kytResult.decision,
      riskLevel: kytResult.riskLevel,
      riskScore: kytResult.riskScore,
      degraded: kytResult.degraded === true,
      checkedAt,
    };

    // KYC 必须 completed 且 approved 才可放行。
    if (!(kycResult.kycCompleted === true && kycResult.kycStatus === "approved")) {
      return {
        ...decisionBase,
        passed: false,
        reasonCode: "KYC_NOT_APPROVED",
        message: `KYC is not approved. Current status: ${String(kycResult.kycStatus)}`,
      };
    }

    // 若上游 KYT 处于降级状态，结果不可靠，按安全策略拒绝支付。
    // if (kytResult.degraded === true) {
    //   return {
    //     ...decisionBase,
    //     passed: false,
    //     reasonCode: "KYT_DEGRADED",
    //     message: "KYT service is degraded. Refusing payment for safety.",
    //   };
    // }

    // KYT decision 必须为 pass。
    if (kytResult.decision !== "pass") {
      return {
        ...decisionBase,
        passed: false,
        reasonCode: "KYT_REJECTED",
        message: `KYT decision is ${kytResult.decision}.`,
      };
    }

    // KYC + KYT 全部通过，允许支付。
    return {
      ...decisionBase,
      passed: true,
      reasonCode: "COMPLIANCE_PASSED",
      message: "Compliance checks passed.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      serviceId,
      toolName,
      counterparty,
      passed: false,
      reasonCode: "COMPLIANCE_API_ERROR",
      message: `Compliance API error: ${message}`,
      checkedAt,
    };
  }
}

/**
 * 收款方对付款方的合规检查结果（从收款方响应中提取）。
 *
 * 收款方在工具响应中将 payeeComplianceDecision 嵌入 JSON，
 * 网关从 downstreamContent 中解析出来，透传给上游 Agent，
 * 用于展示双向合规信息。
 */
interface PayeeComplianceDecision {
  payerAddress: string;
  kycCompleted: boolean;
  kycStatus: string | null;
  kytDecision: string;
  riskLevel: string;
  riskScore: number;
  degraded: boolean;
  checkedAt: string;
  passed: boolean;
  reasonCode: string;
  message: string;
}

/**
 * 从收款方返回的 content 中提取 payeeComplianceDecision。
 *
 * 收款方工具响应格式为 { data: <业务数据>, payeeComplianceDecision: <合规结果> }。
 * 本函数解析第一个 text 类型 content item 的 JSON，提取 payeeComplianceDecision 字段。
 * 向后兼容：若字段不存在或解析失败，返回 null。
 *
 * @param content 收款方返回的 MCP content 数组。
 * @returns 收款方的合规决策，或 null。
 */
function extractPayeeCompliance(content: unknown): PayeeComplianceDecision | null {
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }
  const firstItem = content[0];
  if (typeof firstItem !== "object" || firstItem === null) {
    return null;
  }
  const textItem = firstItem as { type?: string; text?: string };
  if (textItem.type !== "text" || typeof textItem.text !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(textItem.text) as Record<string, unknown>;
    if (parsed.payeeComplianceDecision && typeof parsed.payeeComplianceDecision === "object") {
      return parsed.payeeComplianceDecision as PayeeComplianceDecision;
    }
  } catch {
    // JSON 解析失败，向后兼容返回 null
  }
  return null;
}

/**
 * 生成本次调用的 traceId，便于前后端与日志系统串联一次完整链路。
 *
 * @returns 追踪 ID。
 */
function createTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 获取指定 service + tool 的最近一次合规决策。
 *
 * @param serviceId 下游服务 ID。
 * @param toolName 工具名（避免跨工具串数据）。
 * @returns 决策对象或 undefined。
 */
function getLatestComplianceDecision(serviceId: string, toolName: string): ComplianceDecision | undefined {
  const decision = latestComplianceDecisionByService.get(serviceId);
  if (!decision) {
    return undefined;
  }
  if (decision.toolName !== toolName) {
    return undefined;
  }
  return decision;
}

/**
 * 简单 sleep 工具，用于连接重试时做退避等待。
 *
 * @param ms 等待毫秒数。
 */
async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms)); // 简单延时 Promise
}

/**
 * 根据配置返回传输协议尝试顺序。
 *
 * 为什么 auto 默认 streamable-http 优先：
 * - 生态里越来越多服务以 streamable-http 作为首选；
 * - SSE 作为兼容兜底，提升老服务接入成功率。
 *
 * @param mode 全局传输模式配置。
 * @returns 候选协议顺序。
 */
function getTransportCandidates(
  mode: DownstreamTransportMode,
): Array<Exclude<DownstreamTransportMode, "auto">> {
  if (mode === "sse") {
    return ["sse"]; // 强制 SSE
  }
  if (mode === "streamable-http") {
    return ["streamable-http"]; // 强制 Streamable HTTP
  }
  return ["streamable-http", "sse"]; // auto 模式下优先 HTTP，失败再 SSE
}

/**
 * 连接单个下游 MCP 客户端（带协议回退 + 重试）。
 *
 * 策略：
 * 1) 按候选协议逐个尝试（auto 时先 streamable-http 再 sse）。
 * 2) 每种协议按 connectRetries 次重试，失败后短暂退避。
 * 3) 记录所有失败原因，最终一次性抛出，便于排障。
 *
 * @param client x402 MCP 客户端。
 * @param url 下游地址。
 * @param mode 传输模式配置。
 * @returns 成功连接时实际使用的协议。
 */
async function connectWithTransportFallback(
  client: DownstreamMcpClient,
  url: string,
  mode: DownstreamTransportMode,
): Promise<Exclude<DownstreamTransportMode, "auto">> {
  const candidates = getTransportCandidates(mode); // 获取待尝试协议顺序
  const errors: string[] = []; // 收集失败详情，最终统一报错

  for (const candidate of candidates) { // 先遍历协议
    for (let attempt = 1; attempt <= connectRetries; attempt += 1) { // 再遍历该协议的重试次数
      try {
        const transport =
          candidate === "sse"
            ? new SSEClientTransport(new globalThis.URL(url)) // SSE 传输
            : new StreamableHTTPClientTransport(new globalThis.URL(url), {
              // 某些下游要求显式声明两种 Accept 才会正常返回流式响应。
              requestInit: {
                headers: {
                  Accept: "application/json, text/event-stream",
                },
              },
            });
        await client.connect(transport); // 尝试建立连接
        return candidate; // 连接成功直接返回当前协议
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error); // 提取错误消息
        // 兼容较旧 TS lib，不依赖 Error.cause 的类型推断。
        const cause = extractErrorCause(error);
        errors.push(`${candidate}#${attempt}: ${message}${cause}`); // 记录本次失败
        if (attempt < connectRetries) {
          await sleep(300 * attempt); // 简单线性退避：300ms, 600ms, 900ms...
        }
      }
    }
  }

  throw new Error(`Failed to connect downstream MCP at ${url}. Attempts => ${errors.join(" | ")}`);
}

/**
 * 从异常中提取可读的 cause 信息，拼接到错误日志。
 *
 * @param error 未知异常对象。
 * @returns 格式化后的 cause 文本（包含前导空格）。
 */
function extractErrorCause(error: unknown): string {
  if (!(error instanceof Error)) {
    return ""; // 不是 Error 对象，无法提取 cause
  }
  const maybeCause = (error as { cause?: unknown }).cause; // 兼容读取 cause 字段
  if (maybeCause instanceof Error) {
    return ` (cause: ${maybeCause.message})`; // 嵌套 Error
  }
  if (typeof maybeCause === "string" && maybeCause.length > 0) {
    return ` (cause: ${maybeCause})`; // 字符串 cause
  }
  return ""; // 没有可用 cause
}

/**
 * 为单个下游创建 x402 MCP 客户端并完成连接。
 *
 * 这里是支付控制的关键点：
 * - autoPayment=true：允许客户端在挑战出现时自动支付；
 * - onPaymentRequested：支付前拦截，可决定放行或拒绝。
 *
 * 当前策略：
 * 1) 从挑战里提取对手方地址（payTo）。
 * 2) 调 KYC + KYT 接口做合规校验。
 * 3) 仅当合规通过时返回 true，允许自动支付。
 *
 * @param serviceId 下游服务编号。
 * @param url 下游 MCP 地址。
 * @param privateKey 用于支付的网关钱包私钥。
 * @param mode 传输模式配置。
 * @returns 已连接客户端与实际协议。
 */
async function createAndConnectDownstreamClient(
  serviceId: string,
  url: string,
  privateKey: `0x${string}`,
  mode: DownstreamTransportMode,
): Promise<{
  client: DownstreamMcpClient;
  transport: Exclude<DownstreamTransportMode, "auto">;
}> {
  const signer = privateKeyToAccount(privateKey); // 由私钥生成签名账户（用于自动支付）
  const client = createx402MCPClient({
    name: `gateway-${serviceId}`,
    version: "1.0.0",
    schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(signer) }],
    autoPayment: true, // 打开自动支付：遇到挑战时会触发 onPaymentRequested 决策
    onPaymentRequested: async (context: {
      toolName: string;
      paymentRequired: { accepts: Array<{ payTo?: unknown; amount: string; network: string }> };
    }) => {
      const accepted = context.paymentRequired.accepts[0]; // 取第一条 payment requirement 进行判断
      const counterparty = extractCounterpartyAddress(accepted.payTo); // 提取收款方地址作为对手方

      if (!counterparty) {
        console.error(
          `🚫 支付拒绝：服务=${serviceId}，工具=${context.toolName}，原因=收款方地址无效，payTo=${String(accepted.payTo)}`,
        );
        return false; // 地址无效，拒绝自动支付
      }

      const decision = await runComplianceChecks(serviceId, context.toolName, counterparty); // 调用 KYC/KYT 接口做合规判断
      latestComplianceDecisionByService.set(serviceId, decision); // 记录最近一次合规决策，供 call_service_tool 响应透传
      if (!decision.passed) {
        console.error(
          `🚫 支付拒绝：服务=${serviceId}，工具=${context.toolName}，原因=${decision.reasonCode}，对手方=${counterparty}，详情=${decision.message}`,
        );
        return false; // 合规不通过，拒绝支付
      }

      // 缓存支付上下文（金额、收款方、网络），供 call_service_tool 响应透传资金流向
      latestPaymentContextByService.set(serviceId, {
        amount: accepted.amount,
        payTo: counterparty,
        network: accepted.network,
      });

      console.error(
        `💰 支付放行：服务=${serviceId}，工具=${context.toolName}，金额=${accepted.amount}，网络=${accepted.network}，收款方=${counterparty}`,
      );
      return true; // 合规通过，允许执行自动支付
    },
  });

  const selectedTransport = await connectWithTransportFallback(client, url, mode); // 完成下游连接
  return { client, transport: selectedTransport }; // 返回已连接客户端和实际协议
}

/**
 * 根据配置的多个下游 URL 初始化网关注册表。
 *
 * 执行内容：
 * 1) 为每个 URL 建立连接。
 * 2) 拉取该下游工具列表（listTools）。
 * 3) 生成 service-1 / service-2 ... 映射，供上游调用时选择。
 *
 * @param urls 下游地址列表。
 * @param privateKey 支付钱包私钥。
 * @param mode 传输模式。
 * @returns 已初始化的服务注册表。
 */
async function initializeDownstreamRegistry(
  urls: string[],
  privateKey: `0x${string}`,
  mode: DownstreamTransportMode,
): Promise<DownstreamServiceRecord[]> {
  const records: DownstreamServiceRecord[] = []; // 初始化下游注册表数组

  for (let index = 0; index < urls.length; index += 1) { // 逐个初始化下游服务
    const serviceId = `service-${index + 1}`; // 生成稳定 serviceId（service-1、service-2...）
    const url = urls[index]; // 当前下游 URL
    const { client, transport } = await createAndConnectDownstreamClient(
      serviceId,
      url,
      privateKey,
      mode,
    );
    const toolResult = await client.listTools(); // 发现该下游可用工具清单
    const tools = toolResult.tools.map((tool: { name: string; description?: string }) => ({
      name: tool.name,
      description: tool.description,
    }));
    records.push({ serviceId, url, transport, client, tools }); // 写入注册表

    console.error(`📡 注册下游：${serviceId} 已连接 → ${url}`);
    console.error(`📡 传输协议：${serviceId} → ${transport}`);
    console.error(
      `📡 可用工具：${serviceId} → ${tools.map((tool: { name: string }) => tool.name).join(", ") || "（无）"}`,
    );
  }

  return records; // 所有下游初始化完成
}

/**
 * 根据 serviceId 选择下游服务。
 *
 * 约定：
 * - 未传 serviceId 时，默认走 service-1；
 * - 传了但不存在则抛错，避免请求被错误转发到其他服务。
 *
 * @param registry 下游服务注册表。
 * @param serviceId 可选服务编号。
 * @returns 目标下游服务记录。
 */
function selectService(
  registry: DownstreamServiceRecord[],
  serviceId?: string,
): DownstreamServiceRecord {
  if (!serviceId) {
    return registry[0]; // 未指定时默认第一个下游
  }

  const service = registry.find(item => item.serviceId === serviceId);
  if (!service) {
    throw new Error(`Unknown serviceId: ${serviceId}`);
  }

  return service; // 返回命中的下游记录
}

/**
 * 注册网关对外工具。
 *
 * 对上游 Agent 暴露两个能力：
 * 1) list_gateway_services：查看当前可用下游和工具清单。
 * 2) call_service_tool：调用下游工具（内部自动处理支付与合规拦截）。
 *
 * @param mcpServer 网关 MCP 服务实例。
 * @param registry 下游服务注册表。
 */
function registerGatewayTools(mcpServer: McpServer, registry: DownstreamServiceRecord[]): void {
  // 让上游先探测“可用下游 + 各自工具”，便于路由决策和调试。
  mcpServer.tool(
    "list_gateway_services",
    "List downstream services and their tools.",
    {},
    async () => { // 无参工具：返回下游服务视图
      const result = registry.map(service => ({
        serviceId: service.serviceId,
        url: service.url,
        transport: service.transport,
        tools: service.tools,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // 网关最核心的转发工具：由上游传入工具名与参数，网关负责挑选下游并执行。
  mcpServer.tool(
    "call_service_tool",
    "Call a downstream MCP tool via gateway. Payment is handled by gateway wallet.",
    {
      serviceId: z.string().optional().describe("Optional service id, default is service-1"),
      toolName: z.string().describe("Downstream tool name to call"),
      args: z.record(z.any()).optional().describe("Arguments passed to downstream tool"),
    },
    async (args: { serviceId?: string; toolName: string; args?: JsonObject }) => { // 转发工具：按 serviceId 选择下游并调用
      const traceId = createTraceId(); // 生成调用追踪 ID，便于用户反馈与日志关联
      const service = selectService(registry, args.serviceId); // 选择目标下游

      try {
        const result = await service.client.callTool(args.toolName, args.args ?? {}); // 发起真实下游工具调用（含自动支付逻辑）
        const latestCompliance = getLatestComplianceDecision(service.serviceId, args.toolName); // 读取最近一次合规决策（如果本次触发了支付）
        const latestPaymentCtx = latestPaymentContextByService.get(service.serviceId) ?? null; // 读取支付上下文（金额、收款方、网络）
        const payeeCompliance = extractPayeeCompliance(result.content); // 从收款方响应中提取其对付款方的合规检查结果
        const response: GatewayEnvelope<{
          serviceId: string;
          toolName: string;
          paymentMade: boolean;
          paymentResponse: unknown;
          complianceDecision: ComplianceDecision | null;
          payeeComplianceDecision: PayeeComplianceDecision | null;
          paymentContext: PaymentContext | null;
          downstreamContent: unknown;
        }> = {
          ok: true,
          stage: "tool_execution",
          code: "TOOL_CALL_SUCCEEDED",
          message: "Downstream tool call succeeded.",
          traceId,
          timestamp: new Date().toISOString(),
          detail: {
            serviceId: service.serviceId,
            toolName: args.toolName,
            paymentMade: result.paymentMade ?? false,
            paymentResponse: result.paymentResponse ?? null,
            complianceDecision: latestCompliance ?? null,
            payeeComplianceDecision: payeeCompliance, // 收款方对付款方的合规检查结果
            paymentContext: (result.paymentMade ?? false) ? latestPaymentCtx : null,
            downstreamContent: result.content,
          },
        };

        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        };
      } catch (error) {
        const latestCompliance = getLatestComplianceDecision(service.serviceId, args.toolName); // 尝试回传最近合规决策，帮助定位失败阶段
        const latestPaymentCtx = latestPaymentContextByService.get(service.serviceId) ?? null; // 读取支付上下文，帮助定位资金流向
        const errorMessage = error instanceof Error ? error.message : String(error); // 标准化错误文本
        const response: GatewayEnvelope<{
          serviceId: string;
          toolName: string;
          complianceDecision: ComplianceDecision | null;
          payeeComplianceDecision: PayeeComplianceDecision | null;
          paymentContext: PaymentContext | null;
          downstreamError: string;
        }> = {
          ok: false,
          stage: latestCompliance && !latestCompliance.passed ? "compliance_check" : "tool_execution",
          code:
            latestCompliance && !latestCompliance.passed
              ? latestCompliance.reasonCode
              : "TOOL_CALL_FAILED",
          message:
            latestCompliance && !latestCompliance.passed
              ? latestCompliance.message
              : "Downstream tool call failed.",
          traceId,
          timestamp: new Date().toISOString(),
          detail: {
            serviceId: service.serviceId,
            toolName: args.toolName,
            complianceDecision: latestCompliance ?? null,
            payeeComplianceDecision: null, // 失败时收款方通常未返回合规信息
            paymentContext: latestPaymentCtx,
            downstreamError: errorMessage,
          },
        };

        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        };
      }
    },
  );
}

/**
 * 构建网关 MCP 服务实例并挂载工具。
 *
 * @param registry 下游服务注册表。
 * @returns 可连接 transport 的 MCP 服务对象。
 */
function buildGatewayMcpServer(registry: DownstreamServiceRecord[]): McpServer {
  const mcpServer = new McpServer({
    name: "x402 Gateway MCP",
    version: "1.0.0",
  });
  registerGatewayTools(mcpServer, registry); // 注册网关暴露工具
  return mcpServer; // 返回可连接 transport 的服务对象
}

/**
 * 启动 stdio 模式网关。
 *
 * 说明：
 * - stdio 模式适合被 Cursor 等 Agent 以 command 方式拉起；
 * - 日志统一写 stderr，避免污染 stdio 上的 JSON-RPC 数据流。
 *
 * @param registry 下游服务注册表。
 */
async function startGatewayServer(registry: DownstreamServiceRecord[]): Promise<void> {
  const mcpServer = buildGatewayMcpServer(registry); // 构建服务对象
  const transport = new StdioServerTransport(); // 使用 stdio 作为上游通信通道
  await mcpServer.connect(transport); // 连接 transport，进入可服务状态

  // 所有运行日志使用 stderr，避免与 stdio RPC 报文混流。
  console.error("🚀 网关 MCP 服务已启动（stdio 传输层）");
  console.error(`📡 已注册下游服务：${registry.map(item => item.serviceId).join(", ")}`);
}

/**
 * 优雅关闭所有下游客户端连接。
 *
 * @param registry 当前活跃下游注册表。
 */
async function closeDownstreamClients(registry: DownstreamServiceRecord[]): Promise<void> {
  await Promise.all(registry.map(service => service.client.close())); // 并发关闭所有下游连接
}

/**
 * 主入口函数。
 *
 * 启动顺序：
 * 1) 读取配置并初始化所有下游连接；
 * 2) 启动本地 stdio MCP 服务；
 * 3) 监听 SIGINT，优雅释放下游连接。
 *
 * @returns 初始化完成后的 Promise。
 */
export async function main(): Promise<void> {
  const registry = await initializeDownstreamRegistry(downstreamUrls, evmPrivateKey, transportMode); // 先连下游并构建注册表
  await startGatewayServer(registry); // 再启动对上游的网关服务

  process.on("SIGINT", async () => {
    console.error("\n🛑 正在关闭网关..."); // 接收到 Ctrl+C 时打印关停日志
    await closeDownstreamClients(registry); // 优雅关闭下游连接
    process.exit(0); // 正常退出
  });
}

main().catch(async error => {
  console.error("💀 致命错误：", error); // 启动失败统一兜底日志
  process.exit(1); // 异常退出
});
