/**
 * Facilitator + Bazaar Discovery Extension 示例
 *
 * 目标：
 * 在常规 verify/settle 能力之外，演示 Facilitator 如何在验证阶段
 * 抽取并记录支付中的 Discovery 扩展信息，形成可查询的资源目录（catalog）。
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
import { extractDiscoveryInfo, DiscoveryInfo } from "@x402/extensions/bazaar";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

dotenv.config();

// 服务端口，默认 4022
const PORT = process.env.PORT || "4022";

// 按私钥动态启用网络（EVM/SVM 至少一条）
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;

// 至少提供一条链的私钥，否则无法对支付进行链上能力验证/结算
if (!evmPrivateKey && !svmPrivateKey) {
  console.error(
    "❌ At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required",
  );
  process.exit(1);
}

// CAIP-2 网络标识
const EVM_NETWORK = "eip155:84532"; // Base Sepolia
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // Solana Devnet

// DiscoveredResource：目录中单条“已发现资源”的结构
interface DiscoveredResource {
  resource: string;
  description?: string;
  mimeType?: string;
  type: string;
  x402Version: number;
  accepts: PaymentRequirements[];
  discoveryInfo?: DiscoveryInfo;
  lastUpdated: string;
}

/**
 * BazaarCatalog：内存版目录存储（示例用途）
 *
 * 生产环境建议替换为持久化存储（如 Redis / PostgreSQL），并配合分页与过滤。
 */
class BazaarCatalog {
  private resources: Map<string, DiscoveredResource> = new Map();

  /**
   * Adds a discovered resource to the catalog.
   *
   * @param res - The discovered resource to add
   */
  add(res: DiscoveredResource): void {
    this.resources.set(res.resource, res);
  }

  /**
   * Returns all discovered resources in the catalog.
   *
   * @returns Array of all discovered resources
   */
  getAll(): DiscoveredResource[] {
    return Array.from(this.resources.values());
  }
}

const bazaarCatalog = new BazaarCatalog();

// 在 onAfterVerify 中提取 discovery 信息并入库，是本示例的关键
const facilitator = new x402Facilitator()
  .onBeforeVerify(async (context) => {
    console.log("Before verify", context);
  })
  .onAfterVerify(async (context) => {
    console.log("✅ Payment verified");

    // 从 paymentPayload + requirements 中提取 bazaar discovery 信息
    // validate = true 表示执行结构校验，避免脏数据进入目录
    try {
      const discovered = extractDiscoveryInfo(
        context.paymentPayload,
        context.requirements,
        true, // validate
      );

      if (discovered) {
        console.log(`   📝 Discovered resource: ${discovered.resourceUrl}`);
        console.log(`   📝 Description: ${discovered.description}`);
        console.log(`   📝 MimeType: ${discovered.mimeType}`);
        if ("method" in discovered && discovered.method !== undefined) {
          console.log(`   📝 Method: ${discovered.method}`);
        } else if ("toolName" in discovered) {
          console.log(`   📝 Tool: ${discovered.toolName}`);
        }
        console.log(`   📝 X402Version: ${discovered.x402Version}`);

        // 将此次支付关联的可发现资源写入目录
        bazaarCatalog.add({
          resource: discovered.resourceUrl,
          description: discovered.description,
          mimeType: discovered.mimeType,
          type: "http",
          x402Version: discovered.x402Version,
          accepts: [context.requirements],
          discoveryInfo: discovered.discoveryInfo,
          lastUpdated: new Date().toISOString(),
        });
        console.log("   ✅ Added to bazaar catalog");
      }
    } catch (err) {
      // 扩展提取失败不应影响主支付流程，因此仅记录告警
      console.log(`   ⚠️  Failed to extract discovery info: ${err}`);
    }
  })
  .onVerifyFailure(async (context) => {
    console.log("Verify failure", context);
  })
  .onBeforeSettle(async (context) => {
    console.log("Before settle", context);
  })
  .onAfterSettle(async (context) => {
    console.log(`🎉 Payment settled: ${context.result.transaction}`);
  })
  .onSettleFailure(async (context) => {
    console.log("Settle failure", context);
  });

// -------- EVM 注册分支 --------
if (evmPrivateKey) {
  const evmAccount = privateKeyToAccount(evmPrivateKey);
  console.info(`EVM Facilitator account: ${evmAccount.address}`);

  // viem 读写能力适配为 x402 的 EVM facilitator signer
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

// 暴露 Facilitator HTTP 接口
const app = express();
app.use(express.json());

/**
 * POST /verify
 * 校验支付：通过后会触发 onAfterVerify 并尝试抽取 discovery 信息
 *
 * 注意：资源发现目录的入库逻辑不在接口函数里写死，而是在钩子中处理。
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

    // 进入协议层 verify 流程
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
 * 执行链上结算（与基础示例一致）
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

    // 对钩子主动中止结算进行协议化响应
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
 * 返回 Facilitator 支持能力（网络、机制、扩展）
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
 * GET /discovery/resources
 * 返回当前目录中所有已发现资源（示例为内存数据）
 */
app.get("/discovery/resources", async (req, res) => {
  try {
    const resources = bazaarCatalog.getAll();
    res.json({
      x402Version: 2,
      items: resources,
      pagination: {
        limit: 100,
        offset: 0,
        // total 便于前端做分页器与结果概览
        total: resources.length,
      },
    });
  } catch (error) {
    console.error("Discovery error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /health
 * 健康检查接口
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// 启动后会打印 discovery 查询入口
app.listen(parseInt(PORT), () => {
  console.log(`🚀 Discovery Facilitator listening on http://localhost:${PORT}`);
  console.log(
    `   Supported networks: ${facilitator
      .getSupported()
      .kinds.map((k) => k.network)
      .join(", ")}`,
  );
  console.log(`   Discovery endpoint: GET /discovery/resources`);
  console.log();
});
