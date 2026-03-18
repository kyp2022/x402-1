import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/**
 * x402 Facilitator（TypeScript 基础版）示例
 *
 * 这个文件演示了一个最小可运行的 Facilitator 服务，职责是：
 * 1) 接收资源服务器转发的支付验证请求（/verify）
 * 2) 接收资源服务器转发的支付结算请求（/settle）
 * 3) 对外声明当前 Facilitator 支持的网络和支付机制（/supported）
 *
 * 架构关系：
 * Client -> Resource Server(业务 API) -> Facilitator -> Blockchain
 *
 * 说明：
 * - 资源服务器负责返回 402 和业务资源保护；
 * - Facilitator 负责签名校验、余额/授权校验、链上结算；
 * - 本示例同时注册 EVM(Base Sepolia) + SVM(Solana Devnet)。
 */
dotenv.config();

// 服务端口，默认 4022（可与 examples 中其他服务保持一致）
const PORT = process.env.PORT || "4022";

// 基础示例要求两条链的私钥都提供，便于一次性演示 EVM/SVM
if (!process.env.EVM_PRIVATE_KEY) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

if (!process.env.SVM_PRIVATE_KEY) {
  console.error("❌ SVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

// 从私钥初始化 EVM 账户（用于代表 Facilitator 发起结算交易）
const evmAccount = privateKeyToAccount(
  process.env.EVM_PRIVATE_KEY as `0x${string}`,
);
console.info(`EVM Facilitator account: ${evmAccount.address}`);

// 从 base58 私钥初始化 SVM 账户（Solana）
const svmAccount = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_PRIVATE_KEY as string),
);
console.info(`SVM Facilitator account: ${svmAccount.address}`);

// 这里使用 viem wallet + public 能力：
// - public: 读链（合约读取、验签辅助、查询状态）
// - wallet: 写链（广播交易、等待回执）
const viemClient = createWalletClient({
  account: evmAccount,
  chain: baseSepolia,
  transport: http(),
}).extend(publicActions);

// 将通用 viem 能力适配成 x402 期望的 Facilitator EVM Signer 接口
// 适配后，ExactEvmScheme 才能在 verify/settle 阶段调用这些能力。

const evmSigner = toFacilitatorEvmSigner({
  getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
  address: evmAccount.address,
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) =>
    viemClient.readContract({
      ...args,
      args: args.args || [],
    }),
  verifyTypedData: (args: {
    address: `0x${string}`;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) => viemClient.verifyTypedData(args as any),
  writeContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) =>
    viemClient.writeContract({
      ...args,
      args: args.args || [],
    }),
  sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
    viemClient.sendTransaction(args),
  waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
    viemClient.waitForTransactionReceipt(args),
});

// 将 Solana 账户适配成 x402 的 SVM Signer
const svmSigner = toFacilitatorSvmSigner(svmAccount);

// x402Facilitator 是协议核心对象：
// - verify() 触发支付有效性校验
// - settle() 触发链上结算
// - onXxx 钩子用于插入风控、审计、监控等逻辑
const facilitator = new x402Facilitator()
  .onBeforeVerify(async (context) => {
    console.log("Before verify", context);
  })
  .onAfterVerify(async (context) => {
    console.log("After verify", context);
  })
  .onVerifyFailure(async (context) => {
    console.log("Verify failure", context);
  })
  .onBeforeSettle(async (context) => {
    console.log("Before settle", context);
  })
  .onAfterSettle(async (context) => {
    console.log("After settle", context);
  })
  .onSettleFailure(async (context) => {
    console.log("Settle failure", context);
  });

// 注册支持的网络与支付机制（network + scheme）
facilitator.register(
  "eip155:84532",
  new ExactEvmScheme(evmSigner, { deployERC4337WithEIP6492: true }),
); // Base Sepolia
facilitator.register(
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  new ExactSvmScheme(svmSigner),
); // Devnet

// 通过 Express 暴露 Facilitator 的标准 HTTP 接口
const app = express();
app.use(express.json());

/**
 * POST /verify
 * 校验 paymentPayload 是否满足 paymentRequirements
 *
 * 常见校验包括：
 * - 签名是否来自真实付款方
 * - 授权金额/接收方/有效期是否匹配
 * - 余额与 allowance 是否足够
 *
 * 说明：支付跟踪、扩展提取等逻辑建议通过生命周期钩子处理。
 */
app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    // 执行协议层 verify 逻辑；钩子会在内部自动触发
    const response: VerifyResponse = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /settle
 * 发起链上结算（真正转账发生在这里）
 *
 * 通常资源服务器会在业务处理成功后再调用 settle，
 * 避免“结算成功但业务失败”的不一致。
 */
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    // 执行协议层 settle 逻辑；钩子会在内部自动触发
    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);

    // 若是 onBeforeSettle 的业务中止，返回结构化 SettleResponse，避免 500
    if (
      error instanceof Error &&
      error.message.includes("Settlement aborted:")
    ) {
      // Return a proper SettleResponse instead of 500 error
      return res.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        network: req.body?.paymentPayload?.network || "unknown",
      } as SettleResponse);
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /supported
 * 返回 Facilitator 当前支持的 x402 能力：
 * - 支持的 network + scheme 列表
 * - 支持的扩展（如 bazaar）
 */
app.get("/supported", async (req, res) => {
  try {
    const response = facilitator.getSupported();
    res.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
    });
  }
});

// 启动服务后，资源服务器可将 FACILITATOR_URL 指向本服务地址
app.listen(parseInt(PORT), () => {
  console.log(`🚀 Facilitator listening on http://localhost:${PORT}`);
  console.log();
});
