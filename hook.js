// 主世界 fetch 钩子。通过 chrome.scripting.registerContentScripts({ world: "MAIN" })
// 注册到页面主世界,规避 CSP 对内联 <script> 的拦截。
// 捕获豆包页面自身发起的 /im/chain/single 请求(URL + headers + body 模板),
// 并通过 postMessage 回传给隔离世界的内容脚本 content.js。

if (!window.__doubaoHookInstalled) {
  window.__doubaoHookInstalled = true;

  let lastReq = null;
  const orig = window.fetch;

  window.fetch = async function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
    if (url && url.includes("/im/chain/single")) {
      const opts = args[1] || {};
      let body = null;
      try {
        body = typeof opts.body === "string" ? JSON.parse(opts.body) : null;
      } catch (_) {
        /* 忽略非 JSON body */
      }
      lastReq = { url, headers: opts.headers || {}, body };
      window.postMessage({ source: "doubao-hook", type: "captured", req: lastReq }, "*");
    }
    return orig.apply(this, args);
  };

  // 内容脚本按需索取最近一次捕获的请求
  window.addEventListener("message", (e) => {
    if (e.data && e.data.source === "doubao-hook" && e.data.type === "request" && lastReq) {
      window.postMessage({ source: "doubao-hook", type: "captured", req: lastReq }, "*");
    }
  });
}