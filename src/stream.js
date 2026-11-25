/**
 * AutoClaw 对话流（HTTP SSE）+ 工具调用翻译。
 *
 * ## 406 的真正原因（已实测确认）
 *
 * 上游有一道 body 校验，要求请求「看起来像 AutoClaw 应用自己发的」。判据集中在 body：
 *
 * 1. `messages[0]` 必须是 AutoClaw 的 system persona（`persona.js`），逐字一致。
 * 2. body 里**不能出现 `max_tokens` 字段** —— 用它必 406。限长只能用
 *    `max_completion_tokens`，或者不传。
 *
 * 其余（tools / store / reasoning_effort / 各种头）都可省。
 *
 * ## DSH 的 system 指令
 *
 * 不能塞进 system（会破坏 persona），按 `[system-note]` 并入首条 user 消息。
 *
 * ## 工具调用
 *
 * 必须把 `request.tools` 转成 OpenAI 的 `tools` 传给上游，否则模型看不到工具，
 * 只能把调用写成 JSON 文本（看起来像「模型在输出代码块」）。
 * 上游回的 `delta.tool_calls` 要翻译成 harness 的
 * `block-start(tool-call)` → `tool-call-delta` → `block-end(tool-call)` → `finish(tool-calls)`。
 */

import { randomUUID } from 'node:crypto'
import { API_BASE, ERROR_CODES, INFER_PATH, PROVIDER_ID, PROVIDER_NAME } from './product.js'
import { buildHeaders, isWafBlock } from './headers.js'
import { explainError } from './adapter.js'
import { AUTOCLAW_PERSONA } from './persona.js'
import { toChatMessages as buildMessages, toToolDefs } from './messages.js'

/** 错误类：带 DSH 适配器约定的 `code`。 */
export class AutoClawError extends Error {
	constructor(message, code = 'SERVER', detail) {
		super(message)
		this.name = 'AutoClawError'
		this.code = code
		this.failure = detail
	}
}

/** 从错误里认出「额度耗尽」（810001 = 高峰期/免费额度用尽）。 */
export function detectQuotaExhausted(error) {
	if (error?.kind === 'quota' || error?.code === ERROR_CODES.PAY_VIEW) return true
	const text = `${error?.message ?? ''}${error?.failure ?? ''}`
	return text.includes('810001') || text.includes('pay-view')
}

function codeOf(kind) {
	if (kind === 'auth') return 'AUTH'
	if (kind === 'model') return 'UNSUPPORTED_CONTENT'
	if (kind === 'quota') return 'QUOTA'
	return 'SERVER'
}

/**
 * 把 DSH 的请求转成上游 messages。
 *
 * 实现在 `messages.js` —— 那边要按 content **块**逐个翻译，绝不能整体
 * `JSON.stringify`（那会把块数组变成文本塞给模型，模型就开始模仿着写
 * `[{"type":"tool-call",...}]` 这样的内容）。
 */
export function toChatMessages(request) {
	return buildMessages(request?.messages, request?.system)
}

/** DSH 的工具定义 → OpenAI `tools`。 */
export { toToolDefs }

/**
 * 构造请求体。
 *
 * ⚠️ 绝不写 `max_tokens`（会 406）。限长用 `max_completion_tokens`。
 */
export function buildBody({ model, messages, maxTokens, tools }) {
	const body = {
		model,
		messages: [{ role: 'system', content: AUTOCLAW_PERSONA }, ...messages],
		stream: true,
		stream_options: { include_usage: true },
		store: false
	}
	if (Number.isSafeInteger(maxTokens) && maxTokens > 0) {
		body.max_completion_tokens = maxTokens
	}
	const defs = toToolDefs(tools)
	if (defs !== undefined) body.tools = defs
	return body
}

/**
 * 流式增量累积器 —— 把上游 delta 翻译成 harness 的块事件。
 *
 * 块索引按「首次出现」顺序分配，text / reasoning / tool-call 各占一个。
 */
export class StreamTranslator {
	constructor() {
		this.open = new Map()
		this.nextIndex = 0
		this.lastKey = ''
		this.brokenToolCall = false
	}

	slot(key, kind) {
		let block = this.open.get(key)
		if (block === undefined) {
			block = { index: this.nextIndex, kind, text: '', args: '', started: false, nameSent: false }
			this.nextIndex += 1
			this.open.set(key, block)
		}
		return block
	}

