import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { PipeError, v } from 'valleyed'

import { InMemoryAdapter } from '../../src/orm/adapters/in-memory/index.js'
import { OrmAdapter } from '../../src/orm/orm-adapter.js'
import { Repo } from '../../src/orm/repo/repo.js'
import { OrmNotFoundError, OrmValidationError } from '../../src/orm/errors/index.js'
import { Schema, type SchemaOutput } from '../../src/orm/schema.js'
import type { SchemaCreateInput } from '../../src/orm/schema-validations.js'

function buildRepo<A extends OrmAdapter>(adapter: A) {
	return Repo.from(adapter)
		.resolve((name) => ({ table: name }) as any)
		.build()
}

describe('schema declaration type contracts', () => {
	it('requires output when input and persisted types differ and infers persisted types from output', () => {
		const asNumber = v.string().pipe((value) => Number(value))
		const schema = Schema.from('contract_type_conversion')
			.pk('id', { input: asNumber, output: v.number(), generate: () => 7 })
			.field('count', { input: asNumber, output: v.number() })
			.build()

		expectTypeOf<SchemaCreateInput<typeof schema>>().toEqualTypeOf<{ id?: string; count: string }>()
		expectTypeOf<SchemaOutput<typeof schema>>().toEqualTypeOf<{ id: number; count: number }>()

		// @ts-expect-error output is mandatory when the input pipe changes types
		Schema.from('missing_pk_output').pk('id', { input: asNumber, generate: () => 7 })
		const fields = Schema.from('missing_field_output').pk('id', { input: v.string(), generate: () => 'id' })
		// @ts-expect-error output is mandatory when the input pipe changes types
		fields.field('count', { input: asNumber })
		// @ts-expect-error positional pipe declarations are not supported
		Schema.from('legacy_pk').pk('id', v.string(), () => 'id')
		// @ts-expect-error positional pipe declarations are not supported
		fields.field('legacy', v.string())
	})
})

