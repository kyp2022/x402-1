/**
 * 带 x402 支付支持的 MCP 客户端 - 简单示例
 *
 * 本示例演示推荐的创建方式：使用高层级 createx402MCPClient 工厂函数。
 * 适合快速集成、开箱即用的场景。
 *
 * 运行方式：pnpm dev
 *
 * @author kuangyp
 * @version 2025-03-16
 */

import { config } from "dotenv";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createx402MCPClient } from "@x402/mcp";
import { privateKeyToAccount } from "viem/accounts";

// 加载 .env 环境变量
config();

// 从环境变量获取 EVM 私钥，用于链上签名支付
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
if (!evmPrivateKey) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

// MCP 服务端地址，默认连接本地 4022 端口
const serverUrl = process.env.MCP_SERVER_URL || "http://localhost:4022";

/**
 * 使用 createx402MCPClient 工厂函数演示简单 API
 *
 * @returns 演示完成后 resolve 的 Promise
 */
export async function main(): Promise<void> {
  console.log("\n📦 Using SIMPLE API (createx402MCPClient factory)\n");
  console.log("🔌 Connecting to MCP server at:", serverUrl);

  // 从私钥创建 viem 账户，用于 ExactEvmScheme 签名
  const evmSigner = privateKeyToAccount(evmPrivateKey);
  console.log("💳 Using wallet:", evmSigner.address);

  // ========================================================================
  // 简单模式：使用工厂函数一行完成配置
  // ========================================================================
  const x402Mcp = createx402MCPClient({
    name: "x402-mcp-client-demo",
    version: "1.0.0",
    // 注册 Base Sepolia 链的 Exact 支付方案
    schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(evmSigner) }],
    // 收到 402 时自动发起支付
    autoPayment: true,
    // 支付前回调：可在此做确认、日志等，返回 true 表示批准支付
    onPaymentRequested: async context => {
      const price = context.paymentRequired.accepts[0];
      console.log(`\n💰 Payment required for tool: ${context.toolName}`);
      console.log(`   Amount: ${price.amount} (${price.asset})`);
      console.log(`   Network: ${price.network}`);
      console.log(`   Approving payment...\n`);
      return true;
    },
  });

  // 使用 SSE 传输层连接 MCP 服务端
  const transport = new SSEClientTransport(new URL(`${serverUrl}/sse`));
  await x402Mcp.connect(transport);
  console.log("✅ Connected to MCP server\n");

  // 列出服务端提供的工具
  console.log("📋 Discovering available tools...");
  const tools = await x402Mcp.listTools();
  console.log("Available tools:");
  for (const tool of tools.tools) {
    console.log(`   - ${tool.name}: ${tool.description}`);
  }
  console.log();

  // 测试免费工具（无需支付）
  console.log("━".repeat(50));
  console.log("🆓 Test 1: Calling free tool (ping)");
  console.log("━".repeat(50));

  const pingResult = await x402Mcp.callTool("ping");
  console.log("Response:", pingResult.content[0]?.text);
  console.log("Payment made:", pingResult.paymentMade);
  console.log();

  // 测试付费工具（会触发 402 支付流程）
  console.log("━".repeat(50));
  console.log("💰 Test 2: Calling paid tool (get_weather)");
  console.log("━".repeat(50));

  const weatherResult = await x402Mcp.callTool("get_weather", { city: "San Francisco" });
  console.log("Response:", weatherResult.content[0]?.text);
  console.log("Payment made:", weatherResult.paymentMade);

  // 若有支付响应，打印支付凭证
  if (weatherResult.paymentResponse) {
    console.log("\n📦 Payment Receipt:");
    console.log("   Success:", weatherResult.paymentResponse.success);
    if (weatherResult.paymentResponse.transaction) {
      console.log("   Transaction:", weatherResult.paymentResponse.transaction);
    }
  }

  console.log("\n✅ Demo complete!");
  await x402Mcp.close();
  process.exit(0);
}