	push(delta) {
		const out = []
		if (delta === null || typeof delta !== 'object') return out

		// ── 推理 ──
		const reasoning = delta.reasoning_content ?? delta.reasoning
		if (typeof reasoning === 'string' && reasoning !== '') {
			const block = this.slot('reasoning', 'reasoning')
			if (this.lastKey !== 'reasoning') {
				out.push({ type: 'block-start', index: block.index, blockType: 'reasoning' })
				this.lastKey = 'reasoning'
			}
			block.text += reasoning
			out.push({ type: 'reasoning-delta', index: block.index, text: reasoning })
		}

		// ── 正文 ──
		const content = delta.content
		if (typeof content === 'string' && content !== '') {
			const block = this.slot('text', 'text')
			if (this.lastKey !== 'text') {
				out.push({ type: 'block-start', index: block.index, blockType: 'text' })
				this.lastKey = 'text'
			}
			block.text += content
			out.push({ type: 'text-delta', index: block.index, text: content })
		}

		// ── 工具调用 ──
		if (Array.isArray(delta.tool_calls)) {
			for (const call of delta.tool_calls) {
				const position = Number(call?.index ?? 0)
				const block = this.slot(`tool:${position}`, 'tool-call')
				const id = typeof call?.id === 'string' && call.id !== '' ? call.id : undefined
				if (id !== undefined && block.id === undefined) block.id = id

				const fn = call?.function
				if (typeof fn?.name === 'string' && fn.name !== '') {
					const held = block.name ?? ''
					block.name = fn.name.startsWith(held) ? fn.name : held + fn.name
				}

				const argsDelta = typeof fn?.arguments === 'string' ? fn.arguments : ''
				if (block.id !== undefined && !block.started) {
					block.started = true
					out.push({ type: 'block-start', index: block.index, blockType: 'tool-call' })
				}
				if (argsDelta !== '') {
					block.started = true
					block.args += argsDelta
					out.push({
						type: 'tool-call-delta',
						index: block.index,
						id: block.id ?? '',
						...(block.name !== undefined && block.name !== '' ? { name: block.name } : {}),
						argumentsDelta: argsDelta
					})
				} else if (block.started && block.name !== undefined && block.name !== '' && !block.nameSent) {
					block.nameSent = true
					out.push({ type: 'tool-call-delta', index: block.index, id: block.id ?? '', name: block.name, argumentsDelta: '' })
				}
			}
		}

		return out
	}

	/** 关掉所有打开的块，产出 block-end。 */
	closeAll() {
		const out = []
		const blocks = [...this.open.values()].sort((a, b) => a.index - b.index)
		for (const block of blocks) {
			if (block.kind === 'text') {
				if (block.text !== '') out.push({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } })
			} else if (block.kind === 'reasoning') {
				if (block.text !== '') {
					out.push({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } })
				}
			} else if (block.kind === 'tool-call') {
				// 参数被截断 = 不可执行的调用，标记 broken，让 harness 丢掉它
				const raw = block.args === '' ? '{}' : block.args
				let broken = false
				try {
					JSON.parse(raw)
				} catch {
					broken = true
				}
				if (typeof block.name !== 'string' || block.name === '') broken = true
				if (broken) this.brokenToolCall = true
				if (!block.started) {
					out.push({ type: 'block-start', index: block.index, blockType: 'tool-call' })
				}
				out.push({
					type: 'block-end',
					index: block.index,
					block: { type: 'tool-call', id: block.id ?? '', name: block.name ?? '', arguments: raw }
				})
			}
		}
		this.open.clear()
		return out
	}
}

/** 上游 finish_reason → harness FinishReason。 */
export function mapFinish(reason, sawToolCall, brokenToolCall) {
	if (brokenToolCall) return { kind: 'max-tokens' }
	if (reason === 'tool_calls' || sawToolCall) return { kind: 'tool-calls' }
	if (reason === 'length') return { kind: 'max-tokens' }
	return { kind: 'stop' }
}

/**
 * 流式对话，产出 DSH 内核认的事件。
 *
 * `blockType` 字段名不能写成 `kind`；`block-end` 必须带完整 `block` 对象。
 */
