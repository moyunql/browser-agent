# Browser Agent — 装在浏览器里的 LLM 操作代理

把大模型直接接进浏览器：读页面、点按钮、填表单、抓网络请求与响应体、在页面 JS 上下文里执行代码。
**不需要 Playwright / Selenium，不需要开远程调试端口，不依赖任何外置自动化进程。**

后端只需一个 OpenAI 兼容的 `/chat/completions` 接口。

```
┌─────────────────────────────┐
│ panel.html / panel.js       │  ← 独立弹出窗口，常驻，不会休眠
│  Agent 主循环（思考→调工具）  │
└──────────┬──────────────────┘
           │ chrome.runtime.sendMessage
┌──────────▼──────────────────┐
│ background.js（Service Worker）│
│  · chrome.debugger (CDP 1.3) │───► 目标标签页（真实浏览器内核）
│  · Network 事件缓存 + 响应体   │
│  · LLM 请求代理（绕 CORS）    │
└─────────────────────────────┘
```

- Agent 循环跑在**面板页面**里，不是 service worker —— 不受 MV3 的 30 秒空闲休眠影响。
- 底层走 `chrome.debugger`（DevTools 协议），能力上限就是 DevTools 的上限。
- LLM 请求由 background 代发，绕开扩展页面的 CORS 与混合内容限制。

## 为什么是扩展，不是油猴脚本

| 能力 | 油猴脚本 | 本扩展 |
|---|---|---|
| 操作 DOM / 填表单 | ✅ | ✅ |
| 真实鼠标事件（过 `isTrusted` 校验） | ❌ 只能 `dispatchEvent` | ✅ `Input.dispatchMouseEvent` |
| 读响应体原文 | ⚠️ 得 hook fetch/XHR，会跟页面抢数据 | ✅ 网络层直接拿，页面无感 |
| 读页面内存（全局变量 / 框架内部状态） | ⚠️ 只能读全局 | ✅ 调试器上下文求值 |
| 操作其他标签页 | ❌ | ✅ |
| 读 Cookie（含 HttpOnly） | ❌ | ✅ |

## 功能

**15 个工具**

| 工具 | 作用 |
|---|---|
| `browser_snapshot` | 把页面压成 `[0][1][2]` 编号的可交互元素 + 主要文本 |
| `browser_click` / `type` / `press` / `scroll` | 真实鼠标键盘，能触发 canvas 与 React 受控组件 |
| `browser_eval` | 在页面 JS 上下文执行任意代码，批量提取数据 |
| `net_list` / `net_body` / `net_clear` | 全量请求列表、请求头体、响应体 |
| `tab_list` / `tab_use` / `browser_screenshot` / `browser_cookies` / `browser_wait` | 标签页、截图、Cookie、等待 |

**其他**

- **任务列表**：每次提交自动入库，显示时间 / 步数 / 状态，可回填、删除、清空
- **系统提示词可编辑**：内置约 2200 字强化版，可以「填入默认」后任意修改，保存即时生效
- **技能模板**：7 套可勾选片段（授权声明、渗透作业、登录测试、接口抓取、表单自动化、数据提取、表格输出），支持全选批量插入
- **长任务友好**：步数 0 = 不限制（仅 300 步保险丝），上下文超阈值自动摘要压缩后续跑
- **JS 控制台**：不经过模型，直接在当前页执行 JS —— 模型不配合时的手动执行通道
- **环境自检**：一键检测内核版本、调试器可用性、attach 结果

## 快速开始

**1. 装扩展**

```
chrome://extensions/  →  开发者模式  →  加载已解压的扩展程序  →  选 browser-agent/
```

> 目录里不能有以 `_` 或 `.` 开头的文件/目录名，Chrome 视其为系统保留，会导致整个清单加载失败。

**2. 配接口**

点工具栏图标打开面板 → 右上角 ⚙：

| 项 | 说明 |
|---|---|
| 接口地址 | 形如 `https://your-host/v1`（OpenAI 兼容） |
| 模型 | 例如 `deepseek-v4.1-flash` / `hy4-preview-f`（后者带视觉） |
| API Key | 这里填，**不要写进代码** |
| 最大步数 | `0` 或留空 = 不限制 |

**3. 用**

面板里直接说人话，`Ctrl+Enter` 发送：

```
打开 example.com，把标题和所有链接列出来
清空网络记录，点一下"加载更多"，把 /api/goods/list 的响应 JSON 结构给我
用 eval 把页面里所有带 data-id 的元素 id 一次提取出来
```

## 本地登录靶场

`lab/server.js` 是一个零依赖的练习靶场，用于练登录链路分析与验证码强度评估。

```bash
node lab/server.js        # http://127.0.0.1:8899
```

| 账号 | 密码 |
|---|---|
| admin | 123456 |
| operator | op1234 |
| demo | demo |

内置 6 个真实世界里常见的弱点：

1. 图形验证码 4 位数字、字体固定、无扭曲 —— 可逐像素还原
2. **验证码空值绕过**：`vercode: ""` 直接跳过校验
3. 无失败次数限制
4. 用户名枚举（`用户不存在` / `密码错误` 分开返回）
5. `/api/users` 未鉴权，直接吐出全部账号
6. 弱口令

> 靶场仅用于本地学习，跑在 `127.0.0.1`，不对外监听。

## 目录

```
.
├── browser-agent/        扩展本体
│   ├── manifest.json
│   ├── background.js     CDP 桥 / 网络缓存 / LLM 代理 / 快照与交互实现
│   ├── panel.html|css|js 面板 UI 与 Agent 主循环
│   └── icons/
├── lab/                  本地登录靶场（零依赖）
│   └── server.js
├── dev-tests/            真机验证脚本（用真实 Chrome + CDP 跑）
│   ├── test-features.mjs 任务列表 / 提示词 / 技能 / 压缩 / JS 控制台
│   ├── test-snapshot.mjs 快照函数 13 项断言
│   ├── e2e-agent.mjs     端到端：模型自主操作页面
│   └── mock-panel.mjs    用 mock chrome API 复现面板渲染
└── gen_icons.py          图标生成（纯标准库）
```

跑测试需要先起一个带调试端口的 Chrome：

```bash
chrome --headless=new --remote-debugging-port=9337 --user-data-dir=/tmp/x about:blank
node dev-tests/test-features.mjs
```

## 注意

- **API Key 只存在浏览器本地**（`chrome.storage.local`），仓库里不含任何密钥。
- 目标页开着 DevTools 时 `chrome.debugger` 会互斥，报 `Another debugger is already attached`，关掉 F12 重试即可。
- 操作期间页面顶部会出现「Chrome 正在调试此浏览器」提示条，属正常现象。
- 扩展权限等同于 DevTools，请自行评估使用场景。

## License

MIT
