#!/bin/bash
# x402 MCP Gateway 一键打包脚本
# 执行 build 后 pack，生成 x402-mcp-gateway-example-0.1.0.tgz

set -e
cd "$(dirname "$0")"

echo "📦 Building and packing x402-mcp-gateway..."
pnpm pack

echo "✅ Done. Output: x402-mcp-gateway-example-0.1.0.tgz"
