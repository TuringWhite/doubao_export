// content.js 核心逻辑的单元测试
// 用 vm 加载脚本,注入 chrome / fetch stub,验证消息解析、分页、Markdown 格式化。
// 运行: node test.js

const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const code = fs.readFileSync(__dirname + "/content.js", "utf8");

// ---- stub chrome ----
const listeners = [];
const sentMessages = [];
global.chrome = {
  runtime: {
    sendMessage: (msg) => sentMessages.push(msg),
    onMessage: { addListener: (fn) => listeners.push(fn) },
  },
};

// ---- stub document / fetch ----
const sandbox = {
  chrome: global.chrome,
  console,
  setTimeout,
  Promise,
  document: { querySelector: () => null, body: {} },
  window: {
    addEventListener: () => {},
    postMessage: () => {},
  },
  performance: {
    getEntriesByType: () => [], // 无资源条目,回退到 capturedRequest
  },
  fetch: null, // 由各测试注入
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const { extractText, formatMarkdown, exportConversation } = sandbox;

// ===========================================================================
// 1. extractText —— 新旧两种 content 结构
// ===========================================================================
function testExtractText() {
  // 新结构 content_type 9998: content_block[].content.text_block.text
  const newMsg = {
    content_block: [
      { content: { text_block: { text: "第一段" } } },
      { content: { text_block: { text: "第二段" } } },
    ],
  };
  assert.strictEqual(
    extractText(newMsg),
    "第一段\n第二段",
    "新结构应拼接多个 text_block"
  );

  // 旧结构 content_type 2: content 是字符串化 JSON
  const oldMsg = { content: '{"text":"旧格式文本"}' };
  assert.strictEqual(extractText(oldMsg), "旧格式文本", "旧结构应解析 JSON .text");

  // content 是纯文本(非 JSON)
  const plainMsg = { content: "纯文本" };
  assert.strictEqual(extractText(plainMsg), "纯文本", "非 JSON 字符串应原样返回");

  // 兜底 tts_content
  const ttsMsg = { tts_content: "tts 兜底" };
  assert.strictEqual(extractText(ttsMsg), "tts 兜底", "应使用 tts_content 兜底");

  // 空消息
  assert.strictEqual(extractText({}), "", "空消息应返回空串");

  console.log("✓ extractText: 5 例通过");
}

// ===========================================================================
// 2. formatMarkdown —— 角色与时间戳
// ===========================================================================
function testFormatMarkdown() {
  const conv = { id: "123", title: "测试对话" };
  const messages = [
    { user_type: 0, create_time: 1700000000, content_block: [{ content: { text_block: { text: "你好" } } }] },
    { user_type: 3, create_time: 1700000060, content_block: [{ content: { text_block: { text: "你好,我是 AI" } } }] },
    { user_type: 3, content_block: [{ content: { text_block: { text: "无时间戳" } } }] },
  ];
  const md = formatMarkdown({ conv, messages });

  assert.ok(md.includes("# 测试对话"), "应有标题");
  assert.ok(md.includes("对话 ID: 123"), "应有对话 ID");
  assert.ok(md.includes("## 用户"), "应标记用户消息");
  assert.ok(md.includes("## AI"), "应标记 AI 消息");
  assert.ok(md.includes("你好,我是 AI"), "应包含 AI 文本");
  assert.ok(md.includes("无时间戳"), "无时间戳消息不应被跳过");
  assert.ok(md.includes("## AI ·"), "带时间戳的 AI 消息应显示时间分隔符");

  console.log("✓ formatMarkdown: 通过");
}

// ===========================================================================
// 3. exportConversation —— 分页锚点游标与排序
// ===========================================================================
async function testExportConversation() {
  // 模拟 3 页(新→旧):前两页各满 50 条,最后一页 30 条(不足 limit 触发终止)
  const scope = 50; // 与 content.js 的 PAGE_LIMIT 一致
  const makePage = (start, n) =>
    Array.from({ length: n }, (_, i) => ({
      index_in_conv: start - i,
      user_type: i % 2,
      content: `m${start - i}`,
    }));

  const pages = {
    p1: makePage(200, scope), // 200..151
    p2: makePage(150, scope), // 150..101
    p3: makePage(100, 30), // 100..71
    empty: [],
  };

  // 注入捕获的请求模板(模拟页面自身的成功请求),带 URL query 参数
  sandbox.__setCapturedRequest({
    url: "https://www.doubao.com/im/chain/single?aid=497858&device_id=x&web_id=y&region=CN",
    headers: { referer: "https://www.doubao.com/chat/123" },
    body: {
      cmd: 3100,
      sequence_id: "c0ffee-0000-0000-0000-000000000000",
      uplink_body: {
        pull_singe_chain_uplink_body: {
          conversation_id: "123",
          anchor_index: Number.MAX_SAFE_INTEGER,
          conversation_type: 3,
          direction: 1,
          limit: 50,
          ext: {},
          filter: { index_list: [] },
        },
      },
    },
  });

  const requestAnchors = [];
  sandbox.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const anchor = body.uplink_body.pull_singe_chain_uplink_body.anchor_index;
    requestAnchors.push(anchor);
    let msgs;
    if (anchor > 150) msgs = pages.p1; // 200..151
    else if (anchor > 100) msgs = pages.p2; // 150..101
    else if (anchor > 70) msgs = pages.p3; // 100..71
    else msgs = pages.empty; // 已到底,返回空页
    return {
      ok: true,
      json: async () => ({
        downlink_body: {
          pull_singe_chain_downlink_body: { messages: msgs },
        },
      }),
    };
  };

  const result = await exportConversation({ id: "123", title: "t" });
  const ids = result.messages.map((m) => m.index_in_conv);

  // 应收集 50+50+30 = 130 条,且按旧→新排序
  assert.strictEqual(ids.length, 130, `应收集 130 条,实得 ${ids.length}`);
  assert.strictEqual(ids[0], 71, "最旧消息应排在最前");
  assert.strictEqual(ids[129], 200, "最新消息应排在最后");
  for (let i = 1; i < ids.length; i++) {
    assert.ok(
      ids[i] > ids[i - 1],
      `索引 ${i}: ${ids[i - 1]} -> ${ids[i]} 未严格递增`
    );
  }

  // 锚点应单调递减(从 MAX_SAFE_INTEGER 往旧走)
  for (let i = 1; i < requestAnchors.length; i++) {
    assert.ok(
      requestAnchors[i] < requestAnchors[i - 1],
      "锚点应逐步递减"
    );
  }

  console.log(`✓ exportConversation: 分页正确,共 ${ids.length} 条,锚点游标递减`);
}

// ===========================================================================
// 4. 消息通道 —— 进度事件广播
// ===========================================================================
function testMessageChannel() {
  sandbox.postProgress?.({ type: "started", total: 3 });
  const last = sentMessages[sentMessages.length - 1];
  assert.ok(last && last.type === "started" && last.total === 3, "应广播 started 事件");
  console.log("✓ 消息通道: 进度事件广播通过");
}

// ===========================================================================

async function main() {
  testExtractText();
  testFormatMarkdown();
  await testExportConversation();
  testMessageChannel();
  console.log("\n全部测试通过 ✅");
}

main().catch((err) => {
  console.error("\n测试失败 ❌:", err.message);
  process.exit(1);
});