"use strict";

// ---------- 工具 ----------
const $ = (id) => document.getElementById(id);
const card = $("card");
const todayStr = () => new Date().toISOString().slice(0, 10);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// 存储：扩展里用 chrome.storage.local；普通浏览器（预览）回退 localStorage
const store = (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local)
  ? chrome.storage.local
  : {
      get: (k) => Promise.resolve({ [k]: JSON.parse(localStorage.getItem(k) || "null") }),
      set: (o) => { for (const k in o) localStorage.setItem(k, JSON.stringify(o[k])); return Promise.resolve(); },
    };

// 内置课程（course.js 提供）：{type:'youtube', videoId, title, segments:[{start,end,text}]}
const BUILTIN = window.STRAND_COURSE || { type: "text", videoId: "", title: "我的内容", segments: [] };
// 拆解后端（第1步本地服务；上线后换成线上地址 + 每用户飞书 OAuth）
const BACKEND = "http://localhost:8799";
// 课程库：内置 YouTube 第1讲 + B站第2讲 + 用户导入的（state.imported，持久化）
const library = () => [window.STRAND_COURSE, window.STRAND_COURSE_BILI, ...(state.imported || [])].filter(Boolean);
const courseKey = (s) => !s ? "" : (s.bvid ? `bili:${s.bvid}:${s.page || 1}` : s.videoId ? `yt:${s.videoId}` : "custom:" + (s.title || ""));
const getDone = () => (state.progressByKey || {})[courseKey(state.source)] || 0;        // 当前课程已完成片段数
const setDone = (n) => { state.progressByKey = state.progressByKey || {}; state.progressByKey[courseKey(state.source)] = n; };

// 视频内嵌走 https 中转播放页（YouTube 拒绝 chrome-extension 来源 → error 153；
// 这个页面是合法 https 源，YouTube 肯播，并用 IFrame API 上报「看到结尾」）。参数走 hash（妙搭会丢掉 ?query）。
const PLAYER_BASE = "https://bytedance.aiforce.cloud/app/app_4k97fhsd9ge9g/";
const PLAYER_ORIGIN = "https://bytedance.aiforce.cloud";
let playerHandler = null;
window.addEventListener("message", (e) => {
  if (e.origin !== PLAYER_ORIGIN) return;
  if (e.data && e.data.source === "strand-player" && playerHandler) playerHandler(e.data);
});

// ---------- 状态 ----------
let state = {
  key: "",
  source: null,        // 当前课程
  activeIndex: null,   // 正在消费的片段下标（null = 在首页小路上）
  watched: false,      // 当前片段是否已看/读完
  unit: null,          // 看完后生成的巩固小测验
  step: 0,
  streak: 0,
  lastDay: "",
  unitsDone: 0,        // 累计完成片段数（终身）
  todayDone: 0,        // 今天完成数（跨天归零）
  imported: [],        // 用户导入的课程（后端拆解返回的，持久化进课程库）
  progressByKey: {},   // 各课程进度：{courseKey: 已完成片段数}
  days: [],            // 学习打卡：完成过片段的日期列表（YYYY-MM-DD）
};

async function loadState() {
  const s = await store.get("strand");
  if (s && s.strand) state = Object.assign(state, s.strand);
  if (!state.source) state.source = BUILTIN;
  if (!state.progressByKey) state.progressByKey = {};
  // 兼容老数据：把单一 courseDone 迁到当前课程的进度
  if (state.courseDone && !state.progressByKey[courseKey(state.source)]) state.progressByKey[courseKey(state.source)] = state.courseDone;
  if (state.lastDay !== todayStr()) state.todayDone = 0;
  // 兼容老数据：最近完成日（lastDay）若没记进打卡列表，补上（打卡是后加的，早先完成的没记）
  if (!Array.isArray(state.days)) state.days = [];
  if (state.lastDay && !state.days.includes(state.lastDay)) state.days.push(state.lastDay);
}
async function saveState() { await store.set({ strand: state }); }

const segments = () => (state.source && state.source.segments) || [];
const segCount = () => segments().length;
const effDone = () => Math.max(0, Math.min(getDone(), segCount()));
const todayCount = () => (state.lastDay === todayStr() ? state.todayDone : 0);

// 当前测验的扁平题目列表
function questions() {
  if (!state.unit) return [];
  const cs = (state.unit.choices || []).map((c) => Object.assign({ type: "choice" }, c));
  const os = (state.unit.opens || []).map((o) => Object.assign({ type: "open" }, o));
  return cs.concat(os);
}

// ---------- DeepSeek（看完后的巩固小测验，可选） ----------
const PERSONA =
  "你是「拆条」学习应用里的引擎，人格是一个靠谱、不端着的学长：鼓励但精准，把用户当聪明人，先肯定再点破，禁止空洞夸奖。";

async function callDeepSeek(messages, jsonMode) {
  if (!state.key) throw new Error("还没填 DeepSeek API Key（点右上角 ⚙ 设置）");
  const body = { model: "deepseek-chat", messages, temperature: 0.6 };
  if (jsonMode) body.response_format = { type: "json_object" };
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.key },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("DeepSeek 报错 " + res.status + "：" + t.slice(0, 180));
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

function parseJSON(txt) {
  let t = txt.trim();
  if (t.startsWith("```")) t = t.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

async function generateUnit(segText) {
  const content = (segText || "").slice(0, 6000);
  const sys = { role: "system", content: PERSONA +
    " 出题规则：禁止『讲师说X是什么』这种复读机题；要考查理解、应用、辨析；题目和答案必须能在给定内容里找到依据。" };
  const usr = { role: "user", content:
    "用户刚看完一段课程内容。基于这段内容出一个简短的巩固小测验：4 道单选题（每题 4 个选项，answer 是正确选项下标 0-3，附 why 简述）和 2 道开放题（point 是考查要点）。" +
    "只输出 JSON，不要解释、不要代码块，格式：" +
    '{"title":"小测验标题","choices":[{"stem":"","options":["","","",""],"answer":0,"why":""}],"opens":[{"stem":"","point":""}]}' +
    "\n\n这段内容：\n" + content };
  const out = await callDeepSeek([sys, usr], true);
  return parseJSON(out);
}

async function gradeOpen(q, answer) {
  const sys = { role: "system", content: PERSONA };
  const usr = { role: "user", content:
    "学生在回答一道开放题。\n题目：" + q.stem + "\n考查要点：" + (q.point || "") +
    "\n学生的回答：" + answer +
    "\n请用学长的语气批改：先肯定答对的部分，再点破差距，必要时联系常见误解。" +
    '只输出 JSON：{"verdict":"correct|partial|wrong","feedback":"2-4句中文反馈"}' };
  const out = await callDeepSeek([sys, usr], true);
  return parseJSON(out);
}

// 给一段课程内容生成「这一节讲什么」导读 + 一个勾人的钩子问题（妙记转写的课用得到；内置课手写不走这）
async function generateSummary(segText, idx, total) {
  const sys = { role: "system", content: PERSONA + " 你在给一段课程视频写课前导读。" };
  const usr = { role: "user", content:
    `这是一段课程内容（第 ${idx + 1} / ${total} 段）。给它写三样：\n` +
    `1) title：不超过 16 字的小标题；\n` +
    `2) intro：2-3 句说清这一节主要讲什么的概要（像课前导读，别复述原话）；\n` +
    `3) hookQ：这一节里最勾人的一个问题，一句话、20 字以内、只问不答、不剧透答案，要让人忍不住想点进来看（口语、带点钩子感，别像考题）。\n` +
    `只输出 JSON：{"title":"","intro":"","hookQ":""}\n\n内容：\n` + (segText || "").slice(0, 6000) };
  const out = await callDeepSeek([sys, usr], true);
  return parseJSON(out);
}

function esc(s) { return (s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }

function renderPreparing() {
  card.className = "card";
  card.innerHTML =
    `<div class="kicker"><span class="dot"></span> 准备中</div>
     <h1>正在理解这一节…</h1>
     <p class="sub">第一次看这一段，正在生成这节的导读，几秒就好。</p>`;
}

// ---------- 路由 ----------
function renderMain() {
  if (state.activeIndex == null || state.activeIndex >= segCount()) return renderIdle();
  if (!state.watched) return renderWatch();
  if (state.unit && state.step < questions().length) return renderQuestion();
  return renderDone();
}

// ---------- 首页：多邻国式学习小路（一个片段 = 一个圆点）----------
const ICON = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm3 8H9V7a3 3 0 0 1 6 0v3z"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v13M3 5.5A1.5 1.5 0 0 1 4.5 4H9a3 3 0 0 1 3 3 3 3 0 0 1 3-3h4.5A1.5 1.5 0 0 1 21 5.5v12a1.5 1.5 0 0 1-1.5 1.5H14a2 2 0 0 0-2 2 2 2 0 0 0-2-2H4.5A1.5 1.5 0 0 1 3 17.5z"/></svg>',
  headphone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><path d="M4 14h2.5A1.5 1.5 0 0 1 8 15.5v3A1.5 1.5 0 0 1 6.5 20H6a2 2 0 0 1-2-2zM20 14h-2.5A1.5 1.5 0 0 0 16 15.5v3A1.5 1.5 0 0 0 17.5 20h.5a2 2 0 0 0 2-2z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.9 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/></svg>',
  dumbbell: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="1.5" y="8" width="3" height="8" rx="1.2"/><rect x="4.5" y="5.5" width="3.4" height="13" rx="1.5"/><rect x="16.1" y="5.5" width="3.4" height="13" rx="1.5"/><rect x="19.5" y="8" width="3" height="8" rx="1.2"/><rect x="7.5" y="10.4" width="9" height="3.2" rx="1.4"/></svg>',
  chest: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v1H4z"/><rect x="3" y="10" width="18" height="9" rx="2"/><rect x="10.7" y="12" width="2.6" height="4.5" rx="1.3" opacity=".55"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  forward: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 6.5v11a1 1 0 0 0 1.6.8L12 13.2v4.3a1 1 0 0 0 1.6.8l7.2-5.5a1 1 0 0 0 0-1.6L13.6 5.7a1 1 0 0 0-1.6.8V11L5.6 5.7A1 1 0 0 0 4 6.5z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  merge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 7.5 12 12l9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/></svg>',
  dedup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/></svg>',
  sort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10M4 12h7M4 18h4M18 5v12M18 17l3-3M18 17l-3-3"/></svg>',
  recent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
};

// Catmull-Rom 平滑曲线：把圆点中心连成一条弯路
// 学习打卡热力图：过去 13 周 + 往后铺一段「跑道」（未来空格数 ≥ 课程讲数）。
// 学过=橙格，今天=环标「你在这」，今天之后=浅色待学格。数据来自 state.days。
function studyGrid() {
  const PAST_WEEKS = 6; // 列数少、立方体大、间距大 → 线框 3D 效果清楚
  const set = new Set(state.days || []);
  const total = segCount() || 12;
  const futureDays = Math.max(total, 7); // 往后至少铺满课程讲数（≥ total，最少一周）
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tkey = fmt(today);
  // 起点：往前 PAST_WEEKS 周再回到那周的周日；终点：往后 futureDays 天再推到那周的周六
  const start = new Date(today); start.setDate(start.getDate() - PAST_WEEKS * 7); start.setDate(start.getDate() - start.getDay());
  const end = new Date(today); end.setDate(end.getDate() + futureDays); end.setDate(end.getDate() + (6 - end.getDay()));
  const totalDays = Math.round((end - start) / 86400000) + 1;
  const weeks = Math.round(totalDays / 7);
  // 每个打卡格 = 一个 3D 小立方体（保留打卡数据：学过=点亮、今天=环标、未来=浅）
  const faces = `<span class="hcf hcf-top"></span><span class="hcf hcf-bottom"></span><span class="hcf hcf-left"></span><span class="hcf hcf-right"></span><span class="hcf hcf-front"></span>`;
  let cubes = "";
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = fmt(d);
    let cls = "hcube";
    if (d > today) cls += " fut";          // 未来=浅
    else if (set.has(key)) cls += " on";   // 学过=点亮
    if (key === tkey) cls += " today";     // 今天=环标
    cubes += `<div class="${cls}" data-r="${i % 7}" data-c="${Math.floor(i / 7)}" title="${key}">${faces}</div>`;
  }
  return `<div class="hcube-wrap"><div class="hgrid" id="hgrid" style="grid-template-columns:repeat(${weeks},1fr)">${cubes}</div></div>`;
}

// 给打卡立方体网格接上「跟随鼠标倾斜 + 点击涟漪」（复刻 React Bits Cubes，纯 JS/CSS，不引 GSAP；不做空闲自动飘动以省电）
function wireHeatmapCubes() {
  const grid = $("hgrid"); if (!grid) return;
  const cubes = [...grid.querySelectorAll(".hcube")];
  if (!cubes.length) return;
  const cols = Math.max(...cubes.map((c) => +c.dataset.c)) + 1, rows = 7;
  const RADIUS = 2.4, MAX = 36;
  let raf = 0;
  const tiltAt = (rc, cc) => {
    for (const cube of cubes) {
      const dist = Math.hypot((+cube.dataset.r) - rc, (+cube.dataset.c) - cc);
      if (dist <= RADIUS) { const a = (1 - dist / RADIUS) * MAX; cube.style.transform = `rotateX(${-a}deg) rotateY(${a}deg)`; }
      else cube.style.transform = "";
    }
  };
  grid.addEventListener("pointermove", (e) => {
    const r = grid.getBoundingClientRect();
    const cc = (e.clientX - r.left) / (r.width / cols);
    const rc = (e.clientY - r.top) / (r.height / rows);
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => tiltAt(rc, cc));
  });
  grid.addEventListener("pointerleave", () => { for (const cube of cubes) cube.style.transform = ""; });
  grid.addEventListener("click", (e) => {
    const r = grid.getBoundingClientRect();
    const ch = Math.floor((e.clientX - r.left) / (r.width / cols));
    const rh = Math.floor((e.clientY - r.top) / (r.height / rows));
    const hit = cubes.find((c) => +c.dataset.r === rh && +c.dataset.c === ch);
    const green = !!hit && (hit.classList.contains("on") || hit.classList.contains("today")); // 点中已打卡/今天→整圈绿涟漪，否则灰
    const rings = new Map();
    for (const cube of cubes) {
      const ring = Math.round(Math.hypot((+cube.dataset.r) - rh, (+cube.dataset.c) - ch));
      if (!rings.has(ring)) rings.set(ring, []);
      rings.get(ring).push(cube);
    }
    [...rings.keys()].sort((a, b) => a - b).forEach((ring) => {
      setTimeout(() => {
        const arr = rings.get(ring);
        arr.forEach((cube) => { cube.classList.add("rippling"); if (green) cube.classList.add("rip-on"); });
        setTimeout(() => arr.forEach((cube) => cube.classList.remove("rippling", "rip-on")), 220);
      }, ring * 55);
    });
  });
}

