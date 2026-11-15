const exportBtn = document.getElementById("exportBtn");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");
const resultEl = document.getElementById("result");
const versionEl = document.getElementById("version");

let activeTabId = null;

// 版本号跟随 manifest，改版本不用同步改 HTML
if (versionEl) {
  try {
    versionEl.textContent = chrome.runtime.getManifest().version;
  } catch (_) {
    /* 非扩展环境(直接打开 popup.html 预览)时忽略 */
  }
}

// 监听 content script 的进度事件
chrome.runtime.onMessage.addListener((message) => {
  if (!message || !["started", "progress", "done"].includes(message.type)) return;
  if (message.type === "started") {
    showProgress(true);
    setProgress(0, message.total);
    progressText.textContent = `准备导出 ${message.total} 条对话…`;
  } else if (message.type === "progress") {
    setProgress(message.done, message.total);
    progressText.textContent = `正在导出 ${message.done}/${message.total}`;
  } else if (message.type === "done") {
    showProgress(false);
    if (message.failed > 0) {
      resultEl.textContent = `完成：成功 ${message.success}，失败 ${message.failed}`;
      resultEl.classList.add("warn");
    } else {
      resultEl.textContent = `全部导出完成，共 ${message.success} 条对话。文件已保存到下载目录 doubao_export/ 下。`;
      resultEl.classList.add("ok");
    }
    resultEl.classList.remove("hidden");
    statusEl.textContent = "导出完成";
  }
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/doubao\.com/.test(tab.url)) {
    statusEl.textContent = "请先打开豆包对话页面再导出。";
    exportBtn.disabled = true;
    return;
  }
  activeTabId = tab.id;
  statusEl.textContent = "已就绪，可以开始导出。";
  exportBtn.disabled = false;
}

exportBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  statusEl.textContent = "正在启动…";
  resultEl.classList.add("hidden");

  try {
    const resp = await chrome.tabs.sendMessage(activeTabId, { action: "export-all" });
    if (!resp?.ok) {
      statusEl.textContent = `启动失败：${resp?.error || "页面未响应"}`;
      exportBtn.disabled = false;
    }
    // 成功时后续进度通过事件回调更新
  } catch (err) {
    statusEl.textContent = `无法连接页面：${err.message}`;
    exportBtn.disabled = false;
  }
});

function setProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
}

function showProgress(show) {
  progressEl.classList.toggle("hidden", !show);
}

init();