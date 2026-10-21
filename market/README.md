# 插件市场索引

这个目录放的是 **DSH 插件市场 format 1 索引**（`index.json`），用来把本插件发布到
DSH 的「设置 → 插件 → 发现」页。

## 索引 URL

```
https://raw.githubusercontent.com/lcy362/dsh-radeon-capacity/main/market/index.json
```

国内网络拉 raw.githubusercontent.com 不稳时可换 jsDelivr（同一个文件）：

```
https://cdn.jsdelivr.net/gh/lcy362/dsh-radeon-capacity@main/market/index.json
```

在 DSH 里把上面任一 URL 加成市场来源即可看到本插件：

```
设置 → 插件 → 发现 → 市场来源 → 添加 URL
```

（内核的 `plugin-market` 服务把来源存在 `indexes` 字段里，也可以用 profile 补丁的
用户层配置写。）

## 已经投递的市场

除了本仓库自带的索引，插件也已经提交到社区市场：

| 市场 | 方式 | 状态 |
|---|---|---|
| [losebird/dsh-plugin-market](https://github.com/losebird/dsh-plugin-market) | curated PR（Release 的 `.tgz` 作 spec） | [PR #51](https://github.com/losebird/dsh-plugin-market/pull/51) |
| GitHub `dsh-plugin` topic | 自动采集（`AwesomeHou/dsh-plugin-marketplace` 等按 topic 实时同步） | 已打 topic |

topic 是最省事的一条：那些市场按 `github.com/topics/dsh-plugin` 实时同步，仓库打了
topic 就会自动出现，不用逐个提 PR。

## 格式要点

索引遵循内核 `@deepseek-ai/dsh-plugin-market-index` 的 format 1 校验器：

- `format: 1`
- `title` / `description` 是本地化文本对象，**必须含 `en`** 键
- 每个 plugin 的 `versions[]` 要给出**精确 SemVer**、整数秒的 `publishTimestamp`，
  以及 `source`（`npm` 或 `git`）
- `git` source 必须钉到 **40 位小写 commit SHA**，不能是分支或 tag
- `engines.dsh` 要能被当前内核满足，否则市场会把它标成不兼容

## 发布新版本

索引里的 `source.commit` 不能指向索引自己的 commit（自引用），所以流程是：

1. 提交并推送插件代码，打 tag（例如 `v0.1.1`）
2. 把 `versions[0].source.commit` 改成那个 tag 对应的 commit SHA
3. 往 `versions[]` **追加**新条目（不要改旧条目 —— 旧版本要能继续被装到）
4. 提交 `market/index.json` 并推送

`scripts/check-market.mjs` 会校验索引合规性，并在 commit 不存在时直接报错。

## 校验

```sh
node scripts/check-market.mjs
```
