#!/usr/bin/env node
/**
 * x402 MCP Gateway（付款侧网关）
 *
 * 角色定位：
 * 1) 对上游 Agent（如 Cursor）暴露一个统一的 MCP 服务入口（stdio）。
 * 2) 将工具调用转发给一个或多个下游 MCP 服务。
 * 3) 当下游返回 x402 支付挑战时，网关使用本地钱包自动支付。
 * 4) 在自动支付前，依次执行（fail-close，任一失败即拒绝）：
 *    a. AP2 意图凭证验证（Intent Mandate：单笔限额 + 剩余预算）。
 *    b. AP2 验证服务审批（验签 Cart Mandate + 预算核销，启动与支付路径均必填，不可跳过）。
 *    c. KYC/KYT 合规检查，不满足则拒绝支付。
 * 5) 支付完成后，异步写入交易记录到 Dashboard。
 *
 * 核心链路（简化）：
 * Agent -> gateway.call_service_tool -> downstream tool
 *      -> (如遇支付挑战) onPaymentRequested
 *           -> AP2 runIntentMandateCheck (意图凭证：限额 + 预算)
 *           -> AP2 runAssuranceCheck     (验签 Cart Mandate + 预算核销)
 *           -> KYC/KYT runComplianceChecks
 *           -> allow/deny
 *      -> (支付完成后) recordTransaction -> Dashboard
 */
import { config } from "dotenv";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createx402MCPClient } from "@x402/mcp";

import {
  sleep,
  runComplianceChecks,
  extractPayeeCompliance,
  type ComplianceConfig,
  type ComplianceDecision,
  type PayeeComplianceDecision,
} from "./compliance.js";

import {
  extractCartMandate,
  runAssuranceCheck,
  type AssuranceConfig,
  type AssuranceDecision,
} from "./assurance.js";

import {
  runIntentMandateCheck,
  type IntentMandateConfig,
  type IntentMandateDecision,
} from "./mandate.js";

import {
  extractPaymentResponseData,
  buildTransactionPayload,
  recordTransaction,
  type TransactionConfig,
  type PaymentContext,
} from "./transaction.js";

config(); // 加载环境变量

// =====================================================================
// 类型定义
// =====================================================================

type JsonObject = Record<string, unknown>;
type DownstreamTransportMode = "auto" | "sse" | "streamable-http";
type DownstreamMcpClient = ReturnType<typeof createx402MCPClient>;

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
  | "intent_mandate_check"  // 意图凭证验证阶段（单笔限额 + 剩余预算）
  | "assurance_check"       // AP2 验证服务审批阶段（验签 + 预算核销）
  | "compliance_check";     // KYC/KYT 合规检查阶段
  code: string;
  message: string;
  traceId: string;
  timestamp: string;
  detail: TDetail;
}

// =====================================================================
// 配置读取
// =====================================================================

const evmPrivateKey = requireHexPrivateKey("EVM_PRIVATE_KEY");

/**
 * 网关自身的 EVM 钱包地址，由 EVM_PRIVATE_KEY 推导。
 * 作为意图凭证验证（POST /api/mandates/intent/vc）的 payerAddress 入参，
 * 即买方控制台中登记意图授权时使用的地址。
 */
const payerAddress = privateKeyToAccount(evmPrivateKey).address;

/** 合规服务配置（KYC/KYT 接口共用） */
const complianceConfig: ComplianceConfig | null = (() => {
  const baseUrl = process.env.COMPLIANCE_BASE_URL;
  const apiKey = process.env.COMPLIANCE_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error("⚠️ 合规配置不完整（COMPLIANCE_BASE_URL 或 COMPLIANCE_API_KEY 缺失），合规检查将拒绝所有支付");
    return null;
  }
  return {
    baseUrl,
    apiKey,
    chain: process.env.COMPLIANCE_CHAIN ?? "base",
    maxRetries: 5,
  };
})();

