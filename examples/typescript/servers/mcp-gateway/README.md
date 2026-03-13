# x402 MCP Gateway

`x402 MCP Gateway` 是一个面向生产的 MCP 网关组件，不是临时示例。  
它的职责是：**为上游 Agent 提供统一 MCP 入口，并在网关侧完成下游收费能力的支付闭环与治理。**

---

## 为什么需要这个工具

很多团队第一反应是“让客户端（如 Cursor）直接连收费 MCP 并自己支付”。  
这条路在工程上通常不可控，原因不只是“不能改 Cursor 代码”，还包括：

- 客户端能力不一致，不同 Agent 的支付实现差异大
- 多个下游收费服务接入后，调用链和错误处理难统一
- 密钥、预算、审计分散在客户端，不利于安全和合规
- 一旦供应商更换，所有客户端都要改，维护成本高

Gateway 的产品价值是把这些问题收敛到服务端：

- 上游只接一个 MCP endpoint
- 支付能力在网关侧统一实现
- 下游可以是多个收费/免费服务，统一路由与治理

> 即使未来某些客户端支持原生支付，网关层仍然有统一治理和运维价值。

---

## 工具定位

`x402 MCP Gateway` 是一个 **Payment + Routing + Governance** 中间层：

- **Payment**：遇到下游 402 自动支付并重试
- **Routing**：统一转发到一个或多个下游 MCP 服务
- **Governance**：统一日志、故障处理、后续策略扩展（预算/白名单/限额）

---

## 核心能力

当前版本已实现：

- 多下游服务注册（单个或多个 endpoint）
- 统一网关工具调用下游工具
- x402 自动支付重试（网关钱包代付）
- 双 transport 支持：
  - Streamable HTTP
  - SSE
- 自动 transport 策略：
  - `auto` 模式下先尝试 Streamable HTTP
  - 失败后回退 SSE
- 服务发现工具（列出当前下游服务与其工具）

当前版本刻意不包含：

- 支付策略校验（网络白名单、资产白名单、金额上限）

---

## 架构

```text
Cursor / Any Agent
        |
        v
x402 MCP Gateway
  - list_gateway_services
  - call_service_tool
  - pay on 402 + retry
        |
        v
Downstream MCP Services
  - paid tools / free tools
```

---

## 对外工具

### 1) `list_gateway_services`

返回已连接的下游服务信息：

- `serviceId`
- `url`
- `transport`（最终连接成功使用的 transport）
- `tools`

### 2) `call_service_tool`

通过网关调用下游工具：

- 输入：
  - `serviceId`（可选，默认 `service-1`）
  - `toolName`（必填）
  - `args`（可选）
- 输出：
  - `paymentMade`
  - `paymentResponse`
  - `content`

---

## 环境变量

在 `./.env` 配置：

```bash
EVM_PRIVATE_KEY=0x...
DOWNSTREAM_MCP_URLS=http://localhost:4022/sse,https://vendor.example/mcp
DOWNSTREAM_MCP_TRANSPORT=auto
PORT=4023
```

字段说明：

- `EVM_PRIVATE_KEY`：网关钱包私钥（用于支付）
- `DOWNSTREAM_MCP_URLS`：多个下游地址（逗号分隔）
- `DOWNSTREAM_MCP_URL`：单下游地址（当未配置 `URLS` 时使用）
- `DOWNSTREAM_MCP_TRANSPORT`：
  - `auto`（默认，先 Streamable HTTP 再 SSE）
  - `streamable-http`
  - `sse`
- `DOWNSTREAM_CONNECT_RETRIES`：连接下游的重试次数（默认 `3`，范围 `1-10`）
- `PORT`：网关端口（默认 `4023`）

---

## 使用方式

### 1) 安装依赖

```bash
cd /Users/ppg/Desktop/agentry/x402/examples/typescript
pnpm install --no-frozen-lockfile
```

### 2) 启动一个下游 MCP（例如 `servers/mcp`）

```bash
cd /Users/ppg/Desktop/agentry/x402/examples/typescript/servers/mcp
cp .env-local .env
pnpm dev
```

### 3) 启动网关

```bash
cd /Users/ppg/Desktop/agentry/x402/examples/typescript/servers/mcp-gateway
cp .env-local .env
# 填写 EVM_PRIVATE_KEY 与下游地址
pnpm dev
```

网关地址：

- `http://localhost:4023/sse`

### 4) 上游接入

让 Cursor/Agent 连接网关 endpoint，而不是直接连所有下游：

- MCP Endpoint: `http://localhost:4023/sse`

---

## 多下游接入

示例：

```bash
DOWNSTREAM_MCP_URLS=http://localhost:4022/sse,https://vendor-a.example/mcp,https://vendor-b.example/sse
```

网关会分配：

- `service-1`
- `service-2`
- `service-3`

调用时通过 `serviceId` 指定目标下游。

---

## 常见问题

### `tsx: command not found`

说明依赖未安装，请先在 `examples/typescript` 根目录执行 `pnpm install --no-frozen-lockfile`。

### 启动时报 `ECONNRESET` / `SSE error`

通常是下游地址不可达或 transport 不匹配：

- 先确认下游服务可访问
- 使用 `DOWNSTREAM_MCP_TRANSPORT=auto`
- 先用本地下游验证（如 `http://localhost:4022/sse`）

### 如何确认网关已连上多个下游

调用 `list_gateway_services`，检查每个服务的 `url`、`transport`、`tools`。

---

## 生产化建议（下一步）

