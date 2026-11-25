import test from 'node:test'
import assert from 'node:assert/strict'

import { sign, stripBearer, buildHeaders, isWafBlock } from '../src/headers.js'
import { parseModelConfig, explainError } from '../src/adapter.js'
import { parseWallet } from '../src/wallet.js'
import { decryptCredentialFile, decryptToString, decodeJwtExpMs } from '../src/credential.js'
import { toChatMessages, detectQuotaExhausted, AutoClawError, buildBody, toToolDefs, StreamTranslator, mapFinish } from '../src/stream.js'
import { AUTOCLAW_PERSONA } from '../src/persona.js'
import { sanitizeText } from '../src/messages.js'
import { APP_ID, FALLBACK_MODELS, ERROR_CODES } from '../src/product.js'

test('签名算法与抓包实测值逐字节一致', () => {
	// 抓包 010 号会话：x-auth-timestamp=1795529535, x-auth-sign=d2c79e3bbb34af0340b8fe7723315875
	assert.equal(sign(1795529535), 'd2c79e3bbb34af0340b8fe7723315875')
})

test('stripBearer 剥掉各种形态的 Bearer 前缀', () => {
	assert.equal(stripBearer('Bearer abc'), 'abc')
	assert.equal(stripBearer('bearer abc'), 'abc')
	assert.equal(stripBearer('Bearer  abc'), 'abc')
	assert.equal(stripBearer('abc'), 'abc')
	assert.equal(stripBearer(undefined), '')
})

test('buildHeaders 推理面：对齐抓到的真实请求头', () => {
	const h = buildHeaders({ token: 'tok', kind: 'inference', model: 'zai_glm-5.3-flash' })

	assert.equal(h['X-Authorization'], 'Bearer tok')
	assert.ok(!('Authorization' in h), '推理面不应带 Authorization')
	assert.equal(h['x-channel'], 'AutoClaw16')
	assert.equal(h['x-version'], '2.5.3')
	assert.equal(h['x-trace-id'], h['x-request-id'], 'x-trace-id 与 x-request-id 要一致')
	assert.equal(h['x_trace_id'], 'autoclaw-desktop')
	assert.equal(h['X-Agent-Id'], 'main')
	assert.equal(h['x-request-model'], 'zai_glm-5.3-flash')
	assert.ok(h['x-session-id'], '必须带 x-session-id')
	assert.ok(h['x-query-id'], '必须带 x-query-id')
	assert.equal(h['x-auth-appid'], APP_ID)
	assert.equal(h['x-auth-sign'], sign(h['x-auth-timestamp']))
})

test('buildHeaders 业务面用标准 Authorization', () => {
	const h = buildHeaders({ token: 'tok', kind: 'business' })
	assert.equal(h.Authorization, 'Bearer tok')
	assert.ok(!('X-Authorization' in h))
	assert.ok(!('x-session-id' in h))
})

test('buildBody：system 必须是 persona，且绝不能出现 max_tokens', () => {
	const body = buildBody({ model: 'zai_auto', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1024 })
	assert.equal(body.messages[0].role, 'system')
	assert.equal(body.messages[0].content, AUTOCLAW_PERSONA, 'system 必须逐字等于 persona')
	assert.equal(body.messages[1].content, 'hi')
	assert.equal(body.stream, true)
	assert.ok(!('max_tokens' in body), 'max_tokens 会触发 406')
	assert.equal(body.max_completion_tokens, 1024)
	assert.equal(body.store, false)
})

test('buildBody：不传 maxTokens 时不带限长字段', () => {
	const body = buildBody({ model: 'zai_auto', messages: [{ role: 'user', content: 'hi' }] })
	assert.ok(!('max_tokens' in body))
	assert.ok(!('max_completion_tokens' in body))
})