/**
 * AP2 验证服务配置（必填）。
 *
 * ASSURANCE_BASE_URL：验证服务根地址。
 * API Key 与合规服务复用同一个 COMPLIANCE_API_KEY。
 * AGENTRY_ID：买方控制台下发的意图凭证 ID（见下方非空校验）。
 *
 * 缺失任一项时进程直接退出，避免在未审批场景下代付。
 */
const assuranceConfig: AssuranceConfig = (() => {
  const baseUrl = process.env.ASSURANCE_BASE_URL?.trim();
  const apiKey = process.env.COMPLIANCE_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    console.error("❌ AP2 审批为必填：请配置 ASSURANCE_BASE_URL 与 COMPLIANCE_API_KEY，网关无法启动");
    process.exit(1);
  }
  return { baseUrl, apiKey };
})();

/** 买方意图凭证 ID，来自 Payer Dashboard，用于 AP2 预算查账（必填，非空） */
const agentryId = (() => {
  const id = (process.env.AGENTRY_ID ?? "").trim();
  if (!id) {
    console.error("❌ AP2 审批为必填：请配置非空环境变量 AGENTRY_ID，网关无法启动");
    process.exit(1);
  }
  return id;
})();

/**
 * 意图凭证验证服务配置。
 *
 * 复用现有合规服务的 COMPLIANCE_BASE_URL 和 COMPLIANCE_API_KEY，无需新增环境变量。
 * 若合规配置缺失，意图凭证验证也将被跳过（与合规检查共同依赖同一配置）。
 */
const intentMandateConfig: IntentMandateConfig | null = complianceConfig
  ? { baseUrl: complianceConfig.baseUrl, apiKey: complianceConfig.apiKey }
  : null;

/** 交易记录服务配置（与合规服务共享域名和 API Key） */
const transactionConfig: TransactionConfig | null = complianceConfig
  ? { baseUrl: complianceConfig.baseUrl, apiKey: complianceConfig.apiKey, defaultChain: complianceConfig.chain }
  : null;

/** 缓存每个 service 最近一次意图凭证验证结果，供响应回传 */
const latestIntentMandateDecisionByService = new Map<string, IntentMandateDecision>();
/** 缓存每个 service 最近一次合规结果，供响应回传 */
const latestComplianceDecisionByService = new Map<string, ComplianceDecision>();
/** 缓存每个 service 最近一次 AP2 审批结果，供响应回传 */
const latestAssuranceDecisionByService = new Map<string, AssuranceDecision>();
/** 缓存每个 service 最近一次支付上下文，供响应透传资金流向 */
const latestPaymentContextByService = new Map<string, PaymentContext>();

const rawDownstreamUrls = process.env.DOWNSTREAM_MCP_URLS ?? process.env.DOWNSTREAM_MCP_URL;
if (!rawDownstreamUrls) {
  console.error("❌ 缺少环境变量 DOWNSTREAM_MCP_URL 或 DOWNSTREAM_MCP_URLS，无法确定下游服务地址");
  process.exit(1);
}

const downstreamUrls = rawDownstreamUrls
  .split(",")
  .map((url: string) => url.trim())
  .filter(Boolean);

if (downstreamUrls.length === 0) {
  console.error("❌ 至少需要配置一个下游 MCP 地址");
  process.exit(1);
}

const transportMode = parseTransportMode(process.env.DOWNSTREAM_MCP_TRANSPORT);
const connectRetries = parseConnectRetries(process.env.DOWNSTREAM_CONNECT_RETRIES);

// =====================================================================
// 配置解析工具
// =====================================================================

/**
 * 从环境变量读取十六进制私钥。
 * 必须存在且以 0x 开头，否则启动失败。
 */
function requireHexPrivateKey(envName: string): `0x${string}` {
  const value = process.env[envName];
  if (!value) {
    console.error(`❌ 缺少环境变量 ${envName}，网关无法启动`);
    process.exit(1);
  }
  if (!value.startsWith("0x")) {
    throw new Error(`${envName} must start with 0x.`);
  }
  return value as `0x${string}`;
}