// ---------- 吉祥物表情 ----------
// 加新表情：把图存成 assets/mascot-<名字>.png，然后在下面数组里加上 "<名字>" 即可。
const MASCOT_EMOTIONS = ["grumpy", "shy", "love", "starstruck", "gloomy", "heartbroken"];
let mascotIdx = 0;
const mascotSrc = (i) => {
  const n = MASCOT_EMOTIONS.length;
  return `assets/mascot-${MASCOT_EMOTIONS[((i % n) + n) % n]}.png`;
};

// 按学习状态选表情：今天学了→shy/love/starstruck(按连胜)；没学→grumpy/gloomy/heartbroken(按荒废天数)
function mascotEmotion() {
  const streak = state.streak || 0;
  if (todayCount() >= 1) return streak >= 7 ? "starstruck" : streak >= 3 ? "love" : "shy";
  const last = state.lastDay;
  if (!last) return "grumpy"; // 从没学过
  const gap = Math.round((Date.parse(todayStr()) - Date.parse(last)) / 86400000);
  if (gap >= 7) return "heartbroken"; // 一周+没来
  if (gap >= 3) return "gloomy";      // 荒废几天
  return "grumpy";                     // 1-2 天没学：嫌弃催学
}

// 督学文案池（阴阳怪气版，配嫌弃脸火人）。每开新标签随机一句；加句子往数组里加即可。
const TAGLINES = [
  "哟，又是你。学不学？",
  "开标签页的手速，用来学习多好。",
  "摸鱼一时爽，菜起来是真的菜。",
  "你不学，我这火都快灭了。",
  "又开标签页逃避是吧？学一段赎罪。",
  "脑子这东西，不用真会生锈。",
  "别划走，今天的你还没变强呢。",
  "就看一眼？看一眼也得先学一段。",
  "来都来了，学一段再走。",
  "装忙我看穿了，先学一段。",
];
const pickTagline = () => TAGLINES[Math.floor(Math.random() * TAGLINES.length)];

function renderIdle() {
  card.className = "card home";
  const src = state.source || {};
  const total = segCount();
  const done = effDone();
  const complete = total > 0 && done >= total;
  const cur = complete ? -1 : done;
  mascotIdx = Math.max(0, MASCOT_EMOTIONS.indexOf(mascotEmotion())); // 默认表情跟随学习状态

  // 下一段的内容钩子（有就显示问题、没有退化成段标题/课程名）
  const nextSeg = (!complete && cur >= 0) ? segments()[cur] : null;
  const courseName = src.title || "我的内容";
  const hookText = complete ? "这门课看完了 🎉"
    : (nextSeg && nextSeg.hook) ? nextSeg.hook
    : (nextSeg && nextSeg.title) ? nextSeg.title
    : courseName;
  const ctaLabel = complete ? "再看一遍"
    : (nextSeg && nextSeg.hook) ? "这段就讲这个 →"
    : (done ? "继续学习" : "开始学习");

  card.innerHTML =
    `<div class="home-grid">
       <div class="home-top-band">
       <aside class="home-left">
         <button class="home-settings" id="menuBtn" title="设置">${ICON.list}</button>
         <div class="home-mid">
           <div class="home-info">
             <div class="home-top">
               <div class="mascot" id="mascot" style="background-image:url(${mascotSrc(mascotIdx)})"></div>
               <div class="home-id">
                 <div class="home-streak"><b>${state.streak}</b><span class="su">天连胜</span></div>
                 <div class="home-tagline">${pickTagline()}</div>
               </div>
             </div>
             <div class="section-header" id="segCard" role="button" tabindex="0" title="${esc(ctaLabel)}" aria-label="${esc(ctaLabel)}">
               <div class="sh-main">
                 <div class="sh-title" id="shTitle">${esc(hookText)}</div>
               </div>
               <span class="sh-play" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"><path d="M9 6.5 18 12l-9 5.5z"/></svg></span>
             </div>
           </div>
           <div class="home-left-side">${studyGrid()}</div>
         </div>
       </aside>
         <div class="usage" id="usagePanel">
           <div class="usage-head">
             <span class="usage-hl"><button class="usage-toggle" id="usageToggle" title="圆环 / 近 14 天趋势 切换"><span class="usage-title">AI 用量</span><span class="usage-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5M4 19h16M8 16v-4M13 16V8M18 16v-6"/></svg>趋势</span></button><button class="goal-edit" id="goalEdit" title="设定目标"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.4"/></svg>目标</button></span>
             <span class="usage-tabs" id="usageTabs">
               <button class="ut on" data-range="today">今日</button>
               <button class="ut" data-range="week">近7天</button>
               <button class="ut" data-range="total">累计</button>
             </span>
           </div>
           <div class="usage-rows" id="usageRows"><div class="usage-skel">读取中…</div></div>
           <div class="usage-foot" id="usageFoot"></div>
         </div>
         <div class="lb">
           <span class="lb-authslot" id="lbAuth"></span>
           <div class="lb-cols">
             <div class="lb-col">
               <div class="lb-subhead">打卡连续</div>
               <div class="lb-rows" id="lbRowsStreak"><div class="usage-skel">读取中…</div></div>
             </div>
             <div class="lb-col">
               <div class="lb-subhead lb-subhead-ai">AI 时长<button class="lb-rangetag" id="lbAiRangeBtn" title="今日 / 近7天 切换"><span class="lrt-t">今日</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button></div>
               <div class="lb-rows" id="lbRowsAi"><div class="usage-skel">读取中…</div></div>
             </div>
           </div>
           <div class="lb-foot"><span class="lb-foot-msg" id="lbFoot"></span></div>
         </div>
       </div>
       <div class="tabtool">
           <div class="tt-head">
             <span class="tt-title">标签页</span><span class="tt-count" id="ttCount"></span>
             <div class="tt-actions" id="ttActions"></div>
             <input id="ttSearch" class="tt-search" type="text" placeholder="搜索标题 / 网址…" autocomplete="off">
           </div>
           <div class="tt-body" id="ttBody"></div>
           <div class="tt-tabs" id="ttTabs"><div class="usage-skel">扫描中…</div></div>
         </div>
     </div>`;

  const mb = $("menuBtn"); if (mb) mb.onclick = openSettings;
  const mas = $("mascot");
  if (mas && MASCOT_EMOTIONS.length > 1) {
    mas.style.cursor = "pointer"; mas.title = "点我换表情";
    mas.onclick = () => { mascotIdx++; mas.style.backgroundImage = `url(${mascotSrc(mascotIdx)})`; };
  }
  const seg$ = $("segCard");
  if (seg$) {
    const act = complete
      ? async () => { setDone(0); await saveState(); renderIdle(); }
      : () => enterSegment(cur);
    seg$.onclick = act;
    seg$.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } };
  }
  const tse = $("ttSearch"); if (tse) tse.oninput = () => renderTabsInline(tse.value);
  // 动作按钮点击 → gooey 粒子迸发（委托，覆盖合并/清理重复/排序/保留最近 等按钮）
  const ttAct = $("ttActions");
  if (ttAct) ttAct.addEventListener("click", (e) => { const b = e.target.closest(".tt-btn"); if (b) gooeyBurst(b); });
  // 首页后台预取下一段的钩子；好了原地更新横幅，下次开标签就有
  if (!complete && state.key && nextSeg && nextSeg.text && !nextSeg.hook) {
    ensureSummary(cur).then((changed) => {
      if (!changed || !nextSeg.hook) return;
      const st = $("shTitle"); if (st) st.textContent = nextSeg.hook;
      const sc = $("segCard"); if (sc) { sc.title = "这段就讲这个 →"; sc.setAttribute("aria-label", "这段就讲这个 →"); }
    });
  }
  renderUsage();
  refreshTabsUI();
  wireHeatmapCubes();
  (async () => { await reportToday(); renderLeaderboard(); })();
}

// 合并窗口：把其它窗口的标签全部移到当前窗口（非破坏，空窗口自动关闭）
async function mergeWindows() {
  const body = $("ttBody");
  try {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    const cur = await chrome.windows.getCurrent();
    let movedTabs = 0, movedWins = 0;
    for (const w of wins) {
      if (w.id === cur.id) continue;
      const ids = (w.tabs || []).map((t) => t.id);
      if (ids.length) { await chrome.tabs.move(ids, { windowId: cur.id, index: -1 }); movedTabs += ids.length; movedWins++; }
    }
    if (body) body.innerHTML = movedWins
      ? `已合并 <b>${movedWins}</b> 个窗口、<b>${movedTabs}</b> 个标签到当前窗口 ✓`
      : `只有一个窗口，无需合并 ✓`;
    setTimeout(refreshTabsUI, 1800);
  } catch (e) { if (body) body.textContent = "合并失败：" + e; }
}

// 按网站排序：当前窗口里把同域名的标签挪到一起（只改顺序，不建组、不上色）。固定标签不动。
async function sortTabsByDomain() {
  const body = $("ttBody");
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const movable = tabs.filter((t) => !t.pinned);
    const host = (t) => { try { return new URL(t.url).hostname.replace(/^www\./, ""); } catch { return "￿"; } };
    // 稳定排序：先按域名，同域名保持原相对顺序
    const sorted = movable
      .map((t, i) => ({ t, i }))
      .sort((a, b) => host(a.t).localeCompare(host(b.t)) || a.i - b.i)
      .map((x) => x.t);
    const pinned = tabs.length - movable.length; // 固定标签占据最前面的位置
    for (let k = 0; k < sorted.length; k++) {
      await chrome.tabs.move(sorted[k].id, { index: pinned + k });
    }
    if (body) body.innerHTML = `已按网站把 <b>${sorted.length}</b> 个标签排到一起 ✓`;
    setTimeout(refreshTabsUI, 1800);
  } catch (e) { if (body) body.textContent = "排序失败：" + e; }
}

// ---------- 标签页平铺：所有标签按网站分组直接铺在首页，搜索 + 点一下跳过去 ----------
let _tabSheet = [];
function tsHost(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "其它"; } }
// 不该出现在标签管理里的页面：① 新标签页（本扩展/浏览器自带）② 本地调试（localhost / 127.x / file://）
// 新标签页：浏览器原生 chrome://newtab 或本扩展的 newtab.html
function isNewTab(t) {
  const u = t.url || "";
  return /^chrome:\/\/newtab/i.test(u) || /^chrome-extension:\/\/[^/]+\/newtab\.html/i.test(u);
}
function isJunkTab(t) {
  const u = t.url || "";
  if (!u) return false;
  if (isNewTab(t)) return true;                                          // 新标签页
  if (/^file:\/\//i.test(u)) return true;                               // 本地文件调试
  try {
    const h = new URL(u).hostname;
    if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
    if (/^127(\.\d+){1,3}$/.test(h)) return true;                       // 127.x.x.x
    if (/\.local$/i.test(h)) return true;
  } catch {}
  return false;
}
// 工作流的最小串长：从 A 开 B、从 B 开 C…开了 ≥3 个 tab 才当成一个值得整组关的工作流
const WORKFLOW_MIN = 3;

function refreshTabsUI() { renderTabsInline($("ttSearch") ? $("ttSearch").value : ""); scanTabs(); }

// 点动作按钮时从按钮中心炸一圈 gooey 粒子（复刻 React Bits GooeyNav 的 metaball 迸发，纯 JS/CSS）
function gooeyBurst(btn) {
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const box = document.createElement("span");
  box.className = "gooey-burst";
  box.style.left = `${rect.left + rect.width / 2}px`;
  box.style.top = `${rect.top + rect.height / 2}px`;
  document.body.appendChild(box);

  const N = 14, dist = [70, 12], R = 90, animTime = 200, timeVar = 100;
  const colors = [1, 2, 3, 1, 2, 3, 1, 4];
  const noise = (n = 1) => n / 2 - Math.random() * n;
  const getXY = (d, i, tot) => { const a = ((360 + noise(8)) / tot) * i * (Math.PI / 180); return [d * Math.cos(a), d * Math.sin(a)]; };
  let maxT = 0;
  for (let i = 0; i < N; i++) {
    const t = animTime * 2 + noise(timeVar * 2);
    maxT = Math.max(maxT, t);
    const start = getXY(dist[0], N - i, N);
    const end = getXY(dist[1] + noise(7), N - i, N);
    let rot = noise(R / 10); rot = (rot > 0 ? rot + R / 20 : rot - R / 20) * 10;
    const p = document.createElement("span"), pt = document.createElement("span");
    p.className = "gb-particle"; pt.className = "gb-point";
    p.style.setProperty("--gb-sx", `${start[0]}px`);
    p.style.setProperty("--gb-sy", `${start[1]}px`);
    p.style.setProperty("--gb-ex", `${end[0]}px`);
    p.style.setProperty("--gb-ey", `${end[1]}px`);
    p.style.setProperty("--gb-rotate", `${rot}deg`);
    p.style.setProperty("--gb-scale", `${1 + noise(0.2)}`);
    p.style.setProperty("--gb-time", `${t}ms`);
    pt.style.setProperty("--gb-time", `${t}ms`);
    pt.style.setProperty("--gb-color", `var(--gooey-${colors[Math.floor(Math.random() * colors.length)]}, #fff)`);
    p.appendChild(pt); box.appendChild(p);
  }
  setTimeout(() => { box.remove(); }, maxT + 120);
}

// 找「工作流串」（额外视图，不从网站分类里抽走标签）。只认 live openerTabId，
// 且来源标签必须在当前可见列表里——即「真有一个看得见的源 tab 点开了 ≥2 个」才算。
// 从顶端 DFS 成树，树内 ≥WORKFLOW_MIN 个才算一条工作流。
function findWorkflows(tabs) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const parentOf = (t) => (t.openerTabId != null && t.openerTabId !== t.id && byId.has(t.openerTabId) ? t.openerTabId : null);
  const kids = new Map(); // 来源标签id -> 子标签[]（来源必须可见）
  for (const t of tabs) {
    const p = parentOf(t);
    if (p == null) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(t);
  }
  const walk = (t, depth, acc) => {
    acc.push({ rep: t, count: 1, depth });
    (kids.get(t.id) || []).sort((a, b) => a.id - b.id).forEach((k) => walk(k, depth + 1, acc));
  };
  const workflows = [];
  for (const t of tabs) {
    if (parentOf(t) != null) continue; // 不是链路顶端（它有可见来源）→ 由顶端 DFS 时收纳
    if (!kids.has(t.id)) continue;      // 顶端但没开过别的 tab → 不是工作流
    const items = []; walk(t, 0, items);
    if (items.length >= WORKFLOW_MIN) {
      workflows.push({ label: tsHost(t.url), items, closeIds: items.map((it) => it.rep.id), isWorkflow: true });
    }
  }
  return workflows.sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
}

