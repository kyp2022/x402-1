/**
 * mandate.ts — AP2 意图凭证（Intent Mandate）验证模块
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 业务背景
 * ─────────────────────────────────────────────────────────────────────────────
 * 在 AP2 协议中，付款方在发起支付前，必须在买方控制台（Payer Dashboard）预先登记
 * 一份"意图授权"（Intent Mandate），声明：
 *   - 单笔消费上限（perTxLimit）
 *   - 总预算上限（totalBudget）
 *   - 有效期（expiresAt）
 *
 * MCP 网关在每次支付前，必须向 Payer Dashboard 查询该授权是否有效、金额是否在
 * 限额内，验证不通过则直接拒绝支付，不进入后续流程。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 接口说明（POST /api/mandates/intent/vc）
 * ─────────────────────────────────────────────────────────────────────────────
 * - 鉴权：Body 中传入 apiKey（与现有 COMPLIANCE_API_KEY 复用，无需新增配置）
 * - 入参：payerAddress（付款方钱包地址，即网关自身的 EVM 地址）
 * - 返回：意图授权详情 + W3C VC 凭证（含 EIP-712 签名的 proof）
 * - 重要：该接口本身不校验金额，网关需自行检查：
 *     amount <= mandate.perTxLimit
 *     amount <= remainingBudget
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 金额单位说明
 * ─────────────────────────────────────────────────────────────────────────────
 * x402 协议中 amount 字段为代币最小单位（USDC 为 6 位精度，如 100000 = 0.1 USDC）。
 * Payer Dashboard 返回的 perTxLimit / remainingBudget 为人类可读格式（如 "2.00"）。
 * 本模块在比较前统一将 x402 amount 转换为人类可读的 USDC 金额。
 */

// =====================================================================
// 配置类型
// =====================================================================

/**
 * 意图凭证验证服务配置。
 *
 * 复用现有合规服务的 baseUrl 和 apiKey，无需新增环境变量。
 */
export interface IntentMandateConfig {
  /** Payer Dashboard 根地址，如 https://your-domain.com（不带末尾斜杠） */
  baseUrl: string;
  /** API Key，即 COMPLIANCE_API_KEY，写入请求 Body */
  apiKey: string;
  /** 单次 HTTP 请求超时毫秒数，默认 8000ms */
  timeoutMs?: number;
  /** 最大重试次数（含首次），默认 3 */
  maxRetries?: number;
}

// =====================================================================
// 接口响应类型（内部使用）
// =====================================================================

/**
 * Payer Dashboard 意图凭证接口 —— 授权通过时的 data 结构。
 */
interface IntentMandateData {
  allowed: true;
  mandate: {
    id: string;
    perTxLimit: string;
    totalBudget: string;
    usedAmount: string;
    transactionCount: number;
    expiresAt: string;
    status: string;
  };
  remainingBudget: string;
  usagePercent: number;
  vcJson: Record<string, unknown>;
}

/**
 * Payer Dashboard 意图凭证接口 —— 授权拒绝时的 data 结构。
 */
interface IntentMandateRejectedData {
  allowed: false;
  reason: string;
}

/**
 * Payer Dashboard 意图凭证接口完整响应。
 */
interface IntentMandateApiResponse {
  code: number;
  msg: string;
  data: IntentMandateData | IntentMandateRejectedData;
}

// =====================================================================
// 导出的决策类型
// =====================================================================

/**
 * 意图凭证验证决策结果。
 *
 * 无论通过或拒绝，始终返回此结构，便于上游统一处理和日志记录。
 */
