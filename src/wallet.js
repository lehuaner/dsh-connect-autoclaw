/**
 * 积分与钱包。
 *
 * `agent-assetmgr/api/v2/wallets` 返回的是分类型钱包，不是单一的「余额」。
 * 上游原始形状（`schema_version: wallets.v2`）：
 *
 *   { code: 0, data: {
 *       schema_version: 'wallets.v2',
 *       total_balance: 11391,
 *       wallets: [
 *         { public_wallet_type: 'reward', display_name: '奖励积分',
 *           balance: 11391, balance_view: '1.1w', display: true, priority: 10 },
 *         { public_wallet_type: 'subscription', ..., balance: 0, display: false }, ... ] } }
 *
 * 上游已经算好了 `balance_view`（`1.1w` 这种缩写）和 `display`，直接用，
 * 不要自己再格式化一遍 —— 否则「1.1w」会变成「11,391」，和客户端显示不一致。
 *
 * 只有 `display: true` 的那几项值得显示，其余是拿来做逻辑判断的，
 * 界面上全列出来只会变成一排 0。
 */

import { WALLET_PATH, API_BASE } from './product.js'
import { buildHeaders } from './headers.js'

/** 把上游钱包文档整理成界面要的形状。 */
export function parseWallet(raw) {
	const total = typeof raw?.total_balance === 'number' ? raw.total_balance : 0
	const wallets = Array.isArray(raw?.wallets) ? raw.wallets : []

	const mapped = wallets.map((w) => ({
		type: String(w?.public_wallet_type ?? ''),
		name: String(w?.display_name ?? ''),
		balance: Number(w?.balance) || 0,
		/** 上游算好的缩写余额，优先用它显示。 */
		view: typeof w?.balance_view === 'string' && w.balance_view !== '' ? w.balance_view : undefined,
		display: w?.display === true,
		priority: Number(w?.priority) || 0
	}))

	return {
		total,
		wallets: mapped,
		/** 界面上该显示的，按上游优先级排。 */
		visible: mapped.filter((w) => w.display).sort((a, b) => a.priority - b.priority),
		/** 有没有订阅额度。没有就说明是纯免费账号，高峰期会被限流。 */
		hasSubscription: mapped.some((w) => w.type === 'subscription' && w.balance > 0)
	}
}

/**
 * 拉钱包。
 *
 * 钱包接口走的是**业务鉴权**（`Authorization`），不是推理的 `X-Authorization`。
 * 这一点很容易搞混，因为两个接口在同一个域名下，只是路径和头不一样。
 */
export async function fetchWallet(token, options = {}) {
	const res = await fetch(API_BASE + WALLET_PATH, {
		method: 'GET',
		headers: buildHeaders({ token, kind: 'business', cookie: options.cookie }),
		signal: options.signal ?? AbortSignal.timeout(15000)
	})
	const text = await res.text()
	if (!res.ok) throw new Error(`钱包接口 HTTP ${res.status}: ${text.slice(0, 160)}`)
	let body
	try {
		body = JSON.parse(text)
	} catch {
		throw new Error(`钱包接口返回的不是 JSON: ${text.slice(0, 160)}`)
	}
	if (body?.code !== undefined && body.code !== 0) {
		throw new Error(`钱包接口业务错误 ${body.code}: ${body.msg ?? body.message ?? ''}`)
	}
	return parseWallet(body?.data ?? body)
}

/**
 * 积分缓存。
 *
 * dock 每渲染一次就问一次太浪费，上游也有频率限制。这里做 TTL + 单飞：
 * 缓存有效期内不请求上游，失败的结果也短暂缓存，免得上游抽风时每次都等超时。
 */
export function createWalletCache({ ttlMs = 60_000, errorTtlMs = 15_000, fetcher } = {}) {
	let cached
	let cachedAt = 0
	let cachedError
	let inflight

	async function run(token, options) {
		cachedError = undefined
		try {
			const value = await (fetcher ?? fetchWallet)(token, options)
			cached = value
			cachedAt = Date.now()
			return value
		} catch (error) {
			cachedError = error instanceof Error ? error.message : String(error)
			cachedAt = Date.now()
			throw error
		} finally {
			inflight = undefined
		}
	}

	return {
		async get(token, options = {}) {
			const age = Date.now() - cachedAt
			if (cached !== undefined && age < ttlMs) return cached
			if (cachedError !== undefined && age < errorTtlMs) throw new Error(cachedError)
			if (inflight !== undefined) return inflight
			inflight = run(token, options)
			return inflight
		},
		/** 强制下一次重新拉。 */
		invalidate() {
			cachedAt = 0
			cachedError = undefined
		},
		peek() {
			return cached
		}
	}
}