describe('schema input/output contracts through Repo', () => {
	it('uses input pipes for caller values and output pipes for generated persisted values', async () => {
		let generatedId = 0
		const idGenerate = vi.fn(() => `generated-${++generatedId}`)
		const nameOnCreate = vi.fn(() => '  generated name  ')
		const schema = Schema.from('contract_single_create')
			.pk('id', { input: v.string(), generate: idGenerate })
			.field('name', {
				input: v.string().pipe((value) => value.trim()),
				output: v.string(),
				onCreate: nameOnCreate,
			})
			.build()
		const repo = buildRepo(InMemoryAdapter.create({}))

		const supplied = await repo.on(schema).one().create({ id: 'supplied', name: '  caller name  ' })
		expect(supplied).toEqual({ id: 'supplied', name: 'caller name' })
		expect(idGenerate).not.toHaveBeenCalled()
		expect(nameOnCreate).not.toHaveBeenCalled()

		const generated = await repo.on(schema).one().create({})
		expect(generated).toEqual({ id: 'generated-1', name: '  generated name  ' })
		expect(idGenerate).toHaveBeenCalledTimes(1)
		expect(nameOnCreate).toHaveBeenCalledTimes(1)

		const explicitlyUndefined = await repo.on(schema).one().create({ id: undefined, name: undefined })
		expect(explicitlyUndefined).toEqual({ id: 'generated-2', name: '  generated name  ' })
		expect(idGenerate).toHaveBeenCalledTimes(2)
		expect(nameOnCreate).toHaveBeenCalledTimes(2)
	})

	it('does not fall back to generators for invalid or null supplied values', async () => {
		const idGenerate = vi.fn(() => 'fallback-id')
		const nameOnCreate = vi.fn(() => 'fallback-name')
		const schema = Schema.from('contract_invalid_input')
			.pk('id', { input: v.string(), generate: idGenerate })
			.field('name', { input: v.string(), onCreate: nameOnCreate })
			.build()
		const repo = buildRepo(InMemoryAdapter.create({}))

		await expect(
			repo
				.on(schema)
				.one()
				.create({ id: null as any, name: 'valid' }),
		).rejects.toMatchObject({
			kind: 'validation',
		})
		await expect(
			repo
				.on(schema)
				.one()
				.create({ id: 'valid', name: null as any }),
		).rejects.toMatchObject({
			kind: 'validation',
		})
		expect(idGenerate).not.toHaveBeenCalled()
		expect(nameOnCreate).not.toHaveBeenCalled()

		const throwingId = vi.fn(() => {
			throw new Error('must not generate a supplied key')
		})
		const throwingDefault = vi.fn(() => {
			throw new Error('must not generate a supplied field')
		})
		const suppliedSchema = Schema.from('contract_throwing_generators')
			.pk('id', { input: v.string(), generate: throwingId })
			.field('name', { input: v.string(), onCreate: throwingDefault })
			.build()
		await expect(repo.on(suppliedSchema).one().create({ id: 'given', name: 'given' })).resolves.toEqual({
			id: 'given',
			name: 'given',
		})
		expect(throwingId).not.toHaveBeenCalled()
		expect(throwingDefault).not.toHaveBeenCalled()
	})

	it('generates missing fields once per row in bulk create and upsert create payloads', async () => {
		let nextId = 0
		const idGenerate = vi.fn(() => `id-${++nextId}`)
		const createdAt = vi.fn(() => 123)
		const schema = Schema.from('contract_bulk_upsert')
			.pk('id', { input: v.string(), generate: idGenerate })
			.field('email', { input: v.string() })
			.field('createdAt', { input: v.number(), onCreate: createdAt })
			.build()
		const repo = buildRepo(InMemoryAdapter.create({}))

		const rows = await repo
			.on(schema)
			.all()
			.create([
				{ email: 'first' },
				{ id: 'provided', email: 'second', createdAt: 456 },
				{ id: undefined, email: 'third', createdAt: undefined },
			])
		expect(rows.map(({ id, createdAt: time }) => [id, time])).toEqual([
			['id-1', 123],
			['provided', 456],
			['id-2', 123],
		])
		expect(idGenerate).toHaveBeenCalledTimes(2)
		expect(createdAt).toHaveBeenCalledTimes(2)

		const upserted = await repo
			.on(schema)
			.one()
			.where((q) => q.eq(schema.fields.email, 'upserted'))
			.upsert({ create: { email: 'upserted' } })
		expect(upserted).toEqual({ id: 'id-3', email: 'upserted', createdAt: 123 })
		expect(idGenerate).toHaveBeenCalledTimes(3)
		expect(createdAt).toHaveBeenCalledTimes(3)

		const suppliedUpsert = await repo
			.on(schema)
			.one()
			.where((q) => q.eq(schema.fields.email, 'supplied-upsert'))
			.upsert({ create: { id: 'upsert-id', email: 'supplied-upsert', createdAt: 789 } })
		expect(suppliedUpsert.id).toBe('upsert-id')
		expect(idGenerate).toHaveBeenCalledTimes(3)
		expect(createdAt).toHaveBeenCalledTimes(3)
	})

	it('validates onUpdate-generated persisted values with the output pipe', async () => {
		const schema = Schema.from('contract_bad_on_update')
			.pk('id', { input: v.string(), generate: () => 'row-1' })
			.field('count', { input: v.number(), output: v.number(), onUpdate: () => 'invalid' as any })
			.build()
		const repo = buildRepo(InMemoryAdapter.create({}))
		const created = await repo.on(schema).one().create({ count: 1 })
		await expect(repo.on(schema).one().id(created.id).update({})).rejects.toMatchObject({
			kind: 'output',
			failures: expect.arrayContaining([expect.objectContaining({ cause: expect.any(PipeError) })]),
		})
		expect(await repo.on(schema).one().id(created.id).find()).toEqual({ id: 'row-1', count: 1 })
	})

	it('validates generated persisted outputs before single, bulk, and upsert writes', async () => {
		const idGenerate = vi.fn(() => 42 as any)
		const defaultGenerate = vi.fn(() => 'not-a-number' as any)
		const schema = Schema.from('contract_bad_generated_output')
			.pk('id', { input: v.string(), output: v.string(), generate: idGenerate })
			.field('value', { input: v.number(), output: v.number(), onCreate: defaultGenerate })
			.build()
		const adapter = InMemoryAdapter.create({})
		const repo = buildRepo(adapter)
		const outputFailure = {
			kind: 'output',
			failures: expect.arrayContaining([expect.objectContaining({ cause: expect.any(PipeError) })]),
		}

		await expect(repo.on(schema).one().create({})).rejects.toMatchObject(outputFailure)
		await expect(repo.on(schema).all().create([{}, {}])).rejects.toMatchObject(outputFailure)
		await expect(
			repo
				.on(schema)
				.one()
				.where((q) => q.eq(schema.fields.id, 'no-match'))
				.upsert({ create: {} }),
		).rejects.toMatchObject(outputFailure)
		expect(idGenerate).toHaveBeenCalledTimes(4)
		expect(defaultGenerate).toHaveBeenCalledTimes(4)
		expect(await repo.on(schema).all().find()).toEqual([])
	})
})