export interface IntentMandateDecision {
  /** true = 验证通过，可继续支付；false = 拒绝，必须中止支付 */
  passed: boolean;
  /**
   * 拒绝原因码（仅 passed=false 时有值）：
   * - MANDATE_NOT_FOUND:       无有效授权
   * - MANDATE_EXPIRED:         授权已过期
   * - MANDATE_EXHAUSTED:       预算已用尽
   * - PER_TX_LIMIT_EXCEEDED:   单笔金额超限
   * - TOTAL_BUDGET_EXCEEDED:   累计金额将超总预算
   * - AMOUNT_EXCEEDS_PER_TX:   本次金额超出 perTxLimit（网关自检）
   * - AMOUNT_EXCEEDS_REMAINING: 本次金额超出剩余预算（网关自检）
   * - MANDATE_API_ERROR:       接口请求失败
   */
  reasonCode?: string;
  /** 人类可读的拒绝描述，用于日志和 GatewayEnvelope 响应 */
  message?: string;
  /** 授权通过时：单笔限额（USDC，如 "2.00"） */
  perTxLimit?: string;
  /** 授权通过时：剩余预算（USDC，如 "3.50"） */
  remainingBudget?: string;
  /** 授权通过时：已使用金额（USDC） */
  usedAmount?: string;
  /** 授权通过时：授权过期时间（ISO 8601） */
  expiresAt?: string;
  /** 授权通过时：本次校验的交易金额（USDC，人类可读） */
  checkedAmount?: string;
  /** 本次验证发生的 ISO 8601 时间戳 */
  checkedAt: string;
}

// =====================================================================
// 内部工具函数
// =====================================================================

/**
 * 简单延时，用于请求重试时的退避等待。
 */
async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 将 x402 的代币最小单位金额转为人类可读的 USDC 金额字符串。
 *
 * x402 协议 amount 字段为整数字符串，USDC 精度为 6 位，
 * 例如 "100000" → "0.100000"。
 *
 * @param rawAmount x402 amount 字段（如 "100000"）
 * @returns 人类可读 USDC 金额（如 "0.100000"）
 */