export async function* streamChat({ token, model, messages, signal, cookie, maxTokens, tools, attempts = 2, sessionId, queryId }) {
	let jar = typeof cookie === 'string' && cookie !== '' ? cookie : ''
	const sid = sessionId ?? randomUUID()
	const qid = queryId ?? randomUUID()
	let lastError

	for (let attempt = 1; attempt <= attempts; attempt++) {
		let res
		try {
			res = await fetch(API_BASE + INFER_PATH, {
				method: 'POST',
				headers: buildHeaders({
					token,
					kind: 'inference',
					model,
					cookie: jar || undefined,
					sessionId: sid,
					queryId: qid
				}),
				body: JSON.stringify(buildBody({ model, messages, maxTokens, tools })),
				signal: signal ?? AbortSignal.timeout(300000)
			})
		} catch (error) {
			lastError = new AutoClawError(`对话请求失败 —— ${error?.message ?? String(error)}`, 'TRANSPORT')
			if (attempt < attempts) {
				await new Promise((r) => setTimeout(r, 1000 * attempt))
				continue
			}
			throw lastError
		}

		const setCookie = res.headers.get('set-cookie') ?? ''
		const acw = /acw_tc=([^;\s]+)/.exec(setCookie)
		if (acw) jar = `acw_tc=${acw[1]}`

		if (!res.ok) {
			const text = await res.text().catch(() => '')
			if (isWafBlock(res.status, text, res.headers) && attempt < attempts) {
				lastError = new AutoClawError('上游返回 406（请求体未通过校验），重试中', 'TRANSIENT')
				await new Promise((r) => setTimeout(r, 1500 * attempt))
				continue
			}
			if (res.status === 406) {
				throw new AutoClawError(
					'AutoClaw 上游返回 406。通常是请求体没通过它的校验（system persona 必须逐字一致，且不能用 max_tokens 字段）。',
					'TRANSIENT'
				)
			}
			const explained = explainError(res.status, text)
			throw new AutoClawError(`AutoClaw: ${explained.message}`, codeOf(explained.kind), text)
		}

		// —— 200：逐帧消费 SSE ——
		const tr = new StreamTranslator()
		let sawOutput = false
		let usage
		let finishReason = 'stop'
		let sawToolCall = false

		const reader = res.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		let upstreamError

		try {
			while (true) {
				if (signal?.aborted) {
					finishReason = 'aborted'
					break
				}
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })

				let nl
				while ((nl = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, nl).replace(/\r$/, '')
					buffer = buffer.slice(nl + 1)
					if (!line.startsWith('data:')) continue
					const payload = line.slice(5).trim()
					if (payload === '' || payload === '[DONE]') continue

					let frame
					try {
						frame = JSON.parse(payload)
					} catch {
						continue
					}

					if (frame?.code !== undefined && frame.code !== 0) {
						upstreamError = frame
						break
					}

					const choice = frame?.choices?.[0]
					const delta = choice?.delta ?? {}
					if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) sawToolCall = true

					// usage 通常只在最后一个帧里（stream_options.include_usage）
					if (frame?.usage !== undefined) usage = mapUsage(frame.usage)

					for (const ev of tr.push(delta)) {
						sawOutput = true
						yield ev
					}

					const fr = choice?.finish_reason
					if (typeof fr === 'string' && fr !== '') finishReason = fr
				}
				if (upstreamError) break
			}
		} finally {
			reader.releaseLock()
		}

		if (upstreamError) {
			const explained = explainError(200, JSON.stringify(upstreamError))
			throw new AutoClawError(`AutoClaw: ${explained.message}`, codeOf(explained.kind), JSON.stringify(upstreamError))
		}

		// 收尾：关掉所有块
		for (const ev of tr.closeAll()) {
			sawOutput = true
			yield ev
		}

		if (!sawOutput) {
			throw new AutoClawError('AutoClaw: 上游没有返回任何内容', 'EMPTY_RESPONSE')
		}

		if (usage !== undefined) yield { type: 'usage', usage }

		yield { type: 'finish', reason: mapFinish(finishReason, sawToolCall, tr.brokenToolCall) }
		return
	}

	throw lastError ?? new AutoClawError('AutoClaw: 对话失败', 'SERVER')
}

export { PROVIDER_ID, PROVIDER_NAME }

/** 上游 usage → harness TokenUsage（计数是互斥的：inputTokens 只算未命中缓存的输入）。 */
export function mapUsage(raw) {
	if (raw === null || typeof raw !== 'object') return undefined
	const prompt = Number.isFinite(raw.prompt_tokens) ? raw.prompt_tokens : undefined
	const completion = Number.isFinite(raw.completion_tokens) ? raw.completion_tokens : undefined
	const cached = Number.isFinite(raw.prompt_tokens_details?.cached_tokens) ? raw.prompt_tokens_details.cached_tokens : 0
	if (prompt === undefined && completion === undefined) return undefined
	const out = {}
	if (prompt !== undefined) out.inputTokens = Math.max(0, prompt - cached)
	if (completion !== undefined) out.outputTokens = completion
	if (cached > 0) out.cacheReadTokens = cached
	if (Number.isFinite(raw.completion_tokens_details?.reasoning_tokens)) {
		out.reasoningTokens = raw.completion_tokens_details.reasoning_tokens
	}
	out.totalTokens = (prompt ?? 0) + (completion ?? 0)
	return out
}