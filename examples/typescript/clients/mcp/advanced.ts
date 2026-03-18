/**
 * 带 x402 支付支持的 MCP 客户端 - 高级示例
 *
 * 本示例演示底层 API：直接使用 x402MCPClient 进行手动配置。
 * 适用于以下场景：
 * - 自定义 x402Client 配置
 * - 通过 onPaymentRequired 钩子实现支付缓存
 * - 完全控制支付流程
 * - 与现有 MCP 客户端集成
 *
 * 运行方式：pnpm dev:advanced
 *
 * @author kuangyp
 * @version 2025-03-16
 */

import { config } from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { x402MCPClient } from "@x402/mcp";
import { x402Client } from "@x402/core/client";
import { privateKeyToAccount } from "viem/accounts";

// 加载 .env 环境变量
config();

// 从环境变量获取 EVM 私钥
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
if (!evmPrivateKey) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

// MCP 服务端地址
const serverUrl = process.env.MCP_SERVER_URL || "http://localhost:4022";

/**
 * 演示高级 API：手动组装 MCP 客户端、支付客户端及各类钩子
 *
 * @returns 演示完成后 resolve 的 Promise
 */
export async function main(): Promise<void> {
  console.log("\n📦 Using ADVANCED API (x402MCPClient with manual setup)\n");
  console.log("🔌 Connecting to MCP server at:", serverUrl);

  const evmSigner = privateKeyToAccount(evmPrivateKey);
  console.log("💳 Using wallet:", evmSigner.address);

  // ========================================================================
  // 高级模式：手动组装，获得完整控制权
  // ========================================================================

  // 步骤 1：手动创建 MCP 原生客户端
  const mcpClient = new Client(
    {
      name: "x402-mcp-client-advanced",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // 步骤 2：手动创建 x402 支付客户端并注册链
  const paymentClient = new x402Client();
  paymentClient.register("eip155:84532", new ExactEvmScheme(evmSigner));

  // 步骤 3：将 MCP 客户端与支付客户端组合为 x402MCPClient
  const x402Mcp = new x402MCPClient(mcpClient, paymentClient, {
    autoPayment: true,
    // 支付前回调：返回 true 表示批准支付
    onPaymentRequested: async context => {
      const price = context.paymentRequired.accepts[0];
      console.log(`\n💰 Payment required for tool: ${context.toolName}`);
      console.log(`   Amount: ${price.amount} (${price.asset})`);
      console.log(`   Network: ${price.network}`);
      console.log(`   Approving payment...\n`);
      return true;
    },
  });

  // ========================================================================
  // 高级模式：注册钩子用于可观测性与流程控制
  // ========================================================================

  // 钩子：收到 402 时调用（支付前）
  // 可返回自定义 payment 或 abort 中止流程
  x402Mcp.onPaymentRequired(async context => {
    console.log(`🔔 [Hook] Payment required received for: ${context.toolName}`);
    console.log(`   Options: ${context.paymentRequired.accepts.length} payment option(s)`);
    // 返回 void 继续正常支付流程
    // 返回 { payment: ... } 使用缓存的支付
    // 返回 { abort: true } 中止
  });

  // 钩子：创建支付前调用
  x402Mcp.onBeforePayment(async context => {
    console.log(`📝 [Hook] Creating payment for: ${context.toolName}`);
  });

  // 钩子：支付提交后调用
  x402Mcp.onAfterPayment(async context => {
    console.log(`✅ [Hook] Payment submitted for: ${context.toolName}`);
    if (context.settleResponse) {
      console.log(`   Transaction: ${context.settleResponse.transaction}`);
    }
  });

  // 建立连接
  const transport = new SSEClientTransport(new URL(`${serverUrl}/sse`));
  await x402Mcp.connect(transport);
  console.log("✅ Connected to MCP server");
  console.log("📊 Hooks enabled: onPaymentRequired, onBeforePayment, onAfterPayment\n");

  // 列出可用工具
  console.log("📋 Discovering available tools...");
  const tools = await x402Mcp.listTools();
  console.log("Available tools:");
  for (const tool of tools.tools) {
    console.log(`   - ${tool.name}: ${tool.description}`);
  }
  console.log();

  // 测试免费工具
  console.log("━".repeat(50));
  console.log("🆓 Test 1: Calling free tool (ping)");
  console.log("━".repeat(50));

  const pingResult = await x402Mcp.callTool("ping");
  console.log("Response:", pingResult.content[0]?.text);
  console.log("Payment made:", pingResult.paymentMade);
  console.log();

  // 测试付费工具
  console.log("━".repeat(50));
  console.log("💰 Test 2: Calling paid tool (get_weather)");
  console.log("━".repeat(50));

  const weatherResult = await x402Mcp.callTool("get_weather", { city: "San Francisco" });
  console.log("Response:", weatherResult.content[0]?.text);
  console.log("Payment made:", weatherResult.paymentMade);

  if (weatherResult.paymentResponse) {
    console.log("\n📦 Payment Receipt:");
    console.log("   Success:", weatherResult.paymentResponse.success);
    if (weatherResult.paymentResponse.transaction) {
      console.log("   Transaction:", weatherResult.paymentResponse.transaction);
    }
  }

  // 测试访问底层客户端实例
  console.log("\n━".repeat(50));
  console.log("🔧 Test 3: Accessing underlying clients");
  console.log("━".repeat(50));
  console.log("MCP Client:", x402Mcp.client.constructor.name);
  console.log("Payment Client:", x402Mcp.paymentClient.constructor.name);

  console.log("\n✅ Demo complete!");
  await x402Mcp.close();
  process.exit(0);
}
