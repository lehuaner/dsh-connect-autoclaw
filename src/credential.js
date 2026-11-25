/**
 * 从本机 AutoClaw 客户端里读出登录令牌。
 *
 * 客户端有两处登录态，**用途不同，都要读**：
 *
 * 1. `%APPDATA%\AutoClaw-official\Local State` + `accounts\<hash>\account-credentials.enc`
 *    —— 账号资料与业务令牌（钱包、模型目录用）。AES-256-GCM，`v10` 前缀。
 *
 * 2. `%APPDATA%\autoclaw\Local State` + `token-cache.json`
 *    —— **对话推理用的令牌**。`token-cache.json` 里是 `enc:` + base64(v10 密文)，
 *    用 `autoclaw` 这个目录自己的主密钥解（与 1 的密钥不是同一把）。
 *    客户端把它写进 `~/.openclaw-autoclaw/request-headers.json` 的 `X-Authorization`，
 *    也就是真正发对话请求时用的那个。
 *
 * 注意 `accessToken` 里自带 `Bearer ` 前缀，用之前要剥掉。
 *
 * 这是「读客户端已经存好的登录态」，不是破解：DPAPI 解密走的是当前 Windows
 * 用户的凭据，和客户端自己读的时候是同一条路。
 */

import { createDecipheriv } from 'node:crypto'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { USER_DATA_DIR } from './product.js'

/** Electron 的 userData 目录。 */
export function userDataDir(options = {}) {
	if (options.userDataDir) return options.userDataDir
	const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
	return join(appData, USER_DATA_DIR)
}

/**
 * 另一个 userData 目录：`%APPDATA%\autoclaw`。
 *
 * 注意它**不是** `AutoClaw-official`。客户端有两个用户数据目录：
 * 前者放会话/令牌缓存，后者放账号凭据。两者的 `Local State` 主密钥也不同，
 * 混用会解不开（AES-GCM 校验失败）。
 */
export function tokenCacheDataDir(options = {}) {
	if (options.tokenCacheDataDir) return options.tokenCacheDataDir
	const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
	return join(appData, 'autoclaw')
}

/** 解 JWT 的 exp（毫秒）。解不开返回 undefined，不抛。 */
export function decodeJwtExpMs(token) {
	try {
		const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
		return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
	} catch {
		return undefined
	}
}

/**
 * 用 DPAPI 解开 Electron 的 `encrypted_key`，拿到 AES master key。
 *
 * 只有在 Windows 上才有 DPAPI；其他平台直接返回 undefined，由调用方报
 * 「这个平台不支持自动读取登录态」。
 *
 * 走 PowerShell 而不是原生 FFI：`ProtectedData.Unprotect` 是 .NET 自带的，
 * 不需要装任何依赖就能用，而 .NET 原生调用的方案要多带一个 koffi。
 * 密钥只以 Base64 形式进命令行，不落盘、不出现在文件里。
 */
async function readMasterKey(userDataDirPath) {
	if (process.platform !== 'win32') return undefined
	const localStatePath = join(userDataDirPath, 'Local State')
	if (!existsSync(localStatePath)) return undefined

	let encryptedKey
	try {
		const localState = JSON.parse(readFileSync(localStatePath, 'utf8'))
		encryptedKey = localState?.os_crypt?.encrypted_key
	} catch {
		return undefined
	}
	if (typeof encryptedKey !== 'string' || encryptedKey === '') return undefined

	// base64 → 前 5 字节是 ASCII "DPAPI"，解之前必须去掉。
	const buf = Buffer.from(encryptedKey, 'base64')
	const payload = buf.subarray(5)
	const payloadBase64 = payload.toString('base64')

	// `ProtectedData` 不是默认加载的程序集里的类型，必须先把 System.Security 装上，
	// 否则会报 `TypeNotFound`。这行漏了就是最常见的「DPAPI 解不开」。
	const script = [
		'$ErrorActionPreference = "Stop"',
		'Add-Type -AssemblyName System.Security',
		`$b64 = "${payloadBase64}"`,
		'$blob = [System.Convert]::FromBase64String($b64)',
		'$key = [System.Security.Cryptography.ProtectedData]::Unprotect(',
		'  $blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
		'[System.Convert]::ToBase64String($key)'
	].join('\n')

	const { execFile } = await import('node:child_process')
	const { promisify } = await import('node:util')
	const run = promisify(execFile)

	try {
		const { stdout } = await run(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', script],
			{ timeout: 15000, windowsHide: true }
		)
		const text = String(stdout).trim()
		if (!text) return undefined
		return Buffer.from(text, 'base64')
	} catch {
		return undefined
	}
}

/**
 * 解一个 v10 格式的密文。
 *
 * 格式：`v10`（3 字节魔法）+ 12 字节 IV + 密文 + 16 字节 GCM tag。
 *
 * @param {Buffer} masterKey 32 字节 AES 主密钥
 * @param {string|Buffer} source 文件路径，或直接的密文字节
 */
export function decryptCredentialFile(masterKey, source) {
	const raw = Buffer.isBuffer(source) ? source : readFileSync(source)
	if (raw.subarray(0, 3).toString() !== 'v10') throw new Error('凭据文件格式不认识（缺少 v10 前缀）')
	const iv = raw.subarray(3, 15)
	const tag = raw.subarray(raw.length - 16)
	const ciphertext = raw.subarray(15, raw.length - 16)
	const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
	decipher.setAuthTag(tag)
	const out = Buffer.concat([decipher.update(ciphertext), decipher.final()])
	return JSON.parse(out.toString('utf8'))
}

/**
 * 解一个 v10 密文并返回**原始字符串**（不当作 JSON）。
 *
 * `token-cache.json` 里存的是一个裸 JWT 字符串，不是 JSON 对象。
 */
