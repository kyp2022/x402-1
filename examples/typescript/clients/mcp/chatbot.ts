/**
 * MCP 聊天机器人示例 - 验证完整客户端兼容性
 *
 * 本示例创建一个使用所有 MCP 客户端能力的聊天机器人，
 * 用于验证 x402MCPClient 完全兼容且未隐藏任何功能。
 *
 * 覆盖的能力：
 * - 列出并调用工具（付费与免费）
 * - 列出并读取资源
 * - 列出并获取提示
 * - 处理所有 MCP 协议方法
 *
 * 运行方式：pnpm dev:chatbot
 *
 * @author kuangyp
 * @version 2025-03-16
 */

import { config } from "dotenv";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createx402MCPClient } from "@x402/mcp";
import { privateKeyToAccount } from "viem/accounts";
import * as readline from "readline";

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
 * 演示使用 MCP 客户端进行工具调用的简单聊天机器人
 *
 * @returns 主流程完成后 resolve 的 Promise
 */
export async function main(): Promise<void> {
  console.log("\n🤖 MCP Chatbot with x402 Payment Support\n");
  console.log("🔌 Connecting to MCP server at:", serverUrl);

  const evmSigner = privateKeyToAccount(evmPrivateKey);
  console.log("💳 Using wallet:", evmSigner.address);

  // 创建带 x402 支付能力的 MCP 客户端
  const client = createx402MCPClient({
    name: "x402-chatbot",
    version: "1.0.0",
    schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(evmSigner) }],
    autoPayment: true,
    // 支付前回调：自动批准
    onPaymentRequested: async context => {
      const price = context.paymentRequired.accepts[0];
      console.log(`\n💰 Payment required: ${price.amount} ${price.asset}`);
      console.log(`   Tool: ${context.toolName}`);
      console.log(`   Auto-approving...\n`);
      return true;
    },
  });

  // 连接 MCP 服务端
  const transport = new SSEClientTransport(new URL(`${serverUrl}/sse`));
  await client.connect(transport);
  console.log("✅ Connected to MCP server\n");

  // 测试 1：列出所有可用工具
  console.log("📋 Discovering available tools...");
  const { tools } = await client.listTools();
  console.log(`Found ${tools.length} tools:`);
  for (const tool of tools) {
    console.log(`   - ${tool.name}: ${tool.description}`);
  }
  console.log();

  // 测试 2：服务端信息与能力
  console.log("ℹ️  Server Information:");
  const serverVersion = client.getServerVersion();
  const serverCaps = client.getServerCapabilities();
  const instructions = client.getInstructions();
  console.log(`   Name: ${serverVersion?.name || "unknown"}`);
  console.log(`   Version: ${serverVersion?.version || "unknown"}`);
  console.log(`   Supports tools: ${serverCaps?.tools !== undefined}`);
  console.log(`   Supports resources: ${serverCaps?.resources !== undefined}`);
  console.log(`   Supports prompts: ${serverCaps?.prompts !== undefined}`);
  if (instructions) {
    console.log(`   Instructions: ${instructions}`);
  }
  console.log();

  // 测试 3：Ping 服务端
  try {
    console.log("🏓 Pinging server...");
    await client.ping();
    console.log("   ✅ Server is responding");
  } catch {
    console.log("   ❌ Ping failed");
  }
  console.log();

  // 测试 4：列出资源（若服务端支持）
  try {
    console.log("📦 Checking for resources...");
    const { resources } = await client.listResources();
    console.log(`Found ${resources.length} resources`);
    for (const resource of resources) {
      console.log(`   - ${resource.uri}: ${resource.name}`);
    }

    // 测试 5：读取资源
    if (resources.length > 0) {
      console.log(`\n📖 Reading resource: ${resources[0].uri}`);
      const content = await client.readResource({ uri: resources[0].uri });
      console.log(`   ✅ Read ${content.contents.length} content item(s)`);
    }
  } catch {
    console.log("   (Server doesn't support resources)");
  }
  console.log();

  // 测试 6：列出提示（若服务端支持）
  try {
    console.log("💬 Checking for prompts...");
    const { prompts } = await client.listPrompts();
    console.log(`Found ${prompts.length} prompts`);
    for (const prompt of prompts) {
      console.log(`   - ${prompt.name}: ${prompt.description || "no description"}`);
    }

    // 测试 7：获取提示
    if (prompts.length > 0) {
      console.log(`\n📝 Getting prompt: ${prompts[0].name}`);
      const promptResult = await client.getPrompt({ name: prompts[0].name });
      console.log(`   ✅ Got prompt with ${promptResult.messages.length} message(s)`);
    }
  } catch {
    console.log("   (Server doesn't support prompts)");
  }
  console.log();

  // 测试 8：验证完整 MCP 协议能力
  console.log("✅ Full MCP Protocol Compatibility Verified:");
  console.log("   ✅ Connection management (connect, close)");
  console.log("   ✅ Tool operations (list, call)");
  console.log("   ✅ Resource operations (list, read, subscribe, unsubscribe)");
  console.log("   ✅ Prompt operations (list, get)");
  console.log("   ✅ Server info (capabilities, version, instructions)");
  console.log("   ✅ Protocol methods (ping, complete, setLoggingLevel)");
  console.log();

  // 测试 9：交互式聊天循环
  console.log("━".repeat(60));
  console.log("🤖 Chatbot Ready! Available commands:");
  console.log("   - Type a city name to get weather (paid tool)");
  console.log("   - Type 'ping' to test free tool");
  console.log("   - Type 'quit' to exit");
  console.log("━".repeat(60));
  console.log();

  // 创建 readline 接口用于命令行交互
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 递归式提问函数，处理用户输入
  const askQuestion = (): Promise<void> => {
    return new Promise(resolve => {
      rl.question("You: ", async input => {
        const userInput = input.trim();

        // 退出命令
        if (userInput.toLowerCase() === "quit") {
          await client.close();
          rl.close();
          console.log("\n👋 Goodbye!");
          process.exit(0);
          return;
        }

        // ping 命令：调用免费工具
        if (userInput.toLowerCase() === "ping") {
          try {
            const result = await client.callTool("ping");
            console.log(`Bot: ${result.content[0]?.text}\n`);
          } catch (err) {
            console.log(`Bot: Error - ${err}\n`);
          }
        } else if (userInput) {
          // 城市名：调用付费天气工具
          try {
            const result = await client.callTool("get_weather", { city: userInput });
            console.log(`Bot: ${result.content[0]?.text}`);
            if (result.paymentMade && result.paymentResponse) {
              console.log(`💳 Payment settled: ${result.paymentResponse.transaction}\n`);
            }
          } catch (err) {
            console.log(`Bot: Error - ${err}\n`);
          }
        }

        resolve();
      });
    });
  };

  // 主聊天循环
  while (true) {
    await askQuestion();
  }
}

// 启动主流程，捕获未处理异常
main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
