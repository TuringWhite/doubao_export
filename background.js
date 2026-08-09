// 后台 Service Worker：负责把内容脚本产出的 Markdown 写入下载。
// API 调用放在 content.js；这里只做文件下载，并注册主世界 fetch 钩子。

const HOOK_ID = "doubao-hook";

async function registerMainWorldHook() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [HOOK_ID],
    });
    if (existing.length === 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: HOOK_ID,
          matches: ["https://www.doubao.com/*"],
          js: ["hook.js"],
          runAt: "document_start",
          world: "MAIN", // 主世界，规避 CSP 对内联 script 的拦截
        },
      ]);
    }
  } catch (err) {
    console.warn("[doubao-export] 注册主世界钩子失败:", err.message);
  }
}

chrome.runtime.onInstalled.addListener(registerMainWorldHook);
chrome.runtime.onStartup.addListener(registerMainWorldHook);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "download") {
    handleDownload(message)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // 异步响应
  }
});

async function handleDownload({ filename, content }) {
  const safeName = sanitizeFilename(filename);
  // 用 data URL 而非 blob URL:Service Worker 中 blob URL 生命周期不稳定,
  // 常导致 chrome.downloads 静默失败且不产生下载记录。
  const url = "data:text/markdown;charset=utf-8," + encodeURIComponent(content);
  await chrome.downloads.download({
    url,
    filename: safeName,
    saveAs: false,
    conflictAction: "uniquify",
  });
}

// 去掉文件名中的非法字符，避免下载失败
function sanitizeFilename(name) {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  const final = cleaned || "对话";
  // 控制路径深度，统一放在 doubao_export/ 目录下
  return `doubao_export/${final}.md`;
}

