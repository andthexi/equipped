import { OrmValidationError, type OrmValidationFailure } from '../errors/validation.js'
import type { OrmAdapter } from '../orm-adapter.js'
import type { AnyChange, AnyMigration } from './types.js'

function isEmpty(s: string | undefined | null): boolean {
	return !s || s.trim() === ''
}

type ChangeContext = { adapter: OrmAdapter; migrationId: string; changeIndex: number; failures: OrmValidationFailure[] }

function validateFieldSpec(ctx: ChangeContext, fieldSpec: { name: string; type: string }, fieldLabel: string): void {
	if (isEmpty(fieldSpec.name)) {
		ctx.failures.push({
			migrationId: ctx.migrationId,
			changeIndex: ctx.changeIndex,
			field: fieldLabel,
			cause: `${fieldLabel} name must be non-empty`,
		})
	}
	if (
		ctx.adapter.supportedFieldTypes.length > 0 &&
		!ctx.adapter.supportedFieldTypes.includes(fieldSpec.type as any)
	) {
		ctx.failures.push({
			migrationId: ctx.migrationId,
			changeIndex: ctx.changeIndex,
			field: fieldLabel,
			cause: `unsupported field type '${fieldSpec.type}'`,
		})
	}
}

function fail(ctx: ChangeContext, field: string | undefined, cause: string): void {
	ctx.failures.push({
		migrationId: ctx.migrationId,
		changeIndex: ctx.changeIndex,
		...(field ? { field } : {}),
		cause,
	})
}

function validateChange(
	adapter: OrmAdapter,
	change: AnyChange,
	migrationId: string,
	changeIndex: number,
	failures: OrmValidationFailure[],
): void {
	if (change.kind === 'execute') return

	const ctx: ChangeContext = { adapter, migrationId, changeIndex, failures }
	const methodName = `apply${change.kind[0].toUpperCase()}${change.kind.slice(1)}`
	if (typeof (adapter as any)[methodName] !== 'function') {
		fail(ctx, undefined, `adapter does not support change kind '${change.kind}'`)
	}

	switch (change.kind) {
		case 'createTable': {
			if (isEmpty(change.name)) fail(ctx, 'name', 'table name must be non-empty')
			if (isEmpty(change.pk.name)) fail(ctx, 'pk.name', 'pk name must be non-empty')
			if (
				adapter.supportedFieldTypes.length > 0 &&
				!adapter.supportedFieldTypes.includes(change.pk.type as any)
			) {
				fail(ctx, 'pk.type', `unsupported field type '${change.pk.type}'`)
			}
			const fieldNames = new Set<string>()
			for (const f of change.fields) {
				validateFieldSpec(ctx, f, 'field')
				if (fieldNames.has(f.name)) fail(ctx, 'fields', `duplicate field name '${f.name}' in createTable`)
				fieldNames.add(f.name)
			}
			if (change.pk.name && fieldNames.has(change.pk.name)) {
				fail(ctx, 'pk.name', `pk name '${change.pk.name}' collides with a field name`)
			}
			break
		}
		case 'dropTable': {
			if (isEmpty(change.name)) fail(ctx, 'name', 'table name must be non-empty')
			break
		}
		case 'addField': {
			if (isEmpty(change.table)) fail(ctx, 'table', 'table name must be non-empty')
			validateFieldSpec(ctx, change.field, 'field')
			break
		}
		case 'dropField': {
			if (isEmpty(change.table)) fail(ctx, 'table', 'table name must be non-empty')
			if (isEmpty(change.name)) fail(ctx, 'name', 'field name must be non-empty')
			break
		}
		case 'modifyField': {
			if (isEmpty(change.table)) fail(ctx, 'table', 'table name must be non-empty')
			if (isEmpty(change.name)) fail(ctx, 'name', 'field name must be non-empty')
			validateFieldSpec(ctx, change.to, 'to')
			break
		}
		case 'renameTable': {
			if (isEmpty(change.from)) fail(ctx, 'from', 'table name must be non-empty')
			if (isEmpty(change.to)) fail(ctx, 'to', 'table name must be non-empty')
			break
		}
		case 'renameField': {
			if (isEmpty(change.table)) fail(ctx, 'table', 'table name must be non-empty')
			if (isEmpty(change.from)) fail(ctx, 'from', 'field name must be non-empty')
			if (isEmpty(change.to)) fail(ctx, 'to', 'field name must be non-empty')
			break
		}
		case 'addIndex': {
			if (isEmpty(change.table)) fail(ctx, 'table', 'table name must be non-empty')
			if (!change.on || change.on.length === 0) fail(ctx, 'on', 'addIndex.on must be non-empty')
			break
		}
		case 'dropIndex': {
			if (isEmpty(change.name)) fail(ctx, 'name', 'index name must be non-empty')
			break
		}
		case 'addForeignKey': {
			if (isEmpty(change.table)) fail(ctx, 'table', 'table name must be non-empty')
			if (isEmpty(change.on)) fail(ctx, 'on', 'addForeignKey.on must be non-empty')
			if (isEmpty(change.references?.table)) fail(ctx, 'references.table', 'references table must be non-empty')
			if (isEmpty(change.references?.column))
				fail(ctx, 'references.column', 'references column must be non-empty')
			break
		}
		case 'dropForeignKey': {
			if (isEmpty(change.table)) fail(ctx, 'table', 'table name must be non-empty')
			if (isEmpty(change.name)) fail(ctx, 'name', 'foreign key name must be non-empty')
			break
		}
	}
}