test('persona 是抓到的真实内容（长度与首尾）', () => {
	assert.equal(AUTOCLAW_PERSONA.length, 7256, 'persona 长度必须与捕获一致')
	assert.ok(AUTOCLAW_PERSONA.startsWith('You are AutoClaw.'))
	assert.ok(AUTOCLAW_PERSONA.endsWith('Safety Guard approval request.'))
})

test('toChatMessages：DSH 的 system 挪进首条 user（system-note）', () => {
	const out = toChatMessages({
		system: '你是 DSH 助手',
		messages: [{ role: 'user', content: '你好' }]
	})
	assert.equal(out.length, 1, '不应产生 system 消息')
	assert.equal(out[0].role, 'user')
	assert.ok(out[0].content.includes('[system-note]'))
	assert.ok(out[0].content.includes('你是 DSH 助手'))
	assert.ok(out[0].content.endsWith('你好'))
})

test('toChatMessages：content 是块数组时必须按块翻译，不能 stringify', () => {
	const out = toChatMessages({
		messages: [
			{ role: 'user', content: [{ type: 'text', text: '第一句' }, { type: 'text', text: '第二句' }] }
		]
	})
	assert.equal(out.length, 1)

	// 关键：绝不能是「一个字符串，里面装着 JSON 字面量」
	// （那正是之前模型模仿着输出 [{"type":"reasoning"...}] 的根源）
	if (typeof out[0].content === 'string') {
		assert.ok(!out[0].content.includes('"type"'), `被 stringify 了: ${out[0].content}`)
		assert.ok(!out[0].content.includes('[{'), `出现 JSON 数组字面量: ${out[0].content}`)
	} else {
		// 数组形态必须是干净的 OpenAI parts，每个 part 只有 text 字段
		assert.ok(Array.isArray(out[0].content))
		for (const part of out[0].content) {
			assert.equal(part.type, 'text')
			assert.equal(typeof part.text, 'string')
			assert.ok(!part.text.includes('"type"'), 'part 内不应再嵌 JSON')
		}
	}

	const joined =
		typeof out[0].content === 'string' ? out[0].content : out[0].content.map((p) => p.text).join('')
	assert.ok(joined.includes('第一句'))
	assert.ok(joined.includes('第二句'))
})

test('toChatMessages：assistant 的 tool-call 块还原成 tool_calls 数组', () => {
	const out = toChatMessages({
		messages: [
			{ role: 'user', content: '查天气' },
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: '我查一下' },
					{ type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' }
				]
			}
		]
	})
	const assistant = out.find((m) => m.role === 'assistant')
	assert.ok(assistant, '必须有 assistant 消息')
	assert.equal(assistant.content, '我查一下')
	assert.equal(assistant.tool_calls.length, 1)
	assert.equal(assistant.tool_calls[0].id, 'call_1')
	assert.equal(assistant.tool_calls[0].function.name, 'get_weather')
	assert.equal(assistant.tool_calls[0].function.arguments, '{"city":"北京"}')
})

test('toChatMessages：tool-result 块变成 role:tool 且带 tool_call_id', () => {
	const out = toChatMessages({
		messages: [
			{ role: 'user', content: '查天气' },
			{
				role: 'assistant',
				content: [{ type: 'tool-call', id: 'call_9', name: 'get_weather', arguments: '{}' }]
			},
			{
				role: 'user',
				content: [{ type: 'tool-result', callId: 'call_9', content: [{ type: 'text', text: '晴 25 度' }] }]
			}
		]
	})
	const tool = out.find((m) => m.role === 'tool')
	assert.ok(tool, '必须有 tool 消息')
	assert.equal(tool.tool_call_id, 'call_9')
	assert.equal(tool.content, '晴 25 度')
})

test('toChatMessages：推理块不进历史（避免撑爆上下文）', () => {
	const out = toChatMessages({
		messages: [
			{
				role: 'assistant',
				content: [
					{ type: 'reasoning', text: '这是很长的思考过程……' },
					{ type: 'text', text: '答案' }
				]
			}
		]
	})
	const text = JSON.stringify(out)
	assert.ok(!text.includes('这是很长的思考过程'), 'reasoning 不应进历史')
	assert.ok(text.includes('答案'))
})