export function decryptToString(masterKey, source) {
	const raw = Buffer.isBuffer(source) ? source : readFileSync(source)
	if (raw.subarray(0, 3).toString() !== 'v10') throw new Error('密文格式不认识（缺少 v10 前缀）')
	const iv = raw.subarray(3, 15)
	const tag = raw.subarray(raw.length - 16)
	const ciphertext = raw.subarray(15, raw.length - 16)
	const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
	decipher.setAuthTag(tag)
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * 列出本机所有 AutoClaw 账号。
 *
 * 返回的每一项都带 `token`（已剥 Bearer），`hasCredential` 表示凭据文件在不在。
 * 解不开的账号不会让整体失败，只是那一项没有 token。
 */
export async function listLocalAccounts(options = {}) {
	const dir = userDataDir(options)
	const accountsDir = join(dir, 'accounts')
	if (!existsSync(accountsDir)) return []

	const masterKey = await readMasterKey(dir)

	const accounts = []
	for (const accountKey of readdirSync(accountsDir)) {
		const entryDir = join(accountsDir, accountKey)
		const credentialPath = join(entryDir, 'account-credentials.enc')
		const profilePath = join(entryDir, 'account-profile.json')
		if (!existsSync(credentialPath)) continue

		let profile = {}
		try {
			profile = JSON.parse(readFileSync(profilePath, 'utf8'))
		} catch {
			profile = {}
		}

		let token = ''
		let refreshToken = ''
		let error
		if (masterKey === undefined) {
			error = '读不到 DPAPI 主密钥（非 Windows 或权限不足）'
		} else {
			try {
				const cred = decryptCredentialFile(masterKey, credentialPath)
				token = typeof cred.accessToken === 'string' ? cred.accessToken.replace(/^Bearer\s+/i, '') : ''
				refreshToken = typeof cred.refreshToken === 'string' ? cred.refreshToken : ''
			} catch (e) {
				error = e instanceof Error ? e.message : String(e)
			}
		}

		accounts.push({
			accountKey,
			accountId: profile.accountId ?? profile.userId ?? accountKey,
			phone: profile.phone ?? profile.mobile ?? '',
			token,
			refreshToken,
			hasCredential: token !== '',
			expiresAt: token ? decodeJwtExpMs(token) : undefined,
			active: profile.active === true,
			...(error === undefined ? {} : { error })
		})
	}

	return accounts
}

/**
 * 读账号的本地模型目录快照。
 *
 * 这个文件才是推理时合法的模型 id 来源。客户端里另有一份 BYOK 的
 * `third-party-provider-config`，那份里的 id 拿去推理会 `400 非法模型`。
 */
export function readAccountModelCatalog(options = {}) {
	const dir = userDataDir(options)
	const accountsDir = join(dir, 'accounts')
	if (!existsSync(accountsDir)) return []
	for (const accountKey of readdirSync(accountsDir)) {
		const snapshotPath = join(accountsDir, accountKey, 'runtime', 'model-catalog', 'remote-snapshot.json')
		if (!existsSync(snapshotPath)) continue
		try {
			const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
			const models = Array.isArray(snapshot?.models) ? snapshot.models : []
			if (models.length > 0) {
				return models.map((m) => ({
					id: m.id,
					name: m.name ?? m.id,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
					supportsImage: Array.isArray(m.input) && m.input.includes('image'),
					reasoning: m.reasoning === true,
					creditCostFactor: m.creditCostFactor
				}))
			}
		} catch {
			// 单个账号读坏了不影响别的
		}
	}
	return []
}

/** 账号目录名的算法，方便调试时手工核对。 */
export function accountKeyOf(seed) {
	return createHash('sha256').update(String(seed)).digest('hex')
}

/**
 * 读 `token-cache.json` 里的对话令牌。
 *
 * 文件长这样：
 *   { "token": "enc:<base64>", "refreshToken": "enc:<base64>", "updatedAt": 1795463301195 }
 *
 * `enc:` 后面是 base64 的 **v10 格式**（不是裸 DPAPI）：
 *   `v10`（3 字节）+ 12 字节 IV + 密文 + 16 字节 GCM tag
 * 主密钥来自**同目录**（`%APPDATA%\autoclaw`）的 `Local State` ——
 * 用 `AutoClaw-official` 的密钥会 `unable to authenticate data`。
 *
 * 解出来的字符串自带 `Bearer ` 前缀，这里剥掉。
 */
export async function readTokenCache(options = {}) {
	const dir = tokenCacheDataDir(options)
	const cachePath = join(dir, 'token-cache.json')
	if (!existsSync(cachePath)) return undefined

	let cache
	try {
		cache = JSON.parse(readFileSync(cachePath, 'utf8'))
	} catch {
		return undefined
	}
	const raw = cache?.token
	if (typeof raw !== 'string' || raw === '') return undefined

	const masterKey = await readMasterKey(dir)
	if (masterKey === undefined) {
		return { token: '', refreshToken: '', updatedAt: cache.updatedAt, error: '读不到 DPAPI 主密钥' }
	}

	try {
		const body = raw.startsWith('enc:') ? raw.slice(4) : raw
		const blob = Buffer.from(body, 'base64')
		const token = decryptToString(masterKey, blob)
		return {
			token: token.replace(/^Bearer\s+/i, '').trim(),
			refreshToken: typeof cache.refreshToken === 'string' ? cache.refreshToken : '',
			updatedAt: cache.updatedAt,
			expiresAt: token !== '' ? decodeJwtExpMs(token) : undefined
		}
	} catch (error) {
		return { token: '', refreshToken: '', updatedAt: cache.updatedAt, error: error instanceof Error ? error.message : String(error) }
	}
}