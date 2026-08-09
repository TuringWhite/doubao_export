// 后台 Service Worker：负责把内容脚本产出的 Markdown 写入下载。
// 内容脚本由于运行在豆包页面同一源，能附带登录 Cookie 直连后端 API，
// 因此 API 调用放在 content.js；这里只做文件下载。

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
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: safeName,
      saveAs: false,
      conflictAction: "uniquify",
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

// 去掉文件名中的非法字符，避免下载失败
function sanitizeFilename(name) {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  const final = cleaned || "对话";
  // 控制路径深度，统一放在 doubao_export/ 目录下
  return `doubao_export/${final}.md`;
}

