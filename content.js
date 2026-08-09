// 内容脚本：运行在豆包页面同源环境，可携带已登录 Cookie 直连后端 API。
// 职责：枚举全部对话 → 逐条分页拉取历史 → 格式化为 Markdown → 交由 background 下载。

// 分页游标从最新往旧走，用 MAX_SAFE_INTEGER 作为第一页锚点
const START_ANCHOR = Number.MAX_SAFE_INTEGER;

// 捕获到的页面自身 /im/chain/single 请求(URL + headers + body 模板)。
// 复用它能保证与该豆包版本完全一致,避免手工拼接会话参数。
let capturedRequest = null;

// 主世界 fetch 钩子通过 postMessage 回传捕获的请求
window.addEventListener("message", (e) => {
  if (e.data && e.data.source === "doubao-hook" && e.data.type === "captured" && e.data.req) {
    capturedRequest = e.data.req;
    log("已捕获页面请求:", e.data.req.url);
  }
});

// 向主世界钩子索取最近一次的请求(测试或页面尚未触发时使用)
function requestCapture() {
  window.postMessage({ source: "doubao-hook", type: "request" }, "*");
}

// 测试钩子：允许从外部注入捕获的请求
function __setCapturedRequest(req) {
  capturedRequest = req;
}

// 直接读取页面已发起的 /im/chain/single 请求 URL(含全部会话 query 参数)。
// 这是最可靠的方式——不依赖 fetch 钩子或 CSP,直接从 performance 资源条目拿。
function findSingleRequestUrl() {
  try {
    const entries = performance.getEntriesByType("resource");
    for (const e of entries) {
      if (e.name && e.name.includes("/im/chain/single")) return e.name;
    }
  } catch (_) {
    /* 忽略 */
  }
  return null;
}

// 生成 body 模板(依据抓包确认的线上格式:c/md 3100、direction 1、ext/filter 字段)
function buildBody(conversationId, anchorIndex) {
  return {
    cmd: 3100,
    uplink_body: {
      pull_singe_chain_uplink_body: {
        conversation_id: String(conversationId),
        anchor_index: anchorIndex,
        conversation_type: 3,
        direction: 1,
        limit: 20,
        ext: {},
        filter: { index_list: [] },
        evaluate_ab_params: "",
        evaluate_common_params: "",
      },
    },
    sequence_id: genUuid(),
    channel: 2,
    version: "1",
  };
}

function genUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// 诊断日志：便于在页面控制台观察导出过程
function log(...args) {
  console.log("[豆包导出]", ...args);
}

// 侧边栏选择器（当前线上版本的稳定锚点，Tailwind 工具类不稳定）
const SIDEBAR_SELECTORS = [
  "#flow_chat_sidebar",
  '[data-testid="flow_chat_sidebar"]',
  '[class*="flow_chat_sidebar"]',
];

// ---------------------------------------------------------------------------
// 1. 枚举对话列表
// ---------------------------------------------------------------------------
async function getConversations() {
  const sidebar = await findSidebar();
  if (!sidebar) {
    throw new Error("未找到对话侧边栏。请先打开 https://www.doubao.com/chat 页面再导出。");
  }

  // 侧边栏可能是虚拟滚动，反复滚到底触发懒加载，收集全部唯一会话
  const seen = new Map(); // id -> title
  let lastCount = -1;
  for (let i = 0; i < 100; i++) {
    const links = sidebar.querySelectorAll('a[href*="/chat/"]');
    links.forEach((a) => {
      const m = (a.getAttribute("href") || "").match(/\/chat\/(\d+)/);
      if (!m) return;
      const id = m[1];
      const title = (a.textContent || "").trim();
      if (!seen.has(id)) seen.set(id, title);
    });

    // 滚到底后若没有新增会话，说明已获取全部
    const before = sidebar.scrollHeight;
    sidebar.scrollTop = sidebar.scrollHeight;
    await sleep(400); // 等待懒加载完成
    if (seen.size === lastCount) break;
    lastCount = seen.size;
  }

  const convs = Array.from(seen, ([id, title]) => ({ id, title }));
  if (convs.length === 0) {
    throw new Error("侧边栏没有找到任何对话链接，请确认已登录且页面加载完成。");
  }
  return convs;
}

async function findSidebar() {
  for (const sel of SIDEBAR_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  // 扫描所有 a 标签，若存在对话链接则退回使用整页滚动区域
  const anyLink = document.querySelector('a[href*="/chat/"]');
  if (anyLink) return document.body;
  return null;
}

// ---------------------------------------------------------------------------
// 2. 分页拉取单条对话
// ---------------------------------------------------------------------------
async function fetchPage(conversationId, anchorIndex) {
  // 优先从 performance 条目拿真实 URL;找不到再回退到 fetch 钩子捕获的请求
  let url = findSingleRequestUrl();
  if (!url && capturedRequest) url = capturedRequest.url;
  if (!url) {
    requestCapture();
    await sleep(300);
    if (capturedRequest) url = capturedRequest.url;
  }
  if (!url) {
    throw new Error(
      "无法定位 /im/chain/single 请求。请确认已打开一个豆包对话(/chat/:id)页面,并滚动加载几条历史后重试。"
    );
  }

  // 用已知正确的 body 格式,仅覆盖 conversation_id 与 anchor_index 做分页
  const body = buildBody(conversationId, anchorIndex);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json; encoding=utf-8",
      "agw-js-conv": "str",
    },
    credentials: "include",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`API 请求失败 HTTP ${res.status}`);
  }
  const data = await res.json();
  const messages =
    data?.downlink_body?.pull_singe_chain_downlink_body?.single_chain?.messages ||
    data?.downlink_body?.pull_singe_chain_downlink_body?.messages ||
    [];
  return messages;
}

