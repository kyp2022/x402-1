/**
 * 🎣 x402 生命周期钩子系统详解
 * 
 * 本示例演示了 x402 协议的完整生命周期钩子系统，
 * 这是 Server 端最强大的功能之一，允许在支付流程的各个阶段
 * 插入自定义的业务逻辑、监控、风控和错误恢复机制。
 * 
 * 🔄 完整的支付生命周期：
 * 1. 客户端发起请求 → 服务器返回 402 Payment Required
 * 2. 客户端创建支付 → 发送支付载荷到服务器
 * 3. 【onBeforeVerify】→ 验证前钩子（可中止）
 * 4. 验证支付签名和余额
 * 5. 【onAfterVerify / onVerifyFailure】→ 验证后钩子
 * 6. 【onBeforeSettle】→ 结算前钩子（可中止）
 * 7. 执行链上交易
 * 8. 【onAfterSettle / onSettleFailure】→ 结算后钩子
 * 
 * 运行方式：pnpm dev:hooks
 * 
 * @author kuangyp
 * @version 2025-03-16
 */

import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

// 加载环境变量
config();

// ========================================================================
// 🔧 环境配置和验证
// ========================================================================

// 收款地址：接收支付的 EVM 地址
const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("❌ Missing EVM_ADDRESS environment variable");
  console.error("   Please set your wallet address to receive payments");
  process.exit(1);
}

// Facilitator 服务地址：处理支付验证和结算的服务
const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  console.error("   Please set the URL of your facilitator service");
  process.exit(1);
}

// 创建 Facilitator 客户端，用于与支付处理服务通信
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// ========================================================================
// 🎣 生命周期钩子系统配置
// ========================================================================

/**
 * 创建 x402 资源服务器并配置完整的生命周期钩子系统
 * 
 * 钩子执行顺序：
 * onBeforeVerify → verify → onAfterVerify/onVerifyFailure → 
 * onBeforeSettle → settle → onAfterSettle/onSettleFailure
 */