/** 解析下游传输模式：auto / sse / streamable-http */
function parseTransportMode(value?: string): DownstreamTransportMode {
  if (!value) return "auto";
  if (value === "auto" || value === "sse" || value === "streamable-http") return value;
  throw new Error(`Invalid DOWNSTREAM_MCP_TRANSPORT: ${value}. Expected one of auto|sse|streamable-http.`);
}

/** 解析下游连接重试次数，限制在 [1, 10] */
function parseConnectRetries(value?: string): number {
  if (!value) return 3;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error(`Invalid DOWNSTREAM_CONNECT_RETRIES: ${value}. Expected integer in [1,10].`);
  }
  return parsed;
}

// =====================================================================
// EVM 地址工具
// =====================================================================

/** 校验地址是否为合法 EVM 地址（0x + 40位十六进制） */
function isValidEvmAddress(value: string): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

/** 从下游 paymentRequired 中提取并标准化收款方地址 */
function extractCounterpartyAddress(payTo: unknown): `0x${string}` | null {
  if (typeof payTo !== "string") return null;
  const normalized = payTo.trim();
  if (!isValidEvmAddress(normalized)) return null;
  return normalized.toLowerCase() as `0x${string}`;
}

// =====================================================================
// 网关内部工具
// =====================================================================

/** 生成本次调用的追踪 ID */
function createTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 获取指定 service + tool 的最近一次合规决策 */
function getLatestComplianceDecision(serviceId: string, toolName: string): ComplianceDecision | undefined {
  const decision = latestComplianceDecisionByService.get(serviceId);
  if (!decision || decision.toolName !== toolName) return undefined;
  return decision;
}

/** 获取指定 service 的最近一次 AP2 审批决策 */
function getLatestAssuranceDecision(serviceId: string): AssuranceDecision | undefined {
  return latestAssuranceDecisionByService.get(serviceId);
}

/** 获取指定 service 的最近一次意图凭证验证结果 */
function getLatestIntentMandateDecision(serviceId: string): IntentMandateDecision | undefined {
  return latestIntentMandateDecisionByService.get(serviceId);
}

// =====================================================================
// 下游连接管理
// =====================================================================

/** 根据传输模式返回候选协议顺序 */
function getTransportCandidates(
  mode: DownstreamTransportMode,
): Array<Exclude<DownstreamTransportMode, "auto">> {
  if (mode === "sse") return ["sse"];
  if (mode === "streamable-http") return ["streamable-http"];
  return ["streamable-http", "sse"]; // auto：HTTP 优先，SSE 兜底
}

/**
 * 连接单个下游 MCP 客户端（带协议回退 + 重试）。
 *
 * 按候选协议逐个尝试，每种协议按 connectRetries 次重试，
 * 失败后短暂退避，记录所有失败原因最终一次性抛出。
 */
async function connectWithTransportFallback(
  client: DownstreamMcpClient,
  url: string,
  mode: DownstreamTransportMode,
): Promise<Exclude<DownstreamTransportMode, "auto">> {
  const candidates = getTransportCandidates(mode);
  const errors: string[] = [];

  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= connectRetries; attempt += 1) {
      try {
        const transport =
          candidate === "sse"
            ? new SSEClientTransport(new globalThis.URL(url))
            : new StreamableHTTPClientTransport(new globalThis.URL(url), {
              requestInit: {
                headers: { Accept: "application/json, text/event-stream" },
              },
            });
        await client.connect(transport);
        return candidate;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cause = extractErrorCause(error);
        errors.push(`${candidate}#${attempt}: ${message}${cause}`);
        if (attempt < connectRetries) {
          await sleep(300 * attempt);
        }
      }
    }
  }

  throw new Error(`Failed to connect downstream MCP at ${url}. Attempts => ${errors.join(" | ")}`);
}