// 按网站：同 URL 去重折叠成 ×N，再按域名归堆，按数量降序；closeIds 收齐该站所有真实 tab（含被折叠的）
// 主域名(eTLD+1 简化版)：bytedance.sg.larkoffice.com → larkoffice.com
function regDomain(host) {
  const p = (host || "").split(".");
  return p.length <= 2 ? (host || "") : p.slice(-2).join(".");
}
// 「同一产品多区域」域名：按主域名合并（飞书 sg/my/us/默认 → 一个 larkoffice.com 组）。
// 其余域名仍按完整 host 分组，避免把 tiktok-row.net 下不同工具(libra/aeolus/holmes)混到一起。
const MERGE_DOMAINS = new Set(["larkoffice.com", "feishu.cn", "larksuite.com", "feishu.net"]);
// 飞书文档类型(取自 URL 路径)：docx/sheets/base/wiki/minutes/file —— 跟图标颜色一一对应，跨区域(sg/us/cn)都准
function larkDocType(url) {
  const m = (url || "").match(/(?:larkoffice\.com|feishu\.cn|larksuite\.com|feishu\.net)\/([a-z]+)\//i);
  if (!m) return "";
  let t = m[1].toLowerCase();
  if (t === "docs") t = "docx"; if (t === "sheet") t = "sheets"; if (t === "bitable") t = "base";
  return t;
}
const LARK_TYPES = new Set(["docx", "sheets", "base", "wiki", "minutes", "file"]);
const LARK_LABEL = { docx: "飞书文档", sheets: "飞书表格", base: "飞书多维表格", wiki: "飞书知识库", minutes: "飞书妙记", file: "飞书文件" };
// 站点别名：把内部工具域名映射成中文名，并把多区域子域名(va/row/eu…)合并成一组。要加新名字往这里加一行。
const SITE_ALIASES = [
  { test: /^aeolus[-.]/i, key: "aeolus", label: "风神看板" },
  { test: /^libra[-.]/i, key: "libra", label: "libra 实验" },
];

// 组内排序键：飞书按文档类型，其余按 favicon URL
function iconSortKey(t) {
  const type = larkDocType(t.url);
  return type ? "1lark:" + type : "2fav:" + (t.favIconUrl || "");
}

function groupTabsBySite(tabs) {
  // ① 先按 url 去重（同一 url 多开合一条）
  const byUrl = new Map();
  for (const t of tabs) {
    const key = t.url || ("__noid__" + t.id); // 没 url 的各算各的
    let e = byUrl.get(key);
    if (!e) { byUrl.set(key, { rep: t, count: 1, ids: [t.id] }); continue; }
    e.count++; e.ids.push(t.id);
    const better = (t.active && !e.rep.active) || (!e.rep.active && (t.lastAccessed || 0) > (e.rep.lastAccessed || 0));
    if (better) e.rep = t;
  }
  // ② 归组：飞书文档按「类型」分组(docx/表格/多维表格…，跨区域同类型合并)；飞书里非文档(如 meego)及其余站点→按完整 host
  const keyOf = (t) => {
    const h = tsHost(t.url), rd = regDomain(h);
    if (MERGE_DOMAINS.has(rd)) { const type = larkDocType(t.url); if (LARK_TYPES.has(type)) return "lark:" + type; }
    const a = SITE_ALIASES.find((x) => x.test.test(h));
    if (a) return "alias:" + a.key;
    return h;
  };
  const m = new Map();
  for (const e of byUrl.values()) {
    const k = keyOf(e.rep);
    if (!m.has(k)) {
      let label = k;
      if (k.startsWith("lark:")) label = LARK_LABEL[k.slice(5)] || k.slice(5);
      else if (k.startsWith("alias:")) { const a = SITE_ALIASES.find((x) => "alias:" + x.key === k); label = a ? a.label : k.slice(6); }
      m.set(k, { label, items: [], closeIds: [], favCount: new Map() });
    }
    const g = m.get(k);
    g.items.push({ rep: e.rep, count: e.count, depth: 0 });
    g.closeIds.push(...e.ids);
    const f = (e.rep.favIconUrl || "").trim();
    if (f) g.favCount.set(f, (g.favCount.get(f) || 0) + 1);
  }
  // ③ 组头图标取组内最常见的 favicon
  const arr = [...m.values()].map((g) => {
    let fav = "", best = 0;
    for (const [f, c] of g.favCount) if (c > best) { best = c; fav = f; }
    // 组内：同类型(同色图标)聚到一起（docx 一片、表格一片、多维表格一片）；同类型内保持原顺序
    g.items.sort((x, y) => iconSortKey(x.rep).localeCompare(iconSortKey(y.rep)));
    return { label: g.label, fav, items: g.items, closeIds: g.closeIds };
  });
  // 排序：同图标聚到一起；聚类之间按总标签数排（大图标聚类在前，飞书这种大组仍靠前）；聚类内大组在前
  const favTotal = new Map();
  for (const g of arr) favTotal.set(g.fav, (favTotal.get(g.fav) || 0) + g.closeIds.length);
  return arr.sort((a, b) =>
    (favTotal.get(b.fav) - favTotal.get(a.fav)) ||           // 大的图标聚类在前
    (a.fav || "￿").localeCompare(b.fav || "￿") ||            // 把同图标的紧挨在一起（无图标的排最后）
    (b.closeIds.length - a.closeIds.length) ||               // 同聚类内：标签多的组在前
    a.label.localeCompare(b.label));
}

function tabRowHTML({ rep: t, count, depth }) {
  const fav = t.favIconUrl ? `<img class="ts-fav" src="${esc(t.favIconUrl)}" alt="">` : `<span class="ts-fav ph"></span>`;
  const dup = count > 1 ? `<span class="ts-dup" title="${count} 个相同标签">×${count}</span>` : "";
  const tip = (t.title || t.url || "") + (count > 1 ? `（${count} 个相同）` : "");
  const ind = depth > 0 ? ` style="margin-left:${Math.min(depth, 4) * 15}px"` : "";
  const x = `<button class="ts-x" data-id="${t.id}" title="关闭标签页" aria-label="关闭">${ICON.close}</button>`;
  return `<div class="ts-tab${t.active ? " cur" : ""}${depth > 0 ? " ts-sub" : ""}" role="button" tabindex="0" data-id="${t.id}" data-win="${t.windowId}" title="${esc(tip)}"${ind}>${fav}<span class="ts-tt">${esc(t.title || t.url || "(无标题)")}</span>${dup}${x}</div>`;
}

// 一张分组卡：工作流卡带「工作流」标 + accent；多标签的卡(工作流 或 同站≥2)头部给「整组关闭」键
function groupCardHTML(g) {
  const n = g.closeIds.length;
  const tag = g.isWorkflow ? `<span class="tg-wf">工作流</span>` : "";
  const closeAll = (g.isWorkflow || n >= 2)
    ? `<button class="tg-close" data-ids="${g.closeIds.join(",")}" title="一键关闭这组 ${n} 个标签" aria-label="关闭整组（${n} 个）">${ICON.close}</button>`
    : "";
  const ghFav = (!g.isWorkflow && g.fav) ? `<img class="tg-fav" src="${esc(g.fav)}" alt="">` : "";
  return `<div class="tg-group${g.isWorkflow ? " wf" : ""}"><div class="tg-head">${tag}${ghFav}<span class="tg-host">${esc(g.label)}</span>${closeAll}</div>` +
    `<div class="tg-grid">${g.items.map(tabRowHTML).join("")}</div></div>`;
}

async function renderTabsInline(filter) {
  const body = $("ttTabs"); if (!body) return;
  try { _tabSheet = await chrome.tabs.query({}); } catch { _tabSheet = []; }
  const q = (filter || "").trim().toLowerCase();
  const tabs = _tabSheet.filter((t) => !isJunkTab(t) && (!q || ((t.title || "") + " " + (t.url || "")).toLowerCase().includes(q)));
  // 网站分类用全量（每个 tab 都在它的网站卡里），排前面；工作流是额外视图，有才追加在后面
  const workflows = findWorkflows(tabs);
  const groups = [...groupTabsBySite(tabs), ...workflows];
  if (!groups.length) { body.innerHTML = `<div class="ts-empty">${q ? "没有匹配的标签页" : "没有标签页"}</div>`; return; }
  // 真 masonry：测高再分列。CSS 多列遇到超高的工作流卡会失衡，故改 JS——
  // 先按真实列宽渲染所有卡量高，再「高的先放、贪心进当前最矮列」，避免任何估算误差。
  const GAP = 14, COL_W = 250, MAX_COLS = 5;
  const cols = Math.min(MAX_COLS, Math.max(1, Math.floor((body.clientWidth + GAP) / (COL_W + GAP))));
  const colEls = [];
  for (let i = 0; i < cols; i++) { const d = document.createElement("div"); d.className = "tt-col"; colEls.push(d); }
  body.innerHTML = "";
  colEls.forEach((c) => body.appendChild(c));
  // 第一遍：全塞第 1 列（此时列宽=最终列宽），测每张卡真实高度
  colEls[0].innerHTML = groups.map(groupCardHTML).join("");
  const measured = [...colEls[0].children].map((el, i) => ({ el, h: el.offsetHeight, wf: !!groups[i].isWorkflow }));
  // 第二遍：网站卡按「图标排序」的顺序放（保留 groupTabsBySite 的顺序，不再按高度重排），
  // 每张贪心进当前最矮列——同图标的卡因此落在相邻位置，列高仍大致均衡。工作流卡按高度均衡接在后面。
  const colH = new Array(cols).fill(0);
  const place = (list) => list.forEach(({ el, h }) => {
    let mi = 0; for (let i = 1; i < cols; i++) if (colH[i] < colH[mi]) mi = i;
    colEls[mi].appendChild(el);
    colH[mi] += h + GAP;
  });
  place(measured.filter((m) => !m.wf));
  place(measured.filter((m) => m.wf).sort((a, b) => b.h - a.h));
  // 窗口变化时重排（列数随宽变），防抖
  if (!renderTabsInline._resizeBound) {
    renderTabsInline._resizeBound = true;
    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => renderTabsInline($("ttSearch") ? $("ttSearch").value : ""), 160); });
  }
  body.querySelectorAll("img.ts-fav, img.tg-fav").forEach((img) => img.addEventListener("error", () => {
    const s = document.createElement("span"); s.className = img.className + " ph"; img.replaceWith(s);
  }));
  const activate = async (el) => {
    const id = Number(el.dataset.id), win = Number(el.dataset.win);
    try { await chrome.tabs.update(id, { active: true }); await chrome.windows.update(win, { focused: true }); } catch {}
  };
  body.querySelectorAll(".ts-tab").forEach((el) => {
    el.onclick = () => activate(el);
    el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(el); } };
  });
  // 单个标签 × 关闭
  body.querySelectorAll(".ts-x").forEach((el) => el.onclick = async (e) => {
    e.stopPropagation();
    try { await chrome.tabs.remove(Number(el.dataset.id)); } catch {}
    refreshTabsUI();
  });
  // 整组一键关闭（工作流 / 同站多页）
  body.querySelectorAll(".tg-close").forEach((el) => el.onclick = async (e) => {
    e.stopPropagation();
    const ids = (el.dataset.ids || "").split(",").map(Number).filter(Boolean);
    try { if (ids.length) await chrome.tabs.remove(ids); } catch {}
    refreshTabsUI();
  });
  // 卡片随鼠标 3D 倾斜（复刻 TiltedCard 的 hover，幅度调小以不影响点行/关闭）
  const TILT = 6; // 最大倾斜角(度)
  body.querySelectorAll(".tg-group").forEach((card) => {
    card.onmousemove = (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;   // -0.5 .. 0.5
      const py = (e.clientY - r.top) / r.height - 0.5;
      card.style.transition = "transform .05s ease-out, box-shadow .25s ease-out";
      card.style.transform = `perspective(900px) rotateX(${(-py * 2 * TILT).toFixed(2)}deg) rotateY(${(px * 2 * TILT).toFixed(2)}deg) scale(1.02)`;
    };
    card.onmouseleave = () => {
      card.style.transition = "transform .25s ease-out, box-shadow .25s ease-out";
      card.style.transform = "";
    };
  });
}

