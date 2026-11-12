import type { Pipe } from 'valleyed'

import { EquippedError } from '../errors/index.js'
import { Instance, type ClassRef } from '../instance/index.js'
import type { AggregateOpName, FieldTypeName, FilterOpName, UpdateOpName } from './adapter.js'
import type { OrmUse } from './adapters/base.js'
import { FilterGroup } from './filter.js'
import type { DiscoveredSchema } from './migrations/introspection-types.js'
import type {
	AddFieldChange,
	AddForeignKeyChange,
	AddIndexChange,
	CreateTableChange,
	DropFieldChange,
	DropForeignKeyChange,
	DropIndexChange,
	DropTableChange,
	ModifyFieldChange,
	RenameFieldChange,
	RenameTableChange,
} from './migrations/types.js'
import type { IterationQueryOptions, QueryOptions } from './query-options.js'
import type { AnySchema } from './schema.js'
import type { AnyUpdateOp } from './updates.js'

export type AggregateSpec = {
	where?: FilterGroup
	aggregates: ReadonlyArray<{
		fn: AggregateOpName
		field?: string
		alias: string
	}>
	groupBy: readonly string[]
	having?: FilterGroup
}

export abstract class OrmAdapter {
	readonly queryableOps: readonly FilterOpName[] = []
	readonly updateOps: readonly UpdateOpName[] = []
	readonly aggregateOps: readonly AggregateOpName[] = []
	readonly supportedFieldTypes: readonly FieldTypeName[] = []

	abstract readonly schemaConfigPipe: Pipe<any, any>

	connect?(): Promise<void>
	disconnect?(): Promise<void>
	findByPk?(schema: AnySchema, config: unknown, pk: unknown): Promise<Record<string, unknown> | null>
	createMany?(schema: AnySchema, config: unknown, data: Record<string, unknown>[]): Promise<Record<string, unknown>[]>
	updateByPk?(
		schema: AnySchema,
		config: unknown,
		pk: unknown,
		ops: AnyUpdateOp[],
	): Promise<Record<string, unknown> | null>
	deleteByPk?(schema: AnySchema, config: unknown, pk: unknown): Promise<Record<string, unknown> | null>
	raw?(schema: AnySchema, config: unknown, ...args: any[]): Promise<any>
	findMany?(
		schema: AnySchema,
		config: unknown,
		filter: FilterGroup,
		options?: QueryOptions,
	): Promise<Record<string, unknown>[]>
	count?(schema: AnySchema, config: unknown, filter: FilterGroup): Promise<number>
	iterateMany?(
		schema: AnySchema,
		config: unknown,
		filter: FilterGroup,
		options?: IterationQueryOptions,
	): AsyncGenerator<Record<string, unknown>, void, void>
	updateMany?(
		schema: AnySchema,
		config: unknown,
		filter: FilterGroup,
		data: Record<string, unknown>,
	): Promise<Record<string, unknown>[]>
	deleteMany?(schema: AnySchema, config: unknown, filter: FilterGroup): Promise<Record<string, unknown>[]>
	upsertOne?(
		schema: AnySchema,
		config: unknown,
		filter: FilterGroup,
		create: Record<string, unknown>,
		ops: AnyUpdateOp[],
	): Promise<Record<string, unknown>>
	aggregate?(schema: AnySchema, config: unknown, spec: AggregateSpec): Promise<Array<Record<string, unknown>>>
	session?<T>(fn: () => Promise<T>): Promise<T>

	loadMigrations?(): Promise<{ id: string; appliedAt: number }[]>
	recordMigration?(id: string, appliedAt: number): Promise<void>
	acquireMigrationLock?<T>(fn: () => Promise<T>): Promise<T>
	applyCreateTable?(change: CreateTableChange<any>): Promise<void>
	applyDropTable?(change: DropTableChange): Promise<void>
	applyAddField?(change: AddFieldChange<any>): Promise<void>
	applyDropField?(change: DropFieldChange): Promise<void>
	applyModifyField?(change: ModifyFieldChange<any>): Promise<void>
	applyRenameTable?(change: RenameTableChange): Promise<void>
	applyRenameField?(change: RenameFieldChange): Promise<void>
	applyAddIndex?(change: AddIndexChange): Promise<void>
	applyDropIndex?(change: DropIndexChange): Promise<void>
	applyAddForeignKey?(change: AddForeignKeyChange): Promise<void>
	applyDropForeignKey?(change: DropForeignKeyChange): Promise<void>
	introspect?(): Promise<DiscoveredSchema[]>

