# Strand 使用统计追踪

新标签页右栏「使用统计」卡的数据来源。卡片可切 **时长 / Token** 两个指标 × **今日 / 近7天 / 累计** 三个区间。

| 工具 | 数据来源 | 时长 | Token | 历史 |
|---|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | ✅ | ✅ | 有（往回算） |
| Codex | `~/.codex/sessions/**/*.jsonl` | ✅ | ✅ | 有（往回算） |
| Chrome | 扩展后台 service worker（`chrome.storage.local`） | ✅ | — 无 token | 无，从装上起累积 |

**时长口径**：把会话里所有事件按时间戳排序，相邻两条间隔 < 5 分钟算「连续在用」，累加这些间隔；超过 5 分钟的空档视为离开，不计入。改阈值见下方环境变量。

**Token 口径**：主数字 = **输入 + 输出**。缓存（CC 的 cache_read/创建、Codex 的 cached_input）量极大但几乎不计费，单独列为小字，**不计入主数字**，避免被「重复读上下文」带飞。

---

## 两个部件

1. **本地服务 `server.mjs`** — Node 写的极轻 HTTP 服务，端口 `8788`，零依赖。扫日志、算时长、出 JSON。扩展前端去 `http://127.0.0.1:8788/usage` 取数。
2. **后台 `../background.js`** — 扩展的 service worker，每分钟记一次 Chrome 活跃分钟数。随扩展自动跑，无需手动启动。

> 端口 8788 与扩展原有的 8799 后端（`/course`）互不相干，不冲突。

---

## 启动本地服务

### 手动跑（临时测试）
```bash
node ~/repos/html-demos/strand-newtab/usage-tracker/server.mjs
# 看到 [strand-usage] listening on http://127.0.0.1:8788 即成功
```

### 开机自启 + 常驻（推荐，装一次）
```bash
cp ~/repos/html-demos/strand-newtab/usage-tracker/com.strand.usage.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.strand.usage.plist
# 验证
curl -s http://127.0.0.1:8788/usage | python3 -m json.tool
```

停掉 / 卸载：
```bash
launchctl unload ~/Library/LaunchAgents/com.strand.usage.plist
rm ~/Library/LaunchAgents/com.strand.usage.plist
```

日志在 `/tmp/strand-usage.log`。

---

## 接口

- `GET /usage` → `{ ok, generatedAt, gapMin, tz, tools:{ claude, codex } }`，每个工具含 `todayMin / weekMin / totalMin / sessions`（时长）和 `tokToday / tokWeek / tokTotal`（输入+输出）+ `cacheToday / cacheWeek / cacheTotal`（缓存）
- `GET /usage?gap=10` → 临时用 10 分钟阈值
- `GET /health` → 存活探针

## 环境变量

- `STRAND_USAGE_PORT`（默认 `8788`）
- `STRAND_USAGE_GAP`（默认 `5`，单位分钟）
