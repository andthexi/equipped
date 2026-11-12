import type { AnyField, Field } from './fields.js'
import type { AnySchema, SchemaOutput } from './schema.js'

type SchemaPkValueType<S extends AnySchema> = NonNullable<S['pkField']['__valueType']>
type FkPkMatch<S extends AnySchema, FK extends AnyField> =
	NonNullable<FK['__valueType']> extends SchemaPkValueType<S> ? FK : never

export class ManyRelation<
	N extends string = string,
	TgtOutput extends Record<string, any> = Record<string, any>,
	FK extends AnyField = AnyField,
> {
	declare readonly _output: TgtOutput
	constructor(
		readonly name: N,
		readonly source: AnySchema,
		readonly target: AnySchema,
		readonly foreignKey: FK,
		readonly references: AnyField,
	) {}
}

export class OneRelation<
	N extends string = string,
	TgtOutput extends Record<string, any> = Record<string, any>,
	FK extends AnyField = AnyField,
> {
	declare readonly _output: TgtOutput
	constructor(
		readonly name: N,
		readonly source: AnySchema,
		readonly target: AnySchema,
		readonly foreignKey: FK,
		readonly fkOwner: 'source' | 'target',
		readonly references: AnyField,
	) {}
}

export type AnyRelDef = ManyRelation<string, Record<string, any>, any> | OneRelation<string, Record<string, any>, any>

export type ResolveRelDef<D extends AnyRelDef> =
	D extends OneRelation<any, infer TOut, any>
		? TOut | null
		: D extends ManyRelation<any, infer TOut, any>
			? TOut[]
			: never

export interface NestedPreloadDef<D extends AnyRelDef = AnyRelDef> {
	def: D
	preloads?: readonly AnyPreloadDef[]
}

export type AnyPreloadDef = AnyRelDef | NestedPreloadDef

type Shift<T extends readonly unknown[]> = T extends readonly [unknown, ...infer R] ? R : []
type NodeName<N extends AnyPreloadDef> = N extends AnyRelDef
	? N['name']
	: N extends NestedPreloadDef<infer D extends AnyRelDef>
		? D['name']
		: never

type ResolveRelDefWithNested<
	D extends AnyRelDef,
	P extends readonly AnyPreloadDef[],
	Depth extends readonly unknown[],
> = Depth extends []
	? ResolveRelDef<D>
	: D extends OneRelation<any, infer TOut, any>
		? (TOut & PreloadedMap<P, Shift<Depth>>) | null
		: D extends ManyRelation<any, infer TOut, any>
			? (TOut & PreloadedMap<P, Shift<Depth>>)[]
			: never

type NodeValue<N extends AnyPreloadDef, Depth extends readonly unknown[]> =
	N extends OneRelation<any, infer TOut, any>
		? TOut | null
		: N extends ManyRelation<any, infer TOut, any>
			? TOut[]
			: N extends { def: infer D extends AnyRelDef; preloads?: infer P extends readonly AnyPreloadDef[] }
				? ResolveRelDefWithNested<D, P, Depth>
				: never

export type PreloadedMap<
	P extends readonly AnyPreloadDef[],
	Depth extends readonly unknown[] = [1, 2, 3, 4, 5],
> = Depth extends []
	? Record<never, never>
	: {
			[N in P[number] as NodeName<N>]: NodeValue<N, Depth>
		}

class RelationsBuilder<S extends AnySchema, R extends Record<string, AnyRelDef> = Record<never, never>> {
	readonly #source: S
	readonly #defs: Record<string, AnyRelDef>

	constructor(source: S, defs?: Record<string, AnyRelDef>) {
		this.#source = source
		this.#defs = defs ?? {}
	}

