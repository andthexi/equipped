import type { FieldTypeName } from '../adapter.js'
import type { OrmAdapter } from '../orm-adapter.js'
import type { AnySchema } from '../schema.js'
import type { DiscoveredField, DiscoveredSchema } from './introspection-types.js'
import type { AnyChange } from './types.js'

const EMISSION_ORDER: AnyChange['kind'][] = [
	'dropForeignKey',
	'dropIndex',
	'dropField',
	'dropTable',
	'renameTable',
	'renameField',
	'createTable',
	'addField',
	'modifyField',
	'addIndex',
	'addForeignKey',
]

type SchemaFieldInfo = {
	name: string
	type: FieldTypeName
	nullable?: boolean
	default?: string | number | boolean | null
	unique?: boolean
}

function adapterSupports(adapter: OrmAdapter, kind: AnyChange['kind']): boolean {
	if (kind === 'execute') return true
	const method = `apply${kind[0].toUpperCase()}${kind.slice(1)}` as keyof OrmAdapter
	return typeof (adapter as any)[method] === 'function'
}

function fieldsEqual(target: SchemaFieldInfo, discovered: DiscoveredField): boolean {
	if (target.type !== discovered.type) return false
	if ((target.nullable ?? false) !== discovered.nullable) return false
	if (target.default !== discovered.default) return false
	if ((target.unique ?? false) !== (discovered.unique ?? false)) return false
	return true
}

const toFieldPayload = (f: SchemaFieldInfo) => ({
	name: f.name,
	type: f.type,
	...(f.nullable ? { nullable: true as const } : {}),
})

function extractSchemaInfo(schema: AnySchema): {
	name: string
	pk: { name: string; type: FieldTypeName }
	fields: SchemaFieldInfo[]
} {
	const pkField = schema.pkField
	const pkType = inferFieldType(pkField.pipe)
	const fields: SchemaFieldInfo[] = []
	for (const field of Object.values(schema.fieldDefs)) {
		const f = field as any
		fields.push({
			name: f.name,
			type: inferFieldType(f.pipe),
			nullable: isNullable(f.pipe),
		})
	}
	return { name: schema.name, pk: { name: pkField.name, type: pkType }, fields }
}

const KNOWN_FIELD_TYPES: ReadonlySet<string> = new Set<FieldTypeName>([
	'string',
	'number',
	'boolean',
	'array',
	'object',
	'date',
])

function inferFieldType(pipe: any): FieldTypeName {
	if (!pipe) return 'string'
	const schema = typeof pipe.schema === 'function' ? pipe.schema() : undefined
	if (schema?.type) {
		if (KNOWN_FIELD_TYPES.has(schema.type)) return schema.type as FieldTypeName
		return 'string'
	}
	const std = pipe['~standard']
	if (std?.validate) {
		if (!std.validate(0).issues) return 'number'
		if (!std.validate('').issues) return 'string'
		if (!std.validate(true).issues) return 'boolean'
		if (!std.validate([]).issues) return 'array'
		if (!std.validate({}).issues) return 'object'
	}
	return 'string'
}

function isNullable(pipe: any): boolean {
	if (!pipe) return false
	const ctx = typeof pipe.context === 'function' ? pipe.context() : undefined
	if (ctx?.optional) return true
	const std = pipe['~standard']
	if (std?.validate && !std.validate(undefined).issues) return true
	return false
}

