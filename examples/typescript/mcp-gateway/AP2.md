
# 产品需求文档 (PRD)：通用 Agent 支付验证服务 (Universal Assurance Service)

**产品定位：** 面向泛智能体生态（基于通用 MCP）的 AP2 核心风控与额度核销中心。
**核心原则：** 客户端（MCP）保管私钥并在本地签发转账指令；验证服务仅做风控查账与业务核销；商户端自费发起链上结算（Payee-Settled）；**全链路采用以太坊原生 `secp256k1` 密码学体系**。

---

## 1. 核心系统架构与角色边界

系统被精简并划分为以下五个独立模块，彻底实现权限分离：

1. **买方控制台 (Payer Dashboard API)：** 负责维护用户的资金池和消费规则。生成并存储意图凭证，对外暴露 `agentry_id`，提供内部查询接口。**已存在，接口文档待补充。**
2. **卖方控制台 (Payee Dashboard API)：** 负责商户入驻管理。主要用于展示商户的链上收款地址（Wallet Address）和交易流水。
3. **支付验证服务（本 PRD 核心）：** 负责接收 MCP 的校验请求，通过 `ecrecover` 算法直接从发票中提取商户地址进行验签，并在数据库中锁定/核销买方的消费额度。
4. **支付 MCP (客户端模块，即现有 mcp-gateway)：** 安装在任意 Agent 中。**本地配置用户的以太坊私钥**、`agentry_id` 及验证服务 API KEY（与现有合规 API KEY 复用）。负责拦截 HTTP 402 请求、申请风控审批，并签名交易（与现有逻辑一致）。
5. **下游服务商 (含 Facilitator)：** 提供付费资源。使用**商户自身的以太坊钱包私钥**，通过以太坊 EIP-191 `personal_sign` 对账单 JSON 签名，生成 `0x...` 格式的 Hex 签名，随 HTTP 402 响应下发 `Cart Mandate`。收到 MCP 的 EIP-3009 签名后，由商户承担 Gas 费调用原生 USDC 合约提款。

---

## 2. 核心业务闭环 (Sequence Flow)

1. **触发交易：** Agent 通过 MCP 访问下游付费 API。
2. **开具原生发票：** 下游服务商返回 HTTP 402，并将 `Cart Mandate`（含商户 EIP-191 签名）Base64 编码后嵌入 x402 响应的 `payload` 字段下发。
3. **申请审批：** MCP 拦截 402 原始响应头，从 `Www-Authenticate` 中提取并解码 `payload`，向验证服务发送 `POST /v1/assurance/verify` 请求，携带 `agentry_id` 和解码后的 `Cart Mandate`。
4. **验证服务纯链下验签（去中心化鉴权）：**
   - 将 `Cart Mandate` 中**去除 `merchant_signature` 字段后**的 JSON 序列化字符串，通过 `encode_defunct` 计算消息哈希（EIP-191 格式）。
   - 对 `merchant_signature`（Hex 格式）执行 `ecrecover`，恢复出签名方的以太坊地址。
   - **比对逻辑：** 恢复出的地址与 Payload 中声明的 `merchant_address` 完全一致，则证明发票未被篡改且确由商户签发。
5. **验证服务内网查账与核销：**
   - 验签通过后，通过 `agentry_id` 调用买方控制台 API 获取剩余预算。
   - 确认发票金额 <= 剩余预算后，在数据库中**行级锁扣减**该预算。
6. **下发执行指令：** 验证服务返回 `APPROVED` 状态给 MCP。
7. **本地签名与换取服务：** MCP 收到核销成功的通知后，继续使用本地用户私钥执行 EIP-3009 签名（与现有流程一致）。商户拿到此签名后去 USDC 合约提款，并发货。

---

## 3. 核心 API 接口定义

**接口：** `POST /v1/assurance/verify`
**调用方：** 部署在各处的通用支付 MCP
**鉴权：** Header `X-API-Key: <COMPLIANCE_API_KEY>`

**Request Body (JSON):**
```json
{
  "agentry_id": "agent_req_8f92a1b",
  "cart_mandate": {
    "merchant_id": "21312",
    "merchant_address": "0xMerchantWalletAddress...",
    "total_amount": "0.5",
    "currency": "USDC",
    "pay_to": "0xMerchantWalletAddress...",
    "merchant_signature": "0x1a2b3c..."
  }
}
```

> `merchant_signature` 字段为商户对 Cart Mandate **其余字段**序列化 JSON 字符串的 EIP-191 `personal_sign` 签名，Hex 格式（`0x` 开头，65 字节 / 130 字符）。

**Response Body (JSON) — 审批通过：**
```json
{
  "status": "APPROVED",
  "data": {
    "agentry_id": "agent_req_8f92a1b",
    "approved_amount": "0.5"
  }
}
```

**Response Body (JSON) — 审批拒绝：**
```json
{
  "status": "REJECTED",
  "error": {
    "code": "SIGNATURE_MISMATCH",
    "message": "Recovered address does not match merchant_address."
  }
}
```

**错误码（`error.code`）：**

| 错误码 | 含义 |
|---|---|
| `SIGNATURE_MISMATCH` | ecrecover 恢复地址与 merchant_address 不符 |
| `BUDGET_EXCEEDED` | 发票金额超出 agentry_id 剩余预算 |
| `BUDGET_NOT_FOUND` | agentry_id 不存在或已过期 |
| `DUPLICATE_MANDATE` | 该 cart_mandate 已被核销过（防重放） |
| `INVALID_REQUEST` | 请求体字段缺失或格式错误 |

