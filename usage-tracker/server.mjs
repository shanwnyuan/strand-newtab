#!/usr/bin/env node
// Strand 使用统计本地服务
// 扫 Claude Code / Codex 的会话日志（jsonl），算三类指标：
//   1) 活跃时长：事件按时间戳排序，相邻间隔 < gap 分钟（默认 5）算「连续在用」，累加这些间隔。
//   2) Token：主数字 = 输入 + 输出（不含缓存）；缓存单独给出，不计入主数字。
//   3) 费用：API 等价成本，按 pricing.json 的分模型单价算「全价」(含缓存)，用于「回本」判断。
// 纯 Node 内置模块，零依赖。默认端口 8788（与扩展的 8799 后端隔离）。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";

const PORT = Number(process.env.STRAND_USAGE_PORT || 8788);
const DEFAULT_GAP_MIN = Number(process.env.STRAND_USAGE_GAP || 5);
const HOME = os.homedir();
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SOURCES = {
  claude: path.join(HOME, ".claude", "projects"),
  codex: path.join(HOME, ".codex", "sessions"),
};

// 缓存：文件路径 -> { mtimeMs, ts:[毫秒], days:{ "YYYY-MM-DD": { model: [in,out,cw,cr] } } }
const cache = new Map();
const TS_RE = /"timestamp"\s*:\s*"([^"]+)"/;

function loadPricing() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, "pricing.json"), "utf8")); }
  catch { return { subscriptionMonthly: 0, models: {} }; }
}

function loadLeaderboardCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, "leaderboard.json"), "utf8")); }
  catch { return {}; }
}