export function diffSchemas(
	adapter: OrmAdapter,
	target: ReadonlyArray<AnySchema>,
	current: ReadonlyArray<DiscoveredSchema>,
): ReadonlyArray<AnyChange> {
	const changes: AnyChange[] = []
	const currentByName = new Map(current.map((s) => [s.name, s]))
	const targetByName = new Map(target.map((s) => [s.name, s]))

	for (const disc of current) {
		if (!targetByName.has(disc.name)) {
			for (const fk of disc.foreignKeys) {
				changes.push({ kind: 'dropForeignKey', table: disc.name, name: fk.name })
			}
			for (const idx of disc.indexes) {
				changes.push({ kind: 'dropIndex', table: disc.name, name: idx.name })
			}
			changes.push({ kind: 'dropTable', name: disc.name })
		}
	}

	for (const schema of target) {
		const info = extractSchemaInfo(schema)
		const disc = currentByName.get(info.name)

		if (!disc) {
			changes.push({
				kind: 'createTable',
				name: info.name,
				pk: info.pk,
				fields: info.fields.map(toFieldPayload),
			})
			continue
		}

		const discFieldsByName = new Map(disc.fields.map((f) => [f.name, f]))
		const targetFieldsByName = new Map(info.fields.map((f) => [f.name, f]))

		for (const discField of disc.fields) {
			if (!targetFieldsByName.has(discField.name)) {
				changes.push({ kind: 'dropField', table: info.name, name: discField.name })
			}
		}

		for (const tField of info.fields) {
			const existing = discFieldsByName.get(tField.name)
			if (!existing) {
				changes.push({ kind: 'addField', table: info.name, field: toFieldPayload(tField) })
			} else if (!fieldsEqual(tField, existing)) {
				changes.push({ kind: 'modifyField', table: info.name, name: tField.name, to: toFieldPayload(tField) })
			}
		}
	}

	return changes
		.filter((c) => adapterSupports(adapter, c.kind))
		.sort((a, b) => EMISSION_ORDER.indexOf(a.kind) - EMISSION_ORDER.indexOf(b.kind))
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { v } = await import('valleyed')
	const { InMemoryAdapter } = await import('../adapters/in-memory/index.js')
	const { Schema } = await import('../schema.js')

	describe('diffSchemas', () => {
		function makeAdapter() {
			return InMemoryAdapter.create({})
		}

		test('returns empty array when no changes needed', () => {
			const adapter = makeAdapter()
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => 'x')
				.field('email', v.string())
				.build()
			const current: DiscoveredSchema[] = [
				{
					name: 'users',
					pk: { name: 'id', type: 'string' },
					fields: [{ name: 'email', type: 'string', nullable: false }],
					indexes: [],
					foreignKeys: [],
				},
			]
			const result = diffSchemas(adapter, [UserSchema], current)
			expect(result).toEqual([])
		})

		test('fresh DB returns createTable for everything', () => {
			const adapter = makeAdapter()
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => 'x')
				.field('email', v.string())
				.field('age', v.number())
				.build()
			const result = diffSchemas(adapter, [UserSchema], [])
			expect(result).toHaveLength(1)
			expect(result[0]).toEqual({
				kind: 'createTable',
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [
					{ name: 'email', type: 'string' },
					{ name: 'age', type: 'number' },
				],
			})
		})

		test('add field detected when target has field absent from current', () => {
			const adapter = makeAdapter()
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => 'x')
				.field('email', v.string())
				.field('age', v.number())
				.build()
			const current: DiscoveredSchema[] = [
				{
					name: 'users',
					pk: { name: 'id', type: 'string' },
					fields: [{ name: 'email', type: 'string', nullable: false }],
					indexes: [],
					foreignKeys: [],
				},
			]
			const result = diffSchemas(adapter, [UserSchema], current)
			expect(result).toHaveLength(1)
			expect(result[0]).toEqual({
				kind: 'addField',
				table: 'users',
				field: { name: 'age', type: 'number' },
			})
		})

		test('drop field detected when current has field absent from target', () => {
			const adapter = makeAdapter()
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => 'x')
				.field('email', v.string())
				.build()
			const current: DiscoveredSchema[] = [
				{
					name: 'users',
					pk: { name: 'id', type: 'string' },
					fields: [
						{ name: 'email', type: 'string', nullable: false },
						{ name: 'age', type: 'number', nullable: false },
					],
					indexes: [],
					foreignKeys: [],
				},
			]
			const result = diffSchemas(adapter, [UserSchema], current)
			expect(result).toHaveLength(1)
			expect(result[0]).toEqual({
				kind: 'dropField',
				table: 'users',
				name: 'age',
			})
		})

		test('modify field detected when type changes', () => {
			const adapter = makeAdapter()
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => 'x')
				.field('age', v.string())
				.build()
			const current: DiscoveredSchema[] = [
				{
					name: 'users',
					pk: { name: 'id', type: 'string' },
					fields: [{ name: 'age', type: 'number', nullable: false }],
					indexes: [],
					foreignKeys: [],
				},
			]
			const result = diffSchemas(adapter, [UserSchema], current)
			expect(result).toHaveLength(1)
			expect(result[0]).toEqual({
				kind: 'modifyField',
				table: 'users',
				name: 'age',
				to: { name: 'age', type: 'string' },
			})
		})

		test('drop table detected when current has table absent from target', () => {
			const adapter = makeAdapter()
			const current: DiscoveredSchema[] = [
				{
					name: 'posts',
					pk: { name: 'id', type: 'string' },
					fields: [{ name: 'title', type: 'string', nullable: false }],
					indexes: [{ name: 'posts_title_idx', on: ['title'], unique: false }],
					foreignKeys: [
						{ name: 'posts_author_fk', on: 'authorId', references: { table: 'users', column: 'id' } },
					],
				},
			]
			const result = diffSchemas(adapter, [], current)
			const kinds = result.map((c) => c.kind)
			expect(kinds).toContain('dropForeignKey')
			expect(kinds).toContain('dropIndex')
			expect(kinds).toContain('dropTable')
		})

		test('rename surfaces as drop+add (NOT auto-rename)', () => {
			const adapter = makeAdapter()
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => 'x')
				.field('fullName', v.string())
				.build()
			const current: DiscoveredSchema[] = [
				{
					name: 'users',
					pk: { name: 'id', type: 'string' },
					fields: [{ name: 'name', type: 'string', nullable: false }],
					indexes: [],
					foreignKeys: [],
				},
			]
			const result = diffSchemas(adapter, [UserSchema], current)
			expect(result).toHaveLength(2)
			const kinds = result.map((c) => c.kind)
			expect(kinds).toContain('dropField')
			expect(kinds).toContain('addField')
			expect(kinds).not.toContain('renameField')
		})

		test('emission order respects fixed canonical sequence', () => {
			const adapter = makeAdapter()
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => 'x')
				.field('email', v.string())
				.field('newField', v.number())
				.build()
			const current: DiscoveredSchema[] = [
				{
					name: 'users',
					pk: { name: 'id', type: 'string' },
					fields: [
						{ name: 'email', type: 'number', nullable: false },
						{ name: 'oldField', type: 'string', nullable: false },
					],
					indexes: [],
					foreignKeys: [],
				},
				{
					name: 'posts',
					pk: { name: 'id', type: 'string' },
					fields: [],
					indexes: [],
					foreignKeys: [],
				},
			]
			const result = diffSchemas(adapter, [UserSchema], current)
			const kinds = result.map((c) => c.kind)
			for (let i = 0; i < kinds.length - 1; i++) {
				const a = EMISSION_ORDER.indexOf(kinds[i])
				const b = EMISSION_ORDER.indexOf(kinds[i + 1])
				expect(a).toBeLessThanOrEqual(b)
			}
		})

		test('adapter-aware filtering removes unsupported variants', async () => {
			const { OrmAdapter } = await import('../orm-adapter.js')
			class IndexOnlyAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string', 'number'] as const
				async applyAddIndex() {}
				async applyDropIndex() {}
				async loadMigrations() {
					return []
				}
				async recordMigration() {}
				async introspect() {
					return []
				}
			}
			const adapter = new (IndexOnlyAdapter as any)() as IndexOnlyAdapter
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => 'x')
				.field('email', v.string())
				.build()
			const result = diffSchemas(adapter, [UserSchema], [])
			expect(result).toEqual([])
		})

		test('multiple tables: creates missing and drops extra', () => {
			const adapter = makeAdapter()
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => 'x')
				.field('email', v.string())
				.build()
			const PostSchema = Schema.from('posts')
				.pk('id', v.string(), () => 'x')
				.field('title', v.string())
				.build()
			const current: DiscoveredSchema[] = [
				{
					name: 'users',
					pk: { name: 'id', type: 'string' },
					fields: [{ name: 'email', type: 'string', nullable: false }],
					indexes: [],
					foreignKeys: [],
				},
				{
					name: 'comments',
					pk: { name: 'id', type: 'string' },
					fields: [],
					indexes: [],
					foreignKeys: [],
				},
			]
			const result = diffSchemas(adapter, [UserSchema, PostSchema], current)
			const kinds = result.map((c) => c.kind)
			expect(kinds).toContain('dropTable')
			expect(kinds).toContain('createTable')
			const dropTable = result.find((c) => c.kind === 'dropTable') as any
			expect(dropTable.name).toBe('comments')
			const createTable = result.find((c) => c.kind === 'createTable') as any
			expect(createTable.name).toBe('posts')
		})

		test('Mongo-style adapter with only index ops: field-bearing target returns empty diff', async () => {
			const { OrmAdapter } = await import('../orm-adapter.js')
			class MongoStyleAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string', 'number', 'object', 'array'] as const
				async applyAddIndex() {}
				async applyDropIndex() {}
				async loadMigrations() {
					return []
				}
				async recordMigration() {}
			}
			const adapter = new (MongoStyleAdapter as any)() as MongoStyleAdapter
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => 'x')
				.field('email', v.string())
				.field('age', v.number())
				.build()
			const current: DiscoveredSchema[] = [
				{
					name: 'users',
					pk: { name: 'id', type: 'string' },
					fields: [],
					indexes: [{ name: 'users_email_idx', on: ['email'], unique: true }],
					foreignKeys: [],
				},
			]
			const result = diffSchemas(adapter, [UserSchema], current)
			const kinds = result.map((c) => c.kind)
			expect(kinds.every((k) => k === 'addIndex' || k === 'dropIndex')).toBe(true)
		})

		test('drop index and drop FK emitted when table is dropped', () => {
			const adapter = makeAdapter()
			const current: DiscoveredSchema[] = [
				{
					name: 'posts',
					pk: { name: 'id', type: 'string' },
					fields: [],
					indexes: [{ name: 'posts_title_idx', on: ['title'], unique: false }],
					foreignKeys: [
						{ name: 'posts_author_fk', on: 'authorId', references: { table: 'users', column: 'id' } },
					],
				},
			]
			const result = diffSchemas(adapter, [], current)
			expect(result).toHaveLength(3)
			expect(result[0].kind).toBe('dropForeignKey')
			expect(result[1].kind).toBe('dropIndex')
			expect(result[2].kind).toBe('dropTable')
		})

		test('nullable field mismatch detected as modify', () => {
			const adapter = makeAdapter()
			const UserSchema = Schema.from('users')
				.pk('id', v.string(), () => 'x')
				.field('email', v.optional(v.string()), { onCreate: () => undefined })
				.build()
			const current: DiscoveredSchema[] = [
				{
					name: 'users',
					pk: { name: 'id', type: 'string' },
					fields: [{ name: 'email', type: 'string', nullable: false }],
					indexes: [],
					foreignKeys: [],
				},
			]
			const result = diffSchemas(adapter, [UserSchema], current)
			expect(result).toHaveLength(1)
			expect(result[0].kind).toBe('modifyField')
		})
	})
}
