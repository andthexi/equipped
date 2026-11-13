import { expect, test } from 'vitest'

import { OrmMigrationError } from '../../src/orm/errors/migration'
import { Migrator } from '../../src/orm/migrations/migrator'
import type { Migration } from '../../src/orm/migrations/types'
import type { Repo } from '../../src/orm/repo/repo'

type MigrationAdapter = {
	loadMigrations(config: any): Promise<{ id: string; appliedAt: number }[]>
	recordMigration(config: any, id: string, appliedAt: number): Promise<void>
	acquireMigrationLock<T>(config: any, fn: () => Promise<T>): Promise<T>
}

export type MigrationContractFixture<A extends MigrationAdapter> = {
	adapter: A
	repo: Repo<any>
	runInScope<T>(scope: string, fn: () => Promise<T>): Promise<T>
	cleanup(): Promise<void>
	differentScopesRunConcurrently: boolean
}

export type MigrationContractOptions<A extends MigrationAdapter> = {
	createFixture(): Promise<MigrationContractFixture<A>>
}

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

export function migrationAdapterContract<A extends MigrationAdapter>({ createFixture }: MigrationContractOptions<A>) {
	async function withFixture<T>(run: (fixture: MigrationContractFixture<A>) => Promise<T>): Promise<T> {
		const fixture = await createFixture()
		try {
			return await run(fixture)
		} finally {
			await fixture.cleanup()
		}
	}

	test('loads and records history in the active scope while repeat runs skip', () =>
		withFixture(async ({ repo, runInScope }) => {
			let runs = 0
			const migration = {
				id: '0001',
				changes: [{ kind: 'execute' as const, up: async () => void runs++ }],
			}
			const build = () => Migrator.from(repo).withLock().migrations([migration]).build()

			expect(await runInScope('a', () => build().dry())).toEqual({ would: ['0001'] })
			expect(await runInScope('a', () => build().up())).toEqual({ ran: ['0001'], skipped: [] })
			expect(await runInScope('a', () => build().up())).toEqual({ ran: [], skipped: ['0001'] })
			expect(await runInScope('a', () => build().status())).toEqual([
				{ id: '0001', applied: true, appliedAt: expect.any(Number) },
			])
			expect(await runInScope('b', () => build().dry())).toEqual({ would: ['0001'] })
			expect(runs).toBe(1)
		}))

	test('detects orphaned history in only the affected scope', () =>
		withFixture(async ({ adapter, repo, runInScope }) => {
			await runInScope('a', async () => {
				const historyConfig = repo.resolveConfig('_equipped_migrations')
				await adapter.loadMigrations(historyConfig)
				await adapter.recordMigration(historyConfig, 'orphan', 1)
			})
			const build = () => Migrator.from(repo).withLock().migrations([]).build()

			await expect(runInScope('a', () => build().dry())).rejects.toMatchObject<Partial<OrmMigrationError>>({
				id: 'orphan',
				phase: 'load',
			})
			expect(await runInScope('b', () => build().dry())).toEqual({ would: [] })
		}))

	test('keeps completed migrations recorded when a later migration fails', () =>
		withFixture(async ({ repo, runInScope }) => {
			const migrations: Migration<any>[] = [
				{ id: '0001', changes: [{ kind: 'execute', up: async () => undefined }] },
				{ id: '0002', changes: [{ kind: 'execute', up: async () => Promise.reject(new Error('failure')) }] },
			]
			const build = () => Migrator.from(repo).withLock().migrations(migrations).build()

			await expect(runInScope('failure', () => build().up())).rejects.toMatchObject<Partial<OrmMigrationError>>({
				id: '0002',
				phase: 'user',
			})
			expect(await runInScope('failure', () => build().status())).toEqual([
				{ id: '0001', applied: true, appliedAt: expect.any(Number) },
				{ id: '0002', applied: false },
			])
		}))

	test('serializes runners sharing one history scope', () =>
		withFixture(async ({ repo, runInScope }) => {
			const entered = deferred()
			const release = deferred()
			let runs = 0
			const migration = {
				id: '0001',
				changes: [
					{
						kind: 'execute' as const,
						up: async () => {
							runs++
							entered.resolve()
							await release.promise
						},
					},
				],
			}
			const run = () =>
				runInScope('same', () => Migrator.from(repo).withLock().migrations([migration]).build().up())
			const first = run()
			await timeout(entered.promise)
			const second = run()
			await new Promise((resolve) => setTimeout(resolve, 50))
			expect(runs).toBe(1)
			release.resolve()
			expect(await timeout(first)).toEqual({ ran: ['0001'], skipped: [] })
			expect(await timeout(second)).toEqual({ ran: [], skipped: ['0001'] })
		}))

	test('keeps different history scopes logically independent', () =>
		withFixture(async ({ repo, runInScope, differentScopesRunConcurrently }) => {
			const bothEntered = deferred()
			const release = deferred()
			let entered = 0
			const run = (scope: string) =>
				runInScope(scope, () =>
					Migrator.from(repo)
						.withLock()
						.migrations([
							{
								id: '0001',
								changes: [
									{
										kind: 'execute',
										up: async () => {
											entered++
											if (entered === 2) bothEntered.resolve()
											if (differentScopesRunConcurrently) await release.promise
										},
									},
								],
							},
						])
						.build()
						.up(),
				)
			const first = run('a')
			const second = run('b')
			if (differentScopesRunConcurrently) {
				await timeout(bothEntered.promise)
				release.resolve()
			}
			expect(await timeout(Promise.all([first, second]))).toEqual([
				{ ran: ['0001'], skipped: [] },
				{ ran: ['0001'], skipped: [] },
			])
			expect(entered).toBe(2)
		}))
}