// ---------- 排行榜（团队）：Supabase 邮箱+密码 注册/登录（标准 Auth），只比打卡天数 ----------
const SUPABASE_URL = "https://zvbhpipayitikxurrbjx.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp2YmhwaXBheWl0aWt4dXJyYmp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2NzAxMzMsImV4cCI6MjA5NjI0NjEzM30.Jg5IpFkZ6igBv7pDAO9qdL3-QVkACIikpH_7xrqLYtA";
const sbReady = () => !SUPABASE_URL.includes("YOUR-PROJECT") && !SUPABASE_ANON.includes("YOUR-ANON");

// —— 会话（Supabase Auth token）存 chrome.storage.local ——
function getSess() {
  return new Promise((r) => {
    if (!(window.chrome && chrome.storage)) return r(null);
    chrome.storage.local.get({ "strand.sb": null }, (x) => r(x["strand.sb"]));
  });
}
function setSess(s) { return new Promise((r) => chrome.storage.local.set({ "strand.sb": s }, r)); }
function clearSess() { return new Promise((r) => chrome.storage.local.remove("strand.sb", r)); }
function toSess(j) {
  return {
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)),
    uid: (j.user && j.user.id) || null, email: (j.user && j.user.email) || "",
  };
}

// access_token 快过期就用 refresh_token 换新。
// ⚠️ Supabase 的 refresh_token 是「一次性轮换」：同一个 token 并发刷新，只有第一个成功，
//    其余被判 invalid_grant。新标签页扩展常多标签 + 单页多处调 freshSess → 极易并发，
//    旧实现一失败就 clearSess → 表现为「老是自己退出登录」。两道保险见下。
let _refreshInFlight = null;
async function freshSess() {
  const s = await getSess();
  if (!s) return null;
  if (s.expires_at && s.expires_at * 1000 > Date.now() + 60000) return s; // 还新鲜，直接用
  // ① 同页并发去重：所有调用 await 同一个刷新 Promise，避免自己人抢同一个 token
  if (!_refreshInFlight) _refreshInFlight = doRefresh(s).finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
}
async function doRefresh(s) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.access_token) { const ns = toSess(j); ns.uid = ns.uid || s.uid; await setSess(ns); return ns; }
    // ② 刷新被拒：别的标签页可能刚用同一个 token 抢先换好了 → 重读 storage，若已是新会话就用它
    const cur = await getSess();
    if (cur && cur.refresh_token !== s.refresh_token) return cur;
    await clearSess(); return null; // storage 里还是这个死 token → 真失效才登出
  } catch {
    // 网络抖动等临时错误：绝不登出，保留凭证；返回 storage 里的会话（可能已被别处刷新）
    return (await getSess()) || null;
  }
}

// 带登录态的数据请求（Bearer 用户 JWT，RLS 才认得 auth.uid()）
async function sbFetch(path, opts = {}) {
  const s = await freshSess();
  if (!s) throw new Error("未登录");
  const headers = Object.assign(
    { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: "Bearer " + s.access_token },
    opts.headers || {}
  );
  return fetch(SUPABASE_URL + path, Object.assign({}, opts, { headers }));
}

// 只读请求：匿名也能发（仅 anon key）；登录了就带 Bearer。用于「不登录也能看排行榜」。
// 前提：Supabase 已对 anon 角色放开 players 的 select（见仓库外 strand-private/docs/supabase-setup.sql 末尾「匿名只读」段）。
async function sbRead(path) {
  const s = await freshSess();
  const headers = { apikey: SUPABASE_ANON };
  if (s) headers.Authorization = "Bearer " + s.access_token;
  return fetch(SUPABASE_URL + path, { headers });
}

// 注册 / 登录 / 登出
async function sbSignUp(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST", headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.msg || j.error_description || j.error || "注册失败");
  if (j.access_token) { await setSess(toSess(j)); return true; } // 即时可用
  return false; // 开了邮箱验证 → 要去邮箱确认
}
async function sbSignIn(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.msg || "邮箱或密码不对");
  await setSess(toSess(j));
}
async function sbSignOut() {
  try { await sbFetch("/auth/v1/logout", { method: "POST" }); } catch { /* ignore */ }
  await clearSess();
}

// 头像：裁正方形、压到 128px 的 jpeg dataURL（几 KB，直接进 DB 列，省掉图床）
function fileToAvatar(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const S = 128, c = document.createElement("canvas");
        c.width = c.height = S;
        const s = Math.min(img.width, img.height);
        c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, S, S);
        resolve(c.toDataURL("image/jpeg", 0.72));
      };
      img.onerror = reject; img.src = fr.result;
    };
    fr.onerror = reject; fr.readAsDataURL(file);
  });
}

// 我的 player 行：upsert（user_id 由表默认 auth.uid() 填，存在则更新昵称/头像）
async function upsertMyRow(name, avatar) {
  const r = await sbFetch("/rest/v1/players?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ name, avatar: avatar || null }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || "建资料失败"); }
}

// 本机 AI 时长（分钟）：CC + Codex 的 今日/近7天/累计，来自本地 usage-tracker 服务。
// 没跑服务 / 连不上 → 返回 null（调用方据此「不覆盖」这些列，避免把已有数据清零）。
async function localAiMins() {
  try {
    const r = await fetch(USAGE_BACKEND + "/usage", { cache: "no-store" });
    const j = await r.json();
    if (!j || !j.ok || !j.tools) return null;
    const cc = j.tools.claude, cx = j.tools.codex;
    const sum = (k) => Math.round((Number(cc && cc[k]) || 0) + (Number(cx && cx[k]) || 0));
    return { today: sum("todayMin"), week: sum("weekMin"), total: sum("totalMin") };
  } catch { return null; }
}

// 上报：打卡天数 days、连续 streak、AI 时长 今日/近7天/累计 + 当天日期戳（需已登录）。
// 「今日/近7天」会随时间变，所以节流上报（最多每 3 分钟一次），让榜上当日数保持新鲜。
// 返回 true 表示这次真写了（调用方据此刷新榜）。
async function reportToday(force = false) {
  try {
    if (!sbReady()) return false;
    const s = await freshSess();
    if (!s) return false;
    const now = Date.now();
    const last = await new Promise((r) => chrome.storage.local.get({ lastReportTs: 0 }, (x) => r(Number(x.lastReportTs) || 0)));
    if (!force && now - last < 3 * 60 * 1000) return false; // 节流：最多 3 分钟一次（打卡等事件用 force 绕过）
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const patch = {
      days: (state.days || []).length,
      streak: Number(state.streak) || 0,
      updated_at: new Date().toISOString(),
    };
    const mins = await localAiMins();
    if (mins) { // 只有本机有数据才写时长列，否则保留已有值
      patch.ai_min = mins.total;
      patch.ai_today = mins.today;
      patch.ai_week = mins.week;
      patch.ai_date = today; // 新鲜度戳：读榜时只认 ai_date==今天 的今日/近7天值
    }
    const r = await sbFetch(`/rest/v1/players?user_id=eq.${s.uid}`, {
      method: "PATCH", body: JSON.stringify(patch),
    });
    if (r.ok) { chrome.storage.local.set({ lastReportTs: now }); return true; }
    return false;
  } catch { return false; }
}

// ---------- 排行榜 UI：未登录→登录/注册；已登录无资料→补昵称头像；否则读榜 ----------
function fmtDays(n) { return Math.max(0, Math.round(n || 0)); }

// 退出登录图标（lucide:log-out，线性，弱化用）
const ICON_LOGOUT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 17l5-5l-5-5m5 5H9m0 9H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></svg>`;

// 单个名次的数值显示（带小单位 <i>）：streak→「N 天」，ai→按时长（<60 分显「N 分」，否则「N 时」）
function lbStatHTML(metric, p) {
  if (metric === "ai") {
    const m = Math.max(0, Math.round((lbAiRange === "week" ? p.aiWeek : p.aiToday) || 0));
    if (m < 60) return `${m}<i>分</i>`;
    const h = Math.floor(m / 60), rem = m % 60; // 紧凑「时+分」：满整时不缀「0分」
    return rem ? `${h}<i>时</i>${rem}<i>分</i>` : `${h}<i>时</i>`;
  }
  return `${fmtDays(p.streak)}<i>天</i>`;
}

// 奖牌图标（ri:medal-fill：绶带+圆牌+五角星）。金/银/铜各带竖向金属渐变（上亮→中本色→下暗）。
// 渐变 id 按 metric+rank 唯一，避免两个榜同名 id；fill 末尾带 solid 兜底色。
const MEDAL_PATH = "M12 7a8 8 0 1 1 0 16a8 8 0 0 1 0-16m0 3.5l-1.322 2.68l-2.958.43l2.14 2.085l-.505 2.946L12 17.25l2.645 1.39l-.505-2.945l2.14-2.086l-2.958-.43zm1-8.501L18 2v3l-1.363 1.138A9.9 9.9 0 0 0 13 5.05zm-2 0v3.05a9.9 9.9 0 0 0-3.636 1.088L6 5V2z";
const MEDAL_GRADS = {
  1: ["#F6D375", "#E3A81B", "#C6890C"], // 金
  2: ["#E6EAEE", "#A6ACB3", "#868C93"], // 银
  3: ["#DDA074", "#B5743A", "#93592A"], // 铜
};
function medalSVG(metric, rank) {
  const g = MEDAL_GRADS[rank] || MEDAL_GRADS[1];
  const id = `mg-${metric}-${rank}`;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${g[0]}"/><stop offset=".55" stop-color="${g[1]}"/><stop offset="1" stop-color="${g[2]}"/></linearGradient></defs><path fill="url(#${id}) ${g[1]}" d="${MEDAL_PATH}"/></svg>`;
}

// 渲染单个榜（streak / ai）到指定容器：按该指标降序，前10 + 不在前列的「你」补一行
function renderBoard(container, metric, players) {
  if (!container) return;
  const valOf = (p) => metric === "ai" ? (lbAiRange === "week" ? p.aiWeek : p.aiToday) : p.streak;
  const sorted = players.slice().sort((a, b) => valOf(b) - valOf(a));
  const row = (p, rank) => {
    const initial = ((p.name || "?").trim()[0]) || "?";
    const ava = p.avatar
      ? `<img class="ava" src="${esc(p.avatar)}" data-fb="${esc(initial)}" alt="">`
      : `<span class="ava">${esc(initial)}</span>`;
    const zero = valOf(p) <= 0;
    const medal = rank <= 3 && !zero; // 前三且有成绩才发奖牌（0 分不发金牌）
    const rankCell = medal
      ? `<span class="rank medal" title="第 ${rank} 名">${medalSVG(metric, rank)}</span>`
      : `<span class="rank${zero ? " zero" : ""}">${zero ? "–" : rank}</span>`; // 0 分不算名次，显示「–」
    return `<div class="lrow${medal ? " top" : ""}${p.me ? " me" : ""}">
        ${rankCell}${ava}
        <span class="lname">${esc(p.name || "匿名")}</span>
        <span class="lstat${zero ? "" : " on"}">${lbStatHTML(metric, p)}</span>
      </div>`;
  };
  const TOP = 10; // 小队伍全显示；超过 10 人才折叠成「前10 + 你」
  const meIdx = sorted.findIndex((p) => p.me);
  let html = sorted.slice(0, TOP).map((p, i) => row(p, i + 1)).join("");
  if (meIdx >= TOP) html += `<div class="lgap"></div>` + row(sorted[meIdx], meIdx + 1);
  container.innerHTML = html;
  container.querySelectorAll("img.ava").forEach((img) => img.addEventListener("error", () => {
    const sp = document.createElement("span"); sp.className = "ava"; sp.textContent = img.dataset.fb || "?"; img.replaceWith(sp);
  }));
}

// 头像选择器（注册/补资料共用）：返回读取当前 dataURL 的 getter
function bindAvatar() {
  let avatar = "";
  const f = $("lbAvaFile");
  if (f) f.addEventListener("change", async () => {
    const file = f.files && f.files[0]; if (!file) return;
    try { avatar = await fileToAvatar(file); const p = $("lbAva"); if (p) p.style.backgroundImage = `url(${avatar})`; const t = $("lbAvaTxt"); if (t) t.textContent = ""; }
    catch { /* ignore */ }
  });
  return () => avatar;
}

