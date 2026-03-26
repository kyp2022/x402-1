
11.4 查询账户公钥

通过钱包地址查询账户公钥（可选，用于客户端验证签名）

字段
值
请求方法
POST
接口路径
/api/accounts/public-key
鉴权方式
Body 中传入 apiKey

请求 Body

参数名
类型
必填
说明
apiKey
string
是
API Key
walletAddress
string
是
钱包地址

返回格式（HTTP 200）

{
  "code": 80000000,
  "msg": "success",
  "data": {
    "walletAddress": "0xabcd1234...",
    "publicKey": "0x04..."
  }
}

示例

curl -X POST "https://your-domain.com/api/accounts/public-key" \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "agt_xxxxxxxxxxxx",
    "walletAddress": "0x834474017B9159aBF489303113bA45622804C3fe"
  }'


---

11.5 验证意图授权并获取 VC 凭证

外部服务通过 API Key 验证某付款方的意图授权是否覆盖本次交易，并获取 W3C VC 凭证。
字段
值
请求方法
POST
接口路径
/api/mandates/intent/vc
鉴权方式
Body 中传入 apiKey
请求 Body
参数名
类型
必填
说明
apiKey
string
是
API Key
payerAddress
string
是
付款方钱包地址
返回格式 — 成功（HTTP 200）
{
  "code": 80000000,
  "msg": "success",
  "data": {
    "allowed": true,
    "mandate": {
      "id": "clxxx...",
      "perTxLimit": "2.00",
      "totalBudget": "5.00",
      "usedAmount": "1.50",
      "transactionCount": 3,
      "expiresAt": "2026-04-24T10:30:00.000Z",
      "status": "active"
    },
    "remainingBudget": "3.50",
    "usagePercent": 30.0,
    "vcJson": { "/* 完整 W3C Verifiable Credential */": "..." }
  }
}
重要: 此接口仅返回 VC 凭证，不验证交易金额。支付平台需：
1. 使用 vcJson.proof.proofValue 验证签名合法性
2. 自行检查 amount <= mandate.perTxLimit 和 amount <= remainingBudget
字段
类型
说明
vcJson
object
W3C VC 格式凭证（含 EIP-712 proof）
💡 安全提示：vcJson 包含 EIP-712 签名（proof.proofValue），支付平台可使用请求参数中的 payer 独立验证签名合法性，详见 [Intent Mandate 签名验证指南](./VC_VERIFICATION_GUIDE.md)。
返回格式 — 拒绝
{
  "code": 80000053,
  "msg": "Mandate validation failed: MANDATE_NOT_FOUND",
  "data": {
    "allowed": false,
    "reason": "MANDATE_NOT_FOUND"
  }
}
拒绝原因（reason）
reason
业务 Code
含义
MANDATE_NOT_FOUND
80000053
无有效授权
MANDATE_EXPIRED
80000054
授权已过期
MANDATE_EXHAUSTED
80000055
预算已用尽
PER_TX_LIMIT_EXCEEDED
80000056
单笔金额超限
TOTAL_BUDGET_EXCEEDED
80000057
累计金额将超总预算
示例
# 获取 VC 凭证
curl -X POST "https://your-domain.com/api/mandates/intent/vc" \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "agt_xxxxxxxxxxxx",
    "payer": "0x834474017B9159aBF489303113bA45622804C3fe"
  }'