	protected onFatalError(err: unknown): never {
		const wrapped = err instanceof EquippedError ? err : new EquippedError('OrmAdapter fatal error', {}, err)
		Instance.crash(wrapped)
	}

	constructor() {
		const self = this as any
		if (typeof self.connect === 'function') {
			Instance.on('start', () => self.connect(), { class: this.constructor as ClassRef })
		}
		if (typeof self.disconnect === 'function') {
			Instance.on('close', () => self.disconnect(), { class: this.constructor as ClassRef })
		}
	}

	use(schema: AnySchema, config: unknown): OrmUse {
		const self = this as any
		const emptyIterator = async function* (): AsyncGenerator<Record<string, unknown>, void, void> {}
		const use: OrmUse = {
			findMany: (filter, opts) => self.findMany?.(schema, config, filter, opts) ?? Promise.resolve([]),
			iterateMany: (filter, opts) => self.iterateMany?.(schema, config, filter, opts) ?? emptyIterator(),
			findOne: async (filter) => {
				const rows = await use.findMany(filter, { limit: 1 })
				return rows[0] ?? null
			},
			count: (filter) =>
				self.count?.(schema, config, filter) ?? Promise.reject(new Error('count not implemented')),
			createOne: async (d) => {
				const rows = await use.createMany([d])
				return rows[0]
			},
			createMany: (d) => self.createMany?.(schema, config, d) ?? Promise.resolve([]),
			updateMany: (filter, d) => self.updateMany?.(schema, config, filter, d) ?? Promise.resolve([]),
			updateOne: async (filter, d) => {
				const match = await use.findOne(filter)
				if (!match) return null
				const pk = schema.pkField.name
				const pkFilter = FilterGroup.create().eq(pk, match[pk])
				const rows = await use.updateMany(pkFilter, d)
				return rows[0] ?? null
			},
			upsertOne: (filter, create, ops) =>
				self.upsertOne?.(schema, config, filter, create, ops) ??
				Promise.reject(new Error('upsertOne not implemented')),
			deleteOne: async (filter) => {
				const row = await use.findOne(filter)
				if (!row) return null
				const pk = schema.pkField.name
				if (self.deleteByPk) {
					await self.deleteByPk(schema, config, row[pk])
				} else if (self.deleteMany) {
					const pkFilter = FilterGroup.create().eq(pk, row[pk])
					await self.deleteMany(schema, config, pkFilter)
				}
				return row
			},
			deleteMany: (filter) => self.deleteMany?.(schema, config, filter) ?? Promise.resolve([]),
			raw: (...args: any[]) =>
				self.raw?.(schema, config, ...args) ?? Promise.reject(new Error('raw not implemented')),
			aggregate: (spec) =>
				self.aggregate?.(schema, config, spec) ?? Promise.reject(new Error('aggregate not implemented')),
			aggregateOps: self.aggregateOps ?? [],
		}
		return use
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, vi } = import.meta.vitest
	const { v } = await import('valleyed')

	describe('OrmAdapter', () => {
		test('subclass with connect/disconnect auto-registers Instance hooks', async () => {
			const { Instance: Inst } = await import('../instance/index.js')
			const onSpy = vi.spyOn(Inst, 'on').mockImplementation(() => {})

			class TestAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
				async connect() {}
				async disconnect() {}
			}

			new (TestAdapter as any)()

			expect(onSpy).toHaveBeenCalledWith(
				'start',
				expect.any(Function),
				expect.objectContaining({ class: TestAdapter }),
			)
			expect(onSpy).toHaveBeenCalledWith(
				'close',
				expect.any(Function),
				expect.objectContaining({ class: TestAdapter }),
			)

			onSpy.mockRestore()
		})

		test('subclass without connect/disconnect does not register hooks', async () => {
			const { Instance: Inst } = await import('../instance/index.js')
			const onSpy = vi.spyOn(Inst, 'on').mockImplementation(() => {})

			class MinimalAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
			}

			new (MinimalAdapter as any)()
			expect(onSpy).not.toHaveBeenCalled()

			onSpy.mockRestore()
		})

