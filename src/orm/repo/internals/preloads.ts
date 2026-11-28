import { EquippedError } from '../../../errors/index.js'
import type { OrmUse } from '../../adapters/base.js'
import { FilterGroup } from '../../filter.js'
import type { AnyPreloadDef, AnyRelDef, NestedPreloadDef } from '../../relations.js'
import { ManyRelation, OneRelation } from '../../relations.js'
import type { AnySchema } from '../../schema.js'

const MAX_PRELOAD_DEPTH = 5

type ResolvedPreloadDef = {
	def: AnyRelDef
	preloads: ResolvedPreloadDef[]
}

function isNestedPreloadDef(def: AnyPreloadDef): def is NestedPreloadDef {
	return typeof def === 'object' && def != null && 'def' in def
}

function relationStep(def: AnyRelDef) {
	return `${def.source.name}.${def.name}->${def.target.name}`
}

function uniqueDefinedValues(entities: readonly Record<string, unknown>[], key: string) {
	return [...new Set(entities.map((entity) => entity[key]).filter((value) => value != null))]
}

export function requiredPreloadFields(schema: AnySchema, defs: readonly AnyPreloadDef[]): string[] {
	const fields = new Set<string>()
	for (const entry of defs) {
		const def = isNestedPreloadDef(entry) ? entry.def : entry
		if (def.source !== schema) continue
		fields.add(def instanceof OneRelation && def.fkOwner === 'source' ? def.foreignKey.name : def.references.name)
	}
	return [...fields]
}

export function preloadRelationNames(defs: readonly AnyPreloadDef[]): string[] {
	return defs.map((entry) => ('def' in entry ? entry.def : entry).name)
}

type ValidateRelatedRows = (schema: AnySchema, rows: unknown, operation: string) => Promise<Record<string, unknown>[]>

function attachOneRelation(
	entities: readonly Record<string, unknown>[],
	name: string,
	lookupKey: string,
	lookup: ReadonlyMap<unknown, Record<string, unknown>>,
) {
	return entities.map((entity) => ({ ...entity, [name]: lookup.get(entity[lookupKey]) ?? null }))
}

function attachManyRelation(
	entities: readonly Record<string, unknown>[],
	name: string,
	lookupKey: string,
	lookup: ReadonlyMap<unknown, Record<string, unknown>[]>,
) {
	return entities.map((entity) => ({ ...entity, [name]: lookup.get(entity[lookupKey]) ?? [] }))
}

function normalizePreloads(defs: readonly AnyPreloadDef[]): ResolvedPreloadDef[] {
	return defs.map((def) => {
		if (def instanceof ManyRelation || def instanceof OneRelation) {
			return { def, preloads: [] }
		}

		if (!isNestedPreloadDef(def) || !(def.def instanceof ManyRelation || def.def instanceof OneRelation)) {
			throw new Error('Invalid preload definition: nested preloads must include a relation definition in `def`')
		}

		return {
			def: def.def,
			preloads: normalizePreloads(def.preloads ?? []),
		}
	})
}

export async function resolvePreloads<T extends Record<string, unknown>>(
	entities: T[],
	defs: readonly AnyPreloadDef[],
	getUse: (s: AnySchema) => OrmUse,
	validateRelatedRows: ValidateRelatedRows,
	operation: string,
) {
	return resolvePreloadNodes(
		entities,
		normalizePreloads(defs),
		getUse,
		validateRelatedRows,
		operation,
		1,
		[],
	) as unknown as T[]
}

async function resolvePreloadNodes(
	entities: Record<string, unknown>[],
	defs: readonly ResolvedPreloadDef[],
	getUse: (s: AnySchema) => OrmUse,
	validateRelatedRows: ValidateRelatedRows,
	operation: string,
	depth: number,
	path: readonly string[],
) {
	for (const def of defs) {
		entities = await resolvePreload(entities, def, getUse, validateRelatedRows, operation, depth, path)
	}
	return entities
}