export function assertNormalisedChanges(adapter: OrmAdapter, migrations: ReadonlyArray<AnyMigration>): void {
	const failures: OrmValidationFailure[] = []

	const seenIds = new Set<string>()
	for (const m of migrations) {
		if (isEmpty(m.id)) {
			failures.push({ cause: 'migration id must be a non-empty string' })
			continue
		}

		if (seenIds.has(m.id)) {
			failures.push({ migrationId: m.id, cause: `duplicate migration id '${m.id}'` })
		}
		seenIds.add(m.id)

		for (let i = 0; i < m.changes.length; i++) {
			validateChange(adapter, m.changes[i], m.id, i, failures)
		}
	}

	if (failures.length > 0) {
		throw new OrmValidationError('changes', 'migrations', 'build', failures)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('assertNormalisedChanges', () => {
		const fullAdapter = {
			supportedFieldTypes: ['string', 'number', 'boolean'],
			applyCreateTable: async () => {},
			applyDropTable: async () => {},
			applyAddField: async () => {},
			applyDropField: async () => {},
			applyModifyField: async () => {},
			applyRenameTable: async () => {},
			applyRenameField: async () => {},
			applyAddIndex: async () => {},
			applyDropIndex: async () => {},
			applyAddForeignKey: async () => {},
			applyDropForeignKey: async () => {},
		} as any

		const adapterWithIndex = { supportedFieldTypes: ['string', 'number'], applyAddIndex: async () => {} } as any
		const adapterWithout = { supportedFieldTypes: [] } as any

		test('passes for valid migrations with all variant kinds', () => {
			const migrations = [
				{
					id: '0001',
					changes: [
						{
							kind: 'createTable' as const,
							name: 'users',
							pk: { name: 'id', type: 'string' },
							fields: [{ name: 'email', type: 'string' }],
						},
						{ kind: 'addField' as const, table: 'users', field: { name: 'age', type: 'number' } },
						{ kind: 'addIndex' as const, table: 'users', on: ['email'] },
						{
							kind: 'addForeignKey' as const,
							table: 'users',
							on: 'orgId',
							references: { table: 'orgs', column: 'id' },
						},
					],
				},
			]
			expect(() => assertNormalisedChanges(fullAdapter, migrations)).not.toThrow()
		})

		test('invariant A: throws on empty migration id', () => {
			const migrations = [{ id: '', changes: [] }]
			expect(() => assertNormalisedChanges(fullAdapter, migrations)).toThrow(OrmValidationError)
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.kind).toBe('changes')
				expect(err.failures).toHaveLength(1)
				expect(err.failures[0].cause).toContain('non-empty')
			}
		})

		test('invariant B: throws on duplicate migration ids with migrationId field', () => {
			const migrations = [
				{ id: 'dup', changes: [] },
				{ id: 'dup', changes: [] },
			]
			expect(() => assertNormalisedChanges(fullAdapter, migrations)).toThrow(OrmValidationError)
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.kind).toBe('changes')
				const dup = err.failures.find((f: any) => f.cause.includes('duplicate'))
				expect(dup).toBeDefined()
				expect(dup.migrationId).toBe('dup')
			}
		})

		test('invariant C: throws when field type not in supportedFieldTypes', () => {
			const migrations = [
				{
					id: '0001',
					changes: [
						{
							kind: 'createTable' as const,
							name: 'users',
							pk: { name: 'id', type: 'string' },
							fields: [{ name: 'data', type: 'bigint' }],
						},
					],
				},
			]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.some((f: any) => f.cause.includes("unsupported field type 'bigint'"))).toBe(true)
			}
		})

		test('invariant C: throws when pk type not in supportedFieldTypes', () => {
			const migrations = [
				{
					id: '0001',
					changes: [
						{ kind: 'createTable' as const, name: 'users', pk: { name: 'id', type: 'uuid' }, fields: [] },
					],
				},
			]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.some((f: any) => f.cause.includes("unsupported field type 'uuid'"))).toBe(true)
			}
		})

		test('invariant C: throws for addField with unsupported type', () => {
			const migrations = [
				{
					id: '0001',
					changes: [{ kind: 'addField' as const, table: 'users', field: { name: 'x', type: 'bigint' } }],
				},
			]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.some((f: any) => f.cause.includes('unsupported field type'))).toBe(true)
			}
		})

		test('invariant C: throws for modifyField with unsupported type', () => {
			const migrations = [
				{
					id: '0001',
					changes: [
						{ kind: 'modifyField' as const, table: 'users', name: 'x', to: { name: 'x', type: 'bigint' } },
					],
				},
			]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.some((f: any) => f.cause.includes('unsupported field type'))).toBe(true)
			}
		})

		test('invariant C: skips field type check when supportedFieldTypes is empty', () => {
			const adapter = { ...fullAdapter, supportedFieldTypes: [] } as any
			const migrations = [
				{
					id: '0001',
					changes: [
						{
							kind: 'createTable' as const,
							name: 'users',
							pk: { name: 'id', type: 'anything' },
							fields: [{ name: 'x', type: 'custom' }],
						},
					],
				},
			]
			expect(() => assertNormalisedChanges(adapter, migrations)).not.toThrow()
		})

		test('invariant D: throws on duplicate field names in createTable', () => {
			const migrations = [
				{
					id: '0001',
					changes: [
						{
							kind: 'createTable' as const,
							name: 'users',
							pk: { name: 'id', type: 'string' },
							fields: [
								{ name: 'email', type: 'string' },
								{ name: 'email', type: 'string' },
							],
						},
					],
				},
			]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.some((f: any) => f.cause.includes("duplicate field name 'email'"))).toBe(true)
			}
		})

		test('invariant D: throws when pk.name collides with a field name', () => {
			const migrations = [
				{
					id: '0001',
					changes: [
						{
							kind: 'createTable' as const,
							name: 'users',
							pk: { name: 'email', type: 'string' },
							fields: [{ name: 'email', type: 'string' }],
						},
					],
				},
			]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.some((f: any) => f.cause.includes("pk name 'email' collides"))).toBe(true)
			}
		})

		test('invariant E: throws on empty table name in addIndex', () => {
			const migrations = [{ id: '0001', changes: [{ kind: 'addIndex' as const, table: '', on: ['email'] }] }]
			expect(() => assertNormalisedChanges(adapterWithIndex, migrations)).toThrow(OrmValidationError)
		})

		test('invariant E: throws on empty names in dropTable, dropField, renameTable, renameField, dropIndex, dropForeignKey', () => {
			const migrations = [{ id: '0001', changes: [{ kind: 'dropTable' as const, name: '' }] }]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.some((f: any) => f.cause.includes('table name must be non-empty'))).toBe(true)
			}
		})

		test('invariant E: throws on empty field name in dropField', () => {
			const migrations = [{ id: '0001', changes: [{ kind: 'dropField' as const, table: 'users', name: '' }] }]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.some((f: any) => f.cause.includes('field name must be non-empty'))).toBe(true)
			}
		})

		test('invariant E: throws on empty renameTable from/to', () => {
			const migrations = [{ id: '0001', changes: [{ kind: 'renameTable' as const, from: '', to: '' }] }]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.filter((f: any) => f.cause.includes('table name must be non-empty'))).toHaveLength(
					2,
				)
			}
		})

		test('invariant E: throws on empty renameField from/to/table', () => {
			const migrations = [
				{ id: '0001', changes: [{ kind: 'renameField' as const, table: '', from: '', to: '' }] },
			]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.length).toBeGreaterThanOrEqual(3)
			}
		})

		test('invariant E: throws on empty dropIndex name', () => {
			const migrations = [{ id: '0001', changes: [{ kind: 'dropIndex' as const, name: '' }] }]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.some((f: any) => f.cause.includes('index name must be non-empty'))).toBe(true)
			}
		})

		test('invariant E: throws on empty dropForeignKey table/name', () => {
			const migrations = [{ id: '0001', changes: [{ kind: 'dropForeignKey' as const, table: '', name: '' }] }]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.length).toBeGreaterThanOrEqual(2)
			}
		})

		test('invariant F: throws on empty addIndex.on', () => {
			const migrations = [
				{ id: '0001', changes: [{ kind: 'addIndex' as const, table: 'users', on: [] as string[] }] },
			]
			expect(() => assertNormalisedChanges(adapterWithIndex, migrations)).toThrow(OrmValidationError)
			try {
				assertNormalisedChanges(adapterWithIndex, migrations)
			} catch (err: any) {
				expect(err.failures.some((f: any) => f.cause.includes('non-empty'))).toBe(true)
			}
		})

		test('invariant F: throws on empty addForeignKey.on', () => {
			const migrations = [
				{
					id: '0001',
					changes: [
						{
							kind: 'addForeignKey' as const,
							table: 'users',
							on: '',
							references: { table: 'orgs', column: 'id' },
						},
					],
				},
			]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.some((f: any) => f.cause.includes('addForeignKey.on must be non-empty'))).toBe(true)
			}
		})

		test('invariant F: throws on empty addForeignKey references', () => {
			const migrations = [
				{
					id: '0001',
					changes: [
						{
							kind: 'addForeignKey' as const,
							table: 'users',
							on: 'orgId',
							references: { table: '', column: '' },
						},
					],
				},
			]
			try {
				assertNormalisedChanges(fullAdapter, migrations)
			} catch (err: any) {
				expect(err.failures.some((f: any) => f.cause.includes('references table must be non-empty'))).toBe(true)
				expect(err.failures.some((f: any) => f.cause.includes('references column must be non-empty'))).toBe(
					true,
				)
			}
		})

		test('invariant G: throws when adapter lacks required apply method', () => {
			const migrations = [{ id: '0001', changes: [{ kind: 'addIndex' as const, table: 'users', on: ['email'] }] }]
			expect(() => assertNormalisedChanges(adapterWithout, migrations)).toThrow(OrmValidationError)
			try {
				assertNormalisedChanges(adapterWithout, migrations)
			} catch (err: any) {
				expect(err.failures.some((f: any) => f.cause.includes('does not support'))).toBe(true)
			}
		})

		test('invariant G: throws for each unsupported variant', () => {
			const noOpAdapter = { supportedFieldTypes: ['string'] } as any
			const migrations = [
				{
					id: '0001',
					changes: [
						{ kind: 'createTable' as const, name: 'users', pk: { name: 'id', type: 'string' }, fields: [] },
					],
				},
			]
			try {
				assertNormalisedChanges(noOpAdapter, migrations)
			} catch (err: any) {
				expect(
					err.failures.some((f: any) => f.cause.includes("does not support change kind 'createTable'")),
				).toBe(true)
			}
		})

		test('invariant H: allows empty changes array (no-op baseline)', () => {
			const migrations = [{ id: '0001-baseline', changes: [] }]
			expect(() => assertNormalisedChanges(adapterWithIndex, migrations)).not.toThrow()
		})

		test('invariant I: collects all failures into single throw', () => {
			const migrations = [
				{ id: '', changes: [] },
				{ id: 'dup', changes: [] },
				{ id: 'dup', changes: [{ kind: 'addIndex' as const, table: '', on: [] as string[] }] },
			]
			try {
				assertNormalisedChanges(adapterWithIndex, migrations)
			} catch (err: any) {
				expect(err.failures.length).toBeGreaterThanOrEqual(4)
			}
		})

		test('failures carry migrationId and changeIndex', () => {
			const migrations = [
				{ id: 'mig-1', changes: [{ kind: 'addIndex' as const, table: '', on: [] as string[] }] },
			]
			try {
				assertNormalisedChanges(adapterWithIndex, migrations)
			} catch (err: any) {
				for (const f of err.failures) {
					expect(f.migrationId).toBe('mig-1')
					expect(f.changeIndex).toBe(0)
				}
			}
		})

		test('passes for execute changes without adapter check', () => {
			const migrations = [{ id: '0001', changes: [{ kind: 'execute' as const, up: async () => {} }] }]
			expect(() => assertNormalisedChanges(adapterWithout, migrations)).not.toThrow()
		})
	})
}
