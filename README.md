# 豆包对话导出器

一个 Chrome 浏览器插件（Manifest V3），用于**批量导出豆包（AI 助手）的所有历史对话**为 Markdown 文件。

## 功能

- 一键枚举你账号下的全部历史对话
- 逐条分页拉取完整历史（含时间戳与正确排序）
- 每条对话导出为一个独立的 `.md` 文件
- 复用浏览器已登录的 Cookie，无需二次登录
- 实时进度显示，单条失败不影响整体

## 安装加载

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角**开发者模式**
3. 点击**加载已解压的扩展程序**
4. 选择本目录 `doubao_export/`

## 使用步骤

1. 在 Chrome 中打开并登录豆包：`https://www.doubao.com/chat`
2. 点击工具栏的「豆包对话导出器」图标
3. 点击「开始导出全部对话」
4. 完成后，Markdown 文件会保存到浏览器的下载目录 `doubao_export/` 子目录下

## 工作原理

- 内容脚本运行在豆包页面同源环境，枚举侧边栏 `#flow_chat_sidebar` 中的全部对话链接
- 通过 `hook.js` 在页面主世界注入 fetch 钩子，**捕获页面自身发起的 `/im/chain/single` 请求**（含 aid/device_id/web_id 等会话参数），复用其 URL / headers / body 模板
- 对每条对话，仅覆盖 `conversation_id` 与 `anchor_index` 分页拉取历史——因复用页面真实请求，**与线上版本保持一致，不依赖硬编码参数**
- 解析消息（兼容新旧两种 content 结构），提取时间戳与角色（用户 / AI）
- 格式化输出 Markdown，交由后台 Service Worker 通过 `chrome.downloads` 下载

## 目录结构

```
doubao_export/
├── manifest.json   # MV3 清单
├── hook.js         # 主世界 fetch 钩子，捕获页面真实请求
├── background.js   # 后台，处理文件下载
├── content.js      # 抓取逻辑（枚举 + 分页 + 格式化）
├── popup.html      # 弹窗 UI
├── popup.js        # 弹窗逻辑
└── popup.css       # 弹窗样式
```

## 说明与注意

- 插件仅在你自己的浏览器会话内运行，导出的是你账号自己的数据，不会上传到任何第三方服务
- 大量对话导出耗时较长，请保持页面与弹窗打开
- 若豆包改版导致选择器失效，可调整 `content.js` 顶部的 `SIDEBAR_SELECTORS` 与消息解析逻辑
- 若遇到风控限流，可在 `content.js` 中适当调大 `PAGE_LIMIT` 下方的 `sleep` 间隔