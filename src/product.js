/**
 * AutoClaw（智谱桌面端，代号 zwork）的协议常量。
 *
 * 所有取值都来自实测，不是猜的：
 * - 基础域名、路径：从客户端 `app.asar` 的主进程代码里读出，并用真实请求验证。
 * - 签名算法：用抓包里的 `x-auth-sign` 反推确认，`md5(appId&timestamp&appKey)` 逐字节命中。
 * - 渠道 / 版本：抓包里真实成功请求用的是 `x-channel: AutoClaw16`、`x-version: 2.5.3`，
 *   和安装目录里那个 1.20.0 的壳版本不是一回事，别拿后者去填。
 */

/** 生产环境域名。预发是 autoglm-pre-api.zhipuai.cn，内测是 autoglm-inner-3.zhipuai.cn。 */
export const API_BASE = 'https://autoglm-acceleration-api.zhipuai.cn'

/** 对话补全。只有这一个路径能用，`/api/paas/v4/...`、`/v1/chat/completions` 都是 404。 */
export const INFER_PATH = '/autoclaw-proxy/proxy/autoclaw/chat/completions'

/** 钱包（积分余额）。返回 total + 分类型 wallets。 */
export const WALLET_PATH = '/agent-assetmgr/api/v2/wallets'

/** 即将过期的积分。 */
export const EXPIRING_PATH = '/agent-assetmgr/api/v1/points/expiring'

/** 模型目录。倍率 `creditCostFactor` 就在这里，积分显示要用。 */
export const MODEL_CONFIG_PATH = '/autoclaw-proxy/proxy/autoclaw-model-config'

/** 刷新令牌。 */
export const REFRESH_PATH = '/userapi/v1/refresh'

/** 本地数据目录名。真正的凭据在 `AutoClaw-official`，不是 `autoclaw`。 */
export const USER_DATA_DIR = 'AutoClaw-official'

/** 签名用的应用身份。 */
export const APP_ID = '100003'
export const APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5'

/**
 * 客户端身份头。
 *
 * 取值以新版客户端（zwork 2.5.3）`main.cjs` 里的常量为准：
 *   gel  = { appId: '100003', appKey: '38d239…', product: 'autoclaw' }
 *   Ise  = 'official'            ← 默认 channel
 *   bel  = 'autoclaw-desktop'    ← x_trace_id
 *   _el  = 'pc'                  ← X-Client-Type
 *   Xuo  = 'X-Return-Billing'
 *
 * ⚠️ 旧版抓包里是 `AutoClaw16`，新版默认是 `official`。
 * 这里用 official，并允许通过环境变量覆盖（渠道号可能被配置改写）。
 */
export const CLIENT_VERSION = '2.5.3'
export const CHANNEL = process.env.AUTOCLAW_CHANNEL || 'AutoClaw16'
export const PRODUCT = 'autoclaw'
export const LANG = 'zh-CN'
export const PLATFORM = 'win'

/** `x_trace_id` 的固定值（新版常量 `bel`）。注意这是下划线，与 `X-Trace-Id` 是两个不同的头。 */
export const X_TRACE_ID_VALUE = 'autoclaw-desktop'

/** 客户端类型（新版常量 `_el`）。 */
export const CLIENT_TYPE = 'pc'

export const PROVIDER_ID = 'autoclaw'
export const PROVIDER_NAME = 'AutoClaw'

/**
 * 兜底模型表。
 *
 * 只保留实测能过 `x-request-model` 校验的 id。`zai_glm-5.2`、`zai_glm-5v-turbo`、
 * `glm-5.3` 这些都会返回 `400 非法模型` —— 模型目录以服务端为准，这张表只在
 * 拉不到 model-config 时才用。
 */
export const FALLBACK_MODELS = [
	{ id: 'zai_auto', name: 'Auto', contextWindow: 1048576, maxTokens: 393216, creditCostFactor: 0.4 },
	{ id: 'zai_auto-fast', name: 'Auto-Fast', contextWindow: 1048576, maxTokens: 131072, creditCostFactor: 1 },
	{ id: 'zai_glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 204800, maxTokens: 131072, creditCostFactor: 0.2 }
]

/** 业务错误码。 */
export const ERROR_CODES = {
	/** 免费额度用尽 / 高峰期排队。可重试，但短期内不会好。 */
	PAY_VIEW: 810001,
	/** 未登录。token 失效，需要重新登录客户端。 */
	NOT_LOGGED_IN: 410000,
	/** token 无效。多半是请求头名字用错（对话接口要 X-Authorization）。 */
	INVALID_TOKEN: 401001
}