async function exportConversation(conv) {
  const messages = [];
  let anchor = START_ANCHOR;
  let guard = 0;

  while (guard++ < 10000) {
    const page = await fetchPage(conv.id, anchor);
    if (!page || page.length === 0) break; // 空页视为到底

    messages.push(...page);

    const indexes = page.map((m) => Number(m.index_in_conv)).filter(Number.isFinite);
    if (indexes.length === 0) break;

    const oldest = Math.min(...indexes);
    const nextAnchor = oldest - 1;
    if (nextAnchor >= anchor) break; // 无进展,防死循环
    anchor = nextAnchor;

    await sleep(50); // 轻量限速，避免触发风控
  }

  // API 返回是 新→旧，反转成 旧→新 便于阅读
  messages.reverse();
  return { conv, messages };
}

// ---------------------------------------------------------------------------
// 3. 消息文本提取（兼容新旧两种 content 结构）
// ---------------------------------------------------------------------------
function extractText(msg) {
  // 新结构 content_type 9998：content_block[].content.text_block.text（可能是数组）
  if (Array.isArray(msg.content_block)) {
    const parts = [];
    for (const block of msg.content_block) {
      const text = block?.content?.text_block?.text;
      if (typeof text === "string" && text.length) parts.push(text);
    }
    if (parts.length) return parts.join("\n");
  }

  // 旧结构 content_type 2：content 是字符串化的 JSON {"text": "..."}
  if (typeof msg.content === "string") {
    const trimmed = msg.content.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.text === "string") return parsed.text;
    } catch (_) {
      /* 不是 JSON，直接当纯文本 */
    }
    return trimmed;
  }

  // 兜底
  if (typeof msg.tts_content === "string") return msg.tts_content;
  return "";
}

function formatMarkdown({ conv, messages }) {
  const out = [];
  out.push(`# ${conv.title || conv.id}`, "");
  out.push(`- 对话 ID: ${conv.id}`);
  out.push(`- 消息数: ${messages.length}`);
  out.push(`- 导出时间: ${new Date().toISOString()}`);
  out.push("", "---", "");

  for (const msg of messages) {
    const role = Number(msg.user_type) === 0 ? "用户" : "AI";
    const time = msg.create_time
      ? new Date(Number(msg.create_time) * 1000).toLocaleString()
      : "";
    const text = extractText(msg);
    if (!text) continue;
    out.push(`## ${role}${time ? ` · ${time}` : ""}`, "", text, "", "---", "");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 4. 编排：进度回传 + 触发下载
// ---------------------------------------------------------------------------
async function exportAll() {
  log("开始导出. 捕获到的请求:", capturedRequest ? "有" : "无");
  if (capturedRequest) {
    log("捕获 URL:", capturedRequest.url);
  }

  const convs = await getConversations();
  log("枚举到对话数:", convs.length);
  postProgress({ type: "started", total: convs.length });

  let success = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < convs.length; i++) {
    const conv = convs[i];
    try {
      const result = await exportConversation(conv);
      const markdown = formatMarkdown(result);
      const filename = `${conv.title || conv.id}`;
      await requestDownload(filename, markdown);
      success++;
      log(`[${i + 1}/${convs.length}] ${conv.title || conv.id}: ${result.messages.length} 条 ✓`);
    } catch (err) {
      failed++;
      errors.push(`${conv.title || conv.id}: ${err.message}`);
      log(`[${i + 1}/${convs.length}] ${conv.title || conv.id}: 失败 - ${err.message}`);
    }
    postProgress({ type: "progress", done: i + 1, total: convs.length });
  }

  log(`导出完成: 成功 ${success}, 失败 ${failed}`);
  if (errors.length) log("失败明细:", errors);
  postProgress({ type: "done", success, failed, errors });
}

// ---------------------------------------------------------------------------
// 消息通道
// ---------------------------------------------------------------------------
function requestDownload(filename, content) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "download", filename, content }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`下载通道错误: ${chrome.runtime.lastError.message}`));
        return;
      }
      if (resp && resp.ok) {
        resolve();
      } else {
        reject(new Error((resp && resp.error) || "下载后台未响应"));
      }
    });
  });
}

function postProgress(payload) {
  try {
    chrome.runtime.sendMessage({ type: "progress", ...payload });
  } catch (_) {
    /* popup 可能已关闭 */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 监听 popup 指令
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "export-all") {
    exportAll()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // 异步
  }
  if (message?.action === "ping") {
    sendResponse({ ok: true, url: location.href });
    return false;
  }
});