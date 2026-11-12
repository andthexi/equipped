import type { Pipe, PipeInput } from 'valleyed'

import type { OrmAdapterLike } from '../adapters/base.js'
import type { Repo } from '../repo/repo.js'
import { fire } from './executor.js'
import { HandlerRegistry, type FireFn, type HandlerDef } from './registry.js'
import { replay, rerun } from './walker.js'

export { type EventContext } from './registry.js'

export class EventLog<A extends OrmAdapterLike<any>> {
	readonly #repo: Repo<A>
	readonly #registry: HandlerRegistry

	constructor(repo: Repo<A>, registry: HandlerRegistry) {
		this.#repo = repo
		this.#registry = registry
	}

	handler<P extends Pipe<any, any>, R>(name: string, def: HandlerDef<P, R>): FireFn<P, R> {
		this.#registry.register(name, def)
		return (payload: PipeInput<P>, ctx?: { by?: string; at?: Date }) =>
			fire<R>(this.#repo as Repo<any>, name, def, payload, ctx)
	}

	replay(opts?: { from?: Date }): Promise<void> {
		return replay(this.#repo as Repo<any>, this.#registry, opts)
	}

	rerun(key: string): Promise<void> {
		return rerun(this.#repo as Repo<any>, this.#registry, key)
	}

	static from<A extends OrmAdapterLike<any>>(repo: Repo<A>) {
		return { build: () => new EventLog(repo, new HandlerRegistry()) }
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { v } = await import('valleyed')
	const { InMemoryAdapter } = await import('../adapters/in-memory/index.js')
	const { Schema } = await import('../schema.js')
	const { Repo } = await import('../repo/repo.js')
	const { OrmValidationError } = await import('../errors/index.js')
	const { EventLogSchema } = await import('./schema.js')

	const UserSchema = Schema.from('users')
		.pk('id', v.string(), () => `u-${Math.random()}`)
		.field('email', v.string())
		.field('createdAt', v.number(), { onCreate: () => Date.now() })
		.build()

	function makeRepo() {
		const adapter = InMemoryAdapter.create({})
		return new Repo({
			adapter,
			resolve: (name) => {
				if (name === EventLogSchema.name) return { table: 'events' }
				if (name === UserSchema.name) return { table: 'users' }
				return { table: name }
			},
		})
	}

	describe('EventLog', () => {
		test('EventLog.from(repo).build() constructs a working instance', () => {
			const repo = makeRepo()
			const log = EventLog.from(repo).build()
			expect(log).toBeInstanceOf(EventLog)
		})

		test('handler returns a typed fire function', async () => {
			const repo = makeRepo()
			const log = EventLog.from(repo).build()

			const fireSignup = log.handler('user.signup', {
				pipe: v.object({ email: v.string() }),
				handle: async (payload) => `created-${payload.email}`,
			})

			const result = await fireSignup({ email: 'a@b.com' }, { by: 'admin' })
			expect(result).toBe('created-a@b.com')
		})

		test('duplicate handler name throws', () => {
			const repo = makeRepo()
			const log = EventLog.from(repo).build()
			const def = { pipe: v.string(), handle: async () => {} }

			log.handler('test', def)
			expect(() => log.handler('test', def)).toThrow('already registered')
		})

		test('fire persists EventLogSchema row', async () => {
			const repo = makeRepo()
			const log = EventLog.from(repo).build()

			const fireEvent = log.handler('order.placed', {
				pipe: v.object({ item: v.string(), qty: v.number() }),
				handle: async () => {},
			})

			await fireEvent({ item: 'widget', qty: 3 }, { by: 'user-42' })

			const rows = await repo.on(EventLogSchema).all().find()
			expect(rows).toHaveLength(1)
			expect(rows[0].name).toBe('order.placed')
			expect(rows[0].body).toEqual({ item: 'widget', qty: 3 })
			expect(rows[0].by).toBe('user-42')
		})

		test('invalid payload throws OrmValidationError, no row persisted', async () => {
			const repo = makeRepo()
			const log = EventLog.from(repo).build()

			const fireEvent = log.handler('test', {
				pipe: v.object({ x: v.number() }),
				handle: async () => {},
			})

			await expect(fireEvent({ x: 'not-a-number' } as any)).rejects.toThrow(OrmValidationError)
			const rows = await repo.on(EventLogSchema).all().find()
			expect(rows).toHaveLength(0)
		})

		test('handler throw rolls back session — no row persisted, no side writes', async () => {
			const repo = makeRepo()
			const log = EventLog.from(repo).build()

			const fireEvent = log.handler('user.create', {
				pipe: v.object({ email: v.string() }),
				handle: async (payload) => {
					await repo.on(UserSchema).one().create({ email: payload.email })
					throw new Error('oops')
				},
			})

			await expect(fireEvent({ email: 'a@b.com' })).rejects.toThrow('oops')

			const eventRows = await repo.on(EventLogSchema).all().find()
			expect(eventRows).toHaveLength(0)

			const userRows = await repo.on(UserSchema).all().find()
			expect(userRows).toHaveLength(0)
		})

		test('handler receives firstRun: true and correct EventContext', async () => {
			const repo = makeRepo()
			const log = EventLog.from(repo).build()
			let captured: any

			const fireEvent = log.handler('test', {
				pipe: v.object({ val: v.number() }),
				handle: async (_payload, ctx) => {
					captured = ctx
				},
			})

			const at = new Date('2025-06-01T00:00:00Z')
			await fireEvent({ val: 99 }, { by: 'admin', at })

			expect(captured.firstRun).toBe(true)
			expect(captured.name).toBe('test')
			expect(captured.by).toBe('admin')
			expect(captured.at).toEqual(at)
			expect(captured.ts).toBe(at.getTime())
			expect(captured.body).toEqual({ val: 99 })
		})

		test('end-to-end: register → fire → replay flow', async () => {
			const repo = makeRepo()
			const log = EventLog.from(repo).build()
			const replayedPayloads: unknown[] = []

			const fireEvent = log.handler('order.placed', {
				pipe: v.object({ item: v.string() }),
				handle: async (payload, ctx) => {
					if (!ctx.firstRun) replayedPayloads.push(payload)
				},
			})

			await fireEvent({ item: 'A' }, { at: new Date('2025-01-02') })
			await fireEvent({ item: 'B' }, { at: new Date('2025-01-01') })

			await log.replay()

			expect(replayedPayloads).toEqual([{ item: 'B' }, { item: 'A' }])
		})

		test('rerun re-executes a single event with firstRun: false', async () => {
			const repo = makeRepo()
			const log = EventLog.from(repo).build()
			let rerunCtx: any

			const fireEvent = log.handler('test', {
				pipe: v.object({ val: v.number() }),
				handle: async (_payload, ctx) => {
					if (!ctx.firstRun) rerunCtx = ctx
				},
			})

			await fireEvent({ val: 7 }, { by: 'admin' })

			const rows = await repo.on(EventLogSchema).all().find()
			await log.rerun(rows[0].key)

			expect(rerunCtx).toBeDefined()
			expect(rerunCtx.firstRun).toBe(false)
			expect(rerunCtx.body).toEqual({ val: 7 })
			expect(rerunCtx.by).toBe('admin')
		})

		test('repo.session(() => log.replay()) makes replay atomic — failure rolls back all', async () => {
			const repo = makeRepo()
			const log = EventLog.from(repo).build()

			const fireEvent = log.handler('user.create', {
				pipe: v.object({ email: v.string(), fail: v.boolean() }),
				handle: async (payload, ctx) => {
					await repo.on(UserSchema).one().create({ email: payload.email })
					if (!ctx.firstRun && payload.fail) throw new Error('replay boom')
				},
			})

			await fireEvent({ email: 'alice@test.com', fail: false }, { at: new Date('2025-01-01') })
			await fireEvent({ email: 'bob@test.com', fail: true }, { at: new Date('2025-01-02') })

			const usersBefore = await repo.on(UserSchema).all().find()
			expect(usersBefore).toHaveLength(2)

			await expect(repo.session(() => log.replay())).rejects.toThrow()

			const usersAfter = await repo.on(UserSchema).all().find()
			expect(usersAfter).toHaveLength(2)
		})

		test('end-to-end: fire persists row + handler-side writes atomically', async () => {
			const repo = makeRepo()
			const log = EventLog.from(repo).build()

			const fireSignup = log.handler('user.signup', {
				pipe: v.object({ email: v.string() }),
				handle: async (payload, evCtx) => {
					const user = await repo.on(UserSchema).one().create({
						email: payload.email,
						createdAt: evCtx.at.getTime(),
					})
					return user
				},
			})

			const user = await fireSignup({ email: 'alice@test.com' }, { by: 'system' })
			expect(user.email).toBe('alice@test.com')

			const eventRows = await repo.on(EventLogSchema).all().find()
			expect(eventRows).toHaveLength(1)

			const userRows = await repo.on(UserSchema).all().find()
			expect(userRows).toHaveLength(1)
		})
	})
}