// launchd 子进程 PATH 精简，补 node/lark-cli 路径
// 关键：lark-cli 的 `#!/usr/bin/env node` 在 launchd 精简 PATH 下找不到 node。
// 把「跑本服务的同一个 node」所在目录 + lark-cli 所在目录 + 常见位置都塞进 PATH，跨机器(含 M 系列/homebrew/nvm)稳。
function larkEnv() {
  const dirs = [path.dirname(process.execPath)]; // 启动本服务的 node 的目录（最可靠）
  try { const lc = loadLeaderboardCfg().larkCli; if (lc) dirs.push(path.dirname(lc)); } catch { /* ignore */ }
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", `${HOME}/.npm-global/bin`);
  if (process.env.PATH) dirs.push(process.env.PATH);
  return { ...process.env, PATH: dirs.filter(Boolean).join(":") };
}
function runLark(args) {
  return new Promise((resolve, reject) => {
    const lark = loadLeaderboardCfg().larkCli || "lark-cli";
    execFile(lark, args, { maxBuffer: 8 * 1024 * 1024, timeout: 15000, env: larkEnv() }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}
let _self = null; // 缓存本机登录用户身份（名字+头像）
async function selfIdentity() {
  if (_self) return _self;
  const d = await runLark(["contact", "+get-user", "--as", "user", "--jq", ".data"]);
  const u = (d && d.user) || {};
  _self = { name: u.name || "", avatar: u.avatar_middle || u.avatar_url || "" };
  return _self;
}
const STATE_FILE = path.join(HERE, "report-state.json");
function loadReportState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
function saveReportState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch { /* ignore */ } }
function fmtNow() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function mdLink(s) { const m = /^\[.*\]\((.+)\)$/.exec(String(s || "").trim()); return m ? m[1] : (s || ""); }

function listJsonl(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  return out;
}

function localDayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 解析单个文件：抽时间戳 + 按「日期×模型」累加 [in,out,cacheWrite,cacheRead]
function parseFile(file, kind) {
  let st;
  try { st = fs.statSync(file); } catch { return { ts: [], days: {} }; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit;

  const ts = [];
  const days = {};
  let data, curModel = "?";
  try { data = fs.readFileSync(file, "utf8"); } catch { return hit || { ts: [], days: {} }; }

  const add = (day, model, vec) => {
    const d = days[day] || (days[day] = {});
    const m = d[model] || (d[model] = [0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) m[i] += vec[i];
  };

  for (const line of data.split("\n")) {
    if (!line) continue;
    const mt = TS_RE.exec(line);
    const tms = mt ? Date.parse(mt[1]) : NaN;
    if (!Number.isNaN(tms)) ts.push(tms);

    if (kind === "claude") {
      if (!line.includes('"input_tokens"')) continue;
      try {
        const d = JSON.parse(line);
        const u = d.message && d.message.usage;
        if (!u || Number.isNaN(tms)) continue;
        const model = (d.message && d.message.model) || "?";
        add(localDayKey(tms), model, [
          u.input_tokens || 0,
          u.output_tokens || 0,
          u.cache_creation_input_tokens || 0,
          u.cache_read_input_tokens || 0,
        ]);
      } catch { /* skip */ }
    } else if (kind === "codex") {
      if (line.includes('"turn_context"') || line.includes('"session_meta"')) {
        try {
          const mm = (JSON.parse(line).payload || {}).model;
          if (mm) curModel = mm;
        } catch { /* skip */ }
      }
      if (!line.includes('"last_token_usage"')) continue;
      try {
        const d = JSON.parse(line);
        const lu = d.payload && d.payload.info && d.payload.info.last_token_usage;
        if (!lu || Number.isNaN(tms)) continue;
        const cached = lu.cached_input_tokens || 0;
        const freshIn = Math.max(0, (lu.input_tokens || 0) - cached);
        // OpenAI 无缓存写：cw=0；缓存命中输入放在第4位(cr)
        add(localDayKey(tms), curModel, [
          freshIn,
          (lu.output_tokens || 0) + (lu.reasoning_output_tokens || 0),
          0,
          cached,
        ]);
      } catch { /* skip */ }
    }
  }
  ts.sort((a, b) => a - b);
  const rec = { mtimeMs: st.mtimeMs, ts, days };
  cache.set(file, rec);
  return rec;
}

function activeByDay(allTs, gapMin) {
  const gapMs = gapMin * 60 * 1000;
  const ts = allTs.slice().sort((a, b) => a - b);
  const byDay = {};
  for (let i = 1; i < ts.length; i++) {
    const delta = ts[i] - ts[i - 1];
    if (delta > 0 && delta < gapMs) {
      const k = localDayKey(ts[i - 1]);
      byDay[k] = (byDay[k] || 0) + delta;
    }
  }
  return byDay;
}

function rateFor(model, price) {
  const models = price.models || {};
  for (const key of Object.keys(models)) {
    if (model && model.includes(key)) return models[key];
  }
  return null; // 未知模型 -> 不计价
}

function summarize(dir, kind, gapMin, price) {
  const files = listJsonl(dir);
  let allTs = [];
  const perDayModel = {}; // day -> model -> [in,out,cw,cr]
  for (const f of files) {
    const rec = parseFile(f, kind);
    if (rec.ts.length) allTs = allTs.concat(rec.ts);
    for (const [day, models] of Object.entries(rec.days)) {
      const dst = perDayModel[day] || (perDayModel[day] = {});
      for (const [model, vec] of Object.entries(models)) {
        const m = dst[model] || (dst[model] = [0, 0, 0, 0]);
        for (let i = 0; i < 4; i++) m[i] += vec[i];
      }
    }
  }

  const minByDay = activeByDay(allTs, gapMin);
  const now = Date.now();
  const today = localDayKey(now);
  const last7 = new Set();
  for (let i = 0; i < 7; i++) last7.add(localDayKey(now - i * 86400 * 1000));

  // 时长
  let totalMs = 0, weekMs = 0;
  for (const [k, ms] of Object.entries(minByDay)) {
    totalMs += ms;
    if (last7.has(k)) weekMs += ms;
  }

  // token + 费用（按日按模型）
  let tokToday = 0, tokWeek = 0, tokTotal = 0;
  let cacheToday = 0, cacheWeek = 0, cacheTotal = 0;
  let costToday = 0, costWeek = 0, costTotal = 0;
  for (const [day, models] of Object.entries(perDayModel)) {
    let tok = 0, cache_ = 0, cost = 0;
    for (const [model, v] of Object.entries(models)) {
      tok += v[0] + v[1];
      cache_ += v[2] + v[3];
      const r = rateFor(model, price);
      if (r) cost += (v[0] * r[0] + v[1] * r[1] + v[2] * r[2] + v[3] * r[3]) / 1e6;
    }
    tokTotal += tok; cacheTotal += cache_; costTotal += cost;
    if (day === today) { tokToday += tok; cacheToday += cache_; costToday += cost; }
    if (last7.has(day)) { tokWeek += tok; cacheWeek += cache_; costWeek += cost; }
  }

  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    todayMin: Math.round((minByDay[today] || 0) / 60000),
    weekMin: Math.round(weekMs / 60000),
    totalMin: Math.round(totalMs / 60000),
    sessions: files.length,
    tokToday, tokWeek, tokTotal,
    cacheToday, cacheWeek, cacheTotal,
    costToday: r2(costToday), costWeek: r2(costWeek), costTotal: r2(costTotal),
  };
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "POST" && u.pathname === "/report") {
    const J = { "Content-Type": "application/json; charset=utf-8" };
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => { (async () => {
      let days = 0;
      try { days = Math.max(0, Math.round(Number(JSON.parse(body || "{}").days) || 0)); } catch { /* ignore */ }
      const cfg = loadLeaderboardCfg();
      if (!cfg.baseToken || !cfg.tableId) { res.writeHead(200, J); res.end(JSON.stringify({ ok: false, error: "未配置 Base" })); return; }
      try {
        const me = await selfIdentity();
        const price = loadPricing();
        const ai = (summarize(SOURCES.claude, "claude", DEFAULT_GAP_MIN, price).weekMin || 0)
                 + (summarize(SOURCES.codex, "codex", DEFAULT_GAP_MIN, price).weekMin || 0);
        const payload = { "用户": me.name, "打卡天数": days, "AI时长": ai, "头像": me.avatar, "更新时间": fmtNow() };
        const common = ["base", "+record-upsert", "--as", "user", "--base-token", cfg.baseToken, "--table-id", cfg.tableId];
        const tail = ["--json", JSON.stringify(payload), "--jq", ".data"];
        const st = loadReportState();
        let recordId = st.recordId, done = false;
        if (recordId) { try { await runLark([...common, "--record-id", recordId, ...tail]); done = true; } catch { done = false; } }
        if (!done) {
          const r2 = await runLark([...common, ...tail]);
          recordId = r2 && r2.record && r2.record.record_id_list && r2.record.record_id_list[0];
          if (recordId) saveReportState({ recordId });
        }
        res.writeHead(200, J); res.end(JSON.stringify({ ok: true, name: me.name, days, ai, recordId }));
      } catch (e) {
        res.writeHead(200, J); res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    })(); });
    return;
  }

  if (u.pathname === "/usage") {
    const gapMin = Number(u.searchParams.get("gap")) || DEFAULT_GAP_MIN;
    try {
      const price = loadPricing();
      const payload = {
        ok: true,
        generatedAt: new Date().toISOString(),
        gapMin,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        subscriptionMonthly: price.subscriptionMonthly || 0,
        tools: {
          claude: summarize(SOURCES.claude, "claude", gapMin, price),
          codex: summarize(SOURCES.codex, "codex", gapMin, price),
        },
      };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String((e && e.stack) || e) }));
    }
    return;
  }

  if (u.pathname === "/leaderboard") {
    // 排行榜：读共享飞书 Base，按 metric 排序返回；me 高亮按本机登录身份自动判定。
    const metric = u.searchParams.get("metric") === "ai" ? "ai" : "days";
    const J = { "Content-Type": "application/json; charset=utf-8" };
    const cfg = loadLeaderboardCfg();
    if (!cfg.baseToken || !cfg.tableId) {
      res.writeHead(200, J); res.end(JSON.stringify({ ok: true, configured: false, metric, rows: [] }));
      return;
    }
    (async () => {
      try {
        const d = await runLark(["base", "+record-list", "--as", "user", "--base-token", cfg.baseToken,
          "--table-id", cfg.tableId, "--limit", "200", "--jq", ".data"]);
        const me = await selfIdentity().catch(() => null);
        const meName = (me && me.name) || cfg.me || "";
        const f = d.fields || [];
        const iN = f.indexOf("用户"), iD = f.indexOf("打卡天数"), iA = f.indexOf("AI时长"), iAv = f.indexOf("头像");
        const out = (d.data || [])
          .map((r) => ({ name: r[iN], days: Number(r[iD]) || 0, ai: Number(r[iA]) || 0, avatar: iAv >= 0 ? mdLink(r[iAv]) : "" }))
          .filter((x) => x.name)
          .sort((a, b) => (b.days || 0) - (a.days || 0)) // 按打卡天数排(学习北极星)
          .map((r) => ({ name: r.name, days: r.days, ai: r.ai, me: r.name === meName, avatar: r.avatar }));
        res.writeHead(200, J); res.end(JSON.stringify({ ok: true, configured: true, rows: out }));
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 160);
        res.writeHead(200, J); res.end(JSON.stringify({ ok: true, configured: true, rows: [], note: "读取失败：" + msg }));
      }
    })();
    return;
  }

  if (u.pathname === "/" || u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("strand-usage ok");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[strand-usage] listening on http://127.0.0.1:${PORT}  (gap=${DEFAULT_GAP_MIN}min)`);
});
