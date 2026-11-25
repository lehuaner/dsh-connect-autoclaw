/**
 * dsh-connect-autoclaw — 浏览器半身。
 *
 * ## 形态
 *
 * 手写 CJS bundle，与外挂客户端的 `__ModuleLoader__.load({id, factory})` 约定
 * 逐字一致：执行 bundle 只是**注册** factory；模块体在首次 materialize 时才跑。
 * 用 ESM `export` 写会报
 * `loaded without registering "dsh-connect-autoclaw" via __ModuleLoader__.load`。
 *
 * ## 界面
 *
 * 参照 dsh-codearts 的积分 dock：
 * - 输入框工具行 `conversation.input.left` / `conversation.composer.dock`：
 *   「⚡ 积分 N」角标，点开有明细弹层（各钱包余额 + 模型倍率）。
 * - `settings.section`：设置页状态卡片（账号、积分、测试对话按钮）。
 *
 * 数据全部来自 Host 半身的 `/api/autoclaw/*`，每 60 秒刷新（与后端缓存对齐）。
 *
 * @module dsh-connect-autoclaw/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-connect-autoclaw',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports

		var React = require('react')
		var h = React.createElement

		var API_BASE = '/api/autoclaw'
		var REFRESH_MS = 60_000
		var PANEL_ID = 'dsh-connect-autoclaw'
		/** 弹层往上翻的阈值（px）：角标离视口顶不足这个数就往下翻。 */
		var PANEL_MIN_ABOVE = 420

		/**
		 * 硬依赖。
		 *
		 * ⚠️ 只列**必需**的：多写一个服务 = 该服务缺席时本 fiber 永久 pending。
		 * 这里只挂 slot，不需要 layout / locale。
		 */
		var inject = ['slots']
		var name = 'dsh-connect-autoclaw-client'

		function formatCredits(value) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
			return value.toLocaleString('en-US')
		}

		/** 本插件注册的 provider id，须与 Host 半身 src/product.js 的 PROVIDER_ID 一致。 */
		var PROVIDER_ID = 'autoclaw'

		/**
		 * 读当前模型选择。
		 *
		 * `useProjection('modelSelection')` 是**内核自动注入**给 slot 组件的，
		 * 不是我们通过 `inject()` 返回的 —— 所以组件的 props 里直接就有，
		 * 且必须解构出来用（不在 props 里就说明这个 slot 没提供投影）。
		 */
		function readSelection(useProjection) {
			if (useProjection === undefined) return undefined
			try {
				return useProjection('modelSelection')
			} catch {
				return undefined
			}
		}

		/** `next` 是正在用的、`lastUsed` 是上一次的；两者取先有的那个。 */
		function currentOf(selection) {
			if (selection === undefined || selection === null) return undefined
			return selection.next !== undefined ? selection.next : selection.lastUsed
		}

		/**
		 * 当前选中的是不是 AutoClaw 的模型。
		 *
		 * ⚠️ `useProjection` 拿不到时返回 false（**不显示**）。
		 * 这是刻意的：判断不了就不显示，比把积分常驻在别人家的模型下更安全 ——
		 * 后者会让用户以为「这个模型的额度就是这些」。
		 */
		function isAutoclaw(selection) {
			var current = currentOf(selection)
			return current !== undefined && current !== null && current.provider === PROVIDER_ID
		}

		// ───────────────────────────────────────────────────────────────
		// 全局唯一 status 快照 + 订阅者表
		//
		// 每个组件实例各自 fetch 会把后端缓存打穿（多个实例的轮询叠加），
		// 所以收敛成一份：谁先到谁拉，其余订阅。
		// ───────────────────────────────────────────────────────────────
		var statusListeners = []
		var lastStatus
		var statusFetching = false

		function notifyStatus() {
			for (var i = 0; i < statusListeners.length; i++) {
				try {
					statusListeners[i](lastStatus)
				} catch (error) {
					console.error('[dsh-connect-autoclaw] status listener failed:', error)
				}
			}
		}

		async function refreshStatus() {
			if (statusFetching) return
			statusFetching = true
			try {
				var res = await fetch(API_BASE + '/status', { headers: { Accept: 'application/json' } })
				if (!res.ok) throw new Error('HTTP ' + res.status)
				lastStatus = await res.json()
				notifyStatus()
			} catch (error) {
				console.warn('[dsh-connect-autoclaw] 拉状态失败:', error)
			} finally {
				statusFetching = false
			}
		}

		function subscribeStatus(listener) {
			statusListeners.push(listener)
			if (lastStatus !== undefined) listener(lastStatus)
			return function () {
				var idx = statusListeners.indexOf(listener)
				if (idx !== -1) statusListeners.splice(idx, 1)
			}
		}

		// ───────────────────────────────────────────────────────────────
		// 弹层：钱包明细 + 模型倍率
		// ───────────────────────────────────────────────────────────────
		function CreditPopover(props) {
			var status = props.status
			var wallets = (status.wallet && status.wallet.visible) || []
			var models = status.models || []
			var walletError = status.walletError
			var exp = status.account && status.account.expiresAt

			var children = []

			var headerChildren = [h('span', { key: 't', style: { fontWeight: 600, fontSize: 14 } }, 'AutoClaw 积分')]
			if (exp !== undefined) {
				headerChildren.push(
					h('span', { key: 'e', style: { color: 'var(--dsw-alias-label-tertiary, #999)', fontSize: 11 } }, '登录至 ' + new Date(exp).toLocaleDateString())
				)
			}
			children.push(
				h('div', {
					key: 'h',
					style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 },
				}, headerChildren)
			)

			if (walletError !== undefined) {
				children.push(
					h('div', { key: 'err', style: { color: 'var(--dsw-alias-label-danger, #f66)', fontSize: 12, marginBottom: 8 } }, '积分读取失败：' + walletError)
				)
			}

			if (wallets.length > 0) {
				children.push(
					h('div', { key: 'w', style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 } },
						wallets.map(function (w) {
							return h('div', { key: w.type, style: { display: 'flex', justifyContent: 'space-between' } },
								h('span', { style: { color: 'var(--dsw-alias-label-secondary, #bbb)' } }, w.name),
								h('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 500 } }, w.view !== undefined && w.view !== null ? w.view : formatCredits(w.balance))
							)
						})
					)
				)
			} else if (walletError === undefined) {
				children.push(
					h('div', { key: 'empty', style: { color: 'var(--dsw-alias-label-tertiary, #999)', fontSize: 12, marginBottom: 8 } }, '暂无积分数据')
				)
			}

			if (models.length > 0) {
				children.push(
					h('div', { key: 'm' },
						h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #999)', fontSize: 11, marginBottom: 4 } }, '模型倍率（每 token 消耗系数）'),
						h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
							models.map(function (m) {
								return h('div', { key: m.id, style: { display: 'flex', justifyContent: 'space-between', fontSize: 12 } },
									h('span', { style: { color: 'var(--dsw-alias-label-secondary, #bbb)' } }, m.name),
									h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, m.ratio !== undefined && m.ratio !== null ? '×' + m.ratio : '-')
								)
							})
						)
					)
				)
			}

			return h('div', {
				style: {
					position: 'fixed',
					zIndex: 1000,
					width: 300,
					maxHeight: 420,
					overflowY: 'auto',
					borderRadius: 10,
					border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
					background: 'var(--dsw-alias-bg-layer-1, #1e1e1e)',
					boxShadow: '0 8px 28px rgba(0,0,0,.4)',
					padding: 12,
					fontSize: 13,
				},
			}, children)
		}

		// ───────────────────────────────────────────────────────────────
		// 输入框角标（conversation.input.left / conversation.composer.dock）
		// ───────────────────────────────────────────────────────────────
		function AutoclawCreditDock(props) {
			// ⚠️ 先算「当前选的这个 provider 是不是我」，再走 hooks ——
			// 早返回必须放在所有 hooks 之后，否则违反 React hooks 规则。
			var selection = readSelection(props === undefined || props === null ? undefined : props.useProjection)
			var active = isAutoclaw(selection)

			var statusState = React.useState(undefined)
			var status = statusState[0]
			var setStatus = statusState[1]

			var openState = React.useState(false)
			var open = openState[0]
			var setOpen = openState[1]

			var posState = React.useState(null)
			var pos = posState[0]
			var setPos = posState[1]

			var buttonRef = React.useRef(null)

			// 非 AutoClaw 模型时不订阅、不轮询：切走就停。
			React.useEffect(function () {
				if (!active) return undefined
				var unsubscribe = subscribeStatus(setStatus)
				refreshStatus()
				var timer = setInterval(refreshStatus, REFRESH_MS)
				return function () {
					unsubscribe()
					clearInterval(timer)
				}
			}, [active])

			// 点外部关闭
			React.useEffect(function () {
				if (!open) return undefined
				var onDoc = function (e) {
					if (buttonRef.current && !buttonRef.current.contains(e.target)) setOpen(false)
				}
				document.addEventListener('mousedown', onDoc)
				return function () {
					document.removeEventListener('mousedown', onDoc)
				}
			}, [open])

			// 弹层位置实测（与 active 无关，但必须无条件走 hook）
			React.useLayoutEffect(function () {
				if (!open || !active || !buttonRef.current) return
				var rect = buttonRef.current.getBoundingClientRect()
				var above = rect.top > PANEL_MIN_ABOVE
				setPos({
					top: above ? undefined : rect.bottom + 8,
					bottom: above ? window.innerHeight - rect.top + 8 : undefined,
					left: Math.max(8, Math.min(rect.left, window.innerWidth - 310)),
				})
			}, [open, active])

			// ── 以下才是早返回（hooks 已全部执行完）──
			if (!active) return null
			if (!status || !status.signedIn) return null

			var total = status.wallet && status.wallet.total
			var label = typeof total === 'number' ? '积分 ' + formatCredits(total) : '积分 …'

			var popoverStyle = pos !== null ? Object.assign({ position: 'fixed' }, pos) : null

			return h('div', { style: { display: 'inline-flex', position: 'relative' } },
				h('button', {
					ref: buttonRef,
					onClick: function () {
						setOpen(!open)
					},
					style: {
						display: 'inline-flex',
						alignItems: 'center',
						gap: 4,
						border: 'none',
						background: 'transparent',
						color: 'var(--dsw-alias-label-tertiary, #999)',
						fontSize: 12,
						cursor: 'pointer',
						padding: '2px 6px',
						borderRadius: 6,
					},
					title: 'AutoClaw 积分余额（点击看明细）',
				}, '⚡ ', label),
				open && popoverStyle !== null
					? h('div', { style: popoverStyle }, h(CreditPopover, { status: status }))
					: null
			)
		}

		// ───────────────────────────────────────────────────────────────
		// 设置页卡片
		// ───────────────────────────────────────────────────────────────
		function SettingsCard() {
			var statusState = React.useState(undefined)
			var status = statusState[0]
			var setStatus = statusState[1]

			var testState = React.useState(null)
			var testResult = testState[0]
			var setTestResult = testState[1]

			var testingState = React.useState(false)
			var testing = testingState[0]
			var setTesting = testingState[1]

			React.useEffect(function () {
				var unsubscribe = subscribeStatus(setStatus)
				refreshStatus()
				var timer = setInterval(refreshStatus, REFRESH_MS)
				return function () {
					unsubscribe()
					clearInterval(timer)
				}
			}, [])

			var runTest = React.useCallback(function () {
				setTesting(true)
				setTestResult(null)
				fetch(API_BASE + '/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
					.then(function (r) {
						return r.json()
					})
					.then(function (data) {
						setTestResult(data.ok === true ? '✓ 测试通过，回复：' + data.reply : '✗ ' + data.error + (data.code ? '（' + data.code + '）' : ''))
					})
					.catch(function (e) {
						setTestResult('✗ ' + e.message)
					})
					.finally(function () {
						setTesting(false)
					})
			}, [])

			var wallets = (status && status.wallet && status.wallet.visible) || []
			var body

			if (!status) {
				body = h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #999)' } }, '读取中…')
			} else if (!status.signedIn) {
				body = h('div', { style: { color: 'var(--dsw-alias-label-warning, #fa0)' } }, status.reason || '本机没有已登录的 AutoClaw 账号')
			} else {
				var account = status.account || {}
				var rows = []

				var accountRow = [h('span', { key: 'n' }, '账号: ' + (account.phone || account.accountKey || '已登录'))]
				if (account.expiresAt !== undefined) {
					accountRow.push(
						h('span', { key: 'e', style: { color: 'var(--dsw-alias-label-tertiary, #999)' } }, '令牌到期: ' + new Date(account.expiresAt).toLocaleString())
					)
				}
				rows.push(h('div', { key: 'acc', style: { display: 'flex', gap: 16 } }, accountRow))

				if (wallets.length > 0) {
					rows.push(
						h('div', { key: 'w', style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
							wallets.map(function (w) {
								return h('span', { key: w.type }, w.name + ': ',
									h('b', null, w.view !== undefined && w.view !== null ? w.view : formatCredits(w.balance)))
							})
						)
					)
				}

				if (status.walletError !== undefined) {
					rows.push(h('div', { key: 'err', style: { color: 'var(--dsw-alias-label-danger, #f66)', fontSize: 12 } }, '积分读取失败：' + status.walletError))
				}

				rows.push(
					h('button', {
						key: 'test',
						onClick: runTest,
						disabled: testing,
						style: {
							alignSelf: 'flex-start',
							padding: '5px 14px',
							borderRadius: 8,
							border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
							background: 'var(--dsw-alias-bg-layer-2, #2a2a2a)',
							color: 'inherit',
							cursor: testing ? 'wait' : 'pointer',
						},
					}, testing ? '测试中…' : '发一条测试消息')
				)

				if (testResult !== null) {
					rows.push(h('div', { key: 'res', style: { fontSize: 12, whiteSpace: 'pre-wrap' } }, testResult))
				}

				body = h(React.Fragment, null, rows)
			}

			return h('div', {
				style: {
					border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
					borderRadius: 10,
					padding: 14,
					display: 'flex',
					flexDirection: 'column',
					gap: 10,
					fontSize: 13,
				},
			},
				h('div', { style: { fontWeight: 600, fontSize: 14 } }, 'AutoClaw（智谱）'),
				body
			)
		}

		// ───────────────────────────────────────────────────────────────
		// apply
		// ───────────────────────────────────────────────────────────────
		function apply(ctx) {
			var slots = ctx && ctx.slots
			if (slots === undefined || slots === null || typeof slots.inject !== 'function') {
				console.warn('[dsh-connect-autoclaw] slots 不可用，面板与角标不注册')
				return
			}

			// 输入框工具行（codearts 同款双槽：老壳用 input.left，新壳用 composer.dock）
			try {
				slots.inject('conversation.input.left', function () {
					return slots.register({ name: 'conversation.input.left', id: 'autoclaw-credits-bar', order: 30 }, AutoclawCreditDock)
				})
			} catch (error) {
				console.warn('[dsh-connect-autoclaw] input.left 不可用:', error)
			}
			try {
				slots.inject('conversation.composer.dock', function () {
					return slots.register({ name: 'conversation.composer.dock', id: 'autoclaw-credits', order: 30 }, AutoclawCreditDock)
				})
			} catch (error) {
				console.warn('[dsh-connect-autoclaw] composer.dock 不可用:', error)
			}

			// 设置页
			try {
				slots.inject('settings.section', function () {
					return slots.register({ name: 'settings.section', id: PANEL_ID, order: 60 }, SettingsCard)
				})
			} catch (error) {
				console.warn('[dsh-connect-autoclaw] settings.section 不可用:', error)
			}

			// 不在 apply 里预拉状态：积分只在切到 AutoClaw 模型时才需要，
			// 组件挂载时自己会拉（见 AutoclawCreditDock 的 effect）。
		}

		exports.apply = apply
		exports.inject = inject
		exports.name = name

		return module.exports
	},
})