const resourceServer = new x402ResourceServer(facilitatorClient)
  // 🌐 注册支付方案：支持 Base Sepolia 网络的 EVM 支付
  .register("eip155:84532", new ExactEvmScheme())

  // ========================================================================
  // 🔍 验证阶段钩子
  // ========================================================================

  /**
   * 🔍 验证前钩子 (onBeforeVerify)
   * 
   * 📍 触发时机：收到支付载荷后，开始验证支付前
   * 🎯 主要用途：
   *   - 风控检查：IP 黑名单、地区限制、用户信誉
   *   - 业务验证：用户权限、账户状态、额度检查
   *   - 频率限制：防止恶意请求和滥用
   *   - 合规检查：AML、KYC、制裁名单
   * 
   * ⚠️  重要：可以通过返回 { abort: true, reason: string } 中止整个支付流程
   * 
   * @param context 验证上下文，包含支付信息、请求信息等
   */
  .onBeforeVerify(async context => {
    console.log("🔍 [Hook] Before verify - 支付验证前检查");
    console.log(`   💰 支付金额: ${context.requirements.amount}`);
    console.log(`   🌐 支付网络: ${context.requirements.network}`);
    console.log(`   👤 支付者: ${context.paymentPayload.signature.slice(0, 10)}...`);

    // 💡 实际应用示例：

    // 1. 风控检查
    const paymentAmount = BigInt(context.requirements.amount);
    if (paymentAmount > BigInt("10000")) { // 超过 $0.01
      console.log("   ❌ 支付金额过高，中止验证");
      return {
        abort: true,
        reason: "Payment amount exceeds limit"
      };
    }

    // 2. 频率限制检查（模拟）
    const now = Date.now();
    const lastPayment = getLastPaymentTime(context.paymentPayload.signature);
    if (lastPayment && (now - lastPayment) < 60000) { // 1分钟内重复支付
      console.log("   ⚠️  支付频率过高，建议稍后重试");
      // 注意：这里不中止，只是警告
    }

    // 3. IP 地理位置检查（模拟）
    const clientIP = context.request?.ip || "unknown";
    if (await isRestrictedRegion(clientIP)) {
      console.log("   🚫 地区限制，中止验证");
      return {
        abort: true,
        reason: "Service not available in your region"
      };
    }

    console.log("   ✅ 验证前检查通过");
  })

  /**
   * ✅ 验证成功钩子 (onAfterVerify)
   * 
   * 📍 触发时机：支付验证成功后，开始结算前
   * 🎯 主要用途：
   *   - 记录验证成功的支付
   *   - 更新用户积分或等级
   *   - 发送验证成功通知
   *   - 预处理业务逻辑
   * 
   * 💡 此时支付已验证有效，但尚未在链上执行
   * 
   * @param context 验证成功上下文
   */
  .onAfterVerify(async context => {
    console.log("✅ [Hook] After verify - 支付验证成功");
    console.log(`   🎯 验证结果: ${context.result.isValid ? '有效' : '无效'}`);
    console.log(`   ⏰ 验证时间: ${new Date().toISOString()}`);

    // 💡 实际应用示例：

    // 1. 记录支付验证日志
    await logPaymentVerification({
      paymentId: generatePaymentId(context.paymentPayload),
      amount: context.requirements.amount,
      network: context.requirements.network,
      payer: extractPayerAddress(context.paymentPayload),
      timestamp: new Date(),
      status: 'verified'
    });

    // 2. 更新用户统计
    const payerAddress = extractPayerAddress(context.paymentPayload);
    await updateUserStats(payerAddress, {
      totalPayments: 1,
      totalAmount: context.requirements.amount,
      lastPayment: new Date()
    });

    // 3. 发送实时通知（WebSocket、邮件等）
    await sendNotification(payerAddress, {
      type: 'payment_verified',
      amount: context.requirements.amount,
      service: 'weather_api'
    });

    console.log("   📊 用户数据已更新，通知已发送");
  })

  /**
   * ❌ 验证失败钩子 (onVerifyFailure)
   * 
   * 📍 触发时机：支付验证失败时
   * 🎯 主要用途：
   *   - 记录失败原因和统计
   *   - 智能错误恢复
   *   - 提供替代支付方案
   *   - 用户友好的错误处理
   * 
   * 🔄 重要：可以通过返回 { recovered: true, result: {...} } 从失败中恢复
   * 
   * @param context 验证失败上下文，包含错误信息
   */
  .onVerifyFailure(async context => {
    console.log("❌ [Hook] Verify failure - 支付验证失败");
    console.log(`   🚨 失败原因: ${context.error}`);
    console.log(`   🔍 错误详情: ${JSON.stringify(context.details)}`);

    // 💡 实际应用示例：

    // 1. 记录失败统计
    await logPaymentFailure({
      error: context.error,
      paymentPayload: context.paymentPayload,
      requirements: context.requirements,
      timestamp: new Date()
    });

    // 2. 智能错误恢复
    if (context.error.includes("insufficient balance")) {
      console.log("   💡 余额不足，尝试提供替代方案");

      // 可以提供更低价格的服务或积分支付
      const alternativePrice = BigInt(context.requirements.amount) / 2n;
      if (alternativePrice > 0) {
        console.log(`   🎁 提供优惠价格: ${alternativePrice}`);
        return {
          recovered: true,
          result: {
            isValid: true,
            alternativePayment: true,
            newAmount: alternativePrice.toString()
          }
        };
      }
    }

    // 3. 网络拥堵时的处理
    if (context.error.includes("network congestion")) {
      console.log("   🌐 网络拥堵，建议稍后重试");

      // 可以延迟处理或切换到其他网络
      return {
        recovered: true,
        result: {
          isValid: true,
          delayed: true,
          retryAfter: 30 // 30秒后重试
        }
      };
    }

    console.log("   ⚠️  无法自动恢复，支付验证失败");
  })

  // ========================================================================
  // 🏦 结算阶段钩子
  // ========================================================================

  /**
   * 🏦 结算前钩子 (onBeforeSettle)
   * 
   * 📍 触发时机：支付验证成功后，开始链上结算前
   * 🎯 主要用途：
   *   - 最终业务检查
   *   - Gas 费用检查
   *   - 网络状态检查
   *   - 结算条件验证
   * 
   * ⚠️  重要：可以通过返回 { abort: true, reason: string } 中止结算
   * 
   * @param context 结算前上下文
   */
  .onBeforeSettle(async context => {
    console.log("🏦 [Hook] Before settle - 链上结算前检查");
    console.log(`   ⛽ 准备执行链上交易`);
    console.log(`   💰 结算金额: ${context.requirements.amount}`);

    // 💡 实际应用示例：

    // 1. Gas 费用检查
    const currentGasPrice = await getCurrentGasPrice(context.requirements.network);
    const maxAcceptableGas = 50; // Gwei

    if (currentGasPrice > maxAcceptableGas) {
      console.log(`   ⛽ Gas 价格过高 (${currentGasPrice} Gwei)，暂停结算`);
      return {
        abort: true,
        reason: `Gas price too high: ${currentGasPrice} Gwei`
      };
    }

    // 2. 网络健康检查
    const networkStatus = await checkNetworkHealth(context.requirements.network);
    if (!networkStatus.healthy) {
      console.log("   🌐 网络状态异常，暂停结算");
      return {
        abort: true,
        reason: "Network is experiencing issues"
      };
    }

    // 3. 最终业务状态检查
    const serviceStatus = await checkServiceAvailability();
    if (!serviceStatus.available) {
      console.log("   🚫 服务暂时不可用，暂停结算");
      return {
        abort: true,
        reason: "Service temporarily unavailable"
      };
    }

    // 4. 预留资源（可选）
    await reserveServiceResources(context.paymentPayload);

    console.log("   ✅ 结算前检查通过，准备执行链上交易");
  })

  /**
   * 🎉 结算成功钩子 (onAfterSettle)
   * 
   * 📍 触发时机：链上结算成功后
   * 🎯 主要用途：
   *   - 完整的业务逻辑执行
   *   - 用户权限激活
   *   - 发送支付收据
   *   - 数据分析和统计
   *   - 触发下游服务
   * 
   * 💡 此时支付已完全完成，可以安全执行所有业务逻辑
   * 
   * @param context 结算成功上下文，包含交易哈希等信息
   */
  .onAfterSettle(async context => {
    console.log("🎉 [Hook] After settle - 支付结算成功");
    console.log(`   🔗 交易哈希: ${context.result.transaction}`);
    console.log(`   ⏰ 结算时间: ${new Date().toISOString()}`);
    console.log(`   💰 实际支付: ${context.requirements.amount}`);

    // 💡 实际应用示例：

    // 1. 记录完整的交易信息
    const transactionRecord = {
      transactionHash: context.result.transaction,
      paymentId: generatePaymentId(context.paymentPayload),
      amount: context.requirements.amount,
      network: context.requirements.network,
      payer: extractPayerAddress(context.paymentPayload),
      payee: context.requirements.payTo,
      timestamp: new Date(),
      status: 'completed'
    };
    await recordTransaction(transactionRecord);

    // 2. 激活用户服务权限
    const payerAddress = extractPayerAddress(context.paymentPayload);
    await activateServiceAccess(payerAddress, {
      service: 'weather_api',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24小时有效
      transactionHash: context.result.transaction
    });

    // 3. 发送支付收据
    await sendPaymentReceipt(payerAddress, {
      amount: context.requirements.amount,
      service: 'Weather API Access',
      transactionHash: context.result.transaction,
      receiptUrl: `https://basescan.org/tx/${context.result.transaction}`
    });

    // 4. 更新业务分析数据
    await updateAnalytics({
      event: 'payment_completed',
      amount: parseFloat(context.requirements.amount) / 1000000, // 转换为美元
      network: context.requirements.network,
      timestamp: new Date()
    });

    // 5. 触发下游业务流程
    await triggerDownstreamServices({
      event: 'payment_received',
      user: payerAddress,
      amount: context.requirements.amount,
      service: 'weather_api'
    });

    // 6. 发送实时通知
    await sendRealTimeNotification(payerAddress, {
      type: 'payment_success',
      message: 'Payment completed successfully! You now have access to Weather API.',
      transactionHash: context.result.transaction
    });

    console.log("   📊 所有业务逻辑执行完成");
  })

  /**
   * 🔄 结算失败钩子 (onSettleFailure)
   * 
   * 📍 触发时机：链上结算失败时
   * 🎯 主要用途：
   *   - 智能重试机制
   *   - 用户友好的错误处理
   *   - 替代结算方案
   *   - 失败原因分析
   * 
   * 🔄 重要：可以通过返回 { recovered: true, result: {...} } 提供替代方案
   * 
   * @param context 结算失败上下文，包含详细错误信息
   */
  .onSettleFailure(async context => {
    console.log("🔄 [Hook] Settle failure - 链上结算失败");
    console.log(`   🚨 失败原因: ${context.error}`);
    console.log(`   🔍 错误详情: ${JSON.stringify(context.details)}`);

    // 💡 实际应用示例：

    // 1. 记录结算失败
    await logSettlementFailure({
      error: context.error,
      paymentPayload: context.paymentPayload,
      requirements: context.requirements,
      timestamp: new Date(),
      attemptCount: context.attemptCount || 1
    });

    // 2. 网络拥堵的智能重试
    if (context.error.includes("network congestion") ||
      context.error.includes("gas price too low")) {

      console.log("   🔄 网络拥堵，安排延迟重试");

      // 延迟重试机制
      const retryDelay = Math.min(30000 * (context.attemptCount || 1), 300000); // 最多5分钟
      setTimeout(async () => {
        try {
          const retryResult = await retrySettlement(context);
          if (retryResult.success) {
            console.log("   ✅ 延迟重试成功");
            // 触发成功后的业务逻辑
            await executePostSettlementLogic(context, retryResult);
          }
        } catch (retryError) {
          console.log("   ❌ 重试仍然失败:", retryError);
        }
      }, retryDelay);

      return {
        recovered: true,
        result: {
          success: true,
          transaction: "pending_retry",
          delayed: true,
          retryAfter: retryDelay
        }
      };
    }

    // 3. Gas 费用不足的处理
    if (context.error.includes("insufficient funds for gas")) {
      console.log("   ⛽ Gas 费用不足，尝试 Gas 代付");

      // 可以实现 Gas 代付机制
      const gasSponsorship = await attemptGasSponsorship(context);
      if (gasSponsorship.success) {
        return {
          recovered: true,
          result: {
            success: true,
            transaction: gasSponsorship.transactionHash,
            gasSponsored: true
          }
        };
      }
    }

    // 4. 提供替代补偿方案
    if (context.error.includes("transaction failed")) {
      console.log("   🎁 交易失败，提供服务积分作为补偿");

      const payerAddress = extractPayerAddress(context.paymentPayload);
      await grantServiceCredits(payerAddress, {
        amount: context.requirements.amount,
        reason: 'settlement_failure_compensation',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7天有效
      });

      return {
        recovered: true,
        result: {
          success: true,
          transaction: "credit_compensation",
          compensated: true
        }
      };
    }

    console.log("   ❌ 无法自动恢复，结算最终失败");

    // 5. 发送失败通知
    const payerAddress = extractPayerAddress(context.paymentPayload);
    await sendFailureNotification(payerAddress, {
      error: context.error,
      amount: context.requirements.amount,
      supportContact: 'support@example.com'
    });
  });

