import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe } from 'vitest'

import { InMemoryAdapter } from '../../../src/orm/adapters/in-memory'
import { JsonAdapter } from '../../../src/orm/adapters/json'
import { Repo } from '../../../src/orm/repo/repo'
import { migrationAdapterContract } from '../migration-contract'

describe('InMemoryAdapter migration contract', () => {
	migrationAdapterContract({
		async createFixture() {
			const adapter = InMemoryAdapter.create({})
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
			return {
				adapter,
				repo,
				// In-memory keeps one adapter-wide rollback admission boundary while
				// partitioning history and lock ownership by resolved identity.
				differentScopesRunConcurrently: false,
				runInScope: <T>(scope: string, fn: () => Promise<T>) =>
					repo.resolve(
						(config, name) =>
							name === '_equipped_migrations' ? { ...config, table: `${scope}_${config.table}` } : config,
						fn,
					),
				cleanup: async () => undefined,
			}
		},
	})
})

describe('JsonAdapter migration contract', () => {
	migrationAdapterContract({
		async createFixture() {
			const dir = await mkdtemp(join(tmpdir(), 'equipped-json-migration-contract-'))
			const adapter = JsonAdapter.create({ filePath: join(dir, 'db.json') })
			await adapter.connect()
			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
			return {
				adapter,
				repo,
				// JSON protects one physical file, but histories inside it remain independent.
				differentScopesRunConcurrently: false,
				runInScope: <T>(scope: string, fn: () => Promise<T>) =>
					repo.resolve(
						(config, name) =>
							name === '_equipped_migrations' ? { ...config, table: `${scope}_${config.table}` } : config,
						fn,
					),
				cleanup: async () => {
					await adapter.disconnect()
					await rm(dir, { recursive: true, force: true })
				},
			}
		},
	})
})
