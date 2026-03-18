/**
 * OpenAI 聊天机器人 + MCP 工具集成示例
 *
 * 本示例演示一个真实可用的聊天机器人，结合：
 * - OpenAI GPT 作为大语言模型
 * - MCP 客户端进行工具发现与执行
 * - x402 处理付费工具支付
 *
 * 展示实际使用中会用到的 MCP 客户端方法。
 *
 * 配置步骤：
 * 1. 在 .env 中设置 OPENAI_API_KEY
 * 2. 在 .env 中设置 EVM_PRIVATE_KEY
 * 3. 启动 MCP 服务端：cd ../servers/mcp && pnpm dev
 * 4. 运行：pnpm dev:openai-chatbot
 *
 * @author kuangyp
 * @version 2025-03-16
 */

import { config } from "dotenv";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createx402MCPClient } from "@x402/mcp";
import { privateKeyToAccount } from "viem/accounts";
import OpenAI from "openai";
import * as readline from "readline";

// 加载 .env 环境变量
config();

// OpenAI API 密钥
const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) {
  console.error("❌ OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

// EVM 私钥，用于 x402 支付
const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
if (!evmPrivateKey) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

// MCP 服务端地址
const serverUrl = process.env.MCP_SERVER_URL || "http://localhost:4022";

/**
 * 主聊天机器人实现，展示真实 MCP 客户端用法
 *
 * @returns 主流程完成后 resolve 的 Promise
 */
export async function main(): Promise<void> {
  console.log("\n🤖 OpenAI Chatbot with MCP Tools + x402 Payment\n");
  console.log("━".repeat(60));

  // ========================================================================
  // 步骤 1：创建 OpenAI 客户端（大语言模型）
  // ========================================================================
  const openai = new OpenAI({ apiKey: openaiKey });
  console.log("✅ OpenAI client initialized");

  // ========================================================================
  // 步骤 2：创建 MCP 客户端（连接工具服务端）
  // ========================================================================
  const evmSigner = privateKeyToAccount(evmPrivateKey);
  console.log(`💳 Using wallet: ${evmSigner.address}`);

  const mcpClient = createx402MCPClient({
    name: "openai-chatbot",
    version: "1.0.0",
    schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(evmSigner) }],
    autoPayment: true,
    // 支付前回调：自动批准
    onPaymentRequested: async context => {
      const price = context.paymentRequired.accepts[0];
      console.log(`\n💰 Payment requested: ${price.amount} ${price.asset}`);
      console.log(`   Tool: ${context.toolName}`);
      console.log(`   Auto-approving payment...\n`);
      return true;
    },
  });

  // ========================================================================
  // MCP 客户端接触点 #1：connect() 建立连接
  // ========================================================================
  const transport = new SSEClientTransport(new URL(`${serverUrl}/sse`));
  await mcpClient.connect(transport);
  console.log(`✅ Connected to MCP server at ${serverUrl}`);

  // ========================================================================
  // MCP 客户端接触点 #2：listTools() 从 MCP 服务端发现工具，供 LLM 使用
  // ========================================================================
  console.log("\n📋 Discovering MCP tools...");
  const { tools } = await mcpClient.listTools();
  console.log(`Found ${tools.length} tools:`);
  for (const tool of tools) {
    console.log(`   - ${tool.name}: ${tool.description}`);
  }

  // 将 MCP 工具格式转换为 OpenAI 工具格式
  const openaiTools: OpenAI.ChatCompletionTool[] = tools.map(tool => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }));

  console.log(`\n✅ Converted ${openaiTools.length} MCP tools to OpenAI format`);
  console.log("━".repeat(60));

  // ========================================================================
  // 步骤 3：交互式聊天循环
  // ========================================================================
  const conversationHistory: OpenAI.ChatCompletionMessageParam[] = [];

  // readline 接口用于命令行输入
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n🤖 Chatbot Ready! Try:");
  console.log("   - 'What's the weather in San Francisco?'");
  console.log("   - 'Can you ping the server?'");
  console.log("   - 'quit' to exit\n");

  // 递归式提问函数
  const askQuestion = (): Promise<void> => {
    return new Promise(resolve => {
      rl.question("You: ", async input => {
        const userInput = input.trim();

        // 退出命令
        if (userInput.toLowerCase() === "quit") {
          await mcpClient.close();
          rl.close();
          console.log("\n👋 Goodbye!");
          process.exit(0);
          return;
        }

        if (!userInput) {
          resolve();
          return;
        }

        // 将用户消息加入对话历史
        conversationHistory.push({
          role: "user",
          content: userInput,
        });

        try {
          // ====================================================================
          // 调用 OpenAI，传入 MCP 工具定义
          // LLM 在此决定是否使用工具
          // ====================================================================
          let response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: conversationHistory,
            tools: openaiTools,
            tool_choice: "auto", // Let LLM decide
          });

          let assistantMessage = response.choices[0].message;
          conversationHistory.push(assistantMessage);

          // ====================================================================
          // 处理工具调用（若 LLM 请求了工具）
          // ====================================================================
          while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
            console.log(`\n🔧 LLM is calling ${assistantMessage.tool_calls.length} tool(s)...\n`);

            // 通过 MCP 客户端执行每个工具调用
            const toolResults: OpenAI.ChatCompletionToolMessageParam[] = [];

            for (const toolCall of assistantMessage.tool_calls) {
              console.log(`   Executing: ${toolCall.function.name}`);
              console.log(`   Arguments: ${toolCall.function.arguments}`);

              try {
                const args = JSON.parse(toolCall.function.arguments);

                // ====================================================================
                // MCP 客户端接触点 #3：callTool() 执行工具（含支付逻辑）
                // ====================================================================
                const mcpResult = await mcpClient.callTool(toolCall.function.name, args);

                // 若有支付，打印支付信息
                if (mcpResult.paymentMade && mcpResult.paymentResponse) {
                  console.log(`   💳 Payment: ${mcpResult.paymentResponse.transaction}`);
                }

                console.log(`   ✅ Result: ${mcpResult.content[0]?.text?.substring(0, 100)}...\n`);

                // 将工具执行结果回传给 OpenAI
                toolResults.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content:
                    mcpResult.content[0]?.text ||
                    JSON.stringify(mcpResult.content[0]) ||
                    "No content",
                });
              } catch (error) {
                console.log(`   ❌ Error: ${error}\n`);
                toolResults.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: `Error: ${error}`,
                });
              }
            }

            // 将工具结果加入对话历史
            conversationHistory.push(...toolResults);

            // 获取 LLM 在工具执行后的最终回复
            response = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: conversationHistory,
              tools: openaiTools,
            });

            assistantMessage = response.choices[0].message;
            conversationHistory.push(assistantMessage);
          }

          // ====================================================================
          // 展示最终回复
          // ====================================================================
          if (assistantMessage.content) {
            console.log(`Bot: ${assistantMessage.content}\n`);
          }
        } catch (error) {
          console.log(`Bot: Error - ${error}\n`);
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
