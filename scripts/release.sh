#!/usr/bin/env bash
#
# 发一个版本：跑测试 → 打预构建包 → 挂到 GitHub Release。
#
# 为什么资产名必须固定、不能带版本号：
#   目录/市场索引里的 tarball 字段指向
#     https://github.com/lcy362/dsh-radeon-capacity/releases/latest/download/dsh-radeon-capacity.tgz
#   latest 只会解析到「最新那个 release」的资产。资产名一旦带上版本号
#   （dsh-radeon-capacity-0.1.1.tgz），下一次发版后 latest 下就找不到这个名字，
#   awesome-dsh-plugin 的 probe-tarballs.mjs 实测 404 之后会把这个 tarball
#   字段直接丢掉——而且是静默的。所以资产名固定是这套发布流程的硬约束。
#
# 用法：
#   scripts/release.sh              # 用 package.json 里的 version 发版
#   scripts/release.sh --dry-run    # 只打包并检查内容，不碰 GitHub
#
# 前置：gh 已登录（gh auth status）、工作区干净、当前分支已推送。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
# 固定资产名：带版本号的名字会在下次发版后让 latest 失效
ASSET_NAME="dsh-radeon-capacity.tgz"
PACKED="dsh-radeon-capacity-${VERSION}.tgz"

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; fi

die() { echo "✗ $*" >&2; exit 1; }
ok()  { echo "✓ $*"; }
step(){ echo "· $*"; }

# ---------------------------------------------------------------- 前置检查
[ -z "$(git status --porcelain)" ] || {
  echo "工作区不干净，先提交再发版：" >&2
  git status --short >&2
  die "工作区不干净"
}
git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null && die "tag ${TAG} 已存在"

HEAD_SHA="$(git rev-parse HEAD)"
UPSTREAM_SHA="$(git rev-parse '@{u}' 2>/dev/null || true)"
[ -n "${UPSTREAM_SHA}" ] || die "当前分支没有上游，先 git push -u"
[ "${HEAD_SHA}" = "${UPSTREAM_SHA}" ] || die "还有没推上去的提交，先 git push"

if [ "${DRY_RUN}" = 0 ]; then
  command -v gh >/dev/null || die "需要 gh CLI（brew install gh）"
  gh auth status >/dev/null 2>&1 || die "gh 未登录，先 gh auth login"
fi

step "版本 ${VERSION} → tag ${TAG}，资产名 ${ASSET_NAME}"

# ---------------------------------------------------------------- 跑测试
step "跑测试"
npm test >/dev/null || die "测试没过，不发版"
ok "测试通过"

step "校验市场索引"
node scripts/check-market.mjs >/dev/null || die "market/index.json 不合规"
ok "索引合规"

# ---------------------------------------------------------------- 打包
step "打包"
rm -f "${PACKED}"
npm pack --silent >/dev/null
[ -f "${PACKED}" ] || die "npm pack 没有产出 ${PACKED}"

# 包内容自查：少一个文件，用户装出来就是坏的
LISTING="$(tar tzf "${PACKED}")"
for required in \
  package/package.json \
  package/cordis.patch.yml \
  package/src/host/index.js \
  package/src/client/index.js \
  package/src/shared/catalog.js \
  package/LICENSE
do
  echo "${LISTING}" | grep -qx "${required}" || die "包里缺 ${required}"
done
echo "${LISTING}" | grep -q '\.tgz$' && die "包里混进了 tgz 产物"

# 这是目录认定「这个插件有 npm 包」的前提：probe-npm.mjs 要求 npm 上那一版的
# repository 指回同一个 GitHub 仓库，否则永远判成 npm: null——既没有 npm 下载数，
# 安装命令也不会优先给 npm 包名。
tar xzOf "${PACKED}" package/package.json | node -e '
let raw = ""
process.stdin.on("data", (chunk) => { raw += chunk })
process.stdin.on("end", () => {
  const pkg = JSON.parse(raw)
  const field = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? "")
  if (!field.toLowerCase().includes("lcy362/dsh-radeon-capacity")) {
    console.error("package.json 的 repository 没有指回本仓库：" + JSON.stringify(field))
    process.exit(1)
  }
})' || die "包里的 repository 不达标（会导致目录识别不出 npm 包）"
ok "包内容与 repository 校验通过（$(echo "${LISTING}" | wc -l | tr -d ' ') 个文件）"

cp "${PACKED}" "${ASSET_NAME}"

if [ "${DRY_RUN}" = 1 ]; then
  echo
  ok "--dry-run：跳过 GitHub。产物在 ./${ASSET_NAME}"
  echo "  真发的话会执行：gh release create ${TAG} --target ${HEAD_SHA} --generate-notes ${ASSET_NAME}"
  rm -f "${ASSET_NAME}"
  exit 0
fi

# ---------------------------------------------------------------- 发 Release
step "创建 GitHub Release ${TAG}"
# --target 钉死到当前 HEAD，避免 gh 自行挑一个分支顶端
gh release create "${TAG}" \
  --target "${HEAD_SHA}" \
  --title "${TAG}" \
  --generate-notes \
  "${ASSET_NAME}" >/dev/null

rm -f "${ASSET_NAME}"
ok "Release ${TAG} 已发布"

echo
echo "接下来："
echo "  npm publish                 # 需要先 npm login"
echo "  然后市场索引里的 source.commit 指向 ${HEAD_SHA}"
echo "  索引/目录里的 tarball 用：https://github.com/lcy362/dsh-radeon-capacity/releases/latest/download/${ASSET_NAME}"
