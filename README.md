# dsh-connect-autoclaw

把 **AutoClaw**（智谱桌面客户端，代号 zwork）的模型接进 DeepSeek Harness。

**纯 HTTP 直连**，不需要 AutoClaw 客户端在后台运行，也没有本地 WebSocket 桥接。

## 工作方式

1. **凭据**：读本机客户端已保存的登录态
   - `%APPDATA%\autoclaw\token-cache.json`（DPAPI + AES-256-GCM，`enc:` 前缀）
   - `%APPDATA%\AutoClaw-official\accounts\<hash>\account-credentials.enc`（`v10` 格式）
   在 AutoClaw 客户端登录一次即可，插件自动发现。
2. **推理**：`POST https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions`
3. **模型目录**：服务端 `autoclaw-model-config`（6 个模型，带 `creditCostFactor` 倍率）
4. **积分**：输入框工具行「⚡ 积分 N」角标 + 明细弹层（钱包余额、模型倍率）

## 406 的真相（本项目最重要的一节）

上游有一道**请求体校验**，不通过就返回 `406`（空 body，带 `acw_tc` cookie，看起来很像 WAF）。
踩过的所有弯路和最终结论：

**不是** TLS 指纹（Go 的 crypto/tls、Electron 的 BoringSSL、真实 Chromium 都试过，一样 406）
**不是** IP 风控（同一台机器、同一时刻，官方客户端能通）
**不是** HTTP 版本（HTTP/1.1 与 HTTP/2 都试过）
**不是** 请求头顺序或某个特定头（签名头、`x_trace_id`、`X-Agent-Id`、`x-return-billing` 全去掉仍 200）

真正必须满足的只有两条，都在**请求体**里：

1. **`messages[0]` 必须是 AutoClaw 的 system persona，逐字一致**
   —— 见 `src/persona.js`（7256 字符，从 2.5.3 主进程真实请求中捕获）。
   换一个字、加一行、或者干脆不带 → 406。
2. **body 里不能出现 `max_tokens` 字段**
   —— 用它必 406。要限长请用 `max_completion_tokens`，或者不传。

其余全部可省：`tools`、`store`、`reasoning_effort`、`x-auth-sign`、`x-session-id`（可用随机 UUID）。

DSH 自己的 system 指令不能塞进 `system`（会破坏 persona），所以按
`[system-note]…[/system-note]` 并入**首条 user 消息**——实测 200 且指令生效。

## 工具调用

两件事必须同时做对，否则模型会把工具调用**写成正文文本**（表现成回复里出现
`[{"type":"tool-call",...}]` 这样的 JSON，或者干脆什么都不执行）。

### 1. 把工具定义传给上游

`request.tools` 要转成 OpenAI 的 `tools`。不传的话模型根本不知道有工具可用。

### 2. 消息 content 是**块数组**，必须按块翻译

这是最容易踩的坑：Harness 传来的 `message.content` 常常是

```js
[{ type: 'text', text: '…' }, { type: 'tool-call', id, name, arguments }]
```

而**不是**字符串。如果直接 `JSON.stringify` 它，模型看到的就是一段
`[{"type":"reasoning",...},{"type":"tool-call",...}]` 的**文本**，
于是照着模仿 —— 于是你得到一个「把工具调用写在正文里」的模型。

正确做法（`src/messages.js`）：

| Harness 块 | → OpenAI |
|---|---|
| `text` | `{ type:'text', text }` |
| `image` | `{ type:'image_url', image_url:{ url } }` |
| `tool-call` | `message.tool_calls[]` |
| `tool-result` | `{ role:'tool', tool_call_id, content }` |
| `reasoning` | **丢弃**（不进历史，否则撑爆上下文） |

### 3. 上游回的 tool_calls 要翻译成 harness 事件

```
block-start(blockType: 'tool-call')
  → tool-call-delta { index, id, name, argumentsDelta }
  → block-end { block: { type:'tool-call', id, name, arguments } }
  → finish { kind: 'tool-calls' }
```

块索引按「首次出现」顺序分配（text / reasoning / tool-call 各占一个）；
参数累计后若不是合法 JSON 就标记 `brokenToolCall`，`finish` 降级为 `max-tokens`，
让 harness 丢掉这个半截调用而不是去执行它。

> 交叉验证：开源项目 `apmengzi/autoclaw-switch` 的 `TEST_REPORT.md` 用约 30 组对照实验
> 得出了同样的结论（406 = body 判据，已证伪 TLS 指纹 / IP 风控 / 头顺序），
> 并指出 `max_tokens` 与 system persona 这两条。我们的抓包实验独立复现了它。

## 安装

### 从 GitHub 仓库安装
（收录审核中：awesome-dsh-plugin PR，通过后可从市场一键安装）

### 从源码目录安装

```bash
dsh plugin add github:your-name/dsh-connect-autoclaw
```

或从源码目录 link：

```bash
dsh plugin add D:\Code\Project\未知\dsh\autoclaw-provider
```

## 已知限制

- 免费账号（只有奖励积分、无订阅）在高峰期会被业务层限流：
  `403 {"code":810001}` ——「当前使用人数较多」，等非高峰或开通会员。
- 令牌有效期约 24 小时，客户端刷新后插件自动跟进（10 分钟 TTL）。
- 模型 id 只有服务端目录里的那 6 个合法，其它会 `400 非法模型`。

## 协议要点（速查）

| 项 | 值 |
|---|---|
| 对话路径 | `/autoclaw-proxy/proxy/autoclaw/chat/completions` |
| 鉴权 | `X-Authorization: Bearer <token>`（**不用** `Authorization`；业务接口反过来） |
| 关键头 | `x-channel: AutoClaw16`、`x-version: 2.5.3`、`x_trace_id: autoclaw-desktop`、`X-Agent-Id: main` |
| system | 必须等于 `src/persona.js` |
| 限长字段 | `max_completion_tokens`（**禁止** `max_tokens`） |
| 签名 | `x-auth-sign = md5(appId&timestamp秒&appKey)`（可选但保留） |

## License

MIT