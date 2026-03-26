/**
 * assurance.ts — AP2 通用 Agent 支付验证服务（Universal Assurance Service）集成模块
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 业务背景
 * ─────────────────────────────────────────────────────────────────────────────
 * 本模块实现 AP2 协议中"支付验证服务"的客户端调用逻辑。
 *
 * AP2 协议要求：在 MCP 网关向下游发起支付之前，必须向验证服务申请"审批"，
 * 验证服务会完成以下两项工作：
 *   1. 验签（去中心化鉴权）：用 ecrecover 从商户 EIP-191 签名中恢复以太坊地址，
 *      比对 Cart Mandate 中声明的 merchant_address，确认发票真实性。
 *   2. 查账与核销：通过 agentry_id 查询买方控制台剩余预算，确认金额合法后锁定扣减，
 *      防止超发。
 *
 * 只有验证服务返回 APPROVED 后，网关才继续执行本地 EIP-3009 签名并完成支付。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Cart Mandate 传递方式
 * ─────────────────────────────────────────────────────────────────────────────
 * 下游服务商将 Cart Mandate 对象放入 x402 支付要求的 accepts[0].extra.cartMandate
 * 字段中随 HTTP 402 响应下发。网关在 onPaymentRequested 回调中通过
 * extractCartMandate() 从 paymentRequired 对象里读取该字段。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 密码学约定
 * ─────────────────────────────────────────────────────────────────────────────
 * - 商户侧：用自身以太坊钱包私钥，对 Cart Mandate（去除 merchant_signature 字段后）
 *   的 JSON 序列化字符串执行 EIP-191 personal_sign，生成 0x 开头的 Hex 签名。
 * - 验证服务侧：用 encode_defunct + ecrecover 恢复签名方地址，与 merchant_address 比对。
 * - 全链路采用 secp256k1，无需公钥库，验证服务无需预先注册商户公钥。
 */

// =====================================================================
// 配置类型
// =====================================================================

/**
 * AP2 验证服务的连接配置。
 *
 * 由主模块从环境变量读取后注入，本模块不直接读取 process.env。
 */
export interface AssuranceConfig {
  /** 验证服务根地址，如 https://your-domain.com（不带末尾斜杠） */
  baseUrl: string;
  /**
   * API Key，用于对验证服务的请求鉴权（Header: X-API-Key）。
   * 与现有合规服务（KYC/KYT）共用同一个 COMPLIANCE_API_KEY。
   */
  apiKey: string;
  /** 单次 HTTP 请求超时毫秒数，默认 8000ms */
  timeoutMs?: number;
  /** 最大重试次数（含首次），默认 3 */
  maxRetries?: number;
}

// =====================================================================
// Cart Mandate 类型
// =====================================================================

/**
 * Cart Mandate — 商户签发的链下发票凭证。
 *
 * 由下游服务商在 HTTP 402 响应中通过 accepts[0].extra.cartMandate 字段下发。
 *
 * 字段说明：
 * - merchant_id:        商户在平台的业务 ID（用于日志追踪）。
 * - merchant_address:   商户以太坊钱包地址（0x...），既是收款地址，也是验签基准。
 * - total_amount:       本次交易金额，字符串格式，单位由 currency 指定。
 * - currency:           币种，目前仅支持 "USDC"。
 * - pay_to:             实际收款的以太坊钱包地址（通常与 merchant_address 相同）。
 * - merchant_signature: 商户用自身私钥对上述字段的 EIP-191 personal_sign 签名，
 *                       Hex 格式（0x 开头，65 字节 / 130 字符）。
 *
 * 签名内容：商户对 去除 merchant_signature 字段后 的 Cart Mandate JSON 序列化字符串签名，
 * 即 personal_sign(JSON.stringify({ merchant_id, merchant_address, total_amount,
 *                                   currency, pay_to }))。
 */
export interface CartMandate {
  merchant_id: string;
  merchant_address: string;
  total_amount: string;
  currency: string;
  pay_to: string;
  merchant_signature: string;
}

// =====================================================================
// 验证决策类型
// =====================================================================

/**
 * AP2 验证服务的审批决策结果。
 *
 * 不论通过或拒绝，始终返回此结构，便于上游统一处理和日志记录。
 */