// ========================================================================
// 🌐 Express 应用配置
// ========================================================================

const app = express();

// 配置 x402 支付中间件
app.use(
  paymentMiddleware(
    {
      // 定义付费端点
      "GET /weather": {
        accepts: {
          scheme: "exact",           // 精确支付方案
          price: "$0.001",          // 价格：0.001 美元
          network: "eip155:84532",  // Base Sepolia 测试网
          payTo: evmAddress,        // 收款地址
        },
        description: "Real-time weather data with payment hooks demonstration",
        mimeType: "application/json",
      },
    },
    resourceServer, // 使用配置了钩子的资源服务器
  ),
);

// 实际的业务端点
app.get("/weather", (req, res) => {
  // 💡 当请求到达这里时，支付已经完全完成
  // 所有的钩子都已执行，可以安全地提供服务

  console.log("🌤️  提供天气数据服务");

  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
      humidity: 45,
      windSpeed: 12,
      location: "San Francisco",
      timestamp: new Date().toISOString(),
      // 💡 可以根据支付信息提供个性化服务
      premium: req.headers['x-payment-tier'] === 'premium'
    },
    meta: {
      service: "Weather API with Payment Hooks",
      paymentProcessed: true,
      hooksExecuted: [
        "onBeforeVerify", "onAfterVerify",
        "onBeforeSettle", "onAfterSettle"
      ]
    }
  });
});

