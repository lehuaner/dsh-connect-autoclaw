/**
 * 请求头与签名。
 *
 * ⚠️ 这里最反直觉的一点：**406 与请求头几乎无关，判据在请求体**。
 *
 * 依据两份独立证据：
 *
 * 1. `apmengzi/autoclaw-switch` 的 TEST_REPORT.md（30 组对照实验）明确指出，
 *    406 是「body 判据」，并且已经证伪了 TLS 指纹、IP 风控、请求头顺序这几个假设。
 *
 * 2. 我们自己在 AutoClaw 2.5.3 上抓到的真实请求（probe/52-replay-captured.mjs）
 *    做删减实验（probe/55-minimal-headers.mjs）：签名头、x_trace_id、X-Agent-Id、
 *    x-return-billing 全部去掉仍返回 200；随机 x-session-id 也 200。
 *
 * 真正不可省的两条见 `stream.js`：
 *   - `messages[0]` 必须是 AutoClaw 的 system persona（`persona.js`）
 *   - body 里**不能出现 `max_tokens` 字段**（用它必 406，要用 `max_completion_tokens`）
 *
 * 下面的头按抓到的真实值保留，宁多勿少 —— 它们不构成风险，只是还原真实客户端。
 */

import { createHash, randomUUID } from 'node:crypto'
import { APP_ID, APP_KEY, CHANNEL, CLIENT_VERSION, CLIENT_TYPE, LANG, PLATFORM, PRODUCT } from './product.js'

/** 客户端真实 UA。注意：抓包里对话请求发的就是这个完整 Electron UA。 */
export const USER_AGENT =
	`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
	`AutoClaw/${CLIENT_VERSION} Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36`

/**
 * 算签名：`md5(appId&timestamp秒&appKey)`。
 * 抓包实测值逐字节命中（1795529535 → d2c79e3bbb34af0340b8fe7723315875）。
 */
export function sign(nowSec = Math.floor(Date.now() / 1000)) {
	return createHash('md5').update(`${APP_ID}&${nowSec}&${APP_KEY}`).digest('hex')
}

/** 去掉 token 上游多带的 `Bearer ` 前缀。 */
export function stripBearer(token) {
	return typeof token === 'string' ? token.replace(/^Bearer\s+/i, '').trim() : ''
}

/**
 * 组装对话推理请求头 —— 逐字对齐抓到的真实请求。
 *
 * 真实请求里的头（全部小写发送）：
 *   accept: application/json
 *   x-auth-appid / x-auth-sign / x-auth-timestamp
 *   x-channel: AutoClaw16   ← 不是 official
 *   x-client-type: pc
 *   x-lang: zh-CN
 *   x-product: autoclaw
 *   x-query-id / x-request-id / x-request-model / x-return-billing
 *   x-session-id
 *   x-tm: win
 *   x-trace-id / x-version / x_trace_id: autoclaw-desktop
 *   X-Agent-Id: main
 *   X-Authorization: Bearer <token>
 *   content-type: application/json
 *
 * 注意：**没有** `Authorization`，**没有** OpenAI SDK 的 `x-stainless-*`。
 */
export function buildHeaders({ token, kind = 'inference', model, sessionId, queryId, cookie } = {}) {
	const nowSec = Math.floor(Date.now() / 1000)
	const bare = stripBearer(token)
	const requestId = randomUUID()

	const headers = {
		accept: 'application/json',
		'x-auth-appid': APP_ID,
		'x-auth-sign': sign(nowSec),
		'x-auth-timestamp': String(nowSec),
		'x-channel': CHANNEL,
		'x-client-type': CLIENT_TYPE,
		'x-lang': LANG,
		'x-product': PRODUCT,
		'x-tm': PLATFORM,
		'x-version': CLIENT_VERSION,
		'x_trace_id': 'autoclaw-desktop',
		'content-type': 'application/json',
		'User-Agent': USER_AGENT
	}

	if (cookie) headers.Cookie = cookie

	if (kind === 'inference') {
		headers['x-request-id'] = requestId
		headers['x-trace-id'] = requestId
		headers['x-query-id'] = queryId ?? randomUUID()
		headers['x-session-id'] = sessionId ?? randomUUID()
		headers['x-return-billing'] = 'true'
		headers['X-Agent-Id'] = 'main'
		if (model) headers['x-request-model'] = model
		if (bare) headers['X-Authorization'] = `Bearer ${bare}`
	} else {
		// 业务面（钱包、模型目录）：真实请求用的是标准 Authorization
		if (bare) headers.Authorization = `Bearer ${bare}`
		delete headers.accept
		headers.accept = '*/*'
	}

	return headers
}

/**
 * 判断一个响应是不是「被 WAF 挡了」。
 *
 * 现在我们知道了：406 的主因是 body 不合规，而不是网络抖动。
 * 所以这里只把它当可重试信号，不要当作网络问题去猛刷。
 */
export function isWafBlock(status, body, headers) {
	if (status === 406) return true
	if (status === 403 && !body) return true
	const setCookie = headers?.get?.('set-cookie') ?? ''
	if (setCookie.includes('acw_tc') && !body) return true
	return false
}