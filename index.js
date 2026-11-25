/**
 * dsh-connect-autoclaw — Host 半身（纯 HTTP 版）。
 *
 * 把 AutoClaw（智谱桌面客户端）的账号与模型接进 DSH：
 *
 * 1. **纯 HTTP**：直接调服务端的 OpenAI 兼容接口（`/autoclaw-proxy/proxy/autoclaw/chat/completions`），
 *    不需要桌面客户端运行，也没有本地 WebSocket 桥接。
 * 2. 凭据：读本机 `%APPDATA%\AutoClaw-official\` 下客户端已保存的登录态
 *    （DPAPI + AES-256-GCM），自动发现已登录账号。
 * 3. 模型目录：以服务端 `autoclaw-model-config` 为准，带 `creditCostFactor` 倍率。
 * 4. 浏览器 API：`/api/autoclaw/*` 给客户端面板用（积分、模型、测试对话）。
 *
 * ## `inject` 里为什么只有 `llm`
 *
 * Cordis 会扣住 fiber 里没声明的服务。只有 `llm` 是硬依赖；
 * `credentials` / `webServer` 全部走嵌套 `ctx.inject`，缺席时对应能力降级，
 * 但 provider 本身照常可用。
 *
 * @module dsh-connect-autoclaw
 */

import os from 'node:os'
import { PROVIDER_ID, PROVIDER_NAME } from './src/product.js'
import { listLocalAccounts, readAccountModelCatalog } from './src/credential.js'
import { fetchWallet, createWalletCache } from './src/wallet.js'
import { fetchModelConfig, FALLBACK_MODELS } from './src/adapter.js'
import { AutoClawError, streamChat, toChatMessages } from './src/stream.js'

/** 插件名（cordis 用它做 fiber 标识与日志前缀）。 */
export const name = 'connect-autoclaw'

/** 唯一的硬依赖。 */
export const inject = ['llm']

/** 发 JSON 响应。 */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(body)
	})
	res.end(body)
}

/** 读请求体（有上限）。 */
async function readBody(req, limit = 100_000) {
	const chunks = []
	let total = 0
	for await (const chunk of req) {
		total += chunk.length
		if (total > limit) throw new Error('请求体过大')
		chunks.push(chunk)
	}
	if (chunks.length === 0) return undefined
	const text = Buffer.concat(chunks).toString('utf8')
	if (text.trim().length === 0) return undefined
	return JSON.parse(text)
}

/**
 * 创建 HTTP 适配器。
 *
 * 形状与 teleagent 的 AutoClaw 适配器一致（`providerInfo` / `providerRetryPolicy` /
 * `listModels` / `resolveModel` / `prepareCall` / `stream`），但数据源换成纯 HTTP。
 */
