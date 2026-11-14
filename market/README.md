# 插件市场索引

这个目录放两样东西：

- `index.json` —— **DSH 插件市场 format 1 索引**，把本插件发布到「设置 → 插件 → 发现」；
- 本文件 —— 记录已经投递/收录的地方，以及发版与收录的硬约束。

## 索引 URL

```
https://cdn.jsdelivr.net/gh/lcy362/dsh-radeon-capacity@main/market/index.json
```

国内首选上面这条；同一份文件的 GitHub 原件（部分网络下拉不动）：

```
https://raw.githubusercontent.com/lcy362/dsh-radeon-capacity/main/market/index.json
```

加为来源的路径：**设置 → 插件 → 发现 → 市场来源 → 添加 URL**。（内核的 `plugin-market`
服务把来源存在 `indexes` 字段里，也可以用 profile 补丁的用户层配置写。）

## 已经投递的市场

| 市场 | 方式 | 状态 |
|---|---|---|
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | 目录 PR：`data/plugins/lcy362__dsh-radeon-capacity.yml` | 见仓库 PR |
| [losebird/dsh-plugin-market](https://github.com/losebird/dsh-plugin-market) | registry PR：`registry/curated/dsh-radeon-capacity.json` | [PR #51](https://github.com/losebird/dsh-plugin-market/pull/51) 已合并 |
| GitHub `dsh-plugin` topic | 部分市场按 topic 实时同步 | 已打 topic |

### 两点必须说清楚，否则很容易误判

**1. `dshmarket` 读的是 awesome-dsh-plugin 那份目录，不是 losebird 的。** 它取的是
`https://awesome-dsh-plugin.com/plugins.json`（本机缓存见
`~/.dsh/profiles/desktop/.dsh-market/discovery-compatibility-v1.json`）。
losebird 那份 registry 要么单独加进「发现 → 市场来源」才会被读到，要么根本看不见。
所以**往 losebird 提 PR 已合并，并不等于市场里能看到这个插件**。

**2. 打 topic 不会自动进 awesome-dsh-plugin。** 那份目录是**一个插件一个 YAML、一次 PR 只加
一个文件**地策展出来的，不做 topic 采集。（topic 只对少数按 topic 同步的市场有效。）

**3. 不发 npm 会失去下载量数字。** `dshmarket` 默认按「npm 下载量（近 30 天）」倒序排，比较
函数只认 `downloads` 字段；那份目录里也没有 `githubReleaseDownloads`，所以没有 npm 包 = 卡片上
没有数字，而且在默认视图里排在所有有数的条目之后。

## 格式要点

索引遵循内核 `@deepseek-ai/dsh-plugin-market-index` 的 format 1 校验器：

- `format: 1`
- `title` / `description` 是本地化文本对象，**必须含 `en` 键**
- 每个 plugin 的 `versions[]` 要给出**精确 SemVer**、整数秒的 `publishTimestamp`，
  以及 `source`（`npm` 或 `git`）
- `git` source 必须钉到 **40 位小写 commit SHA**，不能是分支或 tag
- `engines.dsh` 要能被当前内核满足，否则市场会把它标成不兼容

## 发布新版本

索引里的 `source.commit` 不能指向索引自己的 commit（自引用），所以流程是：

1. 改 `package.json` 的版本号：`npm version patch --no-git-tag-version`
2. 提交并推送
3. `bash scripts/release.sh` —— 跑测试、打包、建 tag 与 GitHub Release
4. `npm publish`
5. 把 `versions[0].source.commit` 改成第 3 步那个 commit 的 SHA
6. 往 `versions[]` **追加**新条目（不要改旧条目 —— 旧版本要能继续被装到）
7. 提交 `market/index.json` 并推送

### 两条硬约束

**Release 资产名必须固定为 `dsh-radeon-capacity.tgz`，不能带版本号。** `scripts/release.sh`
已经这么做了。原因：任何指向 `releases/latest/download/<name>` 的地方（目录的 `tarball` 字段）
在资产名带版本号时，下一次发版就会 404；而 awesome-dsh-plugin 的 `probe-tarballs.mjs` 实测
404 之后会**静默丢掉**这个字段——你不会收到任何提示。

**npm 包必须带指回本仓库的 `repository`。** 目录的 `probe-npm.mjs` 认「这个插件有 npm 包」的
条件是：读仓库 `package.json` 的 `name` → 去 registry 查 → 并且该 npm 包的 `repository` 指回
同一个 GitHub 仓库（防抢名）。少了这一步会永远判成 `npm: null`。`scripts/release.sh` 会在打包后
校验这一点。

## 校验

```sh
node scripts/check-market.mjs
```

`release.sh` 也会跑它，索引不合规就不发版。
