import { randomUUID } from 'node:crypto'

import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { v } from 'valleyed'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import { Instance } from '../../../../src/instance'
import { MongoDbAdapter } from '../../../../src/orm/adapters/mongodb'
import { OrmMigrationError } from '../../../../src/orm/errors/migration'
import { Migrator } from '../../../../src/orm/migrations/migrator'
import type { Migration } from '../../../../src/orm/migrations/types'
import { Repo } from '../../../../src/orm/repo/repo'
import { Schema } from '../../../../src/orm/schema'

const UserSchema = Schema.from('users').pk('id', v.string()).field('name', v.string()).build()

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => (resolve = done))
	return { promise, resolve }
}

function timeout<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
	])
}

describe('MongoDbAdapter: live migration integration', () => {
	let server: MongoMemoryReplSet
	let adapter: MongoDbAdapter
	let db: string
	const onSpy = vi.spyOn(Instance, 'on').mockImplementation(() => {})

	beforeAll(async () => {
		server = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
		db = `equipped_${randomUUID().replaceAll('-', '')}`
		adapter = MongoDbAdapter.create({ uri: server.getUri() })
		await adapter.connect()
	}, 120_000)

	afterAll(async () => {
		if (adapter) {
			await adapter.client.db(db).dropDatabase()
			await adapter.disconnect()
		}
		if (server) await server.stop()
		onSpy.mockRestore()
	})

	test('two resolved histories remain independent and support repeat skipping, status, dry, and orphans', async () => {
		const makeRepo = (prefix: string) =>
			Repo.from(adapter)
				.resolve((name) => ({ db, col: `${prefix}_${name}` }))
				.build()
		const repoA = makeRepo('a')
		const repoB = makeRepo('b')
		let runs = 0
		const migration: Migration<typeof adapter> = {
			id: '0001',
			changes: [{ kind: 'execute', up: async () => void runs++ }],
		}
		const a = Migrator.from(repoA).withLock().migrations([migration]).build()
		const b = Migrator.from(repoB).withLock().migrations([migration]).build()

		expect(await a.dry()).toEqual({ would: ['0001'] })
		expect(await a.up()).toEqual({ ran: ['0001'], skipped: [] })
		expect(await a.up()).toEqual({ ran: [], skipped: ['0001'] })
		expect(await b.up()).toEqual({ ran: ['0001'], skipped: [] })
		expect(runs).toBe(2)
		expect(await a.status()).toEqual([{ id: '0001', applied: true, appliedAt: expect.any(Number) }])
		expect(await adapter.client.db(db).collection('a__equipped_migrations').countDocuments()).toBe(1)
		expect(await adapter.client.db(db).collection('b__equipped_migrations').countDocuments()).toBe(1)
		expect(await adapter.client.db(db).collection('_equipped_migrations').countDocuments()).toBe(0)

		await adapter.client
			.db(db)
			.collection('a__equipped_migrations')
			.insertOne({ _id: 'orphan', appliedAt: Date.now() })
		await expect(a.dry()).rejects.toMatchObject<Partial<OrmMigrationError>>({ phase: 'load', id: 'orphan' })
	})

	test('a failed transactional migration rolls back both user data and history', async () => {
		const prefix = `tx_${randomUUID().slice(0, 8)}`
		const repo = Repo.from(adapter)
			.resolve((name) => ({ db, col: `${prefix}_${name}` }))
			.build()
		const migration: Migration<typeof adapter> = {
			id: '0001-fail',
			changes: [
				{
					kind: 'execute',
					up: async (migrationRepo) => {
						await migrationRepo.on(UserSchema).one().create({ id: 'rolled-back', name: 'temporary' })
						throw new Error('rollback')
					},
				},
			],
		}

		await expect(Migrator.from(repo).withLock().migrations([migration]).build().up()).rejects.toBeInstanceOf(
			OrmMigrationError,
		)
		expect(await adapter.client.db(db).collection(`${prefix}_users`).countDocuments()).toBe(0)
		expect(await adapter.client.db(db).collection(`${prefix}__equipped_migrations`).countDocuments()).toBe(0)
	})

	test('same history scope excludes concurrent runners without retrying callbacks', async () => {
		const prefix = `same_${randomUUID().slice(0, 8)}`
		const repo = Repo.from(adapter)
			.resolve((name) => ({ db, col: `${prefix}_${name}` }))
			.build()
		const entered = deferred()
		const release = deferred()
		let runs = 0
		const migration: Migration<typeof adapter> = {
			id: '0001',
			changes: [
				{
					kind: 'execute',
					up: async () => {
						runs++
						entered.resolve()
						await release.promise
					},
				},
			],
		}
		const first = Migrator.from(repo).withLock().migrations([migration]).build().up()
		await timeout(entered.promise)
		const second = Migrator.from(repo).withLock().migrations([migration]).build().up()
		await new Promise((resolve) => setTimeout(resolve, 200))
		expect(runs).toBe(1)
		release.resolve()

		expect(await timeout(first)).toEqual({ ran: ['0001'], skipped: [] })
		expect(await timeout(second)).toEqual({ ran: [], skipped: ['0001'] })
		expect(runs).toBe(1)
	})

	test('different history scopes run concurrently on one adapter', async () => {
		const prefix = `different_${randomUUID().slice(0, 8)}`
		const repo = Repo.from(adapter)
			.resolve((name) => ({ db, col: `${prefix}_${name}` }))
			.build()
		const bothEntered = deferred()
		const release = deferred()
		let active = 0
		const migration = (id: string): Migration<typeof adapter> => ({
			id,
			changes: [
				{
					kind: 'execute',
					up: async () => {
						active++
						if (active === 2) bothEntered.resolve()
						await release.promise
					},
				},
			],
		})
		const run = (history: string, id: string) =>
			repo.resolve(
				(config, name) => (name === '_equipped_migrations' ? { ...config, col: history } : config),
				() =>
					Migrator.from(repo)
						.withLock()
						.migrations([migration(id)])
						.build()
						.up(),
			)
		const first = run(`${prefix}_history_a`, 'a')
		const second = run(`${prefix}_history_b`, 'b')

		await timeout(bothEntered.promise)
		release.resolve()
		expect(await timeout(Promise.all([first, second]))).toEqual([
			{ ran: ['a'], skipped: [] },
			{ ran: ['b'], skipped: [] },
		])
	})
})