test('sanitizeText：去掉控制字符但保留换行与中文', () => {
	assert.equal(sanitizeText('a\u0000b'), 'ab')
	assert.equal(sanitizeText('行1\n行2\t结束'), '行1\n行2\t结束')
	assert.equal(sanitizeText('中文😀'), '中文😀')
})

test('toToolDefs：DSH 工具定义 → OpenAI tools', () => {
	const defs = toToolDefs([
		{ name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } }
	])
	assert.equal(defs.length, 1)
	assert.equal(defs[0].type, 'function')
	assert.equal(defs[0].function.name, 'get_weather')
	assert.equal(defs[0].function.parameters.type, 'object')

	// 空工具 → undefined
	assert.equal(toToolDefs([]), undefined)
	assert.equal(toToolDefs(undefined), undefined)

	// 缺 parameters 时补一个空对象 schema
	const noParams = toToolDefs([{ name: 'ping' }])
	assert.deepEqual(noParams[0].function.parameters, { type: 'object', properties: {} })
})

test('buildBody：工具定义会被带上', () => {
	const body = buildBody({
		model: 'zai_auto',
		messages: [{ role: 'user', content: 'hi' }],
		tools: [{ name: 'echo', description: 'e', parameters: { type: 'object', properties: {} } }]
	})
	assert.equal(body.tools.length, 1)
	assert.equal(body.tools[0].function.name, 'echo')
})

test('StreamTranslator：把 delta.tool_calls 翻译成工具事件', () => {
	const tr = new StreamTranslator()

	// 首帧：带 id 和 name
	const a = tr.push({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] })
	assert.ok(a.some((e) => e.type === 'block-start' && e.blockType === 'tool-call'))

	// 参数分片
	const b = tr.push({ tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] })
	assert.equal(b[0].type, 'tool-call-delta')
	assert.equal(b[0].argumentsDelta, '{"city"')

	const c = tr.push({ tool_calls: [{ index: 0, function: { arguments: ':"北京"}' } }] })
	assert.equal(c[0].argumentsDelta, ':"北京"}')

	// 收尾
	const end = tr.closeAll()
	const callEnd = end.find((e) => e.type === 'block-end' && e.block?.type === 'tool-call')
	assert.ok(callEnd)
	assert.equal(callEnd.block.id, 'call_1')
	assert.equal(callEnd.block.name, 'get_weather')
	assert.equal(callEnd.block.arguments, '{"city":"北京"}')
	assert.equal(tr.brokenToolCall, false)
})

