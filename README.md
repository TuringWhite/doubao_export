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
- 若遇到风控限流，可在 `content.js` 中适当调大翻页之间的 `sleep` 间隔
- 需要 Chrome 111+（`hook.js` 以 `world: "MAIN"` 方式动态注册）

## 版本记录

### 1.1.2

- 角色判定收敛：用 570 条对话 / 300 条消息样本确认，唯一有效字段是 `user_type`（1 = 用户，2 = 助手）；
  `sender_type`、`role`、`message_type` 全部 undefined，`bot_reply_message_id` 在 300/300 条消息上都存在（零区分度）。
  移除 `bot_reply_message_id` 作为助手标记的判定，避免再次整篇误判。
- 新增 [docs/使用说明.md](docs/使用说明.md)：含实拍截图、日志逐行解读、角色判定踩坑记录与常见问题。

### 1.1.1

- 修复角色判定优先级：`reply_id`（引用回复）用户消息也会带，旧逻辑把它当成助手标记，导致整篇被判成 AI。
  现在用户侧标记（`sender_type`/`user_type` = 1、`from_user_id`、`sender.user_id`）排在 `bot_reply_message_id` 之前，
  `reply_id` 不再参与判定。
- 修复侧边栏枚举：原来滚一次等 400ms 就判定「没有新增」，侧边栏稍慢就只拿到当前可见的几条（实测只枚举到 5 条而实际有几百条）。
  现在每轮滚动所有可滚动容器、等 600ms，连续 3 轮无新增才收手，并打印每轮累计数。
- 增加角色诊断：导出时打印首条/第二条消息的角色相关字段，结束时打印字段取值分布，接口改版可一眼定位。

### 1.1.0

- 修复角色判定：线上消息用的是 `sender_type`（1 = 用户，2 = 助手），旧版按 `user_type === 0` 判断，
  导致 409 个导出文件里用户消息全部被标成 AI。现按 `sender_type → is_user / from_user_id → role → bot_reply → user_type`
  的顺序多字段兜底，仍判不出来记为「未识别」，并在文件头与控制台给出提示。
- 修复文件名/标题重复：侧边栏是虚拟列表，`textContent` 会拼出 `标题标题标题`，现做重复段还原、去杂符并截断到 60 字。
- 补 `icons/`（16/32/48/128）并在 manifest 中声明。
- 智能体对话（`/chat/bot/chat/:id`）改用 `anchor=0 + direction=3` 首屏探测，普通对话用 `MAX_SAFE_INTEGER + direction=1`，失败自动换候选。
- 观测不到页面请求时自拼 `/im/chain/single` URL 并补齐默认 query，不再直接报错。
- 分页改用 `has_more` 判终止，锚点优先取接口返回的 `next_anchor`，并加 `seenAnchors` + 重复页 + 消息 ID 三重去重。
- 单元测试扩到 9 组，`node test.js` 全绿。

### 1.0.0

- 首个版本：枚举侧边栏会话、按页拉取历史、导出 Markdown。
