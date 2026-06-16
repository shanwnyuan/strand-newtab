# 拆条 / Strand · 安装（3 步）

> Mac + Chrome。装一次，以后更新只要 `git pull` + 点一下刷新。

## 1. 克隆仓库

```bash
git clone https://github.com/shanwnyuan/strand-newtab.git ~/repos/strand-newtab
```

> 已经装过 git 就行（Mac 自带）。建议放 `~/repos/`，以后更新方便。

## 2. 装本地服务（可选 · 想统计「AI 使用时长」才需要）

```bash
bash ~/repos/strand-newtab/usage-tracker/install.sh
```

它会自动：探测你的 node 路径 → 配置开机自启的本地服务（端口 8788）→ 起服务并自检。看到 `健康检查 8788 … OK ✓` 就成了。

> 这个本地服务只统计你本机的 AI 使用时长（Claude Code / Codex），只在你本机跑。跳过这步扩展也能用，只是 AI 用量卡没数据。

## 3. 加载 Chrome 扩展

1. 打开 `chrome://extensions/`
2. 右上角打开「**开发者模式**」
3. 点「**加载已解压的扩展程序**」→ 选 `~/repos/strand-newtab/` 文件夹
4. 开一个新标签页 —— 就能看到了

> Chrome 可能偶尔提示「关闭开发者模式扩展」，忽略即可（这是未上架商店的正常提示）。

## 上排行榜（自助注册，不用找任何人）

开个新标签页 → 排行榜右上角「**登录**」→「**第一次？去注册**」→ 邮箱 + 密码 + 昵称头像。注册完即上榜，每天自动上报你的打卡天数和 AI 时长。

## 更新

```bash
cd ~/repos/strand-newtab && git pull && bash usage-tracker/install.sh
```

> `git pull` 后**一定要重跑 `install.sh` 重启本地服务**——光 pull 不重启，AI 用量趋势这类依赖本地服务的新功能不会生效（你点「趋势」会看到「本地服务是旧版」的提示）。装过 usage 服务才需要这步；没装的只 `git pull` 即可。

然后在 `chrome://extensions` 点该扩展的「**重新加载 ↻**」。完事。

## 卸载

```bash
launchctl unload ~/Library/LaunchAgents/com.strand.usage.plist
rm ~/Library/LaunchAgents/com.strand.usage.plist
```

再在 `chrome://extensions` 移除扩展即可。