// 登录 / 注册 表单（mode: login | register）
function renderAuth(rows, foot, mode) {
  const reg = mode === "register";
  rows.innerHTML = `<div class="lb-auth">
      ${reg ? `<label class="lb-ava-pick" id="lbAva"><span id="lbAvaTxt">＋头像</span><input type="file" accept="image/*" id="lbAvaFile" hidden></label>` : ``}
      <div class="lb-field">
        <input class="lb-input" id="lbEmail" type="email" placeholder=" " autocomplete="username">
        <label class="lb-label" for="lbEmail">邮箱</label>
      </div>
      <div class="lb-field">
        <input class="lb-input" id="lbPw" type="password" placeholder=" " autocomplete="${reg ? "new-password" : "current-password"}">
        <label class="lb-label" for="lbPw">密码（至少 6 位）</label>
      </div>
      ${reg ? `<div class="lb-field"><input class="lb-input" id="lbNick" maxlength="24" placeholder=" "><label class="lb-label" for="lbNick">昵称</label></div>` : ``}
      <button class="lb-login" id="lbGo"><span>${reg ? "注册并上榜" : "登录"}</span></button>
      <a class="lb-switch" id="lbSwitch">${reg ? "已有账号？登录" : "第一次？去注册"}</a>
    </div>`;
  const getAvatar = reg ? bindAvatar() : () => "";
  const sw = $("lbSwitch"); if (sw) sw.onclick = () => renderAuth(rows, foot, reg ? "login" : "register");
  const go = $("lbGo");
  if (go) go.onclick = async () => {
    const email = (($("lbEmail") || {}).value || "").trim();
    const pw = (($("lbPw") || {}).value || "");
    if (!email || !pw) { if (foot) foot.textContent = "填邮箱和密码"; return; }
    go.disabled = true; go.innerHTML = `<span>${reg ? "注册中…" : "登录中…"}</span>`;
    try {
      if (reg) {
        const nick = (($("lbNick") || {}).value || "").trim();
        if (!nick) throw new Error("填个昵称");
        const ok = await sbSignUp(email, pw);
        if (!ok) { if (foot) foot.textContent = "注册成功，去邮箱点确认链接后回来登录"; go.disabled = false; go.innerHTML = `<span>注册并上榜</span>`; return; }
        await upsertMyRow(nick, getAvatar());
      } else {
        await sbSignIn(email, pw);
      }
      if (foot) foot.textContent = "";
      closeAuthModal();
      await reportToday(true); await renderLeaderboard(); // 登录/注册即强制同步本地 streak（绕过节流，焊死「先打卡后登录」）
    } catch (e) {
      go.disabled = false; go.innerHTML = `<span>${reg ? "注册并上榜" : "登录"}</span>`;
      if (foot) foot.textContent = (e && e.message) || String(e);
    }
  };
}

// 已登录但还没建资料 → 补昵称 + 头像
function renderProfile(rows, foot) {
  rows.innerHTML = `<div class="lb-auth">
      <label class="lb-ava-pick" id="lbAva"><span id="lbAvaTxt">＋头像</span><input type="file" accept="image/*" id="lbAvaFile" hidden></label>
      <div class="lb-field">
        <input class="lb-input" id="lbNick" maxlength="24" placeholder=" ">
        <label class="lb-label" for="lbNick">昵称</label>
      </div>
      <button class="lb-login" id="lbGo"><span>上榜</span></button>
      <a class="lb-switch" id="lbSwitch">退出登录</a>
    </div>`;
  const getAvatar = bindAvatar();
  const sw = $("lbSwitch"); if (sw) sw.onclick = async () => { await sbSignOut(); closeAuthModal(); renderLeaderboard(); };
  const go = $("lbGo");
  if (go) go.onclick = async () => {
    const nick = (($("lbNick") || {}).value || "").trim();
    if (!nick) { if (foot) foot.textContent = "填个昵称"; return; }
    go.disabled = true; go.innerHTML = `<span>上榜中…</span>`;
    try { await upsertMyRow(nick, getAvatar()); closeAuthModal(); await reportToday(true); await renderLeaderboard(); }
    catch (e) { go.disabled = false; go.innerHTML = `<span>上榜</span>`; if (foot) foot.textContent = (e && e.message) || String(e); }
  };
}

// 打开/关闭登录弹窗（登录/注册表单收进弹窗，不再占用榜单界面）
function openAuthModal(mode) {
  const m = $("authMask"); if (!m) return;
  const body = $("authBody"), foot = $("authFoot");
  if (foot) foot.textContent = "";
  if (mode === "profile") renderProfile(body, foot);
  else renderAuth(body, foot, mode || "login");
  m.classList.add("show");
  setTimeout(() => { const e = $("lbEmail") || $("lbNick"); if (e) e.focus(); }, 40);
}
function closeAuthModal() { const m = $("authMask"); if (m) m.classList.remove("show"); }

let lbAiRange = "today";   // AI 时长榜口径：today | week（点标题旁的小标签切换）
let lbPlayersCache = [];   // 最近一次读到的榜，供切口径时本地重渲（不重新拉网）
// 「AI 时长」标题旁的「今日/近7天」小标签：点一下切换口径，只重渲 AI 榜
function bindAiRangeTag() {
  const el = $("lbAiRangeBtn");
  if (!el || el.dataset.bound) return;
  el.dataset.bound = "1";
  el.onclick = () => {
    lbAiRange = lbAiRange === "week" ? "today" : "week";
    syncAiRangeTag();
    renderBoard($("lbRowsAi"), "ai", lbPlayersCache);
  };
}
function syncAiRangeTag() {
  const el = $("lbAiRangeBtn"); if (!el) return;
  const t = el.querySelector(".lrt-t"); if (t) t.textContent = lbAiRange === "week" ? "近7天" : "今日";
  el.classList.toggle("on", lbAiRange === "week");
}
async function renderLeaderboard() {
  const cStreak = $("lbRowsStreak"), cAi = $("lbRowsAi");
  if (!cStreak || !cAi) return;
  bindAiRangeTag(); syncAiRangeTag();
  const foot = $("lbFoot");
  const auth = $("lbAuth");
  const setBoth = (html) => { cStreak.innerHTML = html; cAi.innerHTML = html; };

  if (!sbReady()) {
    setBoth(`<div class="usage-skel">排行榜还没接数据源</div>`);
    if (foot) foot.textContent = ""; if (auth) auth.innerHTML = ""; return;
  }

  const s = await freshSess(); // null = 匿名，仍可看榜

  // 右下角小控件：未登录→「登录」(开弹窗)；已登录→退出 icon（点一下变「确认退出」，再点才真退；3 秒不点复原）
  if (auth) {
    if (s) {
      auth.innerHTML = `<button class="lb-logout" id="lbLogout" title="退出登录" aria-label="退出登录">${ICON_LOGOUT}</button>`;
      const lo = $("lbLogout");
      if (lo) {
        let armed = false, timer = null;
        const reset = () => { armed = false; lo.classList.remove("confirm"); lo.innerHTML = ICON_LOGOUT; lo.title = "退出登录"; };
        lo.onclick = async () => {
          if (!armed) { armed = true; lo.classList.add("confirm"); lo.textContent = "确认退出"; lo.title = "再点一次确认退出"; timer = setTimeout(reset, 3000); return; }
          clearTimeout(timer); await sbSignOut(); renderLeaderboard();
        };
      }
    } else {
      auth.innerHTML = `<button class="lb-loginbtn" id="lbLoginBtn">登录</button>`;
      const li = $("lbLoginBtn"); if (li) li.onclick = () => openAuthModal("login");
    }
  }

  // 读榜：匿名也读（需 Supabase 已对 anon 放开 players 的 select；没放开则匿名读不到 → 提示登录）
  // 一次拿齐两套指标的列，两个榜各自排序
  let data = null;
  try {
    // 优先取带时长窗口的新列；列还没建（迁移 SQL 没跑）则回退旧列，避免整张榜挂掉
    let r = await sbRead(`/rest/v1/players?select=user_id,name,avatar,streak,ai_today,ai_week,ai_min,ai_date`);
    if (!r.ok) r = await sbRead(`/rest/v1/players?select=user_id,name,avatar,streak,ai_min`);
    if (r.ok) data = await r.json();
  } catch { /* 落到下面空态 */ }
  if (!Array.isArray(data)) {
    setBoth(`<div class="usage-skel">${s ? "连不上排行榜" : "登录后查看排行榜"}</div>`);
    if (foot) foot.textContent = ""; return;
  }

  const uid = s && s.uid;
  const dd = new Date();
  const dkey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const todayStr = dkey(dd);
  const weekAgoStr = dkey(new Date(dd.getFullYear(), dd.getMonth(), dd.getDate() - 7)); // 7 天前
  const players = data.map((p) => {
    // 今日值必须当天报的（昨天的「今日」对今天无意义）；近7天值只要 7 天内报过就算（周窗口仍重叠、不应清零）
    const freshToday = p.ai_date === todayStr;
    const freshWeek = !!p.ai_date && p.ai_date >= weekAgoStr;
    return {
      name: p.name || "匿名", avatar: p.avatar || "",
      streak: Number(p.streak) || 0,
      aiToday: freshToday ? (Number(p.ai_today) || 0) : 0,
      aiWeek: freshWeek ? (Number(p.ai_week) || 0) : 0,
      me: p.user_id === uid,
    };
  });
  if (!players.length) { setBoth(`<div class="usage-skel">还没有人上榜</div>`); if (foot) foot.textContent = ""; return; }

  lbPlayersCache = players;
  renderBoard(cStreak, "streak", players);
  renderBoard(cAi, "ai", players);

  // 登录了但还没建资料 → 不挡榜，底部给「去上榜」入口（开弹窗补昵称头像）
  if (foot) {
    if (s && players.findIndex((p) => p.me) < 0) {
      foot.innerHTML = `<a class="lb-switch" id="lbProfileLink" style="margin:0">补个昵称头像就上榜 →</a>`;
      const pl = $("lbProfileLink"); if (pl) pl.onclick = () => openAuthModal("profile");
    } else {
      foot.textContent = "";
    }
  }
}

// ---------- 标签页清理 ----------
// 两个动作：① 清理重复(URL 完全相同，每组留最近用过的一个) ② 只留最近用的 20%(按 lastAccessed)
// 通则：跳过 pinned 与当前这个新标签页；范围=所有窗口；都先显示数量再确认。
async function getTabsState() {
  let tabs, current = null;
  try {
    tabs = await chrome.tabs.query({});
    current = await chrome.tabs.getCurrent(); // 当前新标签页，绝不关
  } catch (e) { return { error: e, eligible: [] }; }
  // 没有『标签页』权限时 url 会全为空 —— 报需要重载，而不是误报
  if (tabs.length && tabs.every((t) => !t.url)) return { needReload: true, eligible: [] };
  const eligible = tabs.filter((t) => !t.pinned && t.url && !isJunkTab(t) && !(current && t.id === current.id));
  // 多余的新标签页：所有新标签里，留一个(优先当前这个)，其余算重复
  const newtabs = tabs.filter((t) => !t.pinned && isNewTab(t));
  let keepId = current && isNewTab(current) ? current.id : null;
  if (keepId == null && newtabs.length) keepId = newtabs.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0].id;
  const newtabExtras = newtabs.filter((t) => t.id !== keepId).map((t) => t.id);
  return { eligible, total: tabs.length, newtabExtras };
}

// 「清理重复」要关的全部 id：同 URL 重复 + 多余的新标签页(只留一个)
function dupCleanIds(s) {
  return [...dupIdsFrom(s.eligible || []), ...(s.newtabExtras || [])];
}

function dupIdsFrom(eligible) {
  const byUrl = new Map();
  for (const t of eligible) {
    let arr = byUrl.get(t.url);
    if (!arr) byUrl.set(t.url, (arr = []));
    arr.push(t);
  }
  const ids = [];
  for (const group of byUrl.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)); // 留最近用过的
    ids.push(...group.slice(1).map((t) => t.id));
  }
  return ids;
}

function lru80IdsFrom(eligible) {
  const e = eligible.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const keep = Math.max(1, Math.ceil(e.length * 0.2)); // 留最近 20%，至少 1 个
  return e.slice(keep).map((t) => t.id);
}

async function scanTabs() {
  const body = $("ttBody"), count = $("ttCount"), actions = $("ttActions");
  if (!body) return;
  const clear = (msg) => { body.textContent = msg; if (count) count.textContent = ""; if (actions) actions.innerHTML = ""; };
  if (!(window.chrome && chrome.tabs && chrome.tabs.query)) return clear("需要『标签页』权限。去 chrome://extensions 重载扩展后生效。");

  const s = await getTabsState();
  if (s.needReload) return clear("需要『标签页』权限。去 chrome://extensions 点重新加载后生效。");
  if (s.error) return clear("读取标签页失败：" + s.error);

  const e = s.eligible;
  const dup = dupCleanIds(s);
  const lru = lru80IdsFrom(e);
  if (count) count.textContent = `共 ${e.length} 个`;
  body.innerHTML = "";

  // 固定顺序：合并窗口 → 清理重复 → 标签排序 → 保留最近 20%（清理类带「将关闭 N」徽章）
  const badge = (n) => `<span class="tt-badge" title="将关闭 ${n} 个">${n}</span>`;
  let btns = `<button class="tt-btn" id="ttMerge">${ICON.merge}合并窗口</button>`;
  if (dup.length) btns += `<button class="tt-btn" id="ttDup">${ICON.dedup}清理重复${badge(dup.length)}</button>`;
  btns += `<button class="tt-btn" id="ttSort">${ICON.sort}标签排序</button>`;
  if (lru.length) btns += `<button class="tt-btn" id="ttLru">${ICON.recent}保留最近 20%${badge(lru.length)}</button>`;
  actions.innerHTML = btns;

  $("ttMerge").onclick = mergeWindows;
  $("ttSort").onclick = sortTabsByDomain;
  // 清理重复：安全(同 URL 留最近用过的一个 + 多余新标签只留一个)，直接执行、不弹确认
  if ($("ttDup")) $("ttDup").onclick = () => executeClean(
    async () => dupCleanIds(await getTabsState()));
  // 保留最近 20%：要关一大批、破坏性强，保留二次确认
  if ($("ttLru")) $("ttLru").onclick = () => confirmClean(lru.length, "（只留最近 20%）",
    async () => lru80IdsFrom((await getTabsState()).eligible || []));
}