function createHttpAdapter({ getAccount, logger }) {
	const adapter = {
		providerInfo(provider) {
			return { id: provider, name: PROVIDER_NAME }
		},

		providerRetryPolicy() {
			return Object.freeze({
				mode: 'normal',
				// WAF 406 与 810001 在内核层重试意义不大（适配器内部已经带退避重试过）。
				maxRetries: 0,
				retryableCodes: Object.freeze(['TRANSPORT', 'TIMEOUT']),
				initialDelayMs: 500,
				maxDelayMs: 4000,
				jitterRatio: 0.2
			})
		},

		/**
		 * 声明「这个路由不做图片请求定价」。
		 *
		 * ⚠️ **必须实现**，哪怕只返回 undefined。
		 * 内核 `LlmRuntime.imageRequestPricing()` 的写法是
		 * `this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model)` ——
		 * 可选链只护住了 `adapters.get()`，方法本身不存在时会直接抛
		 * `imageRequestPricing is not a function`。
		 *
		 * 这个调用发生在**模型切换时的上下文压缩**里，所以缺了它的表现是：
		 * 切到本插件的模型就报「context compaction failed」，一次对话都发不出去，
		 * 而且错误信息完全不提适配器，很难联想到是这里。
		 *
		 * 基类 `LlmAdapter` 默认就返回 undefined（= 消费方用自己的中性估算），
		 * 我这里没有继承基类（纯对象适配器），所以要自己补上。
		 * 契约要求**同步、无 I/O** —— 别在这里塞网络请求。
		 */
		imageRequestPricing(_provider, _model) {
			return undefined
		},

		/**
		 * 图片请求的投影尺寸。
		 *
		 * 同上：基类默认「保持规范化后的原样」，纯对象适配器要自己补，
		 * 否则带图片的请求会在序列化阶段炸 `imageRequestTarget is not a function`。
		 */
		imageRequestTarget(_provider, _model, image) {
			if (image === undefined || image === null) return undefined
			return { width: image.width, height: image.height, maxBytes: image.bytes }
		},

		async listModels(provider) {
			const account = await getAccount()
			// 无已登录账号 ⇒ 空目录，让 DSH 隐藏该分组（返回空数组而不是抛错）。
			if (!account) return []
			let models = FALLBACK_MODELS
			try {
				models = await fetchModelConfig(account.token)
			} catch (error) {
				logger?.warn?.(`[autoclaw] 服务端模型目录拉取失败，退回内置表：${error?.message ?? String(error)}`)
			}
			return models.map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				inputModalities: model.supportsImage ? ['text', 'image'] : ['text']
			}))
		},

		async resolveModel(provider, model) {
			const account = await getAccount()
			let entry
			if (account) {
				try {
					entry = (await fetchModelConfig(account.token)).find((m) => m.id === model)
				} catch {
					entry = undefined
				}
			}
			entry ??= FALLBACK_MODELS.find((m) => m.id === model)

			const resolved = {
				provider,
				id: model,
				name: entry?.name ?? model,
				inputModalities: entry?.supportsImage === true ? ['text', 'image'] : ['text']
			}
			if (entry?.contextWindow > 0) resolved.context = { contextWindow: entry.contextWindow }
			if (Number.isSafeInteger(entry?.maxTokens) && entry.maxTokens > 0) {
				resolved.defaultMaxTokens = entry.maxTokens
			}
			return resolved
		},

		/** 新版内核的 `LlmRuntime.prepareCall()` 会调这里，缺了会抛 not a function。 */
		async prepareCall(provider, model, signal) {
			const resolved = await adapter.resolveModel(provider, model, signal)
			return {
				model: resolved,
				stream: (opts) => adapter.stream(opts)
			}
		},

		/** 推流：HTTP SSE。 */
		async *stream(request) {
			const account = await getAccount()
			if (!account) {
				throw new AutoClawError('autoclaw: 没有找到已登录的本机账号 —— 请先在 AutoClaw 客户端登录一次', 'AUTH')
			}

			const messages = toChatMessages(request)
			if (messages.length === 0) {
				throw new AutoClawError('autoclaw: 消息内容为空', 'UNSUPPORTED_CONTENT')
			}

			// 透传用户选的 maxTokens；注意上游只认 max_completion_tokens（max_tokens 会 406）
			const maxTokens = Number.isSafeInteger(request?.maxTokens) && request.maxTokens > 0
				? request.maxTokens
				: undefined

			// ⚠️ 必须把工具定义传上去，否则模型看不到工具、只能把调用写成 JSON 文本
			const tools = Array.isArray(request?.tools) ? request.tools : undefined
			if (tools !== undefined) {
				logger?.debug?.(`[autoclaw] 透传 ${tools.length} 个工具定义`)
			}

			for await (const event of streamChat({
				token: account.token,
				model: request.model,
				messages,
				signal: request.signal,
				maxTokens,
				tools
			})) {
				yield event
			}
		}
	}
	return adapter
}

/**
 * 插件主体。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dataHome?: string }} [config]
 */