// 健康检查端点
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Weather API with Payment Hooks",
    hooks: "enabled",
    timestamp: new Date().toISOString()
  });
});

// 启动服务器
app.listen(4021, () => {
  console.log(`\n🚀 x402 Hooks Server listening at http://localhost:4021`);
  console.log(`💳 Receiving payments at: ${evmAddress}`);
  console.log(`🎣 Payment hooks: ENABLED`);
  console.log(`\n📋 Available endpoints:`);
  console.log(`   GET /weather  - 付费天气数据 ($0.001)`);
  console.log(`   GET /health   - 健康检查 (免费)`);
  console.log(`\n💡 Test with: curl http://localhost:4021/weather`);
  console.log(`   First request will return 402 Payment Required`);
  console.log(`   Use x402 client to make payment and retry`);
  console.log(`\n🔍 Watch console for detailed hook execution logs\n`);
});

// ========================================================================
// 🛠 辅助函数实现（模拟）
// ========================================================================

/**
 * 模拟函数：获取用户最后支付时间
 */
function getLastPaymentTime(signature: string): number | null {
  // 实际实现中应该查询数据库
  return null;
}

/**
 * 模拟函数：检查是否为受限地区
 */
async function isRestrictedRegion(ip: string): Promise<boolean> {
  // 实际实现中应该调用地理位置 API
  return false;
}

