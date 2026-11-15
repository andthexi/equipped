import { describe, expect, expectTypeOf, test } from 'vitest'
import { v } from 'valleyed'

import { InMemoryAdapter } from '../../src/orm/adapters/in-memory'
import { OrmAdapter } from '../../src/orm/orm-adapter'
import { Repo } from '../../src/orm/repo/repo'

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe('Repo storage locking', () => {
	test('resolves a logical target once through the active scope', async () => {
		const adapter = InMemoryAdapter.create({})
		let resolutions = 0
		const repo = Repo.from(adapter)
			.resolve((name) => {
				resolutions += 1
				return { table: name }
			})
			.build()

		await repo.resolve(
			(config) => ({ table: `tenant_${config.table}` }),
			() => repo.lock('users', 'shared', async () => 42),
		)

		expect(resolutions).toBe(1)
	})

	test('is capability-gated and rejects forged unsupported calls', async () => {
		class NoLockAdapter extends OrmAdapter {
			readonly schemaConfigPipe = v.object({ table: v.string() })
		}
		const repo = Repo.from(new NoLockAdapter())
			.resolve((name) => ({ table: name }))
			.build()

		expectTypeOf<typeof repo.lock>().toBeNever()
		await expect((repo as any).lock('users', 'shared', async () => 1)).rejects.toThrow(TypeError)
	})
})

describe('InMemory storage locking', () => {
	test('shared owners coexist and conflicts fail without callback execution', async () => {
		const adapter = InMemoryAdapter.create({})
		const config = { table: 'users' }
		const entered = deferred()
		const release = deferred()
		let conflictingCalls = 0

		const first = adapter.storageLock(config, 'shared', async () => {
			entered.resolve()
			await release.promise
		})
		await entered.promise
		await expect(adapter.storageLock(config, 'shared', async () => 42)).resolves.toBe(42)
		await expect(
			adapter.storageLock(config, 'exclusive', async () => {
				conflictingCalls += 1
			}),
		).rejects.toMatchObject({ reason: 'busy' })
		expect(conflictingCalls).toBe(0)
		release.resolve()
		await first
	})

	test('coordinates by physical target before tables exist and leaves other targets independent', async () => {
		const adapter = InMemoryAdapter.create({})
		const entered = deferred()
		const release = deferred()
		const first = adapter.storageLock({ table: 'users', prefix: 'tenant_' }, 'exclusive', async () => {
			entered.resolve()
			await release.promise
		})
		await entered.promise

		await expect(
			adapter.storageLock({ table: 'tenant_users' }, 'shared', async () => undefined),
		).rejects.toMatchObject({ reason: 'busy' })
		await expect(adapter.storageLock({ table: 'posts' }, 'exclusive', async () => 7)).resolves.toBe(7)
		expect(await adapter.introspect()).toEqual([])
		release.resolve()
		await first
	})

	test('reuses compatible nesting and rejects upgrades and new ownership in transactions', async () => {
		const adapter = InMemoryAdapter.create({})
		const users = { table: 'users' }

		await adapter.storageLock(users, 'shared', async () => {
			await expect(adapter.storageLock(users, 'shared', async () => 1)).resolves.toBe(1)
			await expect(adapter.storageLock(users, 'exclusive', async () => 2)).rejects.toMatchObject({
				reason: 'invalid-use',
			})
		})
		await adapter.storageLock(users, 'exclusive', async () => {
			await expect(adapter.storageLock(users, 'shared', async () => 3)).resolves.toBe(3)
			await expect(adapter.storageLock(users, 'exclusive', async () => 4)).resolves.toBe(4)
		})
		await adapter.session(async () => {
			await expect(adapter.storageLock(users, 'shared', async () => 5)).rejects.toMatchObject({
				reason: 'invalid-use',
			})
		})
	})

	test('settlement drains started sessions and rejects delayed operations', async () => {
		const adapter = InMemoryAdapter.create({})
		const users = { table: 'users' }
		const sessionEntered = deferred()
		const releaseSession = deferred()
		let delayed!: Promise<unknown>
		let sessionDone = false

		await adapter.storageLock(users, 'exclusive', async () => {
			void adapter
				.session(async () => {
					sessionEntered.resolve()
					await releaseSession.promise
				})
				.then(() => {
					sessionDone = true
				})
			await sessionEntered.promise
			delayed = new Promise((resolve) => setTimeout(resolve, 0)).then(() => adapter.loadMigrations(users))
			releaseSession.resolve()
		})

		expect(sessionDone).toBe(true)
		await expect(delayed).rejects.toMatchObject({ reason: 'invalid-use' })
	})
})
