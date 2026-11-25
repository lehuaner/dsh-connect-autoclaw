/**
 * AutoClaw 提供方适配器。
 *
 * 走纯 HTTP：`POST {API_BASE}{INFER_PATH}`，OpenAI 兼容的 chat/completions 形状。
 * 不需要桌面客户端在跑，也不需要本地 WebSocket 桥接 —— 只要账号的登录令牌还有效。
 *
 * 模型清单以服务端 `autoclaw-model-config` 为准（带 `creditCostFactor` 倍率，
 * 积分显示要用），拉不到时才退回 `FALLBACK_MODELS`。
 */

import { API_BASE, FALLBACK_MODELS, INFER_PATH, MODEL_CONFIG_PATH, PROVIDER_ID, ERROR_CODES } from './product.js'
import { buildHeaders, isWafBlock } from './headers.js'
import { AUTOCLAW_PERSONA } from './persona.js'

/** 从上游 model-config 响应里取出模型清单。 */
export function parseModelConfig(raw) {
	const models = Array.isArray(raw?.models) ? raw.models : []
	return models
		.map((m) => ({
			id: String(m?.id ?? ''),
			name: String(m?.name ?? m?.id ?? ''),
			contextWindow: Number(m?.contextWindow) || 131072,
			maxTokens: Number(m?.maxTokens) || 32768,
			supportsImage: Array.isArray(m?.input) && m.input.includes('image'),
			reasoning: m?.reasoning === true,
			creditCostFactor: typeof m?.creditCostFactor === 'number' ? m.creditCostFactor : undefined,
			tooltip: typeof m?.tooltip === 'string' ? m.tooltip : undefined
		}))
		.filter((m) => m.id !== '')
}

/** 拉模型目录。业务鉴权（`Authorization`），和推理用的头不一样。 */
export async function fetchModelConfig(token, options = {}) {
	const res = await fetch(API_BASE + MODEL_CONFIG_PATH, {
		method: 'GET',
		headers: buildHeaders({ token, kind: 'business', cookie: options.cookie }),
		signal: options.signal ?? AbortSignal.timeout(15000)
	})
	const text = await res.text()
	if (!res.ok) throw new Error(`模型目录接口 HTTP ${res.status}: ${text.slice(0, 160)}`)
	return parseModelConfig(JSON.parse(text))
}

/**
 * 把上游的业务错误翻译成用户能看懂的话。
 *
 * 这个映射是实测出来的，三种情况差别很大：
 * - `810001 pay-view`：免费额度用尽 / 高峰期排队。**等一等再试**可能就好了，
 *   但短时间内重试没用，所以标成不可立即重试。
 * - `401001 Invalid token`：令牌失效，或请求头名字用错。要去客户端重新登录。
 * - `400 非法模型`：模型 id 不对，不是账号问题。
 */
export function explainError(status, body) {
	let parsed
	try {
		parsed = JSON.parse(body)
	} catch {
		parsed = undefined
	}

	const code = parsed?.code
	const message = parsed?.message ?? parsed?.msg ?? ''

	if (code === ERROR_CODES.PAY_VIEW) {
		return {
			code,
			kind: 'quota',
			retryable: false,
			message:
				'当前使用人数较多，系统繁忙：这个 AutoClaw 账号没有可用额度（免费额度用尽，且未开通会员）。' +
				'换非高峰时段再试，或在 AutoClaw 客户端里开通会员后重试。'
		}
	}
	if (code === ERROR_CODES.INVALID_TOKEN || status === 401) {
		return {
			code,
			kind: 'auth',
			retryable: false,
			message: '令牌无效或已过期，请在 AutoClaw 客户端重新登录后重试。'
		}
	}
	if (code === ERROR_CODES.NOT_LOGGED_IN) {
		return { code, kind: 'auth', retryable: false, message: '账号未登录，请先在 AutoClaw 客户端登录。' }
	}
	if (typeof message === 'string' && message.includes('非法模型')) {
		return {
			code,
			kind: 'model',
			retryable: false,
			message: '模型 id 不被接受。可用模型以服务端 autoclaw-model-config 为准。'
		}
	}

	return {
		code,
		kind: 'unknown',
		retryable: true,
		message: message !== '' ? message : `AutoClaw 返回 HTTP ${status}`
	}
}

