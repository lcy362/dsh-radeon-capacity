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

APP_BIN="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"

# 注意：这台机器上 `pgrep -f` 只匹配进程名，匹配不到带参数的宿主进程；
# 而 `pgrep -f "MacOS/DeepSeek Harness"` 又会命中 Helper 子进程（路径里带同一段前缀）。
# 所以这里一律用 ps 的完整命令行，并排除 Helper 行。
app_pids() {
  # bin 走环境变量而不是 awk -v：-v 会把路径塞进 awk 自己的命令行，
  # 于是 awk 进程匹配到自己，守卫永远为真（第一版就踩过）。
  BIN="$APP_BIN" ps -Ao pid=,command= | BIN="$APP_BIN" awk '
    index($0, ENVIRON["BIN"]) && index($0, "Helper") == 0 { print $1 }
  '
}

if [[ -n "$(app_pids)" ]]; then
  if [[ "${1:-}" == "--force" ]]; then
    # 只写文件，不动运行中的进程：最坏情况是本次运行看不到插件，
    # 下次启动照常加载。用于「退出没退干净」时兜底，避免装不进去。
    echo "! App 仍在运行（PID: $(app_pids | tr '\n' ' ')），按 --force 继续；重启后才会生效。"
  else
    echo "✗ DSH App 还在运行（PID: $(app_pids | tr '\n' ' ')）。请先完全退出 App 再安装 —— bundle 只在启动时加载。"
    exit 1
  fi
fi

if [[ ! -f "$PROFILE/package.json" ]]; then
  echo "✗ 找不到 profile：$PROFILE"
  exit 1
fi

MODE="install"
[[ "${1:-}" == "--remove" ]] && MODE="remove"
[[ "${1:-}" == "--force" ]] && FORCE=1

cp "$PROFILE/package.json" "$PROFILE/package.json.bak-radeon-capacity"

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
  pnpm remove "$PKG" || { echo "✗ pnpm remove 失败，package.json 未回滚（改动很小，可手动检查）"; exit 1; }
else
  # 装失败就把 manifest 还原 —— 半截的 package.json 会让 App 起不来。
  if ! pnpm install; then
    cp "$PROFILE/package.json.bak-radeon-capacity" "$PROFILE/package.json"
    echo "✗ pnpm install 失败，已把 package.json 还原。"
    exit 1
  fi
fi
rm -f "$PROFILE/package.json.bak-radeon-capacity"

echo
if [[ "$MODE" == "remove" ]]; then
  echo "✓ 已卸载。注意：你通过本插件写入的 provider 仍在用户层（profile 补丁）里，继续可用。"
  echo "  确实想删它，再到 设置 → 模型 里移除对应 provider。"
else
  echo "✓ 完成。启动 DSH App 后：设置 → Radeon 应能看到状态；模型选择器里 Radeon 模型名后会多一枚容量徽章。"
fi
