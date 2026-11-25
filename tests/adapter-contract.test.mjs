import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

/**
 * 适配器必须实现 `LlmAdapter` 基类的**全部**方法。
 *
 * 这不是形式主义：内核 `LlmRuntime` 里到处是
 *   `this.adapters.get(provider)?.adapter.<method>(...)`
 * 这种写法 —— 可选链只护住了 `adapters.get()`，适配器本身少一个方法就直接抛
 * `... is not a function`。而报错点常常在看起来无关的路径上（例如
 * `imageRequestPricing` 是在**模型切换 / 上下文压缩**时被调的），
 * 排查成本极高。所以拿基类的整张方法表逐项比对。
 *
 * 下表来自 DSH 内核 `@deepseek-ai/dsh-llm/lib/types/index.js` 的 `LlmAdapter` 类。
 */
const BASE_METHODS = [
	'providerInfo',
	'providerRetryPolicy',
	'imageRequestPricing',
	'imageRequestTarget',
	'listModels',
	'resolveModel',
	'prepareCall',
	'stream'
]

function captureAdapter() {
	let adapter
	apply(
		{
			llm: {
				registerAdapter: (_providers, a) => {
					adapter = a
					return () => {}
				},
				registerConfigurableProviders: () => {}
			},
			logger: { info: () => {}, warn: () => {} },
			effect: () => {},
			inject: () => {}
		},
		{}
	)
	return adapter
}

test('适配器实现了 LlmAdapter 基类的全部方法', () => {
	const adapter = captureAdapter()
	for (const name of BASE_METHODS) {
		assert.equal(typeof adapter[name], 'function', `缺少方法 ${name}（内核调用会抛 not a function）`)
	}
})

test('imageRequestPricing 同步返回 undefined（不声明图片定价）', () => {
	const adapter = captureAdapter()
	const result = adapter.imageRequestPricing('autoclaw', 'zai_glm-5.3-flash')
	assert.equal(result, undefined)
	// 契约要求同步、无 I/O：返回 Promise 会让 token meter 拿到错误的估算
	assert.notEqual(typeof result?.then, 'function')
})

test('imageRequestTarget 原样返回尺寸与字节数', () => {
	const adapter = captureAdapter()
	const image = { width: 1024, height: 768, bytes: 12345 }
	assert.deepEqual(adapter.imageRequestTarget('autoclaw', 'zai_auto', image), {
		width: 1024,
		height: 768,
		maxBytes: 12345
	})
})

test('imageRequestTarget 对空 image 不抛', () => {
	const adapter = captureAdapter()
	assert.equal(adapter.imageRequestTarget('autoclaw', 'zai_auto', undefined), undefined)
	assert.equal(adapter.imageRequestTarget('autoclaw', 'zai_auto', null), undefined)
})

test('providerInfo 返回注册名与展示名', () => {
	const adapter = captureAdapter()
	assert.deepEqual(adapter.providerInfo('autoclaw'), { id: 'autoclaw', name: 'AutoClaw' })
})

test('providerRetryPolicy 是冻结对象且不含重试（WAF/额度在内层已处理）', () => {
	const adapter = captureAdapter()
	const policy = adapter.providerRetryPolicy()
	assert.equal(policy.maxRetries, 0)
	assert.ok(Object.isFrozen(policy))
})