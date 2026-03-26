#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# 一键打包：安装依赖、构建 TypeScript、生成可发布的 .tgz
# 用法：在项目根目录执行 ./scripts/pack-for-publish.sh
# 或在 package.json 中：pnpm run pack:release
# -----------------------------------------------------------------------------

set -euo pipefail

# 脚本所在目录的上一级 = 包根目录（含 package.json）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> 工作目录: $ROOT"

# 确保可复现构建：安装依赖（含 devDependencies，构建需要 tsc）
if [[ "${SKIP_INSTALL:-}" != "1" ]]; then
  echo "==> 安装依赖 (SKIP_INSTALL=1 可跳过)"
  pnpm install
else
  echo "==> 跳过 pnpm install（已设置 SKIP_INSTALL=1）"
fi

echo "==> 构建 dist/"
pnpm run build

echo "==> 打包到 release/"
mkdir -p release
# 清理旧包，避免混淆版本
rm -f release/*.tgz

pnpm pack --pack-destination ./release

TGZ="$(ls -1t release/*.tgz 2>/dev/null | head -1)"
if [[ -z "$TGZ" ]]; then
  echo "ERROR: No .tgz generated under release/" >&2
  exit 1
fi

echo ""
echo "-------------------------------------------------------------------"
echo "打包完成: $TGZ"
echo ""
echo "本地校验安装示例:"
echo "  npm install -g \"$TGZ\""
echo ""
echo "发布到 npm（作用域包通常需 public）:"
echo "  npm publish \"$TGZ\" --access public"
echo "-------------------------------------------------------------------"