export function apply(ctx, config = {}) {
	const logger = ctx.logger ?? console

	/** 当前使用的本机账号（惰性扫描 + 缓存）。 */
	let cachedAccount
	let scannedAt = 0
	/** 正在进行的扫描（并发调用合流，避免同时开多个 PowerShell 解 DPAPI）。 */
	let scanInflight
	const SCAN_TTL_MS = 10 * 60_000

	/**
	 * 扫描本机账号。
	 *
	 * ⚠️ `listLocalAccounts()` 是 async（DPAPI 解密要跑一次 PowerShell，约 1 秒），
	 * 所以这里**必须** await —— 写成同步 `.filter()` 会得到
	 * `TypeError: listLocalAccounts(...).filter is not a function`，
	 * 被 catch 吞掉后表现成「永远找不到账号」。
	 */
	const scanAccount = async () => {
		const now = Date.now()
		// 缓存有效且令牌还够用（留 60 秒余量）就直接复用
		if (cachedAccount !== undefined && now - scannedAt < SCAN_TTL_MS) {
			if (cachedAccount.expiresAt === undefined || cachedAccount.expiresAt > now + 60_000) return cachedAccount
		}
		if (scanInflight !== undefined) return scanInflight

		scanInflight = (async () => {
			try {
				const accounts = await listLocalAccounts()
				const alive = accounts.filter((a) => a.hasCredential)
				if (alive.length === 0) {
					cachedAccount = undefined
					scannedAt = Date.now()
					return undefined
				}
				const now1 = Date.now()
				const notExpired = alive.filter((a) => a.expiresAt === undefined || a.expiresAt > now1 + 60_000)
				const pool = notExpired.length > 0 ? notExpired : alive
				// 优先 active 的；否则取剩余寿命最长的
				cachedAccount = pool.find((a) => a.active) ?? pool.reduce((best, a) => ((a.expiresAt ?? 0) > (best.expiresAt ?? 0) ? a : best))
				scannedAt = Date.now()
				return cachedAccount
			} catch (error) {
				logger?.warn?.(`[autoclaw] 扫描本机账号失败：${error?.message ?? String(error)}`)
				cachedAccount = undefined
				scannedAt = Date.now()
				return undefined
			} finally {
				scanInflight = undefined
			}
		})()
		return scanInflight
	}

	// 积分缓存（60s TTL + 失败 15s，避免面板刷新把上游打爆）。
	const walletCache = createWalletCache({})

	const adapter = createHttpAdapter({ getAccount: scanAccount, logger })
	const registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
	// ⚠️ `registration` 是 disposer：setup 返回它，cordis 在 fiber 释放时调用。
	// 写成 `ctx.effect(() => { registration() })` 会在启动瞬间就把路由注销掉。
	ctx.effect(() => () => {
		registration()
	}, 'connect-autoclaw: llm routes')

	try {
		ctx.llm.registerConfigurableProviders?.([
			{ provider: PROVIDER_ID, displayName: PROVIDER_NAME, settingsNs: name, settingsPath: [] }
		])
	} catch (error) {
		logger.warn?.(`[connect-autoclaw] registerConfigurableProviders 跳过：${error?.message ?? String(error)}`)
	}

	// ── 浏览器 API（可选）──────────────────────────────────────────────
	if (typeof ctx.inject === 'function') {
		ctx.inject(['webServer'], (scoped) => {
			scoped.effect(() => scoped.webServer.register({
				kind: 'prefix',
				path: '/api/autoclaw',
				handler: async (req, res) => {
					const url = new URL(req.url ?? '/', 'http://127.0.0.1')
					const action = url.pathname.replace(/^\/api\/autoclaw\/?/u, '').replace(/\/+$/u, '')
					const method = (req.method ?? 'GET').toUpperCase()
					try {
						if (action === 'status') {
							const account = await scanAccount()
							if (!account) {
								sendJson(res, 200, { signedIn: false, reason: '本机没有已登录的 AutoClaw 账号' })
								return
							}
							let wallet
							let walletError
							try {
								wallet = await walletCache.get(account.token)
							} catch (error) {
								walletError = error instanceof Error ? error.message : String(error)
							}
							sendJson(res, 200, {
								signedIn: true,
								account: { accountKey: account.accountKey.slice(0, 12), phone: account.phone, expiresAt: account.expiresAt },
								wallet,
								walletError,
								models: readAccountModelCatalog().map((m) => ({ id: m.id, name: m.name, ratio: m.creditCostFactor }))
							})
							return
						}
						if (action === 'refresh' && method === 'POST') {
							walletCache.invalidate()
							sendJson(res, 200, { ok: true })
							return
						}
						if (action === 'test' && method === 'POST') {
							const body = await readBody(req)
							const account = await scanAccount()
							if (!account) {
								sendJson(res, 200, { ok: false, error: '没有已登录账号' })
								return
							}
							try {
								const chunks = []
								for await (const event of streamChat({
									token: account.token,
									model: typeof body?.model === 'string' && body.model !== '' ? body.model : 'zai_glm-5.3-flash',
									messages: [{ role: 'user', content: '只回复两个字：你好' }],
									maxTokens: 32,
									attempts: 5
								})) {
									if (event.type === 'text-delta') chunks.push(event.text)
								}
								sendJson(res, 200, { ok: true, reply: chunks.join('') })
							} catch (error) {
								sendJson(res, 200, { ok: false, error: error?.message ?? String(error), code: error?.code })
							}
							return
						}
						sendJson(res, 404, { error: `未知动作: ${action}` })
					} catch (error) {
						sendJson(res, 500, { error: error?.message ?? String(error) })
					}
				}
			}), 'connect-autoclaw: api routes')
		})
	}

	logger.info?.(`[connect-autoclaw] 已注册 ${PROVIDER_NAME} provider（纯 HTTP 模式）`)
}
