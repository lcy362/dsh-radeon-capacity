#!/usr/bin/env bash
# 把本仓库 link 进 desktop profile 并登记到 bundles。
#
#   scripts/install-local.sh          # 安装 / 更新链接
#   scripts/install-local.sh --remove  # 卸载（只摘登记与链接，不动用户层 provider 配置）
#
# 之所以先查进程：bundle 只在 App 启动时加载，边装边跑没有意义，还容易看到半截状态。
set -euo pipefail

PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$(node -p "require('$HERE/package.json').name")"

if pgrep -f "MacOS/DeepSeek Harness" >/dev/null 2>&1; then
  echo "✗ DSH App 还在运行（pgrep 命中）。请先完全退出 App 再安装 —— bundle 只在启动时加载。"
  exit 1
fi

if [[ ! -f "$PROFILE/package.json" ]]; then
  echo "✗ 找不到 profile：$PROFILE"
  exit 1
fi

MODE="install"
[[ "${1:-}" == "--remove" ]] && MODE="remove"

node - "$PROFILE/package.json" "$PKG" "$HERE" "$MODE" <<'NODE'
const [file, pkg, here, mode] = process.argv.slice(2)
const fs = require('node:fs')
const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
doc.dsh ??= {}
doc.dsh.profile ??= {}
doc.dsh.profile.bundles ??= []
const spec = `link:${here}`
if (mode === 'remove') {
  delete doc.dependencies?.[pkg]
  doc.dsh.profile.bundles = doc.dsh.profile.bundles.filter((name) => name !== pkg)
  console.log(`- 已从 dependencies 与 bundles 摘掉 ${pkg}`)
} else {
  doc.dependencies ??= {}
  doc.dependencies[pkg] = spec
  if (!doc.dsh.profile.bundles.includes(pkg)) doc.dsh.profile.bundles.push(pkg)
  console.log(`+ ${pkg} → ${spec}`)
  console.log(`+ bundles: ${doc.dsh.profile.bundles.join(', ')}`)
}
fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
NODE

cd "$PROFILE"
if [[ "$MODE" == "remove" ]]; then
  pnpm remove "$PKG"
else
  pnpm install
fi

echo
if [[ "$MODE" == "remove" ]]; then
  echo "✓ 已卸载。注意：你通过本插件写入的 provider 仍在用户层（profile 补丁）里，继续可用。"
  echo "  确实想删它，再到 设置 → 模型 里移除对应 provider。"
else
  echo "✓ 完成。启动 DSH App 后：设置 → Radeon 应能看到状态；模型选择器里 Radeon 模型名后会多一枚容量徽章。"
fi