function toHumanUsdc(rawAmount: string): string {
  const val = BigInt(rawAmount);
  const whole = val / 1_000_000n;
  const frac = val % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

/**
 * 发起带 JSON Body（含 apiKey）的 POST 请求，支持超时控制和线性退避重试。
 *
 * Payer Dashboard 鉴权方式为 Body 中传入 apiKey（区别于 assurance.ts 的 Header 鉴权）。
 *
 * @param url        完整请求地址。
 * @param body       JSON 请求体（含 apiKey）。
 * @param maxRetries 最大重试次数（含首次）。
 * @param timeoutMs  单次请求超时毫秒数。
 * @returns 解析后的响应 JSON 对象。
 * @throws 所有重试耗尽后抛出最后一次错误。
 */
async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  maxRetries: number,
  timeoutMs: number,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // HTTP 4xx 为业务拒绝，直接解析响应体，不重试
      if (response.status >= 400 && response.status < 500) {
        return (await response.json()) as T;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Mandate API request failed: ${response.status} ${response.statusText}. ${text}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(
        `🔄 意图凭证请求重试：第 ${attempt}/${maxRetries} 次，地址=${url}，错误=${lastError.message}`,
      );
      if (attempt < maxRetries) {
        await sleep(300 * attempt); // 线性退避：300ms, 600ms, 900ms...
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error("Mandate API request failed after retries.");
}

// =====================================================================
// 核心导出函数
// =====================================================================

/**
 * 验证付款方的意图授权，并检查本次交易金额是否在限额内。
 *
 * 执行步骤：
 *   1. POST /api/mandates/intent/vc 查询付款方意图授权（apiKey + payerAddress）。
 *   2. 检查 data.allowed === true（授权存在且未过期、未耗尽）。
 *   3. 将 x402 amount（最小单位）转换为人类可读 USDC 金额。
 *   4. 自行校验：amount <= mandate.perTxLimit（单笔限额）。
 *   5. 自行校验：amount <= remainingBudget（剩余预算）。
 *
 * 安全策略（fail-close）：
 * - 接口配置缺失、网络异常、服务 5xx 错误，均返回 passed=false。
 * - 只有全部检查通过才返回 passed=true。
 *
 * @param config        意图凭证验证服务配置（baseUrl + apiKey）。
 * @param payerAddress  付款方钱包地址（网关自身的 EVM 地址，由 EVM_PRIVATE_KEY 推导）。
 * @param rawAmount     x402 payment context 中的 amount 字段（代币最小单位字符串）。
 * @returns 结构化验证决策，始终不抛出异常。
 */
export async function runIntentMandateCheck(
  config: IntentMandateConfig,
  payerAddress: string,
  rawAmount: string,
): Promise<IntentMandateDecision> {
  const checkedAt = new Date().toISOString();
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const maxRetries = config.maxRetries ?? 3;
  const timeoutMs = config.timeoutMs ?? 8000;
  const url = `${baseUrl}/api/mandates/intent/vc`;

  // 提前转换金额，用于日志和后续比较
  let humanAmount: string;
  try {
    humanAmount = toHumanUsdc(rawAmount);
  } catch {
    return {
      passed: false,
      reasonCode: "INVALID_AMOUNT",
      message: `Cannot parse x402 amount: ${rawAmount}`,
      checkedAt,
    };
  }

  try {
    const raw = await postJson<IntentMandateApiResponse>(
      url,
      { apiKey: config.apiKey, payerAddress },
      maxRetries,
      timeoutMs,
    );

    const successCode = 80000000;

    // 接口返回业务失败（如 MANDATE_NOT_FOUND）
    if (raw.code !== successCode || !raw.data.allowed) {
      const rejectedData = raw.data as IntentMandateRejectedData;
      const reasonCode = rejectedData.reason ?? "MANDATE_REJECTED";
      const message = raw.msg ?? `Intent mandate check failed: ${reasonCode}`;

      console.error(
        `🚫 意图凭证验证拒绝：payer=${payerAddress}，原因=${reasonCode}，详情=${message}`,
      );

      return { passed: false, reasonCode, message, checkedAt };
    }

    // 授权通过，提取 mandate 详情
    const approvedData = raw.data as IntentMandateData;
    const { mandate, remainingBudget } = approvedData;

    // 将字符串金额转为数字进行比较
    const amountNum         = parseFloat(humanAmount);
    const perTxLimitNum     = parseFloat(mandate.perTxLimit);
    const remainingBudgetNum = parseFloat(remainingBudget);

    // 自检 1：单笔限额
    if (amountNum > perTxLimitNum) {
      const message = `Amount ${humanAmount} USDC exceeds perTxLimit ${mandate.perTxLimit} USDC`;
      console.error(`🚫 意图凭证单笔限额超限：payer=${payerAddress}，${message}`);
      return {
        passed: false,
        reasonCode: "AMOUNT_EXCEEDS_PER_TX",
        message,
        perTxLimit: mandate.perTxLimit,
        remainingBudget,
        usedAmount: mandate.usedAmount,
        expiresAt: mandate.expiresAt,
        checkedAmount: humanAmount,
        checkedAt,
      };
    }

    // 自检 2：剩余预算
    if (amountNum > remainingBudgetNum) {
      const message = `Amount ${humanAmount} USDC exceeds remainingBudget ${remainingBudget} USDC`;
      console.error(`🚫 意图凭证剩余预算不足：payer=${payerAddress}，${message}`);
      return {
        passed: false,
        reasonCode: "AMOUNT_EXCEEDS_REMAINING",
        message,
        perTxLimit: mandate.perTxLimit,
        remainingBudget,
        usedAmount: mandate.usedAmount,
        expiresAt: mandate.expiresAt,
        checkedAmount: humanAmount,
        checkedAt,
      };
    }

    // 全部通过
    console.error(
      `✅ 意图凭证验证通过：payer=${payerAddress}，金额=${humanAmount} USDC，` +
      `单笔限额=${mandate.perTxLimit}，剩余预算=${remainingBudget}`,
    );

    return {
      passed: true,
      perTxLimit: mandate.perTxLimit,
      remainingBudget,
      usedAmount: mandate.usedAmount,
      expiresAt: mandate.expiresAt,
      checkedAmount: humanAmount,
      checkedAt,
    };
  } catch (error) {
    // 网络异常 / 服务 5xx，按 fail-close 策略拒绝支付
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `❌ 意图凭证接口请求失败（fail-close 拒绝支付）：payer=${payerAddress}，错误=${message}`,
    );

    return {
      passed: false,
      reasonCode: "MANDATE_API_ERROR",
      message: `Intent mandate API error: ${message}`,
      checkedAt,
    };
  }
}
