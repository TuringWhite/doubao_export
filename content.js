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
function buildBody(conversationId, anchorIndex, direction = 1) {
  return {
    cmd: 3100,
    uplink_body: {
      pull_singe_chain_uplink_body: {
        conversation_id: String(conversationId),
        anchor_index: anchorIndex,
        conversation_type: 3,
        direction,
        limit: PAGE_SIZE,
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

  // 侧边栏可能是虚拟滚动，反复滚到底触发懒加载，收集全部唯一会话。
  // 只在"连续 3 轮没有新增"时才收手——之前固定 400ms 判断一次，
  // 侧边栏稍慢一点就只枚举到当前可见的几条(实测只拿到 5 条而不是全部)。
  const seen = new Map(); // id -> title
  let stableRounds = 0;
  for (let round = 0; round < 80 && stableRounds < 3; round++) {
    collectConversationLinks(sidebar, seen);
    const before = seen.size;

    scrollAll(sidebar);
    await sleep(600); // 等待懒加载

    collectConversationLinks(sidebar, seen);
    if (seen.size === before) stableRounds++;
    else stableRounds = 0;

    log(`枚举第 ${round + 1} 轮: 累计 ${seen.size} 条`);
  }

  const convs = Array.from(seen, ([id, title]) => ({ id, title }));
  if (convs.length === 0) {
    throw new Error("侧边栏没有找到任何对话链接，请确认已登录且页面加载完成。");
  }
  return convs;
}

// 从侧边栏当前 DOM 里捞出对话链接(虚拟列表会反复挂载/卸载,所以每轮都要重捞)
function collectConversationLinks(root, seen) {
  const links = root.querySelectorAll('a[href*="/chat/"]');
  links.forEach((a) => {
    const m = (a.getAttribute("href") || "").match(/\/chat\/(\d+)/);
    if (!m) return;
    const id = m[1];
    if (!seen.has(id)) seen.set(id, normalizeTitle(a.textContent, id));
  });
  return seen.size;
}

// 把侧边栏里所有可滚动容器都滚到底。
// 真正的滚动容器往往是 #flow_chat_sidebar 的深层子节点,只滚外层不会触发懒加载。
function scrollAll(root) {
  let scrolled = 0;
  const nodes = [root];
  try {
    nodes.push(...Array.from(root.querySelectorAll("div, ul, ol, section")).slice(0, 600));
  } catch (_) {
    /* 忽略 */
  }

  for (const el of nodes) {
    if (!el || el.scrollHeight <= el.clientHeight + 40) continue;
    let overflowY = "";
    try {
      overflowY = typeof getComputedStyle === "function"
        ? getComputedStyle(el).overflowY
        : "";
    } catch (_) {
      overflowY = "";
    }
    if (el !== root && !["auto", "scroll", "overlay"].includes(overflowY)) continue;
    el.scrollTop = el.scrollHeight;
    scrolled++;
  }
  return scrolled;
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

// 单页请求条数
const PAGE_SIZE = 20;

// 单条对话最多翻多少页,防死循环
const PAGE_GUARD = 1000;

// 识别当前页面类型:普通对话从最新锚点往下翻,智能体对话从 0 往上翻
function detectChatType() {
  try {
    const path = (typeof location !== "undefined" && location.pathname) || "";
    if (/^\/chat\/bot\/chat\/\d+/.test(path)) return "bot-chat";
    if (/^\/chat\/\d+/.test(path)) return "chat";
  } catch (_) {
    /* 测试环境无 location */
  }
  return "chat";
}

// 首屏锚点候选。不同页面类型约定的 anchor / direction 不一样,
// 逐个探测,谁先返回消息就用谁的参数继续翻页。
function getAnchorCandidates() {
  const botAnchor = { anchor: 0, direction: 3, source: "bot-anchor-0" };
  const newest = { anchor: START_ANCHOR, direction: 1, source: "newest" };
  const zero = { anchor: 0, direction: 3, source: "zero" };
  return detectChatType() === "bot-chat"
    ? [botAnchor, newest]
    : [newest, zero];
}

// 拼 /im/chain/single 的 URL。
// 观测到真实 URL 就直接复用(它已带齐会话参数);否则自拼并补齐默认 query,
// 这样即使页面还没发过该请求,也能直接开始导出。
function buildSingleChainUrl(observedUrl) {
  if (observedUrl) return observedUrl;

  const origin =
    (typeof location !== "undefined" && location.origin) || "https://www.doubao.com";
  const defaults = {
    version_code: "20800",
    language: "zh",
    device_platform: "web",
    aid: "497858",
    real_aid: "497858",
    pkg_type: "release_version",
    region: "CN",
    sys_region: "CN",
    samantha_web: "1",
    web_platform: "browser",
    "use-olympus-account": "1",
  };

  if (typeof URL !== "function") {
    const qs = Object.entries(defaults)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return `${origin}/im/chain/single?${qs}`;
  }

  const url = new URL("/im/chain/single", origin);
  const current = typeof location !== "undefined" ? new URL(location.href) : null;
  Object.entries(defaults).forEach(([key, value]) => {
    url.searchParams.set(
      key,
      (current && current.searchParams.get(key)) || value
    );
  });
  return url.toString();
}

// 兼容几种可能的返回层级(single / singe 两种拼写线上都出现过,偶尔外面还包一层 data)
function getSingleChainBody(data) {
  return (
    data?.downlink_body?.pull_singe_chain_downlink_body ||
    data?.downlink_body?.pull_single_chain_downlink_body ||
    data?.downlink_body?.pull_singe_chain_downlink_body?.single_chain ||
    data?.data?.downlink_body?.pull_singe_chain_downlink_body ||
    data?.data?.downlink_body?.pull_single_chain_downlink_body ||
    null
  );
}

// 接口若有显式的 next_anchor,优先信它(比自己算的准)
function getExplicitNextAnchor(body) {
  const keys = [
    body?.next_anchor_index,
    body?.next_anchor,
    body?.next_index_in_conv,
    body?.min_anchor_index,
    body?.min_index_in_conv,
    body?.last_index_in_conv,
    body?.cursor?.next_anchor_index,
    body?.cursor?.anchor_index,
    body?.page_info?.next_anchor_index,
    body?.pagination?.next_anchor_index,
  ];
  for (const value of keys) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.floor(num);
  }
  return 0;
}

// 计算下一页锚点
function getNextAnchor(body, pageMessages, currentAnchor) {
  const explicit = getExplicitNextAnchor(body);
  if (explicit && explicit !== currentAnchor) return explicit;

  const indexes = pageMessages
    .map((m) => Number(m.index_in_conv))
    .filter(Number.isFinite);
  if (indexes.length === 0) return 0;

  const oldest = Math.min(...indexes);
  return Math.max(1, oldest - 1); // anchor 是闭区间,往前退一格
}

// 消息唯一标识,用于跨页去重(接口分页之间可能有重叠)
function messageIdentity(msg) {
  return String(
    msg.message_id ||
      msg.id ||
      msg.server_message_id ||
      `${msg.index_in_conv}:${msg.user_type}:${extractText(msg)}`
  );
}

async function fetchPage(conversationId, anchorIndex, direction) {
  // 优先从 performance 条目拿真实 URL;找不到再回退到 fetch 钩子捕获的请求
  let observed = findSingleRequestUrl();
  if (!observed && capturedRequest) observed = capturedRequest.url;
  if (!observed) {
    requestCapture();
    await sleep(300);
    if (capturedRequest) observed = capturedRequest.url;
  }

  // 观测不到也不报错,直接自拼 URL 兜底
  const url = buildSingleChainUrl(observed);
  const body = buildBody(conversationId, anchorIndex, direction);

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
  const chain = getSingleChainBody(data) || {};
  return {
    messages: Array.isArray(chain.messages) ? chain.messages : [],
    hasMore: chain.has_more,
    body: chain,
  };
}

// 用一组锚点参数把一条对话翻到底
async function pullConversation(conv, start) {
  const collected = [];
  const seen = new Set();
  const seenAnchors = new Set();

  let anchor = start.anchor;
  let direction = start.direction;
  let repeated = 0;
  let lastPageKey = null;

  for (let page = 0; page < PAGE_GUARD; page++) {
    seenAnchors.add(anchor);
    const { messages: list, hasMore, body } = await fetchPage(
      conv.id,
      anchor,
      direction
    );
    if (!list.length) break; // 空页视为到底

    // 接口重复返回同一页,说明锚点没生效,连续两次就停
    const pageKey = list.map(messageIdentity).join("|");
    if (pageKey === lastPageKey) {
      repeated++;
      if (repeated >= 2) break;
    } else {
      repeated = 0;
      lastPageKey = pageKey;
    }

    for (const msg of list) {
      const key = messageIdentity(msg);
      if (!seen.has(key)) {
        seen.add(key);
        collected.push(msg);
      }
    }

    if (hasMore === false) break; // 接口明确说没有更早的了
    if (!hasMore && list.length < PAGE_SIZE) break; // 没给 has_more 时,短页视为到底

    const next = getNextAnchor(body, list, anchor);
    if (!next || seenAnchors.has(next)) break;
    anchor = next;
    direction = 1; // 除首屏外一律往更早的方向翻
    await sleep(50); // 轻量限速,避免触发风控
  }

  // 按 index_in_conv 升序(旧→新),比整体 reverse 更抗接口乱序
  collected.sort(
    (a, b) => Number(a.index_in_conv || 0) - Number(b.index_in_conv || 0)
  );
  return { messages: collected, start };
}

async function exportConversation(conv) {
  const attempts = [];
  for (const candidate of getAnchorCandidates()) {
    try {
      const result = await pullConversation(conv, candidate);
      if (result.messages.length) return { conv, ...result };
      attempts.push(`${candidate.source}: 空页`);
    } catch (err) {
      attempts.push(`${candidate.source}: ${err.message}`);
    }
  }
  throw new Error(`没有拉到任何消息(${attempts.join("; ")})`);
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

const ROLE_USER = "用户";
const ROLE_AI = "AI";
const ROLE_UNKNOWN = "?";

// 角色判定。
// 依据 570 条对话 / 300 条消息样本的实测结论:
//   - 有效字段只有 user_type:1 = 用户,2 = 助手
//   - sender_type / role / message_type 全为 undefined
//   - bot_reply_message_id 在 300/300 条消息上都存在(用户消息也带),没有区分度,
//     之前把它当"助手标记",导致整篇被判成 AI,现已移除
//   - reply_id 同理(引用回复),不可用
function inferRole(msg) {
  const senderType = Number(msg?.sender_type);
  const userType = Number(msg?.user_type);

  // 1. 角色枚举(实测:user_type 1 = 用户,2 = 助手)
  if (senderType === 1 || userType === 1) return ROLE_USER;
  if (senderType === 2 || senderType === 3 || userType === 2 || userType === 3) {
    return ROLE_AI;
  }

  // 2. 用户侧标记(实测未出现,保留给其他接口版本兜底)
  if (msg?.is_user === true) return ROLE_USER;
  if (msg?.sender?.user_id) return ROLE_USER;

  // 3. 字符串角色
  const role = typeof msg?.role === "string" ? msg.role.toLowerCase() : "";
  if (role === "user") return ROLE_USER;
  if (role === "assistant" || role === "bot" || role === "ai") return ROLE_AI;

  // 4. 旧结构:user_type 0 = 用户
  if (Number.isFinite(userType) && userType === 0) return ROLE_USER;

  return ROLE_UNKNOWN;
}

// 统计一条对话里的角色分布,用来在控制台暴露"全被标成 AI"这类回归
function countRoles(messages) {
  const stat = { user: 0, ai: 0, unknown: 0 };
  for (const msg of messages) {
    const role = inferRole(msg);
    if (role === ROLE_USER) stat.user++;
    else if (role === ROLE_AI) stat.ai++;
    else stat.unknown++;
  }
  return stat;
}

// 诊断:把一条消息里跟角色相关的字段挑出来打印,方便接口改版时快速定位
function sampleRoleFields(msg, limit = 80) {
  const keys = [
    "message_id",
    "index_in_conv",
    "create_time",
    "sender_type",
    "user_type",
    "role",
    "message_type",
    "from_user_id",
    "bot_reply_message_id",
    "reply_id",
    "brief",
  ];
  const pick = {};
  for (const key of keys) {
    if (msg?.[key] !== undefined) pick[key] = msg[key];
  }
  pick.text = extractText(msg).replace(/\s+/g, " ").slice(0, limit);
  pick.allKeys = Object.keys(msg || {}).slice(0, 24).join(",");
  return pick;
}

// 诊断:统计若干候选字段的取值分布,一眼能看出哪个字段在区分用户/助手
function summarizeRoleFields(messages) {
  const fields = ["sender_type", "user_type", "role", "message_type"];
  const flags = ["from_user_id", "bot_reply_message_id", "reply_id", "brief"];
  const stats = {};
  for (const field of fields) stats[field] = {};
  const present = {};
  for (const flag of flags) present[flag] = 0;

  for (const msg of messages) {
    for (const field of fields) {
      const value = msg?.[field];
      const key = value === undefined ? "undefined" : String(value);
      stats[field][key] = (stats[field][key] || 0) + 1;
    }
    for (const flag of flags) {
      const value = msg?.[flag];
      if (value !== undefined && value !== null && value !== "") present[flag]++;
    }
  }
  return { 样本数: messages.length, 字段分布: stats, 字段出现次数: present };
}

// 标题清洗:侧边栏是虚拟列表,textContent 常把同一条标题重复拼 2~3 遍;
// 顺手去掉首尾杂符并截断,避免文件名过长。
function normalizeTitle(raw, fallback) {
  let text = String(raw || "").replace(/\s+/g, " ").trim();

  for (let times = 4; times >= 2; times--) {
    if (text.length >= times * 2 && text.length % times === 0) {
      const unit = text.slice(0, text.length / times);
      if (unit.repeat(times) === text) {
        text = unit;
        break;
      }
    }
  }

  text = text.replace(/^[\s·\-–—|:：]+/, "").replace(/[\s·\-–—|:：]+$/, "");
  if (!text) text = String(fallback || "对话");
  return text.length > 60 ? text.slice(0, 60).trim() : text;
}

function formatMarkdown({ conv, messages }) {
  const title = normalizeTitle(conv.title, conv.id);
  const out = [];
  out.push(`# ${title}`, "");
  out.push(`- 对话 ID: ${conv.id}`);
  out.push(`- 消息数: ${messages.length}`);
  out.push(`- 导出时间: ${new Date().toISOString()}`);

  let unknown = 0;
  const rows = [];
  for (const msg of messages) {
    const detected = inferRole(msg);
    if (detected === ROLE_UNKNOWN) unknown++;
    const role = detected === ROLE_UNKNOWN ? ROLE_AI : detected;
    const time = msg.create_time
      ? new Date(Number(msg.create_time) * 1000).toLocaleString()
      : "";
    const text = extractText(msg);
    if (!text) continue;
    rows.push(`## ${role}${time ? ` · ${time}` : ""}`, "", text, "", "---", "");
  }

  if (unknown > 0) {
    out.push(`- 角色识别: ${unknown} 条未能判定(sender_type / role 均缺失),已按 AI 输出`);
  }
  out.push("", "---", "", ...rows);
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
  let totalUser = 0;
  const roleSamples = [];
  const errors = [];

  for (let i = 0; i < convs.length; i++) {
    const conv = convs[i];
    try {
      const result = await exportConversation(conv);
      const markdown = formatMarkdown(result);
      const filename = normalizeTitle(conv.title, conv.id);
      await requestDownload(filename, markdown);
      success++;
      const roleStat = countRoles(result.messages);
      totalUser += roleStat.user;
      for (const msg of result.messages) {
        if (roleSamples.length < 300) roleSamples.push(msg);
      }
      if (i === 0) {
        log("字段样本#1:", sampleRoleFields(result.messages[0]));
        if (result.messages[1]) log("字段样本#2:", sampleRoleFields(result.messages[1]));
      }
      log(
        `[${i + 1}/${convs.length}] ${filename}: ${result.messages.length} 条 ` +
          `(用户 ${roleStat.user} / AI ${roleStat.ai} / 未识别 ${roleStat.unknown}) ✓`
      );
    } catch (err) {
      failed++;
      errors.push(`${conv.title || conv.id}: ${err.message}`);
      log(`[${i + 1}/${convs.length}] ${conv.title || conv.id}: 失败 - ${err.message}`);
    }
    postProgress({ type: "progress", done: i + 1, total: convs.length });
  }

  log(`导出完成: 成功 ${success}, 失败 ${failed}`);
  if (roleSamples.length) {
    log("角色字段分布:", JSON.stringify(summarizeRoleFields(roleSamples)));
  }
  if (errors.length) log("失败明细:", errors);
  if (success > 0 && totalUser === 0) {
    console.warn(
      "[豆包导出] 警告:全部导出里没有识别到任何用户消息,角色判定可能已失效(接口字段变了)。"
    );
  }
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