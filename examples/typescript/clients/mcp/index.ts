/**
 * MCP 客户端示例入口文件
 *
 * 根据命令行参数路由到 simple 或 advanced 示例。
 *
 * 使用方式：
 *   pnpm dev           - 运行简单示例（使用 createx402MCPClient 工厂函数）
 *   pnpm dev:advanced  - 运行高级示例（使用 x402MCPClient 手动配置）
 *
 * @author kuangyp
 * @version 2025-03-16
 */

// 从命令行参数获取运行模式，默认为 "simple"
const mode = process.argv[2] || "simple";

/**
 * 根据选定的模式运行对应的 MCP 客户端示例
 *
 * @returns 示例执行完成后 resolve 的 Promise
 */
async function run(): Promise<void> {
  if (mode === "advanced") {
    // 动态导入高级示例模块并执行
    const { main } = await import("./advanced.js");
    await main();
  } else {
    // 动态导入简单示例模块并执行（默认）
    const { main } = await import("./simple.js");
    await main();
  }
}

// 执行示例，捕获未处理的异常并退出
run().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