/**
 * 模拟函数：记录支付验证日志
 */
async function logPaymentVerification(data: any): Promise<void> {
  console.log("   📝 记录支付验证:", data);
}

/**
 * 模拟函数：更新用户统计
 */
async function updateUserStats(address: string, stats: any): Promise<void> {
  console.log(`   📊 更新用户统计 ${address}:`, stats);
}

/**
 * 模拟函数：发送通知
 */
async function sendNotification(address: string, notification: any): Promise<void> {
  console.log(`   📨 发送通知给 ${address}:`, notification);
}

/**
 * 模拟函数：记录支付失败
 */
async function logPaymentFailure(data: any): Promise<void> {
  console.log("   📝 记录支付失败:", data);
}

/**
 * 模拟函数：获取当前 Gas 价格
 */
async function getCurrentGasPrice(network: string): Promise<number> {
  // 实际实现中应该调用区块链 API
  return 20; // 模拟 20 Gwei
}

/**
 * 模拟函数：检查网络健康状态
 */
async function checkNetworkHealth(network: string): Promise<{ healthy: boolean }> {
  // 实际实现中应该检查区块链网络状态
  return { healthy: true };
}

/**
 * 模拟函数：检查服务可用性
 */
async function checkServiceAvailability(): Promise<{ available: boolean }> {
  // 实际实现中应该检查服务状态
  return { available: true };
}

/**
 * 模拟函数：预留服务资源
 */
async function reserveServiceResources(paymentPayload: any): Promise<void> {
  console.log("   🔒 预留服务资源");
}

/**
 * 模拟函数：生成支付 ID
 */
function generatePaymentId(paymentPayload: any): string {
  return `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 模拟函数：提取支付者地址
 */
function extractPayerAddress(paymentPayload: any): string {
  // 实际实现中应该从签名中恢复地址
  return "0x" + paymentPayload.signature.slice(2, 42);
}

/**
 * 模拟函数：记录交易
 */
async function recordTransaction(record: any): Promise<void> {
  console.log("   💾 记录交易:", record);
}

/**
 * 模拟函数：激活服务访问权限
 */
async function activateServiceAccess(address: string, access: any): Promise<void> {
  console.log(`   🔓 激活服务访问 ${address}:`, access);
}

/**
 * 模拟函数：发送支付收据
 */
async function sendPaymentReceipt(address: string, receipt: any): Promise<void> {
  console.log(`   🧾 发送收据给 ${address}:`, receipt);
}

/**
 * 模拟函数：更新分析数据
 */
async function updateAnalytics(data: any): Promise<void> {
  console.log("   📈 更新分析数据:", data);
}

/**
 * 模拟函数：触发下游服务
 */
async function triggerDownstreamServices(event: any): Promise<void> {
  console.log("   🔗 触发下游服务:", event);
}

/**
 * 模拟函数：发送实时通知
 */
async function sendRealTimeNotification(address: string, notification: any): Promise<void> {
  console.log(`   ⚡ 实时通知 ${address}:`, notification);
}

/**
 * 模拟函数：记录结算失败
 */
async function logSettlementFailure(data: any): Promise<void> {
  console.log("   📝 记录结算失败:", data);
}

/**
 * 模拟函数：重试结算
 */
async function retrySettlement(context: any): Promise<{ success: boolean; transactionHash?: string }> {
  // 实际实现中应该重新尝试链上结算
  return { success: true, transactionHash: "0x" + Math.random().toString(16).slice(2) };
}

/**
 * 模拟函数：执行结算后业务逻辑
 */
async function executePostSettlementLogic(context: any, result: any): Promise<void> {
  console.log("   🎯 执行结算后业务逻辑");
}

/**
 * 模拟函数：尝试 Gas 代付
 */
async function attemptGasSponsorship(context: any): Promise<{ success: boolean; transactionHash?: string }> {
  // 实际实现中应该实现 Gas 代付逻辑
  return { success: false };
}

/**
 * 模拟函数：授予服务积分
 */
async function grantServiceCredits(address: string, credits: any): Promise<void> {
  console.log(`   🎁 授予积分给 ${address}:`, credits);
}

/**
 * 模拟函数：发送失败通知
 */
async function sendFailureNotification(address: string, notification: any): Promise<void> {
  console.log(`   📨 发送失败通知给 ${address}:`, notification);
}