---

## 4. 安全与并发要求

- **网络隔离：** 支付验证服务仅接收携带有效 API KEY 的 MCP 请求，查账动作完全在平台内网（VPC）流转。
- **并发控制（悲观锁）：** 同一个 `agentry_id` 高频并发时，必须使用数据库行级锁（`SELECT ... FOR UPDATE`），严防预算超发。
- **双向重放防御：**
  - **防发票重放：** 缓存已核销的 `cart_mandate` 唯一标识（如 `merchant_id + total_amount + merchant_signature` 的哈希），拒绝重复扣减。
  - **防链上重放：** MCP 侧 EIP-3009 签名本身携带 nonce，由现有 `@x402/evm` 本地随机生成，无需验证服务介入。

---

# 改造方案 (Implementation Plan)

## 概述

本次改造在**不破坏现有 KYC/KYT 合规流程**的前提下，在支付放行前新增一个 AP2 审批环节。两者串联执行：

```
onPaymentRequested 回调触发
  ↓
① 提取原始 Cart Mandate（从 x402 payload 解码）
  ↓
② 调用 POST /v1/assurance/verify（AP2 验证服务）  ← 新增
  ↓  失败 → 拒绝支付
③ runComplianceChecks()（KYC/KYT）               ← 保留现有
  ↓  失败 → 拒绝支付
④ 放行 → ExactEvmScheme 本地签名 EIP-3009       ← 现有逻辑不变
```

---

## 新增环境变量

| 变量名 | 说明 | 是否必填 |
|---|---|---|
| `AGENTRY_ID` | 买方控制台下发的意图凭证 ID | 必填 |
| `ASSURANCE_BASE_URL` | AP2 验证服务地址（如 `https://your-domain.com`） | 必填 |

> `COMPLIANCE_API_KEY` 同时作为验证服务的鉴权 Key，无需新增。

---

## 文件改动清单

### 1. 新建 `assurance.ts`

职责：封装对 AP2 验证服务的 HTTP 调用，对外暴露 `runAssuranceCheck()` 函数。

**核心逻辑：**
- 接收 `agentryId` 和 `cartMandate` 对象
- `POST /v1/assurance/verify`（带 `X-API-Key` 鉴权）
- 返回结构化决策 `AssuranceDecision`（含 `passed`、`status`、`errorCode`、`approvedAmount`）
- 失败即拒（fail-close）：配置缺失或接口异常时返回 `passed: false`
- 可复用 `compliance.ts` 中的 `postJson` / `sleep` 工具函数

**导出类型：**
```typescript
interface AssuranceConfig {
  baseUrl: string;
  apiKey: string;
}

interface CartMandate {
  merchant_id: string;
  merchant_address: string;
  total_amount: string;
  currency: string;
  pay_to: string;
  merchant_signature: string;  // 0x... EIP-191 Hex 签名
}

interface AssuranceDecision {
  passed: boolean;
  status: "APPROVED" | "REJECTED" | "ERROR";
  errorCode?: string;
  errorMessage?: string;
  approvedAmount?: string;
}
```

---

### 2. 改造 `index.ts`

**① 配置读取区**

新增 `assuranceConfig`，读取 `ASSURANCE_BASE_URL` 和 `AGENTRY_ID`：

```typescript
const assuranceConfig: AssuranceConfig | null = (() => {
  const baseUrl = process.env.ASSURANCE_BASE_URL;
  const apiKey = process.env.COMPLIANCE_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error("⚠️ AP2 验证服务配置不完整，将拒绝所有支付");
    return null;
  }
  return { baseUrl, apiKey };
})();

const agentryId = process.env.AGENTRY_ID ?? "";
```

**② `onPaymentRequested` 回调**

在现有 KYC/KYT 检查**之前**，插入 AP2 验证步骤：

```
// 伪代码示意
onPaymentRequested: async (context) => {
  // 1. 从 context 中提取 Cart Mandate
  //    Cart Mandate 嵌入于 x402 payload 中（Base64 解码后得到 JSON）
  //    ⚠️ 技术调查点：确认 @x402/mcp 回调中 payload 的暴露方式
  const cartMandate = extractCartMandate(context.paymentRequired);

  // 2. AP2 验证（新增）
  if (cartMandate && assuranceConfig && agentryId) {
    const assuranceDecision = await runAssuranceCheck(
      assuranceConfig, agentryId, cartMandate
    );
    latestAssuranceDecisionByService.set(serviceId, assuranceDecision);

    if (!assuranceDecision.passed) {
      return false;  // 拒绝支付
    }
  }

  // 3. KYC/KYT 合规检查（现有，保留）
  const decision = await runComplianceChecks(...);
  ...

  // 4. 放行
  return true;
}
```

**③ `GatewayEnvelope` 的 `detail` 扩展**

在成功和失败响应的 `detail` 中均增加 `assuranceDecision` 字段：

```typescript
detail: {
  assuranceDecision: AssuranceDecision | null,  // ← 新增
  complianceDecision: ComplianceDecision | null,
  payeeComplianceDecision: ...,
  ...
}
```

**④ `stage` 枚举扩展**

`GatewayEnvelope.stage` 新增 `"assurance_check"` 值，供 AP2 验证拒绝时使用。


---

。
