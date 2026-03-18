/**
 * All Networks Facilitator（多网络）示例
 *
 * 目标：
 * 通过“按私钥存在与否动态启用”的方式，演示一个 Facilitator 同时支持
 * EVM / SVM / Stellar 三条链，并统一暴露 /verify /settle /supported。
 *
 * 建议：
 * 新增链支持时按 network prefix 的字母顺序维护，便于阅读与合并。
 */

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
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

dotenv.config();

// 服务端口，默认 4022
const PORT = process.env.PORT || "4022";

// 每条链可独立配置私钥：只要有私钥就注册该链，不强制全量配置
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;
const stellarPrivateKey = process.env.STELLAR_PRIVATE_KEY as string | undefined;

// 至少启用一条链，否则 Facilitator 没有任何可用支付能力
if (!evmPrivateKey && !svmPrivateKey && !stellarPrivateKey) {
  console.error(
    "❌ At least one of EVM_PRIVATE_KEY, SVM_PRIVATE_KEY, or STELLAR_PRIVATE_KEY is required",
  );
  process.exit(1);
}

// CAIP-2 网络标识
const EVM_NETWORK = "eip155:84532"; // Base Sepolia
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // Solana Devnet
const STELLAR_NETWORK = "stellar:testnet"; // Stellar Testnet

// 协议核心对象：统一处理 verify/settle，并通过钩子扩展业务逻辑
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

// -------- EVM 注册分支 --------
if (evmPrivateKey) {
  const evmAccount = privateKeyToAccount(evmPrivateKey);
  console.info(`EVM Facilitator account: ${evmAccount.address}`);

  // viem 同时提供读链/写链能力，再适配给 x402 EVM facilitator signer
  const viemClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http(),
  }).extend(publicActions);

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

  // deployERC4337WithEIP6492 用于支持部分智能钱包场景
  facilitator.register(
    EVM_NETWORK,
    new ExactEvmScheme(evmSigner, { deployERC4337WithEIP6492: true }),
  );
}

// -------- SVM 注册分支 --------
if (svmPrivateKey) {
  const svmAccount = await createKeyPairSignerFromBytes(
    base58.decode(svmPrivateKey),
  );
  console.info(`SVM Facilitator account: ${svmAccount.address}`);

  const svmSigner = toFacilitatorSvmSigner(svmAccount);

  facilitator.register(SVM_NETWORK, new ExactSvmScheme(svmSigner));
}

// -------- Stellar 注册分支 --------
if (stellarPrivateKey) {
  const stellarSigner = createEd25519Signer(stellarPrivateKey);
  console.info(`Stellar Facilitator account: ${stellarSigner.address}`);

  facilitator.register(
    STELLAR_NETWORK,
    new ExactStellarScheme([stellarSigner]),
  );
}

// 暴露标准 HTTP 接口，供资源服务器调用
const app = express();
app.use(express.json());

/**
 * POST /verify
 * 校验支付载荷是否合法（签名、参数、余额/授权等）
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
 * 执行链上结算（广播交易并等待确认）
 */
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);

    // 兼容钩子主动中止结算的场景，返回协议内可识别的失败结构
    if (
      error instanceof Error &&
      error.message.includes("Settlement aborted:")
    ) {
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
 * 返回当前 Facilitator 实际启用的网络能力
 */
app.get("/supported", async (req, res) => {
  try {
    const response = facilitator.getSupported();
    res.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /health
 * 健康检查，便于容器探针/网关探活
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// 启动后可通过 /supported 快速确认到底启用了哪些链
app.listen(parseInt(PORT), () => {
  console.log(
    `🚀 All Networks Facilitator listening on http://localhost:${PORT}`,
  );
  console.log(
    `   Supported networks: ${facilitator
      .getSupported()
      .kinds.map((k) => k.network)
      .join(", ")}`,
  );
  console.log();
});