/**
 * 发起一次对话补全（非流式，便于测试与兜底）。
 *
 * ⚠️ 两个 406 陷阱都在这：
 * 1. `messages[0]` 必须是 AutoClaw 的 system persona（`persona.js`）
 * 2. 限长字段必须用 `max_completion_tokens`，**绝不能写 `max_tokens`**
 */
export async function chatCompletion({ token, model, messages, maxTokens, temperature, signal, cookie, attempts = 2 }) {
	let jar = typeof cookie === 'string' && cookie !== '' ? cookie : ''
	let lastError

	// 保证 system persona 在最前
	const withPersona = messages?.[0]?.role === 'system' && messages[0].content === AUTOCLAW_PERSONA
		? messages
		: [{ role: 'system', content: AUTOCLAW_PERSONA }, ...(messages ?? [])]

	for (let attempt = 1; attempt <= attempts; attempt++) {
		let res
		try {
			res = await fetch(API_BASE + INFER_PATH, {
				method: 'POST',
				headers: buildHeaders({ token, kind: 'inference', model, cookie: jar || undefined }),
				body: JSON.stringify({
					model,
					messages: withPersona,
					stream: false,
					store: false,
					...(Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { max_completion_tokens: maxTokens } : {}),
					...(temperature === undefined ? {} : { temperature })
				}),
				signal: signal ?? AbortSignal.timeout(120000)
			})
		} catch (error) {
			lastError = error
			if (attempt < attempts) {
				await new Promise((r) => setTimeout(r, 800 * attempt))
				continue
			}
			throw error
		}

		const text = await res.text()

		// 把 WAF 发的 acw_tc 收进 jar，下一个 attempt 就带着它。
		const setCookie = res.headers.get('set-cookie') ?? ''
		const acw = /acw_tc=([^;\s]+)/.exec(setCookie)
		if (acw && `acw_tc=${acw[1]}` !== jar) jar = `acw_tc=${acw[1]}`

		// WAF 层的 406 是噪声，带上 cookie 重试通常能过。
		if (isWafBlock(res.status, text, res.headers) && attempt < attempts) {
			lastError = new Error('被 WAF 拦截（406），正在重试')
			await new Promise((r) => setTimeout(r, 1200 * attempt))
			continue
		}

		if (!res.ok) {
			const explained = explainError(res.status, text)
			const err = new Error(explained.message)
			err.code = explained.code
			err.kind = explained.kind
			err.retryable = explained.retryable
			err.wafBlocked = false
			throw err
		}

		let body
		try {
			body = JSON.parse(text)
		} catch {
			throw new Error(`对话接口返回的不是 JSON: ${text.slice(0, 160)}`)
		}
		if (body?.code !== undefined && body.code !== 0 && body.code !== ERROR_CODES.PAY_VIEW) {
			const explained = explainError(res.status, text)
			const err = new Error(explained.message)
			err.code = explained.code
			throw err
		}
		return body
	}
	throw lastError ?? new Error('对话请求失败')
}

/**
 * 把上游响应翻译成 DSH 认的形状。
 *
 * 上游是标准 OpenAI 形状，但 `usage` 里额外带积分消耗，能显示「这次花了多少积分」。
 */
export function normalizeCompletion(raw, model) {
	const choice = Array.isArray(raw?.choices) ? raw.choices[0] : undefined
	const content = choice?.message?.content ?? ''
	const usage = raw?.usage ?? {}
	return {
		id: raw?.id ?? `autoclaw-${Date.now()}`,
		model: raw?.model ?? model,
		content: typeof content === 'string' ? content : JSON.stringify(content),
		finishReason: choice?.finish_reason ?? 'stop',
		usage: {
			inputTokens: Number(usage.prompt_tokens) || 0,
			outputTokens: Number(usage.completion_tokens) || 0,
			totalTokens: Number(usage.total_tokens) || 0,
			/** 上游可能带的积分字段，没有就是 undefined，不要瞎填 0。 */
			credits: typeof usage.credits === 'number' ? usage.credits : undefined
		}
	}
}

export { PROVIDER_ID, FALLBACK_MODELS }