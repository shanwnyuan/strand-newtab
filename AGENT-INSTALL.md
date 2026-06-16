# 用你的 AI Agent 安装拆条 / Strand

你有 Claude Code 或 Codex？让它帮你装。把下面整段**粘贴给你的 agent** 即可。

---

## 粘给 agent 的 prompt（整段复制）

```
帮我安装一个 Chrome 新标签页工具「拆条/Strand」。整个过程只在本机，不要上传任何文件到外部。步骤：

1. 准备代码目录 ~/repos/strand-newtab（~/repos 不存在就先创建）：
   - 不存在 → git clone https://github.com/shanwnyuan/strand-newtab.git ~/repos/strand-newtab
   - 已存在且是 git 仓库 → 进去执行 git pull 更新
   - 已存在但不是 git 仓库（之前用 zip 装的旧版残留）→ 直接删掉重新 clone，不要停下来问我：
     rm -rf ~/repos/strand-newtab && git clone https://github.com/shanwnyuan/strand-newtab.git ~/repos/strand-newtab
2. 运行：bash ~/repos/strand-newtab/usage-tracker/install.sh
   （这是可选的本地 AI 用量统计服务，会顺便重启服务让新功能生效；如果我本机没有 node，先告诉我怎么装 node，别自作主张装。）
3. 等它输出「健康检查 8788 … OK ✓」。若失败，把 /tmp/strand-usage.log 最后 20 行贴给我，并停下。
4. 成功后，把下面两件「只能我手动做」的事清楚列给我，第 (a) 条要带上绝对路径：
   (a) 打开 chrome://extensions → 右上角开「开发者模式」→「加载已解压的扩展程序」→ 选 ~/repos/strand-newtab 的绝对路径
   (b) 开一个新标签页 → 排行榜右上角「登录」→「第一次？去注册」→ 邮箱+密码+昵称头像，注册完即上榜
不要尝试替我加载 Chrome 扩展（agent 无法操作 chrome:// 页面）；注册也由我自己在页面上完成。
```

---

## agent 跑完后，你手动做（2 件）

1. **加载扩展**：按 agent 给你的绝对路径，在 `chrome://extensions` 加载已解压 → 开个新标签页就能用
2. **注册上榜**：新标签页排行榜右上角「登录」→「第一次？去注册」，邮箱+密码+昵称头像

## 以后更新

把这句粘给 agent：

```
更新拆条/Strand：进入 ~/repos/strand-newtab 执行 git pull，然后重跑 bash usage-tracker/install.sh 重启本地服务（关键：只 git pull 不重启服务，AI 用量趋势等新功能不会生效），最后提醒我去 chrome://extensions 点该扩展「重新加载 ↻」。
```

> 为什么扩展要手动：Chrome 不允许任何程序（包括 agent）静默给你的浏览器装扩展，这是浏览器的安全设计。这一步只能你亲手点。