		test('capability declarations default to empty arrays', async () => {
			const { Instance: Inst } = await import('../instance/index.js')
			vi.spyOn(Inst, 'on').mockImplementation(() => {})

			class DefaultAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
			}
			const adapter = new (DefaultAdapter as any)() as DefaultAdapter
			expect(adapter.queryableOps).toEqual([])
			expect(adapter.updateOps).toEqual([])
			expect(adapter.aggregateOps).toEqual([])
			expect(adapter.supportedFieldTypes).toEqual([])

			vi.restoreAllMocks()
		})

		test('onFatalError wraps non-EquippedError and calls Instance.crash', async () => {
			const { Instance: Inst } = await import('../instance/index.js')
			vi.spyOn(Inst, 'on').mockImplementation(() => {})
			const crashSpy = vi.spyOn(Inst, 'crash').mockImplementation((() => {
				throw new Error('crash')
			}) as any)

			class FatalAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				triggerFatal() {
					this.onFatalError(new Error('something broke'))
				}
			}

			const adapter = new (FatalAdapter as any)() as FatalAdapter
			expect(() => adapter.triggerFatal()).toThrow('crash')
			expect(crashSpy).toHaveBeenCalled()

			vi.restoreAllMocks()
		})

		test('onFatalError passes through EquippedError directly', async () => {
			const { Instance: Inst } = await import('../instance/index.js')
			vi.spyOn(Inst, 'on').mockImplementation(() => {})
			let crashedWith: unknown
			vi.spyOn(Inst, 'crash').mockImplementation(((err: any) => {
				crashedWith = err
				throw err
			}) as any)

			class FatalAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				triggerFatal() {
					this.onFatalError(new EquippedError('equipped error', { detail: 'test' }))
				}
			}

			const adapter = new (FatalAdapter as any)() as FatalAdapter
			expect(() => adapter.triggerFatal()).toThrow()
			expect(crashedWith).toBeInstanceOf(EquippedError)
			expect((crashedWith as EquippedError).message).toBe('equipped error')

			vi.restoreAllMocks()
		})

		test('use() creates OrmUse bridge that delegates to flat methods', async () => {
			const { Instance: Inst } = await import('../instance/index.js')
			const { Schema } = await import('./schema.js')
			vi.spyOn(Inst, 'on').mockImplementation(() => {})

			class BridgeAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
				readonly queryableOps = ['eq'] as const

				async findMany(_s: AnySchema, _c: unknown, _f: any, _o?: any) {
					return [{ id: 'found' }]
				}
				async count(_s: AnySchema, _c: unknown, _f: any) {
					return 1
				}
				async *iterateMany(_s: AnySchema, _c: unknown, _f: any, _o?: any) {
					yield { id: 'iterated' }
				}
				async createMany(_s: AnySchema, _c: unknown, data: Record<string, unknown>[]) {
					return data
				}
			}

			const TestSchema = Schema.from('bridge_test')
				.pk('id', v.string(), () => 'x')
				.build()
			const adapter = new (BridgeAdapter as any)() as BridgeAdapter
			const ormUse = adapter.use(TestSchema, { table: 'bridge_test' })

			const rows = await ormUse.findMany(FilterGroup.create())
			expect(rows).toEqual([{ id: 'found' }])
			await expect(ormUse.count(FilterGroup.create())).resolves.toBe(1)

			const iterated: Record<string, unknown>[] = []
			for await (const row of ormUse.iterateMany(FilterGroup.create())) iterated.push(row)
			expect(iterated).toEqual([{ id: 'iterated' }])

			const created = await ormUse.createOne({ id: 'new' })
			expect(created).toEqual({ id: 'new' })

			vi.restoreAllMocks()
		})

		test('use() bridge delegates updateMany to flat method', async () => {
			const { Instance: Inst } = await import('../instance/index.js')
			const { Schema } = await import('./schema.js')
			vi.spyOn(Inst, 'on').mockImplementation(() => {})

			class UpdateAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string', 'number'] as const
				readonly updateOps = ['set'] as const

				async findMany(_s: AnySchema, _c: unknown, _f: any) {
					return [{ id: 'u1', name: 'old' }]
				}
				async updateMany(_s: AnySchema, _c: unknown, _f: any, data: Record<string, unknown>) {
					return [{ id: 'u1', ...data }]
				}
			}

			const TestSchema = Schema.from('upd_test')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			const adapter = new (UpdateAdapter as any)() as UpdateAdapter
			const ormUse = adapter.use(TestSchema, { table: 'upd_test' })

			const updated = await ormUse.updateOne(FilterGroup.create().eq('id', 'u1'), { name: 'new' })
			expect(updated).not.toBeNull()
			expect(updated!.name).toBe('new')

			vi.restoreAllMocks()
		})

		test('use().iterateMany does not fall back to findMany when adapter omits iterateMany', async () => {
			const { Instance: Inst } = await import('../instance/index.js')
			const { Schema } = await import('./schema.js')
			vi.spyOn(Inst, 'on').mockImplementation(() => {})

			let findManyCalls = 0
			class FindOnlyAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const
				async findMany() {
					findManyCalls += 1
					return [{ id: 'found' }]
				}
			}

			const TestSchema = Schema.from('iter_no_fallback')
				.pk('id', v.string(), () => 'x')
				.build()
			const adapter = new (FindOnlyAdapter as any)() as FindOnlyAdapter
			const rows: Record<string, unknown>[] = []
			for await (const row of adapter
				.use(TestSchema, { table: 'iter_no_fallback' })
				.iterateMany(FilterGroup.create()))
				rows.push(row)

			expect(rows).toEqual([])
			expect(findManyCalls).toBe(0)

			vi.restoreAllMocks()
		})

		test('use() bridge delegates deleteByPk via deleteOne', async () => {
			const { Instance: Inst } = await import('../instance/index.js')
			const { Schema } = await import('./schema.js')
			vi.spyOn(Inst, 'on').mockImplementation(() => {})

			let deletedPk: unknown = null
			class DeleteAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				readonly supportedFieldTypes = ['string'] as const

				async findMany(_s: AnySchema, _c: unknown, _f: any) {
					return [{ id: 'd1' }]
				}
				async deleteByPk(_s: AnySchema, _c: unknown, pk: unknown) {
					deletedPk = pk
					return { id: String(pk) }
				}
			}

			const TestSchema = Schema.from('del_test')
				.pk('id', v.string(), () => 'x')
				.build()
			const adapter = new (DeleteAdapter as any)() as DeleteAdapter
			const ormUse = adapter.use(TestSchema, { table: 'del_test' })

			const deleted = await ormUse.deleteOne(FilterGroup.create().eq('id', 'd1'))
			expect(deleted).toEqual({ id: 'd1' })
			expect(deletedPk).toBe('d1')

			vi.restoreAllMocks()
		})

		test('use() bridge delegates session to flat method', async () => {
			const { Instance: Inst } = await import('../instance/index.js')
			vi.spyOn(Inst, 'on').mockImplementation(() => {})

			let sessionRan = false
			class SessionAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				async session<T>(fn: () => Promise<T>): Promise<T> {
					sessionRan = true
					return fn()
				}
			}

			const adapter = new (SessionAdapter as any)() as SessionAdapter
			const result = await adapter.session!(async () => 42)
			expect(result).toBe(42)
			expect(sessionRan).toBe(true)

			vi.restoreAllMocks()
		})

		test('type-level: subclass method override enforces canonical signature', async () => {
			const { Instance: Inst } = await import('../instance/index.js')
			vi.spyOn(Inst, 'on').mockImplementation(() => {})

			class CorrectAdapter extends OrmAdapter {
				readonly schemaConfigPipe = v.object({ table: v.string() })
				async findByPk(_s: AnySchema, _c: unknown, _pk: unknown) {
					return null
				}
				async createMany(_s: AnySchema, _c: unknown, _d: Record<string, unknown>[]) {
					return []
				}
				async raw(_s: AnySchema, _c: unknown, ..._args: any[]) {
					return null
				}
			}

			const adapter = new (CorrectAdapter as any)() as CorrectAdapter
			expect(adapter.findByPk).toBeTypeOf('function')
			expect(adapter.createMany).toBeTypeOf('function')
			expect(adapter.raw).toBeTypeOf('function')

			vi.restoreAllMocks()
		})
	})
}