/** 从异常中提取可读的 cause 信息 */
function extractErrorCause(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const maybeCause = (error as { cause?: unknown }).cause;
  if (maybeCause instanceof Error) return ` (cause: ${maybeCause.message})`;
  if (typeof maybeCause === "string" && maybeCause.length > 0) return ` (cause: ${maybeCause})`;
  return "";
}

// =====================================================================
// 下游客户端创建与注册
// =====================================================================

/**
 * 为单个下游创建 x402 MCP 客户端并完成连接。
 *
 * 核心支付控制点：
 * - autoPayment=true：遇到支付挑战时自动支付。
 * - onPaymentRequested：支付前拦截，执行 KYC/KYT 检查决定放行或拒绝。
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
  const signer = privateKeyToAccount(privateKey);
  const client = createx402MCPClient({
    name: `gateway-${serviceId}`,
    version: "1.0.0",
    schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(signer) }],
    autoPayment: true,
    onPaymentRequested: async (context: {
      toolName: string;
      paymentRequired: {
        accepts: Array<{
          payTo?: unknown;
          amount: string;
          network: string;
          // extra 为 x402 协议的扩展字段，AP2 Cart Mandate 通过此字段传递：
          // accepts[0].extra.cartMandate = { merchant_id, merchant_address, ... }
          extra?: Record<string, unknown>;
        }>;
      };
    }) => {
      const accepted = context.paymentRequired.accepts[0];
      const counterparty = extractCounterpartyAddress(accepted.payTo);

      if (!counterparty) {
        console.error(
          `🚫 支付拒绝：服务=${serviceId}，工具=${context.toolName}，原因=收款方地址无效，payTo=${String(accepted.payTo)}`,
        );
        return false;
      }

      // ── Step 0: 意图凭证验证（AP2 Intent Mandate）──────────────────────
      // 最先执行，fail-close：配置缺失或验证不通过均拒绝支付，不进入后续流程。
      // 检查：单笔金额 <= perTxLimit 且 单笔金额 <= remainingBudget。
      if (!intentMandateConfig) {
        console.error(`🚫 支付拒绝：服务=${serviceId}，工具=${context.toolName}，原因=意图凭证配置缺失（COMPLIANCE_BASE_URL 或 COMPLIANCE_API_KEY 未配置）`);
        latestIntentMandateDecisionByService.set(serviceId, {
          passed: false,
          reasonCode: "MANDATE_CONFIG_MISSING",
          message: "Intent mandate configuration is missing.",
          checkedAt: new Date().toISOString(),
        });
        return false;
      }

      const intentDecision = await runIntentMandateCheck(intentMandateConfig, payerAddress, accepted.amount);
      latestIntentMandateDecisionByService.set(serviceId, intentDecision);

      if (!intentDecision.passed) {
        console.error(
          `🚫 意图凭证验证拒绝（中止支付）：服务=${serviceId}，工具=${context.toolName}，原因码=${intentDecision.reasonCode ?? "UNKNOWN"}，详情=${intentDecision.message ?? ""}`,
        );
        return false;
      }

      // ── Step 1: AP2 验证服务审批（Cart Mandate）────────────────────────
      // 在 KYC/KYT 合规检查之前，必须完成验证服务审批（启动时已保证配置存在）。
      // 验证服务完成：① 商户签名 ecrecover 验签；② 预算查账与行级锁核销。
      // 下游未在支付挑战中携带合法 Cart Mandate 时直接拒绝，不再放行。
      const cartMandate = extractCartMandate(context.paymentRequired);

      if (!cartMandate) {
        const checkedAt = new Date().toISOString();
        latestAssuranceDecisionByService.set(serviceId, {
          passed: false,
          status: "ERROR",
          errorCode: "CART_MANDATE_MISSING",
          errorMessage: "Cart Mandate is missing or invalid in payment challenge.",
          checkedAt,
        });
        console.error(
          `🚫 AP2 审批拒绝（中止支付）：服务=${serviceId}，工具=${context.toolName}，原因=Cart Mandate 未找到或格式非法`,
        );
        return false;
      }

      const assuranceDecision = await runAssuranceCheck(assuranceConfig, agentryId, cartMandate);
      latestAssuranceDecisionByService.set(serviceId, assuranceDecision);

      if (!assuranceDecision.passed) {
        console.error(
          `🚫 AP2 审批拒绝（中止支付）：服务=${serviceId}，工具=${context.toolName}，错误码=${assuranceDecision.errorCode ?? "UNKNOWN"}`,
        );
        return false;
      }

      // ── Step 2: KYC/KYT 合规检查（保留现有逻辑）───────────────────────
      // 合规配置缺失时直接拒绝（fail-close）
      if (!complianceConfig) {
        console.error(`🚫 支付拒绝：服务=${serviceId}，工具=${context.toolName}，原因=合规配置缺失`);
        latestComplianceDecisionByService.set(serviceId, {
          serviceId, toolName: context.toolName, counterparty, passed: false,
          reasonCode: "COMPLIANCE_CONFIG_MISSING", message: "Compliance configuration is missing.",
          checkedAt: new Date().toISOString(),
        });
        return false;
      }

      const decision = await runComplianceChecks(complianceConfig, serviceId, context.toolName, counterparty);
      latestComplianceDecisionByService.set(serviceId, decision);

      if (!decision.passed) {
        console.error(
          `🚫 支付拒绝：服务=${serviceId}，工具=${context.toolName}，原因=${decision.reasonCode}，对手方=${counterparty}，详情=${decision.message}`,
        );
        return false;
      }

      // ── Step 3: 放行，缓存支付上下文供后续响应和交易记录使用 ────────────
      latestPaymentContextByService.set(serviceId, {
        amount: accepted.amount,
        payTo: counterparty,
        network: accepted.network,
        tokenSymbol: (accepted.extra?.["name"] as string | undefined) ?? "UNKNOWN",
      });

      console.error(
        `💰 支付放行：服务=${serviceId}，工具=${context.toolName}，金额=${accepted.amount}，网络=${accepted.network}，收款方=${counterparty}`,
      );
      return true;
    },
  });

  const selectedTransport = await connectWithTransportFallback(client, url, mode);
  return { client, transport: selectedTransport };
}

/**
 * 根据配置的多个下游 URL 初始化网关注册表。
 *
 * 为每个 URL 建立连接、拉取工具列表、生成 service-1/service-2... 映射。
 */
