import { AsyncLocalStorage } from 'node:async_hooks'

export type ConfigTransform<C> = (config: C, name: string) => C

const store = new AsyncLocalStorage<ConfigTransform<any>[]>()

export function run<C, T>(transform: ConfigTransform<C>, fn: () => T): T {
	const current = store.getStore() ?? []
	return store.run([...current, transform], fn)
}

export function currentTransforms<C>(): ConfigTransform<C>[] {
	return store.getStore() ?? []
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	type TestConfig = { prefix: string }
	function applyTransforms(base: TestConfig): TestConfig {
		let config = base
		for (const t of currentTransforms<TestConfig>()) {
			config = t(config, 'test')
		}
		return config
	}

	describe('ALS runtime', () => {
		test('reads outside run() see no transforms (default config)', () => {
			const transforms = currentTransforms<TestConfig>()
			expect(transforms).toEqual([])
			expect(applyTransforms({ prefix: 'base' })).toEqual({ prefix: 'base' })
		})

		test('reads inside run() see the override', () => {
			const result = run<TestConfig, TestConfig>(
				(config) => ({ prefix: `scoped_${config.prefix}` }),
				() => applyTransforms({ prefix: 'base' }),
			)
			expect(result).toEqual({ prefix: 'scoped_base' })
		})

		test('reads after run() returns see no transforms', () => {
			run<TestConfig, void>(
				(config) => ({ prefix: `inner_${config.prefix}` }),
				() => {},
			)
			expect(applyTransforms({ prefix: 'base' })).toEqual({ prefix: 'base' })
		})

		test('nested run() calls compose — inner derives from outer', () => {
			const result = run<TestConfig, TestConfig>(
				(config) => ({ prefix: `a_${config.prefix}` }),
				() =>
					run<TestConfig, TestConfig>(
						(config) => ({ prefix: `b_${config.prefix}` }),
						() => applyTransforms({ prefix: 'base' }),
					),
			)
			expect(result).toEqual({ prefix: 'b_a_base' })
		})

		test('two parallel run() calls do not bleed into each other', async () => {
			const results = await Promise.all([
				run<TestConfig, Promise<TestConfig>>(
					(config) => ({ prefix: `tenant1_${config.prefix}` }),
					async () => {
						await new Promise((r) => setTimeout(r, 10))
						return applyTransforms({ prefix: 'base' })
					},
				),
				run<TestConfig, Promise<TestConfig>>(
					(config) => ({ prefix: `tenant2_${config.prefix}` }),
					async () => {
						await new Promise((r) => setTimeout(r, 10))
						return applyTransforms({ prefix: 'base' })
					},
				),
			])

			expect(results[0]).toEqual({ prefix: 'tenant1_base' })
			expect(results[1]).toEqual({ prefix: 'tenant2_base' })
		})

		test('overrides survive across awaits inside fn', async () => {
			const result = await run<TestConfig, Promise<TestConfig>>(
				(config) => ({ prefix: `async_${config.prefix}` }),
				async () => {
					await new Promise((r) => setTimeout(r, 5))
					const mid = applyTransforms({ prefix: 'step1' })
					await new Promise((r) => setTimeout(r, 5))
					const end = applyTransforms({ prefix: 'step2' })
					return { prefix: `${mid.prefix}+${end.prefix}` }
				},
			)
			expect(result).toEqual({ prefix: 'async_step1+async_step2' })
		})
	})
}
