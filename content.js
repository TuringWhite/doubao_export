// 内容脚本：运行在豆包页面同源环境，可携带已登录 Cookie 直连后端 API。
// 职责：枚举全部对话 → 逐条分页拉取历史 → 格式化为 Markdown → 交由 background 下载。

const API_URL = "https://www.doubao.com/im/chain/single";
const PAGE_LIMIT = 50;
// 分页游标从最新往旧走，用 MAX_SAFE_INTEGER 作为第一页锚点
const START_ANCHOR = Number.MAX_SAFE_INTEGER;

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
  const body = {
    cmd: 3001,
    uplink_body: {
      pull_singe_chain_uplink_body: {
        conversation_id: conversationId,
        anchor_index: anchorIndex,
        conversation_type: 3,
        direction: 3,
        limit: PAGE_LIMIT,
      },
    },
    sequence_id: 1,
    channel: 2,
    version: "1",
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; encoding=utf-8",
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
  let consecutiveEmpty = 0;

  for (let i = 0; i < 10000; i++) {
    const page = await fetchPage(conv.id, anchor);
    if (!page || page.length === 0) {
      consecutiveEmpty++;
      // 连续两次空页视为到底
      if (consecutiveEmpty >= 2) break;
      anchor = anchor - PAGE_LIMIT;
      continue;
    }
    consecutiveEmpty = 0;
    messages.push(...page);

    // 计算本页最旧消息的 index，作为下一页锚点
    const indexes = page.map((m) => Number(m.index_in_conv)).filter(Number.isFinite);
    if (indexes.length === 0) break;
    const oldest = Math.min(...indexes);
    anchor = oldest - 1;

    if (page.length < PAGE_LIMIT) break;
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
  const convs = await getConversations();
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
    } catch (err) {
      failed++;
      errors.push(`${conv.title || conv.id}: ${err.message}`);
    }
    postProgress({ type: "progress", done: i + 1, total: convs.length });
  }

  postProgress({ type: "done", success, failed, errors });
}

// ---------------------------------------------------------------------------
// 消息通道
// ---------------------------------------------------------------------------
function requestDownload(filename, content) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "download", filename, content }, (resp) => {
      // 忽略响应，避免 content script 生命周期问题
      void resp;
      resolve();
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