async function initializeDownstreamRegistry(
  urls: string[],
  privateKey: `0x${string}`,
  mode: DownstreamTransportMode,
): Promise<DownstreamServiceRecord[]> {
  const records: DownstreamServiceRecord[] = [];

  for (let index = 0; index < urls.length; index += 1) {
    const serviceId = `service-${index + 1}`;
    const url = urls[index];
    const { client, transport } = await createAndConnectDownstreamClient(serviceId, url, privateKey, mode);
    const toolResult = await client.listTools();
    const tools = toolResult.tools.map((tool: { name: string; description?: string }) => ({
      name: tool.name,
      description: tool.description,
    }));
    records.push({ serviceId, url, transport, client, tools });

    console.error(`📡 注册下游：${serviceId} 已连接 → ${url}`);
    console.error(`📡 传输协议：${serviceId} → ${transport}`);
    console.error(`📡 可用工具：${serviceId} → ${tools.map((t: { name: string }) => t.name).join(", ") || "（无）"}`);
  }

  return records;
}

/** 根据 serviceId 选择下游服务（默认 service-1） */
function selectService(
  registry: DownstreamServiceRecord[],
  serviceId?: string,
): DownstreamServiceRecord {
  if (!serviceId) return registry[0];
  const service = registry.find(item => item.serviceId === serviceId);
  if (!service) throw new Error(`Unknown serviceId: ${serviceId}`);
  return service;
}