// 「粉碎」动效：把被关的标签条逐条砸碎 + 喷碎屑（复用 gooeyBurst），返回动画总时长的 Promise
function crushRows(ids) {
  const rows = ids.map((id) => document.querySelector(`.ts-tab[data-id="${id}"]`)).filter(Boolean);
  if (!rows.length) return Promise.resolve();
  const step = rows.length > 8 ? 28 : 55; // 标签多就加快错峰，别拖太长；少则慢一点更有「连环碎」的爽感
  rows.forEach((el, i) => setTimeout(() => { el.classList.add("crushing"); gooeyBurst(el); }, i * step));
  return new Promise((r) => setTimeout(r, (rows.length - 1) * step + 360));
}

// 真正执行关闭：关之前重新扫一遍，防止期间有变化
async function executeClean(recompute) {
  const ids = await recompute();
  try {
    await crushRows(ids);                 // 先「粉碎」给你看（爽），动画跑完再真正关掉
    if (ids.length) await chrome.tabs.remove(ids);
    const body = $("ttBody");
    if (body) body.innerHTML = `已关闭 <b>${ids.length}</b> 个标签页 ✓`;
    if ($("ttActions")) $("ttActions").innerHTML = "";
    if ($("ttCount")) $("ttCount").textContent = "";
    setTimeout(refreshTabsUI, 1500);
  } catch (e) {
    const body = $("ttBody");
    if (body) body.textContent = "关闭失败：" + e;
  }
}

function confirmClean(n, what, recompute) {
  const actions = $("ttActions");
  actions.innerHTML =
    `<span class="tt-confirm">将关闭 ${n} 个标签页${what}，确定？</span>
     <button class="tt-btn danger" id="ttYes">关闭 ${n} 个</button>
     <button class="tt-btn ghost" id="ttNo">取消</button>`;
  $("ttNo").onclick = refreshTabsUI;
  $("ttYes").onclick = () => executeClean(recompute);
}

// ---------- 使用统计卡（CC/Codex 来自本地服务 8788；Chrome 来自后台 service worker） ----------
const USAGE_BACKEND = "http://127.0.0.1:8788";
let usageRange = "today";   // today | week | total
let goalEditing = false;
let usageBarsOpen = false;   // 每日时长柱状图：默认收起，点「AI 用量」展开/收起（状态持久化）
function loadUsageBarsOpen() {
  return new Promise((r) => {
    try { chrome.storage.local.get({ usageBarsOpen: false }, (x) => { usageBarsOpen = !!(x && x.usageBarsOpen); r(); }); }
    catch { try { usageBarsOpen = JSON.parse(localStorage.getItem("usageBarsOpen") || "false"); } catch { /* ignore */ } r(); }
  });
}
function saveUsageBarsOpen() {
  try { chrome.storage.local.set({ usageBarsOpen }); } catch { /* ignore */ }
  try { localStorage.setItem("usageBarsOpen", JSON.stringify(usageBarsOpen)); } catch { /* ignore */ }
}
// 目标：每日基准。近7天 ×7、累计 ×30 缩放时长/Token；回本是比率，各周期目标恒定
const GOAL_DEFAULTS = { timeHrs: 3, tokM: 1, be: 200 };
let usageGoals = { ...GOAL_DEFAULTS };
// 三环配色（外=时长 中=Token 内=回本），与图例小点一致
const RING = { time: "oklch(0.72 0.155 62)", token: "oklch(0.60 0.17 256)", be: "oklch(0.70 0.15 150)" };
function loadGoals() {
  return new Promise((r) => {
    try { chrome.storage.local.get({ usageGoals: null }, (x) => { if (x && x.usageGoals) usageGoals = { ...GOAL_DEFAULTS, ...x.usageGoals }; r(); }); }
    catch { try { const j = JSON.parse(localStorage.getItem("usageGoals") || "null"); if (j) usageGoals = { ...GOAL_DEFAULTS, ...j }; } catch {} r(); }
  });
}
function saveGoals() {
  try { chrome.storage.local.set({ usageGoals }); } catch {}
  try { localStorage.setItem("usageGoals", JSON.stringify(usageGoals)); } catch {}
}

