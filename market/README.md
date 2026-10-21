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

在 DSH 里把上面任一 URL 加成市场来源即可看到本插件。两条命令都能加：

```sh
# 方式一：设置页手动添加（设置 → 插件 → 发现 → 市场来源）
# 方式二：直接写 profile 补丁的用户层配置
#   plugin-market 的 indexes 字段
```

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
