// Strand 后台 service worker —— 统计「Chrome 活跃使用时长」
// 每分钟一跳：当且仅当(5 分钟内有过输入，且没锁屏)且(某个 Chrome 窗口在前台)时，今日计 1 分钟。
// 数据存 chrome.storage.local 的 chromeUsage = { "YYYY-MM-DD": 分钟数 }，只在本机。
// 注：系统里没有历史浏览时长，所以 Chrome 只能从「重载扩展」这一刻往后累积。

const ALARM = "strand-tick";
const IDLE_SEC = 300; // 5 分钟内有输入就算在用，与时长口径一致

// 顶层就建闹钟：每次 SW 启动都跑一次（create 同名会覆盖，幂等），比只在 onInstalled 里建更稳
ensureAlarm();
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

function localDayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  chrome.idle.queryState(IDLE_SEC, (idleState) => {
    if (idleState !== "active") {
      console.log("[strand] skip: idle =", idleState);
      return;
    }
    chrome.windows.getLastFocused({}, (win) => {
      if (chrome.runtime.lastError || !win || !win.focused) {
        console.log("[strand] skip: chrome 未在前台");
        return;
      }
      const key = localDayKey();
      chrome.storage.local.get({ chromeUsage: {} }, (data) => {
        const usage = data.chromeUsage || {};
        usage[key] = (usage[key] || 0) + 1; // +1 分钟
        chrome.storage.local.set({ chromeUsage: usage }, () => {
          console.log("[strand] +1min chrome", key, "=", usage[key], "分");
        });
      });
    });
  });
});