function fmtDur(min) {
  min = Math.max(0, Math.round(min || 0));
  if (min < 60) return min + " 分钟";
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}
// 三同心环（仿 Apple Watch 活动环）：每环 track + 进度弧，圆角端、从 12 点顺时针、超额封顶满环
function ringSVG(items) {
  const SW = 9;
  const arcs = items.map(({ r, color, p }) => {
    const c = 2 * Math.PI * r, prog = Math.max(0, Math.min(1, p || 0)); // 满圈封顶：超 100% 只画满，不标溢出
    return `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-opacity=".16" stroke-width="${SW}"/>` +
      `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="${SW}" stroke-linecap="round" ` +
      `stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - prog)).toFixed(2)}" transform="rotate(-90 50 50)"/>`;
  }).join("");
  return `<svg class="rings" viewBox="0 0 100 100" width="150" height="150" aria-hidden="true">${arcs}</svg>`;
}
function fmtTok(n) {
  n = Math.round(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}
function fmtMoney(n) {
  n = n || 0;
  if (n >= 100) return "$" + Math.round(n).toLocaleString();
  if (n >= 1) return "$" + n.toFixed(1);
  return "$" + n.toFixed(2);
}
let usageSub = 0; // 订阅基准（$/月），来自服务端 pricing.json

// 柱状图悬停提示：自定义浮层（替换原生 title 那个灰框）。深色暖药丸 + 指向柱子的小尖角。
let _barTip = null;
function ensureBarTip() {
  if (!_barTip) { _barTip = document.createElement("div"); _barTip.className = "ubar-tip"; document.body.appendChild(_barTip); }
  return _barTip;
}
function hideBarTip() { if (_barTip) _barTip.classList.remove("show"); }
function wireBarHover() {
  const host = $("usageRows"); if (!host || host.dataset.tipBound) return;
  host.dataset.tipBound = "1";
  host.addEventListener("mouseover", (e) => {
    const b = e.target.closest(".ubar"); if (!b || !b.dataset.d) return;
    const tip = ensureBarTip();
    tip.innerHTML = `<span class="ut-d">${b.dataset.d}</span><b class="ut-t">${b.dataset.t}</b>` +
      (b.dataset.s ? `<span class="ut-s">${b.dataset.s}</span>` : "");
    tip.classList.add("show");
    // 锚到可见柱子（.ubar-stack）的顶，而非整列（.ubar 占满图高）——否则矮柱子浮层会飘在图顶离得很远
    const anchor = b.querySelector(".ubar-stack") || b;
    const r = anchor.getBoundingClientRect(), tr = tip.getBoundingClientRect();
    let x = r.left + r.width / 2 - tr.width / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - tr.width - 8));      // 贴边不溢出
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(r.top - tr.height - 9)}px`;
    const caret = Math.max(9, Math.min(r.left + r.width / 2 - x, tr.width - 9)); // 尖角始终指向该柱
    tip.style.setProperty("--caret", `${Math.round(caret)}px`);
  });
  host.addEventListener("mouseout", (e) => { if (e.target.closest(".ubar")) hideBarTip(); });
}

// 近 N 天每日 AI 时长柱状图（Claude + Codex 堆叠）。数据来自 /usage 每个工具的 daily{日期:分钟}。
// main=true：作为「趋势」主视图替换圆环（更高、撑满圆环那块的高度）。
function dailyBars(claude, codex, N = 14, main = false) {
  const cd = (claude && claude.daily) || {}, xd = (codex && codex.daily) || {};
  const p2 = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const days = [];
  for (let i = N - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const cc = cd[key] || 0, cx = xd[key] || 0;
    days.push({ d, cc, cx, total: cc + cx });
  }
  if (!days.some((x) => x.total > 0)) return ""; // 近 N 天无记录 → 不画
  const max = Math.max(...days.map((x) => x.total));
  const fm = (m) => m >= 60 ? `${Math.floor(m / 60)}时${m % 60 ? `${m % 60}分` : ""}` : `${m}分`;
  const lbl = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  const bars = days.map((x) => {
    const dd = lbl(x.d);
    const tt = x.total ? fm(x.total) : "无记录";
    const ss = (x.cc && x.cx) ? `Claude ${fm(x.cc)} · Codex ${fm(x.cx)}` : "";
    const hStyle = x.total ? `height:max(3px, ${((x.total / max) * 100).toFixed(1)}%)` : "height:0";
    return `<div class="ubar" data-d="${dd}" data-t="${tt}"${ss ? ` data-s="${ss}"` : ""}><div class="ubar-stack" style="${hStyle}">` +
      `<span class="useg cx" style="flex:${x.cx}"></span><span class="useg cc" style="flex:${x.cc}"></span></div></div>`;
  }).join("");
  return `<div class="ubars${main ? " ubars-main" : ""}">
      <div class="ubars-head"><span class="ubars-title">近 ${N} 天 · 每日时长</span>
        <span class="ubars-leg"><i class="ud cc"></i>Claude<i class="ud cx"></i>Codex</span></div>
      <div class="ubars-plot">${bars}</div>
      <div class="ubars-x"><span>${lbl(days[0].d)}</span><span>${lbl(days[N - 1].d)}</span></div>
    </div>`;
}

async function renderUsage() {
  const rowsEl = $("usageRows"); if (!rowsEl) return;

  // 本地服务（CC/Codex）
  let server = null, serverErr = false;
  try {
    const r = await fetch(USAGE_BACKEND + "/usage", { cache: "no-store" });
    server = await r.json();
    if (server && server.ok) usageSub = server.subscriptionMonthly || 0;
  } catch { serverErr = true; }

  const data = {
    claude: server && server.ok ? server.tools.claude : null,
    codex: server && server.ok ? server.tools.codex : null,
  };

  // 合并 Claude Code + Codex 为「AI 编程」，时长/Token/费用 三项做成同心环
  const minKey = usageRange === "today" ? "todayMin" : usageRange === "week" ? "weekMin" : "totalMin";
  const suf = usageRange === "today" ? "Today" : usageRange === "week" ? "Week" : "Total";
  const cc = data.claude, cx = data.codex;
  const sum = (a, b) => (Number(a) || 0) + (Number(b) || 0);
  const hasAI = !!(cc || cx);
  const aiMin = sum(cc && cc[minKey], cx && cx[minKey]);
  const aiTok = sum(cc && cc["tok" + suf], cx && cx["tok" + suf]);
  const aiCost = sum(cc && cc["cost" + suf], cx && cx["cost" + suf]);
  const aiCache = sum(cc && cc["cache" + suf], cx && cx["cache" + suf]);

  // 目标（每日基准；近7天 ×7、累计 ×30 缩放时长/Token；回本是比率，目标恒定）
  const PF = usageRange === "today" ? 1 : usageRange === "week" ? 7 : 30;
  const goalMin = usageGoals.timeHrs * 60 * PF;
  const goalTok = usageGoals.tokM * 1e6 * PF;
  const goalBe = usageGoals.be;
  const daily = usageSub / 30;
  const beBase = usageRange === "today" ? daily : usageRange === "week" ? daily * 7 : usageSub;
  const beMult = beBase > 0 ? aiCost / beBase : 0;
  // 回本依据：API 等价成本 vs 订阅摊销 —— 直接挂在「回本」环后面，不再单列横幅
  const subLabel = usageRange === "today" ? `订阅 ${fmtMoney(daily)}/天`
    : usageRange === "week" ? `订阅 ${fmtMoney(daily * 7)}/周` : `订阅 ${fmtMoney(usageSub)}/月`;
  const beBasis = (!hasAI || !usageSub || beBase <= 0) ? ""
    : aiCost >= beBase ? `${fmtMoney(aiCost)} API 等价 vs ${subLabel}`
    : `${fmtMoney(aiCost)} / ${subLabel}，还差 ${fmtMoney(beBase - aiCost)}`;

  // 「目标」按钮：绑定一次，切换编辑态
  const goalBtn = $("goalEdit");
  if (goalBtn && !goalBtn.dataset.bound) {
    goalBtn.dataset.bound = "1";
    goalBtn.onclick = () => { goalEditing = !goalEditing; renderUsage(); };
  }
  if (goalBtn) goalBtn.classList.toggle("on", goalEditing);

  // 「AI 用量」点击：展开/收起每日柱状图（绑定一次，状态持久化）
  const barsBtn = $("usageToggle");
  if (barsBtn && !barsBtn.dataset.bound) {
    barsBtn.dataset.bound = "1";
    barsBtn.onclick = () => { usageBarsOpen = !usageBarsOpen; saveUsageBarsOpen(); renderUsage(); };
  }
  if (barsBtn) barsBtn.classList.toggle("on", usageBarsOpen);

  // 编辑态：表单替换环；底部清空
  if (goalEditing) {
    rowsEl.innerHTML =
      `<div class="goal-form">
         <div class="gf-row"><label>每日时长目标</label><span class="gf-in"><input id="gTime" type="number" min="0" step="0.5" value="${usageGoals.timeHrs}"><i>小时</i></span></div>
         <div class="gf-row"><label>每日 Token 目标</label><span class="gf-in"><input id="gTok" type="number" min="0" step="0.1" value="${usageGoals.tokM}"><i>M</i></span></div>
         <div class="gf-row"><label>回本目标</label><span class="gf-in"><input id="gBe" type="number" min="1" step="10" value="${usageGoals.be}"><i>倍</i></span></div>
         <div class="gf-note">近7天目标 = 每日 ×7，累计 ×30；回本是比率，各周期恒定。</div>
         <div class="gf-actions"><button class="tt-btn ghost" id="gCancel">取消</button><button class="tt-btn" id="gSave">保存</button></div>
       </div>`;
    const footE0 = $("usageFoot"); if (footE0) footE0.textContent = "";
    const cancel = $("gCancel"); if (cancel) cancel.onclick = () => { goalEditing = false; renderUsage(); };
    const save = $("gSave"); if (save) save.onclick = () => {
      const num = (id, d) => { const v = parseFloat(($(id) || {}).value); return isFinite(v) && v > 0 ? v : d; };
      usageGoals = { timeHrs: num("gTime", GOAL_DEFAULTS.timeHrs), tokM: num("gTok", GOAL_DEFAULTS.tokM), be: Math.round(num("gBe", GOAL_DEFAULTS.be)) };
      saveGoals();
      goalEditing = false; renderUsage();
    };
    bindUsageTabs("usageTabs", "range", (v) => { usageRange = v; });
    return;
  }

  // 三同心环（外=时长 中=Token 内=回本）+ 右侧图例
  const rings = ringSVG([
    { r: 41, color: RING.time,  p: goalMin ? aiMin / goalMin : 0 },
    { r: 30, color: RING.token, p: goalTok ? aiTok / goalTok : 0 },
    { r: 19, color: RING.be,    p: goalBe ? beMult / goalBe : 0 },
  ]);
  const legRow = (color, k, v, g) =>
    `<div class="rleg"><span class="rdot" style="background:${color}"></span><span class="rl-k">${k}</span><b class="rl-v">${v}</b><i class="rl-g">/ ${g}</i></div>`;
  const legend =
    legRow(RING.time,  "时长",  hasAI ? fmtDur(aiMin) : "—", fmtDur(goalMin)) +
    legRow(RING.token, "Token", hasAI ? fmtTok(aiTok) : "—", fmtTok(goalTok)) +
    legRow(RING.be,    "回本",  hasAI ? Math.round(beMult) + "x" : "—", goalBe + "x") +
    (beBasis ? `<div class="rleg-sub">${beBasis}</div>` : "");

  // 趋势态：柱状图替换圆环（占同一块、卡片不变高）；否则显示三同心环 + 图例
  const ringView = `<div class="ring-wrap"><div class="ring-box">${rings}</div><div class="ring-legend">${legend}</div></div>`;
  hideBarTip(); // 重渲前先收掉可能残留的浮层
  rowsEl.innerHTML =
    `<div class="ustat-card">${usageBarsOpen ? (dailyBars(cc, cx, 14, true) || ringView) : ringView}</div>`;
  wireBarHover(); // 柱状图悬停浮层（委托在 usageRows 上，绑定一次）
  // 区间 tab（今日/近7天/累计）只服务于圆环；趋势态隐藏
  const tabsEl = $("usageTabs"); if (tabsEl) tabsEl.style.display = usageBarsOpen ? "none" : "";

  // 底部只留异常/配置提示；回本依据已挂在「回本」环后面
  const footEl = $("usageFoot");
  if (footEl) {
    footEl.innerHTML = serverErr
      ? `<span class="uwarn">本地服务未启动 · CC/Codex 显示不了。启动：<code>node usage-tracker/server.mjs</code></span>`
      : (!usageSub ? `<span class="unote">没设订阅基准，无法判断回本。改 <code>usage-tracker/pricing.json</code> 的 subscriptionMonthly。</span>` : "");
  }

  // 只剩区间切换（今日/近7天/累计）一组
  bindUsageTabs("usageTabs", "range", (v) => { usageRange = v; });
}

function bindUsageTabs(id, attr, set) {
  const el = $(id);
  if (!el || el.dataset.bound) return;
  el.dataset.bound = "1";
  el.onclick = (e) => {
    const b = e.target.closest(".ut"); if (!b) return;
    set(b.dataset[attr]);
    [...el.querySelectorAll(".ut")].forEach((x) => x.classList.toggle("on", x === b));
    renderUsage();
  };
}

// 自动刷新：页面回到前台时 + 每 60 秒（仅在首页且可见时），解决「数字不更新」
// 回前台 + 每 60 秒：刷新用量；顺带（节流后）补报一次，让「今日/近7天」榜保持新鲜
async function usageTick() {
  if (document.hidden) return;
  renderUsage();
  const reported = await reportToday();
  if (reported) renderLeaderboard();
}
document.addEventListener("visibilitychange", usageTick);
setInterval(usageTick, 60000);

// ---------- 进入 / 退出一个片段 ----------
async function enterSegment(i) {
  state.activeIndex = i;
  state.watched = false;
  state.unit = null;
  state.step = 0;
  await saveState();
  // 有文字稿但还没导读(妙记转写的课) + 有 Key → 现场生成导读+钩子并缓存；内置课已手写好，跳过
  const seg = segments()[i];
  if (state.key && seg.text && (!seg.intro || !seg.hook)) {
    renderPreparing();
    await ensureSummary(i);
  }
  renderWatch();
}

// 生成并缓存某段的 {title, intro, hook}；只在「有文字稿 + 有 Key + 还没生成」时跑。返回是否更新。
async function ensureSummary(i) {
  const seg = segments()[i];
  if (!seg || !seg.text || !state.key) return false;
  if (seg.intro && seg.hook) return false;
  try {
    const s = await generateSummary(seg.text, i, segCount());
    if (s) {
      if (s.title) seg.title = s.title;
      if (s.intro) seg.intro = s.intro;
      if (s.hookQ) seg.hook = s.hookQ;
      await saveState();
      return true;
    }
  } catch (e) { /* 失败不卡住 */ }
  return false;
}
async function exitSegment() {
  state.activeIndex = null;
  state.watched = false;
  state.unit = null;
  state.step = 0;
  await saveState();
  renderIdle();
}

// ---------- 自助抓 YouTube 字幕（在用户浏览器里，免后端；需 host_permissions youtube） ----------
function extractBalancedJSON(s, fromIdx) {
  const i = s.indexOf("{", fromIdx);
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) return s.slice(i, k + 1); }
  }
  return null;
}
async function fetchTranscript(videoId) {
  try {
    const r = await fetch("https://www.youtube.com/watch?v=" + videoId + "&hl=en", { credentials: "omit" });
    const html = await r.text();
    const at = html.indexOf("ytInitialPlayerResponse");
    if (at < 0) return null;
    const pr = JSON.parse(extractBalancedJSON(html, at) || "null");
    const tracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (!tracks || !tracks.length) return null;
    const pick = tracks.find((t) => /^zh/.test(t.languageCode)) || tracks.find((t) => /^en/.test(t.languageCode)) || tracks[0];
    if (!pick.baseUrl) return null;
    const url = pick.baseUrl + (pick.baseUrl.indexOf("?") >= 0 ? "&" : "?") + "fmt=json3";
    const data = await (await fetch(url, { credentials: "omit" })).json();
    const cues = [];
    for (const ev of (data.events || [])) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
      if (text) cues.push({ t: (ev.tStartMs || 0) / 1000, text });
    }
    return cues.length ? cues : null;
  } catch (e) { return null; }
}
function assignSegmentText(segs, cues) {
  for (const seg of segs) {
    const parts = [];
    for (const c of cues) if (c.t >= seg.start && c.t < (seg.end || 1e9)) parts.push(c.text);
    seg.text = parts.join(" ");
  }
}

// ---------- 导入任意 YouTube 链接：按时长拆成片段 ----------
function parseVideoId(u) {
  if (!u) return "";
  u = u.trim();
  const m = u.match(/[?&]v=([\w-]{6,})/) || u.match(/youtu\.be\/([\w-]{6,})/) ||
            u.match(/\/embed\/([\w-]{6,})/) || u.match(/\/shorts\/([\w-]{6,})/) || u.match(/^([\w-]{11})$/);
  return m ? m[1] : "";
}

function importYouTube(id) {
  if (id === BUILTIN.videoId) {   // 正好是内置那门课 → 直接用带概要/文字稿的内置版
    state.source = BUILTIN; state.activeIndex = null; state.watched = false; state.unit = null; state.step = 0; setDone(getDone());
    saveState().then(renderIdle);
    return;
  }
  card.className = "card watch";
  card.innerHTML =
    `<div class="q-head"><button class="q-exit" id="qExit" title="取消">✕</button>
       <div class="watch-kicker">拆解视频中</div></div>
     <h1>正在拆解这个视频…</h1>
     <p class="sub">读取时长、按时间切成若干片段，几秒就好。</p>
     <div class="video"><iframe id="ytFrame" src="${PLAYER_BASE}#v=${id}" allow="autoplay; encrypted-media"></iframe></div>
     <div class="watch-foot"><span class="note" id="wnote">分析中…</span></div>`;
  $("qExit").onclick = () => { playerHandler = null; renderIdle(); };

  let settled = false;
  const fail = (m) => {
    if (settled) return; settled = true; playerHandler = null;
    const wn = $("wnote"); if (wn) wn.innerHTML = `<span class="err show">${esc(m)}</span> · <button class="btn btn-text" id="reSet">去设置重试</button>`;
    const r = $("reSet"); if (r) r.onclick = openSettings;
  };
  const timer = setTimeout(() => fail("拿不到视频信息，确认链接、且该视频允许嵌入播放。"), 15000);

  playerHandler = async (msg) => {
    if (msg.type !== "meta" || settled) return;
    settled = true; clearTimeout(timer); playerHandler = null;
    const dur = Math.floor(msg.duration || 0);
    if (dur < 30) return fail("视频太短或拿不到时长。");
    const count = Math.max(3, Math.min(20, Math.round(dur / 540)));  // 目标每段约 9 分钟
    const len = dur / count;
    const segs = [];
    for (let k = 0; k < count; k++) segs.push({ start: Math.round(k * len), end: k === count - 1 ? dur : Math.round((k + 1) * len) });
    state.source = { type: "youtube", videoId: id, title: msg.title || "YouTube 视频", segments: segs };
    // 自助抓字幕（用户浏览器里）→ 有字幕就给每段配文字稿，之后扩展用 Key 自动出概要+测验；抓不到就纯看片段
    try {
      const wn = $("wnote"); if (wn) wn.textContent = "读取字幕中…";
      const cues = await fetchTranscript(id);
      if (cues) assignSegmentText(segs, cues);
    } catch (e) {}
    state.activeIndex = null; state.watched = false; state.unit = null; state.step = 0; setDone(0);
    await saveState();
    renderIdle();
  };
}

// 把后端返回的课程加进课程库（持久化）+ 设为当前 → 回首页
async function addCourse(course) {
  const k = courseKey(course);
  state.imported = state.imported || [];
  if (!library().some((c) => courseKey(c) === k)) state.imported.push(course);
  state.source = course; state.activeIndex = null; state.watched = false; state.unit = null; state.step = 0;
  await saveState();
  renderIdle();
}

// B站 → 走后端拆解（下音频 + 妙记转写 + 切段）；轮询直到出课
function importBili(url) {
  card.className = "card watch";
  card.innerHTML =
    `<div class="q-head"><button class="q-exit" id="qExit" title="取消">✕</button>
       <div class="watch-kicker">拆解 B站视频</div></div>
     <h1>正在拆解这个 B站视频…</h1>
     <p class="sub">后端在下音频、转写、切段。第一次要几分钟，同一视频以后秒开。</p>
     <div class="watch-foot"><span class="note" id="wnote">连接后端…</span></div>`;
  let stop = false;
  $("qExit").onclick = () => { stop = true; renderIdle(); };
  const poll = async () => {
    if (stop) return;
    try {
      const r = await fetch(BACKEND + "/course", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const d = await r.json();
      if (d.done && d.course) return addCourse(d.course);
      const wn = $("wnote");
      if (d.error) { if (wn) wn.innerHTML = `<span class="err show">拆解失败：${esc(d.error)}</span>`; return; }
      if (wn) wn.textContent = d.status || "拆解中…";
      setTimeout(poll, 5000);
    } catch (e) {
      const wn = $("wnote");
      if (wn) wn.innerHTML = `<span class="err show">连不上后端。先在项目根目录跑：<code>node server/server.js</code></span>`;
    }
  };
  poll();
}

// ---------- 看片段 / 读章节 ----------
function renderWatch() {
  card.className = "card watch";
  const i = state.activeIndex;
  const seg = segments()[i];
  const src = state.source;
  const total = segCount();
  playerHandler = null;
  if (src.type === "bilibili") { renderWatchBili(seg, src, i, total); return; }
  const isVideo = src.type === "youtube";
  const kicker = isVideo ? `片段 ${i + 1} / ${total} · 视频` : `章节 ${i + 1} / ${total}`;

  let media, btnTxt, note, gated = false;
  if (isVideo) {
    // 内嵌 https 中转播放页播这一段；播放器先盖一张「前情提要 + 这一节概要」卡，点开始才播。
    // 看到这段结尾才解锁「看完了」（播放器上报，不靠自觉）。
    const start = Math.floor(seg.start);
    const endH = seg.end ? `&end=${Math.ceil(seg.end)}` : "";
    let meta = "";   // 只有真实概要(内置/已生成)才盖「前情提要+这一节」卡，绝不假装总结
    if (seg.intro) {
      const prev = segments()[i - 1];
      const recap = i === 0 ? "这是开篇第一段，从这里开始。" : (prev && prev.intro) || "";
      meta = `&title=${encodeURIComponent(seg.title || "")}&recap=${encodeURIComponent(recap)}&intro=${encodeURIComponent(seg.intro)}`;
    }
    const url = `${PLAYER_BASE}#v=${src.videoId}&start=${start}${endH}${meta}`;
    media = `<div class="video"><iframe id="ytFrame" src="${url}"
        allow="autoplay; accelerometer; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
    btnTxt = "看到结尾解锁 →";
    note = seg.end ? `本段 ${fmtTime(seg.start)}–${fmtTime(seg.end)}` : `从 ${fmtTime(seg.start)} 起`;
    gated = true;
  } else {
    const paras = esc(seg.text || "").split(/\n+/).map((t) => t.trim()).filter(Boolean).map((t) => `<p>${t}</p>`).join("");
    media = `<div class="reader">${paras}</div>`;
    btnTxt = "读完了 →";
    note = "读完点右边继续";
  }

  const foot = gated
    ? `<div class="watch-foot col">
         <div class="seg-bar"><i id="segFill"></i></div>
         <div class="watch-row"><span class="note" id="wnote">${note}</span>
           <button class="btn btn-primary" id="consumed" disabled>${btnTxt}</button></div>
       </div>`
    : `<div class="watch-foot"><span class="note" id="wnote">${note}</span>
         <button class="btn btn-primary" id="consumed">${btnTxt}</button></div>`;
  card.innerHTML =
    `<div class="q-head"><button class="q-exit" id="qExit" title="退出回到首页">✕</button>
       <div class="watch-kicker">${kicker}</div></div>
     <h1>${esc(src.title || "")}</h1>
     ${media}
     ${foot}`;
  $("qExit").onclick = exitSegment;
  $("consumed").onclick = onConsumed;

  if (gated) {
    const dur = seg.end && seg.end > seg.start ? seg.end - seg.start : 0;
    // 播放器每秒上报进度 → 更新本节进度条；播到结尾 → 解锁「看完了」
    playerHandler = (msg) => {
      if (msg.type === "progress") {
        if (!dur) return;
        const pct = Math.max(0, Math.min(1, (msg.t - seg.start) / dur));
        const fill = $("segFill"); if (fill) fill.style.width = (pct * 100).toFixed(1) + "%";
        const b = $("consumed"), wn = $("wnote");
        if (wn && b && b.disabled) wn.textContent = `已看 ${Math.round(pct * 100)}% · 还剩 ${fmtTime(Math.max(0, Math.round(seg.end - msg.t)))}`;
        return;
      }
      if (msg.type === "ended") {
        const b = $("consumed"); if (!b) return;
        b.disabled = false; b.textContent = "看完了 →";
        const fill = $("segFill"); if (fill) fill.style.width = "100%";
        const wn = $("wnote"); if (wn) wn.textContent = "✓ 这段看完了";
      }
    };
  }
}

// B 站片段：内嵌 player.bilibili.com（无事件接口，「看完了」手动点）；上方显示概要卡（若已生成）
function renderWatchBili(seg, src, i, total) {
  const p = src.page || 1;
  const start = Math.floor(seg.start);
  const url = `https://player.bilibili.com/player.html?bvid=${src.bvid}&p=${p}&t=${start}&autoplay=0&danmaku=0&high_quality=1`;
  let brief = "";
  if (seg.intro) {
    const prev = segments()[i - 1];
    const recap = i === 0 ? "这是开篇第一段，从这里开始。" : (prev && prev.intro) || "";
    brief = `<div class="brief">
        ${recap ? `<div class="brief-recap"><span class="brief-k">前情提要</span>${esc(recap)}</div>` : ""}
        <div class="brief-now"><span class="brief-k now">这一节 · ${esc(seg.title || `第 ${i + 1} 段`)}</span>${esc(seg.intro)}</div>
      </div>`;
  }
  card.innerHTML =
    `<div class="q-head"><button class="q-exit" id="qExit" title="退出回到首页">✕</button>
       <div class="watch-kicker">片段 ${i + 1} / ${total} · 视频 (B站)</div></div>
     <h1>${esc(src.title || "")}</h1>
     ${brief}
     <div class="video bili"><iframe src="${url}" scrolling="no" frameborder="0" allowfullscreen></iframe></div>
     <div class="watch-foot"><span class="note">本段 ${fmtTime(seg.start)}–${fmtTime(seg.end)} · 看完自己点</span>
       <button class="btn btn-primary" id="consumed">看完了 →</button></div>`;
  $("qExit").onclick = exitSegment;
  $("consumed").onclick = onConsumed;
}