class ResponseAdapter extends OrmAdapter {
	readonly schemaConfigPipe = v.object({ table: v.string() })
	readonly supportedFieldTypes = ['string', 'number', 'object'] as const
	readResponse: unknown = []
	createResponse: unknown = []
	updateResponse: unknown = []
	deleteResponse: unknown = []
	deleteByPkResponse: unknown = null
	deleteByPkCalls = 0
	updateManyCalls = 0

	async findMany() {
		return this.readResponse as Record<string, unknown>[]
	}

	async createMany() {
		return this.createResponse as Record<string, unknown>[]
	}

	async updateMany() {
		this.updateManyCalls++
		return this.updateResponse as Record<string, unknown>[]
	}

	async deleteMany() {
		return this.deleteResponse as Record<string, unknown>[]
	}

	async deleteByPk() {
		this.deleteByPkCalls++
		return this.deleteByPkResponse as Record<string, unknown> | null
	}
}

function responseSchema() {
	return Schema.from('contract_response')
		.pk('id', { input: v.string(), generate: () => 'unused' })
		.field('name', { input: v.string() })
		.field('age', { input: v.number() })
		.field('settings', { input: v.object({ theme: v.string() }) })
		.build()
}

describe('ordinary Repo output validation', () => {
	it('validates only selected persisted fields and strips top-level and nested JSON extras', async () => {
		const adapter = new ResponseAdapter()
		adapter.readResponse = [
			{ id: 'row-1', name: 'Ada', age: 'not selected', settings: { theme: 'dark', extra: true }, extra: true },
		]
		const repo = buildRepo(adapter)
		const result = await repo.on(responseSchema()).one().select(['settings']).find()
		expect(result).toEqual({ settings: { theme: 'dark' } })
	})

	it('validates the complete nested shape of selected JSON fields', async () => {
		const adapter = new ResponseAdapter()
		adapter.readResponse = [{ id: 'row-1', name: 'Ada', age: 37, settings: { theme: 42, extra: true } }]
		const repo = buildRepo(adapter)
		const schema = responseSchema()
		let error: OrmValidationError | undefined
		try {
			await repo.on(schema).one().select(['settings']).find()
		} catch (caught) {
			error = caught as OrmValidationError
		}
		expect(error?.kind).toBe('output')
		expect(error?.failures[0].cause).toBeInstanceOf(PipeError)
		expect((error?.failures[0].cause as PipeError).messages[0].path).toContain('settings')
	})

	it('rejects malformed result containers and any invalid row with retained PipeError diagnostics', async () => {
		const adapter = new ResponseAdapter()
		const repo = buildRepo(adapter)
		const schema = responseSchema()

		adapter.readResponse = { id: 'not-an-array' }
		await expect(repo.on(schema).all().find()).rejects.toMatchObject({
			kind: 'output',
			failures: [expect.objectContaining({ cause: expect.any(PipeError) })],
		})

		adapter.readResponse = [
			{ id: 'ok', name: 'Ada', age: 37, settings: { theme: 'dark' } },
			{ id: 'bad', name: 'Grace', age: 'invalid', settings: { theme: 'light' } },
		]
		let error: OrmValidationError | undefined
		try {
			await repo.on(schema).all().find()
		} catch (caught) {
			error = caught as OrmValidationError
		}
		expect(error).toBeInstanceOf(OrmValidationError)
		expect(error?.kind).toBe('output')
		expect(error?.failures[0].cause).toBeInstanceOf(PipeError)
		expect((error?.failures[0].cause as PipeError).messages[0].path).toContain('1')
	})

	it('preserves null/empty reads, rejects non-null malformed single results, and keeps required not-found behavior', async () => {
		const adapter = new ResponseAdapter()
		const repo = buildRepo(adapter)
		const schema = responseSchema()
		adapter.readResponse = []
		expect(await repo.on(schema).one().find()).toBeNull()
		await expect(repo.on(schema).one().required().find()).rejects.toBeInstanceOf(OrmNotFoundError)
		expect(await repo.on(schema).all().find()).toEqual([])

		adapter.readResponse = [null]
		await expect(repo.on(schema).one().find()).rejects.toMatchObject({ kind: 'output' })
		adapter.readResponse = [undefined]
		await expect(repo.on(schema).one().find()).rejects.toMatchObject({ kind: 'output' })
	})

	it('enforces single and bulk create response cardinality', async () => {
		const adapter = new ResponseAdapter()
		const repo = buildRepo(adapter)
		const schema = responseSchema()
		adapter.createResponse = []
		await expect(
			repo
				.on(schema)
				.one()
				.create({ name: 'Ada', age: 37, settings: { theme: 'dark' } }),
		).rejects.toMatchObject({
			kind: 'output',
		})

		adapter.createResponse = [
			{ id: 'one', name: 'Ada', age: 37, settings: { theme: 'dark' } },
			{ id: 'two', name: 'Grace', age: 85, settings: { theme: 'light' } },
		]
		await expect(
			repo
				.on(schema)
				.one()
				.create({ name: 'Ada', age: 37, settings: { theme: 'dark' } }),
		).rejects.toMatchObject({
			kind: 'output',
		})

		adapter.createResponse = [{ id: 'one', name: 'Ada', age: 37, settings: { theme: 'dark' } }]
		await expect(
			repo
				.on(schema)
				.all()
				.create([
					{ name: 'Ada', age: 37, settings: { theme: 'dark' } },
					{ name: 'Grace', age: 85, settings: { theme: 'light' } },
				]),
		).rejects.toMatchObject({ kind: 'output' })
	})

	it('validates internal lookup keys before mutation helpers use them', async () => {
		const adapter = new ResponseAdapter()
		adapter.readResponse = [{ id: 42, name: 'Ada', age: 37, settings: { theme: 'dark' } }]
		adapter.deleteByPkResponse = { id: 'row-1' }
		const repo = buildRepo(adapter)
		const schema = responseSchema()

		await expect(repo.on(schema).one().delete()).rejects.toMatchObject({ kind: 'output' })
		expect(adapter.deleteByPkCalls).toBe(0)

		await expect(repo.on(schema).one().id('row-1').update({ name: 'updated' })).rejects.toMatchObject({
			kind: 'output',
		})
		expect(adapter.updateManyCalls).toBe(0)
	})

	it('validates required internal delete responses before discarding them', async () => {
		const adapter = new ResponseAdapter()
		adapter.readResponse = [{ id: 'row-1' }]
		adapter.deleteByPkResponse = { id: 'row-1', name: 'Ada', age: 'invalid', settings: { theme: 'dark' } }
		const repo = buildRepo(adapter)
		await expect(repo.on(responseSchema()).one().id('row-1').delete()).rejects.toMatchObject({
			kind: 'output',
		})
	})

	it('validates mutation projections without certifying unreturned response fields', async () => {
		const adapter = new ResponseAdapter()
		adapter.readResponse = [{ id: 'row-1' }]
		adapter.updateResponse = [{ id: 'row-1', name: 'updated', age: 'malformed', settings: { theme: 'dark' } }]
		const repo = buildRepo(adapter)
		const result = await repo.on(responseSchema()).one().id('row-1').select(['name']).update({ name: 'updated' })
		expect(result).toEqual({ name: 'updated' })
	})
})