export interface AssuranceDecision {
  /** true = 审批通过，可继续支付；false = 拒绝或异常，必须中止支付 */
  passed: boolean;
  /**
   * 验证服务返回的状态：
   * - APPROVED: 验签通过且预算充足，核销成功。
   * - REJECTED: 业务拒绝（验签失败 / 预算不足 / 重放攻击等）。
   * - ERROR:    网络异常或服务内部错误，按 fail-close 策略视为拒绝。
   */
  status: "APPROVED" | "REJECTED" | "ERROR";
  /** 审批通过时，本次授权的金额（与 cart_mandate.total_amount 一致） */
  approvedAmount?: string;
  /**
   * 拒绝或错误时的业务错误码：
   * - SIGNATURE_MISMATCH: ecrecover 恢复地址与 merchant_address 不符
   * - BUDGET_EXCEEDED:    发票金额超出 agentry_id 剩余预算
   * - BUDGET_NOT_FOUND:   agentry_id 不存在或已过期
   * - DUPLICATE_MANDATE:  该 cart_mandate 已被核销过（防重放）
   * - INVALID_REQUEST:    请求体字段缺失或格式错误
   */
  errorCode?: string;
  /** 人类可读的错误描述，用于日志和 GatewayEnvelope 响应 */
  errorMessage?: string;
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
 * 发起带 X-API-Key 鉴权的 JSON POST 请求，支持超时控制和线性退避重试。
 *
 * 与 compliance.ts 中的 postJson 区别：
 * - 鉴权方式为 Header（X-API-Key），而非请求体字段。
 * - 超时和重试次数由调用方通过参数传入。
 *
 * @param url        完整请求地址。
 * @param apiKey     鉴权 Key，写入 X-API-Key 请求头。
 * @param body       JSON 请求体。
 * @param maxRetries 最大重试次数（含首次）。
 * @param timeoutMs  单次请求超时毫秒数。
 * @returns 解析后的响应 JSON 对象。
 * @throws 所有重试耗尽后抛出最后一次错误。
 */
async function postJsonWithApiKey<T>(
  url: string,
  apiKey: string,
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
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // HTTP 4xx 为业务拒绝，直接解析响应体返回，不重试
      if (response.status >= 400 && response.status < 500) {
        return (await response.json()) as T;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Assurance API request failed: ${response.status} ${response.statusText}. ${text}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(
        `🔄 AP2 验证请求重试：第 ${attempt}/${maxRetries} 次，地址=${url}，错误=${lastError.message}`,
      );
      if (attempt < maxRetries) {
        await sleep(300 * attempt); // 线性退避：300ms, 600ms, 900ms...
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error("Assurance API request failed after retries.");
}

// =====================================================================
// 核心导出函数
// =====================================================================

/**
 * 从 x402 支付要求中提取 Cart Mandate。
 *
 * 约定：下游服务商将 Cart Mandate 对象放置于 x402 支付要求的
 * accepts[0].extra.cartMandate 字段，随 HTTP 402 响应一并下发。
 *
 * 本函数做最小化字段校验（存在性检查），不做签名验证（签名验证由验证服务完成）。
 *
 * @param paymentRequired x402 onPaymentRequested 回调中的 paymentRequired 对象。
 * @returns 解析出的 CartMandate，或 null（字段缺失 / 格式不符时）。
 */
export function extractCartMandate(
  paymentRequired: { accepts?: Array<{ extra?: Record<string, unknown> }> },
): CartMandate | null {
  const raw = paymentRequired.accepts?.[0]?.extra?.["cartMandate"];

  if (raw === null || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;

  // 必填字段存在性校验
  const requiredFields: Array<keyof CartMandate> = [
    "merchant_id",
    "merchant_address",
    "total_amount",
    "currency",
    "pay_to",
    "merchant_signature",
  ];

  for (const field of requiredFields) {
    if (typeof candidate[field] !== "string" || (candidate[field] as string).length === 0) {
      console.error(`⚠️ Cart Mandate 字段缺失或为空：${field}`);
      return null;
    }
  }

  // merchant_address 和 pay_to 必须是合法 EVM 地址（0x + 40位 hex）
  const evmAddressPattern = /^0x[a-fA-F0-9]{40}$/;
  if (!evmAddressPattern.test(candidate["merchant_address"] as string)) {
    console.error(`⚠️ Cart Mandate merchant_address 格式非法：${String(candidate["merchant_address"])}`);
    return null;
  }
  if (!evmAddressPattern.test(candidate["pay_to"] as string)) {
    console.error(`⚠️ Cart Mandate pay_to 格式非法：${String(candidate["pay_to"])}`);
    return null;
  }

  // merchant_signature 必须是 0x 开头的 Hex（EIP-191 personal_sign 产出为 65 字节 / 132 字符）
  if (!/^0x[a-fA-F0-9]+$/.test(candidate["merchant_signature"] as string)) {
    console.error(`⚠️ Cart Mandate merchant_signature 格式非法，应为 0x 开头 Hex`);
    return null;
  }

  return {
    merchant_id:        candidate["merchant_id"] as string,
    merchant_address:   candidate["merchant_address"] as string,
    total_amount:       candidate["total_amount"] as string,
    currency:           candidate["currency"] as string,
    pay_to:             candidate["pay_to"] as string,
    merchant_signature: candidate["merchant_signature"] as string,
  };
}

/**
 * 请求 AP2 验证服务对本次支付进行审批。
 *
 * 执行步骤（均在验证服务端完成，本函数仅负责 HTTP 通信）：
 *   1. 验证服务对 Cart Mandate 执行 ecrecover，恢复商户签名地址。
 *   2. 恢复地址与 merchant_address 比对，确认发票真实性。
 *   3. 查询 agentry_id 对应的剩余预算，确认金额合法。
 *   4. 行级锁扣减预算，防止并发超发。
 *   5. 校验 cart_mandate 唯一标识，拒绝重复核销（防重放）。
 *
 * 安全策略（fail-close）：
 * - 验证服务配置缺失、网络异常、服务 5xx 错误，均返回 passed=false。
 * - 只有明确收到 { status: "APPROVED" } 才放行。
 *
 * @param config     AP2 验证服务配置（baseUrl + apiKey）。
 * @param agentryId  买方控制台下发的意图凭证 ID，标识本次消费的预算来源。
 * @param cartMandate 从下游 402 响应中提取的商户发票凭证。
 * @returns 结构化审批决策，始终不抛出异常。
 */
export async function runAssuranceCheck(
  config: AssuranceConfig,
  agentryId: string,
  cartMandate: CartMandate,
): Promise<AssuranceDecision> {
  const checkedAt = new Date().toISOString();
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const maxRetries = config.maxRetries ?? 3;
  const timeoutMs = config.timeoutMs ?? 8000;
  const url = `${baseUrl}/v1/assurance/verify`;

  // 请求体：agentry_id + cart_mandate
  const requestBody: Record<string, unknown> = {
    agentry_id: agentryId,
    cart_mandate: cartMandate,
  };

  try {
    // 调用验证服务
    const raw = await postJsonWithApiKey<Record<string, unknown>>(
      url,
      config.apiKey,
      requestBody,
      maxRetries,
      timeoutMs,
    );

    // 解析响应：验证服务必须返回 { status: "APPROVED" | "REJECTED", ... }
    const status = raw["status"];

    if (status === "APPROVED") {
      const data = (raw["data"] ?? {}) as Record<string, unknown>;
      const approvedAmount = typeof data["approved_amount"] === "string"
        ? data["approved_amount"]
        : cartMandate.total_amount;

      console.error(
        `✅ AP2 审批通过：agentry_id=${agentryId}，merchant=${cartMandate.merchant_address}，金额=${approvedAmount} ${cartMandate.currency}`,
      );

      return {
        passed: true,
        status: "APPROVED",
        approvedAmount,
        checkedAt,
      };
    }

    // REJECTED 或其他非 APPROVED 状态，均视为拒绝
    const error = (raw["error"] ?? {}) as Record<string, unknown>;
    const errorCode = typeof error["code"] === "string" ? error["code"] : "REJECTED";
    const errorMessage = typeof error["message"] === "string"
      ? error["message"]
      : `Assurance service rejected the payment. Status: ${String(status)}`;

    console.error(
      `🚫 AP2 审批拒绝：agentry_id=${agentryId}，merchant=${cartMandate.merchant_address}，错误码=${errorCode}，详情=${errorMessage}`,
    );

    return {
      passed: false,
      status: "REJECTED",
      errorCode,
      errorMessage,
      checkedAt,
    };
  } catch (error) {
    // 网络异常 / 服务 5xx，按 fail-close 策略拒绝支付
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `❌ AP2 验证服务请求失败（fail-close 拒绝支付）：agentry_id=${agentryId}，错误=${message}`,
    );

    return {
      passed: false,
      status: "ERROR",
      errorCode: "ASSURANCE_API_ERROR",
      errorMessage: `Assurance API error: ${message}`,
      checkedAt,
    };
  }
}