// 看完 / 读完 → 有 Key 出巩固测验；没 Key 直接算完成（消费本身就算数）
async function onConsumed() {
  state.watched = true;
  await saveState();
  const btn = $("consumed"), note = $("wnote");
  const segText = segments()[state.activeIndex].text;
  if (state.key && segText) {                 // 有 Key 且这段有文字稿才出测验（自定义视频没字幕→直接完成）
    if (btn) { btn.disabled = true; btn.textContent = "出题中…"; }
    try {
      state.unit = await generateUnit(segText);
      state.step = 0;
      await saveState();
      renderQuestion();
    } catch (e) {
      if (note) note.innerHTML = `<span class="err show">测验生成失败：${esc(e.message)}</span>`;
      if (btn) { btn.disabled = false; btn.textContent = "跳过测验，标记看完 →"; btn.onclick = finishSegment; }
    }
  } else {
    await finishSegment();
  }
}

// 完成当前片段：计数 + 连胜 + 正反馈
async function finishSegment() {
  const i = state.activeIndex;
  state.unitsDone = (state.unitsDone || 0) + 1;
  setDone(Math.max(getDone(), i + 1));
  const t = todayStr();
  if (state.lastDay !== t) { state.streak = state.lastDay ? state.streak + 1 : 1; state.lastDay = t; state.todayDone = 1; }
  else { state.todayDone = (state.todayDone || 0) + 1; }
  if (!Array.isArray(state.days)) state.days = [];
  if (!state.days.includes(t)) state.days.push(t);   // 当天打卡（日历上点亮）
  await saveState();
  renderDone();
  // 打卡即上报（force 绕过 3 分钟节流），让新 streak 立刻进榜；成功就刷新榜
  reportToday(true).then((ok) => { if (ok) renderLeaderboard(); });
}

// ---------- 巩固小测验（看完之后） ----------
function renderQuestion() {
  card.className = "card";
  const qs = questions();
  const q = qs[state.step];
  const total = qs.length;
  const isLast = state.step === total - 1;
  let segs = "";
  for (let i = 0; i < total; i++)
    segs += `<i class="${i < state.step ? "on" : i === state.step ? "cur" : ""}"></i>`;
  const head = `<div class="q-head"><button class="q-exit" id="qExit" title="退出回到首页">✕</button><div class="pbar">${segs}</div></div>`;
  const tag = q.type === "choice" ? "选择题" : "开放题";
  const label = `<div class="qlabel">第 ${state.step + 1} 题 / 共 ${total} · ${tag}</div>`;
  const nextTxt = isLast ? "看看结果 →" : "下一题 →";

  if (q.type === "choice") {
    let opts = "";
    q.options.forEach((o, i) => {
      opts += `<div class="opt" data-i="${i}"><div class="k">${"ABCD"[i]}</div><div class="t">${esc(o)}</div></div>`;
    });
    card.innerHTML = `${head}${label}<div class="qstem">${esc(q.stem)}</div><div id="opts">${opts}</div><div id="qextra"></div>`;
    document.querySelectorAll(".opt").forEach((el) => {
      el.onclick = () => {
        const i = +el.dataset.i;
        document.querySelectorAll(".opt").forEach((x) => x.classList.add("disabled"));
        document.querySelectorAll(".opt")[q.answer].classList.add("correct");
        if (i !== q.answer) el.classList.add("wrong");
        const ok = i === q.answer;
        $("qextra").innerHTML = `<div class="fb ${ok ? "correct" : "wrong"}">
            <div class="h">${ok ? "✓ 答对了" : "✕ 差一点"}</div>${esc(q.why)}</div>
          <div class="row-end"><button class="btn btn-primary" id="next">${nextTxt}</button></div>`;
        $("next").onclick = nextStep;
      };
    });
  } else {
    card.innerHTML = `${head}${label}<div class="qstem">${esc(q.stem)}</div>
      <textarea id="ans" placeholder="用你自己的话说说…"></textarea>
      <div class="row-end"><button class="btn btn-primary" id="submit">提交批改 →</button></div>
      <div class="err" id="qerr"></div><div id="qextra"></div>`;
    $("submit").onclick = async () => {
      const ans = $("ans").value.trim();
      if (!ans) { $("qerr").textContent = "先写点什么吧 🙂"; $("qerr").classList.add("show"); return; }
      const b = $("submit"); b.disabled = true; b.textContent = "批改中…";
      try {
        const r = await gradeOpen(q, ans);
        const cls = r.verdict === "correct" ? "correct" : r.verdict === "wrong" ? "wrong" : "partial";
        const vh = r.verdict === "correct" ? "✓ 到位" : r.verdict === "wrong" ? "✕ 还差点" : "≈ 答对一半";
        $("qextra").innerHTML = `<div class="fb ${cls}"><div class="h">${vh}</div>${esc(r.feedback)}</div>
          <div class="row-end"><button class="btn btn-primary" id="next">${nextTxt}</button></div>`;
        $("next").onclick = nextStep;
      } catch (e) {
        $("qerr").textContent = "批改出错：" + e.message; $("qerr").classList.add("show");
        b.disabled = false; b.textContent = "重试 →";
      }
    };
  }
  $("qExit").onclick = exitSegment;
}

async function nextStep() {
  state.step++;
  await saveState();
  if (state.step >= questions().length) return finishSegment();
  renderQuestion();
}

// ---------- 完成一段（正反馈） ----------
function renderDone() {
  card.className = "card";
  const total = segCount();
  const done = effDone();
  const allDone = total > 0 && done >= total;

  let chips = `<span class="chip">看完 <b>${done}</b> / ${total} 段</span>`;
  if (state.streak > 0) chips = `<span class="chip"><b>${state.streak}</b> 天连胜</span>` + chips;

  const note = allDone
    ? "整门课你都看完了 🎉 要不要回头复习两段？"
    : todayCount() >= 1
      ? "今天的目标达成了。再看一段，还是明天见？"
      : "又往前走了一段，保持住。";
  const keyHint = (!state.key)
    ? `<p class="sub" style="margin-top:-6px;font-size:13px">想看完顺手测一下？设置里填个 DeepSeek Key 就解锁巩固小测验。</p>`
    : "";

  card.innerHTML =
    `<div class="done-mark">✓</div>
     <h1>${allDone ? "全部看完了" : "这一段搞定 ✓"}</h1>
     <p class="sub">${note}</p>${keyHint}
     <div class="chips">${chips}</div>
     <div class="actions">
       ${allDone
        ? `<button class="btn btn-primary" id="rest">回首页</button>`
        : `<button class="btn btn-primary" id="next2">下一段 →</button><button class="btn btn-ghost" id="rest">今天到此</button>`}
     </div>`;
  const n2 = $("next2"); if (n2) n2.onclick = () => enterSegment(effDone());
  $("rest").onclick = exitSegment;
}

// ---------- 设置 ----------
function openSettings() {
  $("keyIn").value = state.key || "";
  const u = $("urlIn"); if (u) u.value = "";
  renderCourseList();
  $("setErr").classList.remove("show");
  $("mask").classList.add("show");
}

// 课程库选择器（设置里）
function renderCourseList() {
  const box = $("courseList"); if (!box) return;
  const curKey = courseKey(state.source);
  const tag = (s) => s.bvid ? "B站" : s.videoId ? "YT" : "自定义";
  box.innerHTML = library().map((c) => {
    const k = courseKey(c);
    const done = (state.progressByKey || {})[k] || 0, tot = (c.segments || []).length;
    return `<button class="course-item${k === curKey ? " active" : ""}" data-key="${k}">
        <span class="t">${esc(c.title || "课程")}</span>
        <span class="tag">${tag(c)} · ${done}/${tot}</span></button>`;
  }).join("");
  box.querySelectorAll(".course-item").forEach((el) => {
    el.onclick = async () => {
      const c = library().find((x) => courseKey(x) === el.dataset.key);
      if (!c) return;
      state.source = c; state.activeIndex = null; state.watched = false; state.unit = null; state.step = 0;
      await saveState(); closeSettings(); renderIdle();
    };
  });
}
function closeSettings() { $("mask").classList.remove("show"); }

function bindSettings() {
  $("setCancel").onclick = closeSettings;
  // 登录弹窗：点关闭 × 或点遮罩空白处都收起
  const ac = $("authClose"); if (ac) ac.onclick = closeAuthModal;
  const am = $("authMask"); if (am) am.onclick = (e) => { if (e.target === am) closeAuthModal(); };
  const ub = $("useBuiltin");
  if (ub) ub.onclick = async (e) => {
    e.preventDefault();
    state.source = BUILTIN; state.activeIndex = null; state.watched = false; state.unit = null; state.step = 0; setDone(getDone());
    await saveState(); closeSettings(); renderIdle();
  };
  $("setSave").onclick = async () => {
    const k = $("keyIn").value.trim();
    if (k && !k.startsWith("sk-")) { $("setErr").textContent = "Key 应以 sk- 开头，留空则用无测验模式"; $("setErr").classList.add("show"); return; }
    state.key = k;
    const url = ($("urlIn").value || "").trim();
    if (url) {
      if (/BV[0-9A-Za-z]+/.test(url)) {        // B站 → 走后端拆解（下音频+妙记转写）
        await saveState(); closeSettings(); importBili(url); return;
      }
      const id = parseVideoId(url);            // YouTube → 客户端按时长切片段
      if (!id) { $("setErr").textContent = "链接识别不了（支持 B站 / YouTube）"; $("setErr").classList.add("show"); return; }
      await saveState(); closeSettings(); importYouTube(id);
      return;
    }
    await saveState();
    closeSettings();
    renderMain();
  };
}

// ---------- 启动 ----------
(async function init() {
  await loadState();
  await loadGoals();
  await loadUsageBarsOpen();
  bindSettings();
  renderMain();
})();