// =====================================================================
// 网关工具注册
// =====================================================================

/**
 * 注册网关对外工具。
 *
 * 对上游 Agent 暴露两个能力：
 * 1) list_gateway_services：查看当前可用下游和工具清单。
 * 2) call_service_tool：调用下游工具（内部自动处理支付、合规、交易记录）。
 */
function registerGatewayTools(mcpServer: McpServer, registry: DownstreamServiceRecord[]): void {
  mcpServer.tool(
    "list_gateway_services",
    "List downstream services and their tools.",
    {},
    async () => {
      const result = registry.map(service => ({
        serviceId: service.serviceId,
        url: service.url,
        transport: service.transport,
        tools: service.tools,
      }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  mcpServer.tool(
    "call_service_tool",
    "Call a downstream MCP tool via gateway. Payment is handled by gateway wallet.",
    {
      serviceId: z.string().optional().describe("Optional service id, default is service-1"),
      toolName: z.string().describe("Downstream tool name to call"),
      args: z.record(z.any()).optional().describe("Arguments passed to downstream tool"),
    },
    async (args: { serviceId?: string; toolName: string; args?: JsonObject }) => {
      const traceId = createTraceId();
      const service = selectService(registry, args.serviceId);

      try {
        const result = await service.client.callTool(args.toolName, args.args ?? {});
        const latestCompliance = getLatestComplianceDecision(service.serviceId, args.toolName);
        const latestAssurance = getLatestAssuranceDecision(service.serviceId);
        const latestIntentMandate = getLatestIntentMandateDecision(service.serviceId);
        const latestPaymentCtx = latestPaymentContextByService.get(service.serviceId) ?? null;
        const payeeCompliance = extractPayeeCompliance(result.content);
        const paymentResponseData = extractPaymentResponseData(result.paymentResponse);

        // 异步写入交易记录（fire-and-forget），仅在实际发生支付时记录
        if (result.paymentMade && transactionConfig) {
          recordTransaction(transactionConfig, buildTransactionPayload(transactionConfig, {
            toolName: args.toolName,
            serviceResult: "pass",
            paymentCtx: latestPaymentCtx,
            paymentResponseData,
            payerCompliance: latestCompliance ?? null,
            payeeCompliance,
          }));
        }

        const response: GatewayEnvelope<{
          serviceId: string;
          toolName: string;
          paymentMade: boolean;
          paymentResponse: unknown;
          intentMandateDecision: IntentMandateDecision | null;
          assuranceDecision: AssuranceDecision | null;
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
            intentMandateDecision: latestIntentMandate ?? null,
            assuranceDecision: latestAssurance ?? null,
            complianceDecision: latestCompliance ?? null,
            payeeComplianceDecision: payeeCompliance,
            paymentContext: (result.paymentMade ?? false) ? latestPaymentCtx : null,
            downstreamContent: result.content,
          },
        };

        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        const latestCompliance = getLatestComplianceDecision(service.serviceId, args.toolName);
        const latestAssurance = getLatestAssuranceDecision(service.serviceId);
        const latestIntentMandate = getLatestIntentMandateDecision(service.serviceId);
        const latestPaymentCtx = latestPaymentContextByService.get(service.serviceId) ?? null;
        const errorMessage = error instanceof Error ? error.message : String(error);

        // 异步写入交易记录：合规拒绝 → "reject"，其他异常 → "error"
        if (transactionConfig) {
          const failResult = latestCompliance && !latestCompliance.passed ? "reject" as const : "error" as const;
          recordTransaction(transactionConfig, buildTransactionPayload(transactionConfig, {
            toolName: args.toolName,
            serviceResult: failResult,
            paymentCtx: latestPaymentCtx,
            paymentResponseData: null,
            payerCompliance: latestCompliance ?? null,
            payeeCompliance: null,
          }));
        }

        // 确定失败阶段：意图凭证拒绝 > AP2 审批拒绝 > 合规拒绝 > 工具执行失败
        const isIntentMandateRejected = latestIntentMandate && !latestIntentMandate.passed;
        const isAssuranceRejected = latestAssurance && !latestAssurance.passed;
        const isComplianceRejected = latestCompliance && !latestCompliance.passed;
        const failStage = isIntentMandateRejected
          ? "intent_mandate_check" as const
          : isAssuranceRejected
            ? "assurance_check" as const
            : isComplianceRejected
              ? "compliance_check" as const
              : "tool_execution" as const;
        const failCode = isIntentMandateRejected
          ? (latestIntentMandate.reasonCode ?? "INTENT_MANDATE_REJECTED")
          : isAssuranceRejected
            ? (latestAssurance.errorCode ?? "ASSURANCE_REJECTED")
            : isComplianceRejected
              ? latestCompliance.reasonCode
              : "TOOL_CALL_FAILED";
        const failMessage = isIntentMandateRejected
          ? (latestIntentMandate.message ?? "Intent mandate check rejected the payment.")
          : isAssuranceRejected
            ? (latestAssurance.errorMessage ?? "AP2 assurance check rejected the payment.")
            : isComplianceRejected
              ? latestCompliance.message
              : "Downstream tool call failed.";

        const response: GatewayEnvelope<{
          serviceId: string;
          toolName: string;
          intentMandateDecision: IntentMandateDecision | null;
          assuranceDecision: AssuranceDecision | null;
          complianceDecision: ComplianceDecision | null;
          payeeComplianceDecision: PayeeComplianceDecision | null;
          paymentContext: PaymentContext | null;
          downstreamError: string;
        }> = {
          ok: false,
          stage: failStage,
          code: failCode,
          message: failMessage,
          traceId,
          timestamp: new Date().toISOString(),
          detail: {
            serviceId: service.serviceId,
            toolName: args.toolName,
            intentMandateDecision: latestIntentMandate ?? null,
            assuranceDecision: latestAssurance ?? null,
            complianceDecision: latestCompliance ?? null,
            payeeComplianceDecision: null,
            paymentContext: latestPaymentCtx,
            downstreamError: errorMessage,
          },
        };

        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      }
    },
  );
}

// =====================================================================
// 启动与关闭
// =====================================================================

function buildGatewayMcpServer(registry: DownstreamServiceRecord[]): McpServer {
  const mcpServer = new McpServer({ name: "x402 Gateway MCP", version: "1.0.0" });
  registerGatewayTools(mcpServer, registry);
  return mcpServer;
}

async function startGatewayServer(registry: DownstreamServiceRecord[]): Promise<void> {
  const mcpServer = buildGatewayMcpServer(registry);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error("🚀 网关 MCP 服务已启动（stdio 传输层）");
  console.error(`📡 已注册下游服务：${registry.map(item => item.serviceId).join(", ")}`);
}

async function closeDownstreamClients(registry: DownstreamServiceRecord[]): Promise<void> {
  await Promise.all(registry.map(service => service.client.close()));
}

/**
 * 主入口函数。
 *
 * 启动顺序：
 * 1) 读取配置并初始化所有下游连接。
 * 2) 启动本地 stdio MCP 服务。
 * 3) 监听 SIGINT，优雅释放下游连接。
 */
export async function main(): Promise<void> {
  const registry = await initializeDownstreamRegistry(downstreamUrls, evmPrivateKey, transportMode);
  await startGatewayServer(registry);

  process.on("SIGINT", async () => {
    console.error("\n🛑 正在关闭网关...");
    await closeDownstreamClients(registry);
    process.exit(0);
  });
}

main().catch(async error => {
  console.error("💀 致命错误：", error);
  process.exit(1);
});