- 增加支付策略层（网络/资产/金额/预算）
- 增加审计日志与 requestId 追踪
- 增加下游级别熔断与重试策略
- 增加 per-service transport 与认证配置

---

## 安全说明

- 私钥请使用测试或低权限钱包
- 不要提交真实私钥到仓库
- 发生泄露时立即轮换私钥

# x402 MCP Gateway（代理 MCP）示例

本示例实现了一个 **Gateway MCP Server**：  
对上游（如 Cursor）暴露统一 MCP 工具，对下游（一个或多个 MCP 服务）进行转发调用；当下游返回 x402 支付挑战时，由网关钱包自动支付并重试。

---

## 1. 背景与作用

在实际接入中，经常会遇到这类场景：

- 上游 Agent（如 Cursor）可以调用 MCP 工具，但不便直接集成钱包支付逻辑
- 下游服务是收费 MCP（返回 402 Payment Required）
- 需要统一治理支付行为（例如后续加预算、审计、路由、限流）

`mcp-gateway` 的作用就是把这些复杂性收敛到网关层：

- 上游只连一个网关 MCP
- 网关负责转发和支付闭环
- 下游可以是多个服务，统一接入与管理

---

## 2. 功能说明

当前版本已实现：

- **多下游注册**：支持一个或多个下游 MCP endpoint
- **转发调用**：通过网关工具调用指定下游工具
- **自动支付重试**：下游返回 402 时自动支付并重试
- **双 transport 支持**：
  - Streamable HTTP
  - SSE
- **自动 transport 选择（auto）**：
  - 先尝试 Streamable HTTP
  - 失败后自动回退到 SSE
- **服务发现工具**：列出当前下游服务及可用工具

> 注意：本示例按你的要求，**不包含支付 policy 校验**（如网络白名单、资产白名单、金额上限）。

---

## 3. 架构概览

```text
Cursor / Agent
      |
      v
Gateway MCP (this project)
  - list_gateway_services
  - call_service_tool
  - auto pay on 402
      |
      v
Downstream MCP Service(s)
  - paid/free tools
```

---

## 4. 对外工具

### 4.1 `list_gateway_services`

列出网关当前已连接的下游服务：

- `serviceId`
- `url`
- `transport`（最终选用的 transport）
- `tools`（下游工具列表）

### 4.2 `call_service_tool`

调用下游工具（经网关转发）：

- 输入参数：
  - `serviceId`（可选，默认 `service-1`）
  - `toolName`（必填）
  - `args`（可选，下游工具参数）
- 返回内容：
  - `paymentMade`
  - `paymentResponse`
  - `content`（下游工具返回）

---

## 5. 环境变量

在 `./.env` 中配置：

```bash
EVM_PRIVATE_KEY=0x...
DOWNSTREAM_MCP_URLS=http://localhost:4022/sse,https://example.com/mcp
DOWNSTREAM_MCP_TRANSPORT=auto
PORT=4023
```

字段说明：

- `EVM_PRIVATE_KEY`：网关支付钱包私钥（用于下游 402 支付）
- `DOWNSTREAM_MCP_URLS`：多个下游地址，英文逗号分隔
- `DOWNSTREAM_MCP_URL`：单下游地址（与上面二选一；`URLS` 优先）
- `DOWNSTREAM_MCP_TRANSPORT`：
  - `auto`（默认，先 Streamable HTTP 后 SSE）
  - `streamable-http`（仅 Streamable HTTP）
  - `sse`（仅 SSE）
- `PORT`：网关监听端口（默认 `4023`）

---

## 6. 使用方式

### 6.1 准备依赖

在 examples 根目录安装依赖：

```bash
cd /Users/ppg/Desktop/agentry/x402/examples/typescript
pnpm install --no-frozen-lockfile
```

### 6.2 启动下游 MCP（示例）

先启动一个下游服务（例如现有 `servers/mcp`）：

```bash
cd /Users/ppg/Desktop/agentry/x402/examples/typescript/servers/mcp
cp .env-local .env
pnpm dev
```

### 6.3 启动网关 MCP

```bash
cd /Users/ppg/Desktop/agentry/x402/examples/typescript/servers/mcp-gateway
cp .env-local .env
# 编辑 .env，填好 EVM_PRIVATE_KEY 和下游地址
pnpm dev
```

启动成功后，网关 SSE 地址为：

`http://localhost:4023/sse`

### 6.4 上游接入（例如 Cursor）

让上游客户端连接网关，而不是直接连所有下游：

- MCP Endpoint: `http://localhost:4023/sse`

---

## 7. 多下游添加方式

示例：

```bash
DOWNSTREAM_MCP_URLS=http://localhost:4022/sse,https://vendor-a.example/mcp,https://vendor-b.example/sse
```

网关会自动分配：

- `service-1`
- `service-2`
- `service-3`

调用时可在 `call_service_tool` 里指定 `serviceId`。

---

## 8. 常见问题

### Q1: `tsx: command not found`

依赖未安装。请在 `examples/typescript` 根目录执行：

```bash
pnpm install --no-frozen-lockfile
```

### Q2: `SSE error / ECONNRESET`

通常是下游地址或 transport 不匹配：

- 检查下游 URL 是否可访问
- 若不确定 transport，使用 `DOWNSTREAM_MCP_TRANSPORT=auto`
- 先用本地下游验证（如 `http://localhost:4022/sse`）

### Q3: 连接多个下游后怎么确认是否成功？

调用 `list_gateway_services`，看每个服务的：

- `url`
- `transport`
- `tools`

---



