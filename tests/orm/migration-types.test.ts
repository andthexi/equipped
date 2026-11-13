import { v } from 'valleyed'
import { describe, expectTypeOf, test } from 'vitest'

import { InMemoryAdapter } from '../../src/orm/adapters/in-memory'
import { MigrationCodegen } from '../../src/orm/migrations/codegen'
import { Migrator } from '../../src/orm/migrations/migrator'
import { OrmAdapter } from '../../src/orm/orm-adapter'
import { Repo } from '../../src/orm/repo/repo'

class UnsupportedAdapter extends OrmAdapter {
	readonly schemaConfigPipe = v.object({ table: v.string() })
	readonly supportedFieldTypes = ['string'] as const
}

class ReadOnlyHistoryAdapter extends UnsupportedAdapter {
	async loadMigrations(_config: { table: string }) {
		return []
	}
}

class NoLockAdapter extends ReadOnlyHistoryAdapter {
	async recordMigration(_config: { table: string }, _id: string, _appliedAt: number) {}
}

function repoFor<A extends OrmAdapter>(adapter: A) {
	return Repo.from(adapter)
		.resolve((name) => ({ table: name }))
		.build()
}

describe('migration compile-time contract', () => {
	test('Repo exposes its exact adapter and scopes typed resolver transforms', () => {
		const adapter = InMemoryAdapter.create({})
		const repo = repoFor(adapter)

		expectTypeOf(repo.adapter).toEqualTypeOf<typeof adapter>()
		repo.resolve(
			(config, name) => {
				expectTypeOf(config).toEqualTypeOf<{ table: string; prefix?: string }>()
				expectTypeOf(name).toEqualTypeOf<string>()
				return config
			},
			() => undefined,
		)
	})

	test('construction remains universal while unsupported terminals are hidden', () => {
		const unsupported = repoFor(new (UnsupportedAdapter as any)() as UnsupportedAdapter)
		const migrator = Migrator.from(unsupported).withoutLock().migrations([]).build()
		const codegen = MigrationCodegen.from(unsupported).target([]).build()

		expectTypeOf(migrator.status).toBeNever()
		expectTypeOf(migrator.dry).toBeNever()
		expectTypeOf(migrator.up).toBeNever()
		expectTypeOf(codegen.diff).toBeNever()
		expectTypeOf(codegen.discover).toBeNever()
	})

	test('method signatures and lock policy follow adapter capabilities', () => {
		const readOnly = Migrator.from(repoFor(new (ReadOnlyHistoryAdapter as any)() as ReadOnlyHistoryAdapter))
		expectTypeOf(readOnly).toHaveProperty('withoutLock')
		expectTypeOf(readOnly).not.toHaveProperty('withLock')
		const readOnlyBuilt = readOnly.withoutLock().migrations([]).build()
		expectTypeOf(readOnlyBuilt.status).toBeCallableWith()
		expectTypeOf(readOnlyBuilt.dry).toBeCallableWith()
		expectTypeOf(readOnlyBuilt.up).toBeNever()

		const noLock = Migrator.from(repoFor(new (NoLockAdapter as any)() as NoLockAdapter))
		expectTypeOf(noLock).toHaveProperty('withoutLock')
		expectTypeOf(noLock).not.toHaveProperty('withLock')
		expectTypeOf(noLock.withoutLock().migrations([]).build().up).toBeCallableWith()

		const lockable = Migrator.from(repoFor(InMemoryAdapter.create({})))
		expectTypeOf(lockable).toHaveProperty('withLock')
		expectTypeOf(lockable).toHaveProperty('withoutLock')
		expectTypeOf(lockable).not.toHaveProperty('migrations')
		expectTypeOf(lockable.withLock().migrations([]).build().up).toBeCallableWith()
	})
})