	hasMany<K extends string, T extends AnySchema, FK extends Field<any, any, T>>(
		name: K extends keyof R ? never : K,
		fk: FkPkMatch<S, FK>,
	): RelationsBuilder<
		S,
		{
			[Key in keyof R | K]: Key extends K
				? ManyRelation<K, SchemaOutput<T>, FK>
				: Key extends keyof R
					? R[Key]
					: never
		}
	> {
		const target = (fk as any).__schema as AnySchema
		const nextDefs = {
			...this.#defs,
			[name]: new ManyRelation(name, this.#source, target, fk as any, this.#source.pkField),
		}
		return new RelationsBuilder(this.#source, nextDefs) as any
	}

	hasOne<K extends string, T extends AnySchema, FK extends Field<any, any, T>>(
		name: K extends keyof R ? never : K,
		fk: FkPkMatch<S, FK>,
	): RelationsBuilder<
		S,
		{
			[Key in keyof R | K]: Key extends K
				? OneRelation<K, SchemaOutput<T>, FK>
				: Key extends keyof R
					? R[Key]
					: never
		}
	> {
		const target = (fk as any).__schema as AnySchema
		const nextDefs = {
			...this.#defs,
			[name]: new OneRelation(name, this.#source, target, fk as any, 'target', this.#source.pkField),
		}
		return new RelationsBuilder(this.#source, nextDefs) as any
	}

	belongsTo<K extends string, T extends AnySchema, FK extends Field<any, any, S>>(
		name: K extends keyof R ? never : K,
		fk: FkPkMatch<T, FK>,
		target: T,
		references?: Field<NonNullable<FK['__valueType']>, any, T>,
	): RelationsBuilder<
		S,
		{
			[Key in keyof R | K]: Key extends K
				? OneRelation<K, SchemaOutput<T>, FK>
				: Key extends keyof R
					? R[Key]
					: never
		}
	> {
		const ref = references ?? target.pkField
		const nextDefs = {
			...this.#defs,
			[name]: new OneRelation(name, this.#source, target, fk as any, 'source', ref as any),
		}
		return new RelationsBuilder(this.#source, nextDefs) as any
	}

	build(): R {
		return this.#defs as R
	}
}

export class Relations {
	static from<S extends AnySchema>(source: S) {
		return new RelationsBuilder(source)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf } = import.meta.vitest
	const { v } = await import('valleyed')
	const { Schema } = await import('./schema.js')

	describe('Relations.from()', () => {
		const UserSchema = Schema.from('users')
			.pk('id', v.string(), () => 'user-id')
			.field('name', v.string())
			.field('orgId', v.string())
			.build()

		const PostSchema = Schema.from('posts')
			.pk('id', v.string(), () => 'post-id')
			.field('title', v.string())
			.field('userId', v.string())
			.build()

		const OrgSchema = Schema.from('orgs')
			.pk('id', v.string(), () => 'org-id')
			.field('name', v.string())
			.build()

		const ProfileSchema = Schema.from('profiles')
			.pk('id', v.string(), () => 'profile-id')
			.field('bio', v.string())
			.field('userId', v.string())
			.build()

		test('builds relations with hasMany, belongsTo, hasOne', () => {
			const rels = Relations.from(UserSchema)
				.hasMany('posts', PostSchema.fields.userId)
				.belongsTo('org', UserSchema.fields.orgId, OrgSchema)
				.hasOne('profile', ProfileSchema.fields.userId)
				.build()

			expect(rels.posts).toBeInstanceOf(ManyRelation)
			expect(rels.org).toBeInstanceOf(OneRelation)
			expect(rels.profile).toBeInstanceOf(OneRelation)
		})

		test('source references use outer-scope const (no src param)', () => {
			const rels = Relations.from(UserSchema).belongsTo('org', UserSchema.fields.orgId, OrgSchema).build()

			expect(rels.org.foreignKey).toBe(UserSchema.fields.orgId)
			expect(rels.org.target).toBe(OrgSchema)
		})

		test('clone-on-step: .hasMany() returns a new builder', () => {
			const base = Relations.from(UserSchema)
			const a = base.hasMany('posts', PostSchema.fields.userId)
			expect(a).not.toBe(base)
		})

		test('clone-on-step: .hasOne() returns a new builder', () => {
			const base = Relations.from(UserSchema)
			const a = base.hasOne('profile', ProfileSchema.fields.userId)
			expect(a).not.toBe(base)
		})

		test('clone-on-step: .belongsTo() returns a new builder', () => {
			const base = Relations.from(UserSchema)
			const a = base.belongsTo('org', UserSchema.fields.orgId, OrgSchema)
			expect(a).not.toBe(base)
		})

		test('clone-on-step: fan-out from shared base does not pollute either branch', () => {
			const base = Relations.from(UserSchema)
			const branchA = base.hasMany('posts', PostSchema.fields.userId).build()
			const branchB = base.hasOne('profile', ProfileSchema.fields.userId).build()

			expect(Object.keys(branchA)).toEqual(['posts'])
			expect(Object.keys(branchB)).toEqual(['profile'])
		})
	})

	describe('Relations.from() behavior', () => {
		const UserSchema = Schema.from('users')
			.pk('id', v.string(), () => 'user-id')
			.field('name', v.string())
			.field('orgId', v.string())
			.field('managerId', v.optional(v.string()), { onCreate: () => undefined })
			.build()

		const PostSchema = Schema.from('posts')
			.pk('id', v.string(), () => 'post-id')
			.field('title', v.string())
			.field('userId', v.string())
			.build()

		const OrgSchema = Schema.from('orgs')
			.pk('id', v.string(), () => 'org-id')
			.field('name', v.string())
			.build()

		const TagSchema = Schema.from('tags')
			.pk('id', v.string(), () => 'tag-id')
			.field('label', v.string())
			.build()

		const PostTagSchema = Schema.from('post_tags')
			.pk('id', v.string(), () => 'pt-id')
			.field('postId', v.string())
			.field('tagId', v.string())
			.build()

		const ProfileSchema = Schema.from('profiles')
			.pk('id', v.string(), () => 'profile-id')
			.field('bio', v.string())
			.field('userId', v.string())
			.build()

		const UserRels = Relations.from(UserSchema)
			.hasMany('posts', PostSchema.fields.userId)
			.belongsTo('org', UserSchema.fields.orgId, OrgSchema)
			.hasOne('profile', ProfileSchema.fields.userId)
			.build()

		const PostRels = Relations.from(PostSchema)
			.belongsTo('author', PostSchema.fields.userId, UserSchema)
			.hasMany('postTags', PostTagSchema.fields.postId)
			.build()

		const TagRels = Relations.from(TagSchema).hasMany('postTags', PostTagSchema.fields.tagId).build()

		const PostTagRels = Relations.from(PostTagSchema)
			.belongsTo('post', PostTagSchema.fields.postId, PostSchema)
			.belongsTo('tag', PostTagSchema.fields.tagId, TagSchema)
			.build()

		test('hasMany returns ManyRelation instances', () => {
			expect(UserRels.posts).toBeInstanceOf(ManyRelation)
			expect(PostRels.postTags).toBeInstanceOf(ManyRelation)
			expect(TagRels.postTags).toBeInstanceOf(ManyRelation)
		})

		test('belongsTo returns OneRelation instances', () => {
			expect(UserRels.org).toBeInstanceOf(OneRelation)
			expect(PostRels.author).toBeInstanceOf(OneRelation)
			expect(PostTagRels.post).toBeInstanceOf(OneRelation)
			expect(PostTagRels.tag).toBeInstanceOf(OneRelation)
		})

		test('hasOne returns OneRelation instances', () => {
			expect(UserRels.profile).toBeInstanceOf(OneRelation)
		})

		test('hasMany stores correct source, target, foreignKey, and references', () => {
			const rel = UserRels.posts
			expect(rel.name).toBe('posts')
			expect(rel.source).toBe(UserSchema)
			expect(rel.target).toBe(PostSchema)
			expect(rel.foreignKey).toBe(PostSchema.fields.userId)
			expect(rel.references).toBe(UserSchema.pkField)
		})

		test('hasOne stores correct source, target, foreignKey, and fkOwner', () => {
			const rel = UserRels.profile
			expect(rel.name).toBe('profile')
			expect(rel.source).toBe(UserSchema)
			expect(rel.target).toBe(ProfileSchema)
			expect(rel.foreignKey).toBe(ProfileSchema.fields.userId)
			expect(rel.fkOwner).toBe('target')
			expect(rel.references).toBe(UserSchema.pkField)
		})

		test('belongsTo stores correct source, target, foreignKey, and fkOwner', () => {
			const rel = UserRels.org
			expect(rel.name).toBe('org')
			expect(rel.source).toBe(UserSchema)
			expect(rel.target).toBe(OrgSchema)
			expect(rel.foreignKey).toBe(UserSchema.fields.orgId)
			expect(rel.fkOwner).toBe('source')
			expect(rel.references).toBe(OrgSchema.pkField)
		})

		test('join-table hasMany stores correct metadata', () => {
			const rel = PostRels.postTags
			expect(rel.name).toBe('postTags')
			expect(rel.source).toBe(PostSchema)
			expect(rel.target).toBe(PostTagSchema)
			expect(rel.foreignKey).toBe(PostTagSchema.fields.postId)
		})

		test('join-table belongsTo stores correct metadata', () => {
			const rel = PostTagRels.tag
			expect(rel.name).toBe('tag')
			expect(rel.source).toBe(PostTagSchema)
			expect(rel.target).toBe(TagSchema)
			expect(rel.foreignKey).toBe(PostTagSchema.fields.tagId)
		})

		test('self-referential relation works without special casing', () => {
			const SelfRels = Relations.from(UserSchema)
				.belongsTo('manager', UserSchema.fields.managerId!, UserSchema)
				.build()

			expect(SelfRels.manager).toBeInstanceOf(OneRelation)
			expect(SelfRels.manager.source).toBe(UserSchema)
			expect(SelfRels.manager.target).toBe(UserSchema)
			expect(SelfRels.manager.fkOwner).toBe('source')
		})

		test('many-to-many via explicit join schema', () => {
			expect(PostRels.postTags).toBeInstanceOf(ManyRelation)
			expect(PostTagRels.post).toBeInstanceOf(OneRelation)
			expect(PostTagRels.tag).toBeInstanceOf(OneRelation)
			expect(PostTagRels.post.target).toBe(PostSchema)
			expect(PostTagRels.tag.target).toBe(TagSchema)
		})
	})

	describe('type-level: Relations.from uniqueness guard', () => {
		test('duplicate relation name is a TS error', () => {
			const S = Schema.from('test')
				.pk('id', v.string(), () => 'x')
				.build()
			const T = Schema.from('targets')
				.pk('id', v.string(), () => 'x')
				.field('sId', v.string())
				.build()
			// @ts-expect-error — duplicate name 'items' should fail
			Relations.from(S).hasMany('items', T.fields.sId).hasMany('items', T.fields.sId)
		})
	})

	describe('type-level: FK-PK type-match guarantee', () => {
		test('string FK pointing at number PK is a TS error', () => {
			const NumPkSchema = Schema.from('nums')
				.pk('id', v.number(), () => 0)
				.field('name', v.string())
				.build()

			const StringFkSchema = Schema.from('strings')
				.pk('id', v.string(), () => 'x')
				.field('numRef', v.string())
				.build()

			// @ts-expect-error — string FK does not match number PK
			Relations.from(NumPkSchema).hasMany('items', StringFkSchema.fields.numRef)
		})

		test('matching FK-PK types compile correctly', () => {
			const S = Schema.from('source')
				.pk('id', v.string(), () => 'x')
				.build()
			const T = Schema.from('target')
				.pk('id', v.string(), () => 'x')
				.field('sourceId', v.string())
				.build()
			const rels = Relations.from(S).hasMany('items', T.fields.sourceId).build()
			expect(rels.items).toBeInstanceOf(ManyRelation)
		})
	})

	describe('type-level: Field-only-FK rule', () => {
		test('raw string FK is a TS error for hasMany', () => {
			const S = Schema.from('s')
				.pk('id', v.string(), () => 'x')
				.build()
			// @ts-expect-error — raw string not allowed, must be a Field instance
			Relations.from(S).hasMany('items', 'someKey')
		})

		test('raw string FK is a TS error for belongsTo', () => {
			const S = Schema.from('s')
				.pk('id', v.string(), () => 'x')
				.field('ref', v.string())
				.build()
			const T = Schema.from('t')
				.pk('id', v.string(), () => 'x')
				.build()
			// @ts-expect-error — raw string not allowed, must be a Field instance
			Relations.from(S).belongsTo('parent', 'ref', T)
		})
	})

	describe('type-level: schema relations-agnosticism', () => {
		test('schema artifact contains no relational information', () => {
			const _S = Schema.from('users')
				.pk('id', v.string(), () => 'x')
				.field('name', v.string())
				.build()
			type SKeys = keyof typeof _S
			expectTypeOf<'relations' extends SKeys ? true : false>().toEqualTypeOf<false>()
		})
	})
}
