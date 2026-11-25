/**
 * Harness 消息 ↔ OpenAI Chat 消息。
 *
 * 这里有两个必须守住的细节，都是踩过坑才写下来的：
 *
 * 1. **content 是块数组，不是字符串。**
 *    Harness 传进来的 `message.content` 往往是
 *    `[{ type:'text', text:'…' }, …]`，而不是纯字符串。
 *    如果直接 `JSON.stringify` 它，模型就会看到一整段
 *    `[{"type":"reasoning",...},{"type":"tool-call",...}]` 的**文本**，
 *    然后照着模仿 —— 表现就是「模型把工具调用写在正文里」。
 *    正确做法是按块类型分别转成 OpenAI 的 parts。
 *
 * 2. **工具结果要变成 `role:'tool'` 且带 `tool_call_id`。**
 *    不能塞成 user 的普通文本，否则模型不知道那是哪个调用的结果。
 *
 * 另外 assistant 消息里的 `tool-call` 块必须还原成 `tool_calls` 数组，
 * 否则多轮工具对话的历史对不上，模型会重复调用或报参数错误。
 */

/** 取消息的 content 块数组。 */
function blocksOf(content) {
	if (Array.isArray(content)) return content
	if (typeof content === 'string') return [{ type: 'text', text: content }]
	return []
}

/** 把块里的纯文本拼起来。 */
function textOf(blocks) {
	let out = ''
	for (const block of blocks) {
		if (block?.type === 'text' && typeof block.text === 'string') out += block.text
	}
	return out
}

/**
 * 出站清洗：去掉控制字符与孤立代理对。
 *
 * 这些在真实会话里很常见（工具输出二进制、文件带 BOM、日志含 ANSI 转义），
 * 丢一个字符远好过整轮请求被打死。只保留 \n \r \t 三个合法空白。
 */
export function sanitizeText(text) {
	if (typeof text !== 'string' || text === '') return text
	return text
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
		.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF\uFFFE\uFFFF]/g, '')
}

/** 图片块 → data URL。解析不出来返回 undefined（丢弃，绝不因此打死整轮）。 */
function imageDataUrl(block) {
	const media = typeof block?.mediaType === 'string' ? block.mediaType : 'image/png'
	if (typeof block?.data === 'string' && block.data !== '') {
		return block.data.startsWith('data:') ? block.data : `data:${media};base64,${block.data}`
	}
	return undefined
}

/** 从消息里摘出工具结果块。Harness 用 `tool-result` 块带 `callId`。 */
function toolResultsOf(message) {
	const out = []
	for (const block of blocksOf(message?.content)) {
		if (block?.type !== 'tool-result') continue
		out.push({
			callId: String(block.callId ?? block.toolCallId ?? ''),
			content: blocksOf(block.content)
		})
	}
	return out
}

/** DSH 的工具定义 → OpenAI `tools`。 */
export function toToolDefs(tools) {
	if (!Array.isArray(tools) || tools.length === 0) return undefined
	const out = []
	for (const tool of tools) {
		const name = String(tool?.name ?? '')
		if (name === '') continue
		out.push({
			type: 'function',
			function: {
				name,
				description: sanitizeText(String(tool?.description ?? '')),
				parameters:
					tool?.parameters !== null && typeof tool?.parameters === 'object'
						? tool.parameters
						: { type: 'object', properties: {} }
			}
		})
	}
	return out.length > 0 ? out : undefined
}

/**
 * Harness 消息 → OpenAI messages。
 *
 * @param {ReadonlyArray<any>} messages
 * @param {string} [system] 调用方单独给的 system（并进 system-note）
 * @param {(reason: string) => void} [warn]
 * @returns {Array<Record<string, unknown>>}
 */
export function toChatMessages(messages, system, warn) {
	const out = []
	/** 工具结果带出来的图，得在 tool 消息之后作为 user 轮单独发 */
	const followUp = []

	const flush = () => {
		if (followUp.length > 0) out.push({ role: 'user', content: followUp.splice(0) })
	}

	// 调用方给的 system 先收集起来，最后并进首条 user（上游只认 persona 那一条 system）
	const notes = []
	if (typeof system === 'string' && system.trim() !== '') notes.push(sanitizeText(system.trim()))

	for (const message of messages ?? []) {
		const results = toolResultsOf(message)
		if (results.length === 0) flush()

		// ── 工具结果：一条 tool 消息一个 ──
		for (const result of results) {
			const images = []
			for (const block of result.content) {
				if (block?.type !== 'image') continue
				const url = imageDataUrl(block)
				if (url !== undefined) images.push({ type: 'image_url', image_url: { url } })
				else warn?.('image-dropped')
			}
			const text = textOf(result.content)
			out.push({
				role: 'tool',
				tool_call_id: result.callId,
				content: text !== '' ? sanitizeText(text) : images.length > 0 ? '(见附图)' : '(无输出)'
			})
			if (images.length > 0) {
				followUp.push({ type: 'text', text: `工具 ${result.callId} 返回了 ${images.length} 张图，附在下面。` }, ...images)
			}
		}

		const blocks = blocksOf(message?.content).filter((block) => block?.type !== 'tool-result')
		if (blocks.length === 0 && results.length > 0) continue

		switch (message?.role) {
			case 'system':
			case 'developer': {
				const text = textOf(blocks)
				if (text.trim() !== '') notes.push(sanitizeText(text.trim()))
				break
			}

			case 'user': {
				const parts = []
				for (const block of blocks) {
					if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
						parts.push({ type: 'text', text: sanitizeText(block.text) })
					} else if (block?.type === 'image') {
						const url = imageDataUrl(block)
						if (url !== undefined) parts.push({ type: 'image_url', image_url: { url } })
						else warn?.('image-dropped')
					}
				}
				if (parts.length === 0) {
					const fallback = sanitizeText(textOf(blocks))
					if (fallback.trim() !== '') out.push({ role: 'user', content: fallback })
					break
				}
				if (results.length > 0) followUp.push(...parts)
				else out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts })
				break
			}

			case 'assistant': {
				// 推理块不进历史（上游不需要，且会把上下文撑爆）
				const text = textOf(blocks)
				const calls = []
				for (const block of blocks) {
					if (block?.type !== 'tool-call') continue
					calls.push({
						id: String(block.id ?? ''),
						type: 'function',
						function: {
							name: String(block.name ?? ''),
							arguments: typeof block.arguments === 'string' ? sanitizeText(block.arguments) : '{}'
						}
					})
				}
				if (text.trim() === '' && calls.length === 0) break
				const message2 = { role: 'assistant', content: sanitizeText(text) }
				if (calls.length > 0) message2.tool_calls = calls
				out.push(message2)
				break
			}

			default: {
				// 未知角色当 user 处理，别丢内容
				const fallback = sanitizeText(textOf(blocks))
				if (fallback.trim() !== '') out.push({ role: 'user', content: fallback })
			}
		}
	}
	flush()

	// system-note 并入首条 user（上游只认 persona 那一条 system）
	if (notes.length > 0) {
		const prefix = `[system-note]\n${notes.join('\n\n')}\n[/system-note]`
		const firstUser = out.findIndex((m) => m.role === 'user' && typeof m.content === 'string')
		if (firstUser === -1) out.unshift({ role: 'user', content: prefix })
		else out[firstUser] = { role: 'user', content: `${prefix}\n\n${out[firstUser].content}` }
	}

	return out
}