async function resolvePreload(
	entities: Record<string, unknown>[],
	node: ResolvedPreloadDef,
	getUse: (s: AnySchema) => OrmUse,
	validateRelatedRows: ValidateRelatedRows,
	operation: string,
	depth: number,
	path: readonly string[],
): Promise<Record<string, unknown>[]> {
	if (depth > MAX_PRELOAD_DEPTH) {
		throw new EquippedError(`Preload depth exceeded max depth ${MAX_PRELOAD_DEPTH}`, {
			operation: 'resolvePreload',
			depth,
			maxDepth: MAX_PRELOAD_DEPTH,
		})
	}

	const { def } = node
	const { target, name } = def
	const step = relationStep(def)
	if (path.includes(step)) {
		throw new EquippedError(`Preload cycle detected: ${[...path, step].join(' -> ')}`, {
			operation: 'resolvePreload',
			path,
			step,
		})
	}
	const nextPath = [...path, step]

	if (def instanceof OneRelation) {
		if (def.fkOwner === 'source') {
			const refCol = def.references.name
			const fkValues = uniqueDefinedValues(entities, def.foreignKey.name)
			if (fkValues.length === 0) return entities.map((e) => ({ ...e, [name]: null }))

			const rawRelated = await getUse(target).findMany(FilterGroup.create().in(refCol, fkValues))
			let related = await validateRelatedRows(target, rawRelated, operation)
			if (node.preloads.length > 0 && related.length > 0) {
				related = await resolvePreloadNodes(
					related,
					node.preloads,
					getUse,
					validateRelatedRows,
					operation,
					depth + 1,
					nextPath,
				)
			}
			const lookup = new Map(related.map((r) => [r[refCol], r]))
			return attachOneRelation(entities, name, def.foreignKey.name, lookup)
		}

		const refCol = def.references.name
		const refValues = uniqueDefinedValues(entities, refCol)
		if (refValues.length === 0) return entities.map((e) => ({ ...e, [name]: null }))

		const rawRelated = await getUse(target).findMany(FilterGroup.create().in(def.foreignKey, refValues))
		let related = await validateRelatedRows(target, rawRelated, operation)
		if (node.preloads.length > 0 && related.length > 0) {
			related = await resolvePreloadNodes(
				related,
				node.preloads,
				getUse,
				validateRelatedRows,
				operation,
				depth + 1,
				nextPath,
			)
		}
		const lookup = new Map(related.map((r) => [r[def.foreignKey.name], r]))
		return attachOneRelation(entities, name, refCol, lookup)
	}

	if (def instanceof ManyRelation) {
		const refCol = def.references.name
		const refValues = uniqueDefinedValues(entities, refCol)
		if (refValues.length === 0) return entities.map((e) => ({ ...e, [name]: [] }))

		const rawRelated = await getUse(target).findMany(FilterGroup.create().in(def.foreignKey, refValues))
		let related = await validateRelatedRows(target, rawRelated, operation)
		if (node.preloads.length > 0 && related.length > 0) {
			related = await resolvePreloadNodes(
				related,
				node.preloads,
				getUse,
				validateRelatedRows,
				operation,
				depth + 1,
				nextPath,
			)
		}

		const grouped = new Map<unknown, Record<string, unknown>[]>()
		for (const r of related) {
			const fk = r[def.foreignKey.name]
			if (!grouped.has(fk)) grouped.set(fk, [])
			grouped.get(fk)!.push(r)
		}
		return attachManyRelation(entities, name, refCol, grouped)
	}

	throw new Error(
		`Unknown relation kind: ${String(Reflect.get(def as object, 'kind'))}; expected OneRelation or ManyRelation`,
	)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { v } = await import('valleyed')
	const { InMemoryAdapter } = await import('../../adapters/in-memory/index.js')
	const { OrmValidationError } = await import('../../errors/index.js')
	const { Relations } = await import('../../relations.js')
	const { Repo } = await import('../repo.js')
	const { Schema } = await import('../../schema.js')

	describe('repo preload resolution', () => {
		let userCounter = 0
		let postCounter = 0
		let profileCounter = 0
		let orgCounter = 0
		let aCounter = 0
		let bCounter = 0
		let cCounter = 0
		let dCounter = 0
		let eCounter = 0
		let fCounter = 0
		let gCounter = 0

		const UserSchema = Schema.from('users')
			.pk('id', { input: v.string(), generate: () => `u${++userCounter}` })
			.field('email', { input: v.string() })
			.field('name', { input: v.string() })
			.field('orgId', { input: v.optional(v.string()), onCreate: () => undefined })
			.build()

		const PostSchema = Schema.from('posts')
			.pk('id', { input: v.string(), generate: () => `p${++postCounter}` })
			.field('title', { input: v.string() })
			.field('userId', { input: v.string() })
			.build()

		const ProfileSchema = Schema.from('profiles')
			.pk('id', { input: v.string(), generate: () => `pr${++profileCounter}` })
			.field('bio', { input: v.string() })
			.field('userId', { input: v.string() })
			.build()

		const OrgSchema = Schema.from('orgs')
			.pk('id', { input: v.string(), generate: () => `o${++orgCounter}` })
			.field('name', { input: v.string() })
			.build()

		const ASchema = Schema.from('as')
			.pk('id', { input: v.string(), generate: () => `a${++aCounter}` })
			.build()
		const BSchema = Schema.from('bs')
			.pk('id', { input: v.string(), generate: () => `b${++bCounter}` })
			.field('aId', { input: v.string() })
			.build()
		const CSchema = Schema.from('cs')
			.pk('id', { input: v.string(), generate: () => `c${++cCounter}` })
			.field('bId', { input: v.string() })
			.build()
		const DSchema = Schema.from('ds')
			.pk('id', { input: v.string(), generate: () => `d${++dCounter}` })
			.field('cId', { input: v.string() })
			.build()
		const ESchema = Schema.from('es')
			.pk('id', { input: v.string(), generate: () => `e${++eCounter}` })
			.field('dId', { input: v.string() })
			.build()
		const FSchema = Schema.from('fs')
			.pk('id', { input: v.string(), generate: () => `f${++fCounter}` })
			.field('eId', { input: v.string() })
			.build()
		const GSchema = Schema.from('gs')
			.pk('id', { input: v.string(), generate: () => `g${++gCounter}` })
			.field('fId', { input: v.string() })
			.build()

		const UserRels = Relations.from(UserSchema)
			.hasMany('posts', PostSchema.fields.userId)
			.hasOne('profile', ProfileSchema.fields.userId)
			.belongsTo('org', UserSchema.fields.orgId, OrgSchema)
			.build()

		const PostRels = Relations.from(PostSchema).belongsTo('author', PostSchema.fields.userId, UserSchema).build()

		const ARels = Relations.from(ASchema).hasMany('bs', BSchema.fields.aId).build()
		const BRels = Relations.from(BSchema).hasMany('cs', CSchema.fields.bId).build()
		const CRels = Relations.from(CSchema).hasMany('ds', DSchema.fields.cId).build()
		const DRels = Relations.from(DSchema).hasMany('es', ESchema.fields.dId).build()
		const ERels = Relations.from(ESchema).hasMany('fs', FSchema.fields.eId).build()
		const FRels = Relations.from(FSchema).hasMany('gs', GSchema.fields.fId).build()

		function makeRepo() {
			const adapter = InMemoryAdapter.create({})
			return Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()
		}

		async function expectPreloadQueryShapeError(read: Promise<unknown>, cause: RegExp) {
			try {
				await read
				expect.unreachable('preload query-shape validation should have failed')
			} catch (error) {
				expect(error).toBeInstanceOf(OrmValidationError)
				const err = error as InstanceType<typeof OrmValidationError>
				expect(err.kind).toBe('query-shape')
				expect(err.failures.some((failure) => cause.test(String(failure.cause)))).toBe(true)
			}
		}

		test('hasMany preload resolves related entities', async () => {
			const Repo = makeRepo()
			const user = await Repo.on(UserSchema).one().create({ email: 'u@test.com', name: 'User' })
			await Repo.on(PostSchema).one().create({ title: 'Post 1', userId: user.id })
			await Repo.on(PostSchema).one().create({ title: 'Post 2', userId: user.id })

			const users = await Repo.on(UserSchema).all().preload([UserRels.posts]).find()
			expect(users[0].posts).toHaveLength(2)
		})

		test('preload queries resolve each related schema logical name through the shared pipeline', async () => {
			const adapter = InMemoryAdapter.create({})
			const resolvedNames: string[] = []
			const repo = Repo.from(adapter)
				.resolve((name) => {
					resolvedNames.push(name)
					return { table: `mapped_${name}` }
				})
				.build()
			const user = await repo.on(UserSchema).one().create({ email: 'mapped@test.com', name: 'Mapped' })
			await repo.on(PostSchema).one().create({ title: 'Mapped post', userId: user.id })
			resolvedNames.length = 0

			const users = await repo.on(UserSchema).all().preload([UserRels.posts]).find()

			expect(users[0].posts).toHaveLength(1)
			expect(resolvedNames).toEqual(['users', 'posts'])
		})

		test('hasOne and belongsTo preloads resolve null and non-null branches', async () => {
			const Repo = makeRepo()
			const user = await Repo.on(UserSchema).one().create({ email: 'x@test.com', name: 'X' })
			await Repo.on(ProfileSchema).one().create({ bio: 'Hello', userId: user.id })

			const users = await Repo.on(UserSchema).all().preload([UserRels.profile]).find()
			expect(users[0].profile?.bio).toBe('Hello')

			const usersWithoutOrg = await Repo.on(UserSchema).all().preload([UserRels.org]).find()
			expect(usersWithoutOrg[0].org).toBeNull()
		})

		test('nested preload resolves recursively', async () => {
			const Repo = makeRepo()
			const user = await Repo.on(UserSchema).one().create({ email: 'nested@test.com', name: 'Nested User' })
			await Repo.on(ProfileSchema).one().create({ bio: 'Hello nested', userId: user.id })
			await Repo.on(PostSchema).one().create({ title: 'Nested Post', userId: user.id })

			const users = await Repo.on(UserSchema)
				.all()
				.preload([
					{
						def: UserRels.posts,
						preloads: [{ def: PostRels.author, preloads: [UserRels.profile] }],
					},
				])
				.find()

			const author = users[0].posts[0].author
			const profile = author?.profile
			expect(author?.id).toBe(user.id)
			expect(profile?.bio).toBe('Hello nested')
		})

		test('cycle detection throws descriptive error', async () => {
			const Repo = makeRepo()
			const user = await Repo.on(UserSchema).one().create({ email: 'cycle@test.com', name: 'Cycle User' })
			await Repo.on(PostSchema).one().create({ title: 'Cycle Post', userId: user.id })

			await expectPreloadQueryShapeError(
				Repo.on(UserSchema)
					.all()
					.preload([
						{
							def: UserRels.posts,
							preloads: [{ def: PostRels.author, preloads: [UserRels.posts] }],
						},
					])
					.find(),
				/Preload cycle detected/,
			)
		})

		test('depth limit throws when chain exceeds max depth', async () => {
			const Repo = makeRepo()
			const a = await Repo.on(ASchema).one().create({})
			const b = await Repo.on(BSchema).one().create({ aId: a.id })
			const c = await Repo.on(CSchema).one().create({ bId: b.id })
			const d = await Repo.on(DSchema).one().create({ cId: c.id })
			const e = await Repo.on(ESchema).one().create({ dId: d.id })
			const f = await Repo.on(FSchema).one().create({ eId: e.id })
			await Repo.on(GSchema).one().create({ fId: f.id })

			await expectPreloadQueryShapeError(
				Repo.on(ASchema)
					.all()
					.preload([
						{
							def: ARels.bs,
							preloads: [
								{
									def: BRels.cs,
									preloads: [
										{
											def: CRels.ds,
											preloads: [
												{
													def: DRels.es,
													preloads: [
														{
															def: ERels.fs,
															preloads: [FRels.gs],
														},
													],
												},
											],
										},
									],
								},
							],
						},
					])
					.find(),
				/Preload depth exceeded/,
			)
		})

		test('invalid nested preload definition throws a validation error', async () => {
			const Repo = makeRepo()
			await Repo.on(UserSchema).one().create({ email: 'u@test.com', name: 'User' })

			await expectPreloadQueryShapeError(
				Repo.on(UserSchema)
					.all()
					.preload([{ def: {} as any }])
					.find(),
				/Invalid preload definition/,
			)
		})

		test('findOne with preloads resolves relations', async () => {
			const Repo = makeRepo()
			const user = await Repo.on(UserSchema).one().create({ email: 'u@test.com', name: 'User' })
			await Repo.on(PostSchema).one().create({ title: 'Post', userId: user.id })

			const found = await Repo.on(UserSchema).one().id(user.id).preload([UserRels.posts]).find()
			expect(found?.posts).toHaveLength(1)
		})

		test('N+1 avoidance: N parents + children loaded in 2 queries, not N+1', async () => {
			const { vi } = await import('vitest')
			const adapter = InMemoryAdapter.create({})
			let queryCount = 0
			const origUse = adapter.use.bind(adapter)
			;(adapter as any).use = vi.fn((schema: any, config: any) => {
				const use = origUse(schema, config)
				return {
					...use,
					findMany: async (...args: any[]) => {
						queryCount++
						return use.findMany(...(args as [any, any]))
					},
				}
			})

			const repo = Repo.from(adapter)
				.resolve((name) => ({ table: name }))
				.build()

			const u1 = await repo.on(UserSchema).one().create({ email: 'a@test.com', name: 'A' })
			const u2 = await repo.on(UserSchema).one().create({ email: 'b@test.com', name: 'B' })
			const u3 = await repo.on(UserSchema).one().create({ email: 'c@test.com', name: 'C' })
			await repo.on(PostSchema).one().create({ title: 'P1', userId: u1.id })
			await repo.on(PostSchema).one().create({ title: 'P2', userId: u1.id })
			await repo.on(PostSchema).one().create({ title: 'P3', userId: u2.id })
			await repo.on(PostSchema).one().create({ title: 'P4', userId: u3.id })

			queryCount = 0
			const users = await repo.on(UserSchema).all().preload([UserRels.posts]).find()

			expect(users).toHaveLength(3)
			expect(users.find((u) => u.id === u1.id)!.posts).toHaveLength(2)
			expect(users.find((u) => u.id === u2.id)!.posts).toHaveLength(1)
			expect(users.find((u) => u.id === u3.id)!.posts).toHaveLength(1)
			expect(queryCount).toBe(2)
		})
	})
}