test('StreamTranslator：参数被截断时标记 broken', () => {
	const tr = new StreamTranslator()
	tr.push({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":' } }] })
	const end = tr.closeAll()
	const callEnd = end.find((e) => e.block?.type === 'tool-call')
	assert.ok(callEnd)
	assert.equal(tr.brokenToolCall, true, '不合法的 JSON 必须标记 broken')
})

test('mapFinish：工具调用 / 截断 / 正常', () => {
	assert.deepEqual(mapFinish('tool_calls', false, false), { kind: 'tool-calls' })
	assert.deepEqual(mapFinish('stop', true, false), { kind: 'tool-calls' })
	assert.deepEqual(mapFinish('length', false, false), { kind: 'max-tokens' })
	assert.deepEqual(mapFinish('stop', false, true), { kind: 'max-tokens' })
	assert.deepEqual(mapFinish('stop', false, false), { kind: 'stop' })
})

test('toChatMessages：多轮历史保持顺序，空内容丢弃', () => {
	const out = toChatMessages({
		messages: [
			{ role: 'user', content: 'a' },
			{ role: 'assistant', content: 'b' },
			{ role: 'user', content: '' },
			{ role: 'user', content: 'c' }
		]
	})
	assert.deepEqual(out.map((m) => m.content), ['a', 'b', 'c'])
	assert.equal(out[1].role, 'assistant')
})

test('isWafBlock：406 算可重试', () => {
	assert.equal(isWafBlock(406, '', new Headers()), true)
	assert.equal(isWafBlock(200, '{"code":0}', new Headers()), false)
})

test('explainError：810001 额度 / 401001 鉴权 / 非法模型', () => {
	assert.equal(explainError(403, '{"code":810001}').kind, 'quota')
	assert.equal(explainError(401, '{"code":401001}').kind, 'auth')
	assert.equal(explainError(400, '{"message":"非法模型"}').kind, 'model')
})

test('parseWallet：wallets.v2 原始形状', () => {
	const parsed = parseWallet({
		total_balance: 11391,
		wallets: [
			{ public_wallet_type: 'reward', display_name: '奖励积分', balance: 11391, balance_view: '1.1w', display: true, priority: 10 },
			{ public_wallet_type: 'subscription', display_name: '订阅积分', balance: 0, display: false, priority: 30 }
		]
	})
	assert.equal(parsed.total, 11391)
	assert.equal(parsed.visible.length, 1)
	assert.equal(parsed.visible[0].view, '1.1w')
	assert.equal(parsed.hasSubscription, false)
})

test('parseModelConfig：提取倍率与模态', () => {
	const models = parseModelConfig({
		models: [
			{ id: 'zai_auto', name: 'Auto', contextWindow: 1048576, maxTokens: 393216, creditCostFactor: 0.4, input: ['image', 'text'] },
			{ id: '', name: 'bad' }
		]
	})
	assert.equal(models.length, 1)
	assert.equal(models[0].creditCostFactor, 0.4)
	assert.equal(models[0].supportsImage, true)
})

test('decryptCredentialFile / decryptToString 往返', async () => {
	const { createCipheriv, randomBytes } = await import('node:crypto')
	const { writeFileSync, mkdtempSync } = await import('node:fs')
	const { tmpdir } = await import('node:os')
	const { join } = await import('node:path')

	const key = randomBytes(32)
	const iv = randomBytes(12)

	const mk = (plain) => {
		const c = createCipheriv('aes-256-gcm', key, iv)
		const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
		return Buffer.concat([Buffer.from('v10'), iv, enc, c.getAuthTag()])
	}

	const dir = mkdtempSync(join(tmpdir(), 'ac-'))
	const f1 = join(dir, 'a.enc')
	writeFileSync(f1, mk(JSON.stringify({ accessToken: 'Bearer abc' })))
	assert.equal(decryptCredentialFile(key, f1).accessToken, 'Bearer abc')

	assert.equal(decryptToString(key, mk('Bearer xyz')).replace(/^Bearer\s+/i, ''), 'xyz')
})

test('decodeJwtExpMs', async () => {
	const payload = Buffer.from(JSON.stringify({ exp: 1795550292 })).toString('base64url')
	assert.equal(decodeJwtExpMs(`h.${payload}.s`), 1795550292000)
	assert.equal(decodeJwtExpMs('bad'), undefined)
})

test('detectQuotaExhausted / AutoClawError', () => {
	assert.equal(detectQuotaExhausted({ kind: 'quota' }), true)
	assert.equal(detectQuotaExhausted({ message: 'x pay-view y' }), true)
	assert.equal(detectQuotaExhausted({ message: '普通' }), false)
	const e = new AutoClawError('x', 'QUOTA')
	assert.equal(e.code, 'QUOTA')
})

test('FALLBACK_MODELS 只含实测合法 id', () => {
	const legal = new Set(['zai_auto', 'zai_auto-fast', 'zai_glm-x-preview', 'zaicoding_glm-5.3', 'zai_glm-5.3-flash', 'zai_glm-5.3-flashx-legal'])
	for (const m of FALLBACK_MODELS) assert.ok(legal.has(m.id), `非法兜底模型: ${m.id}`)
})