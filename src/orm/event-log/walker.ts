import type { EventContext, HandlerDef, HandlerRegistry } from './registry'
import { EventLogSchema } from './schema'
import { OrmReplayError } from '../errors/replay'
import type { Repo } from '../repo/repo'

const executeReplay = async (
	repo: Repo<any>,
	def: HandlerDef,
	row: { key: string; name: string; ts: number; body: unknown; by: string | null },
): Promise<void> => {
	const evCtx: EventContext = {
		key: row.key,
		name: row.name,
		ts: row.ts,
		body: row.body,
		by: row.by,
		at: new Date(row.ts),
		firstRun: false,
	}
	try {
		await repo.session(async () => {
			await def.handle(row.body, evCtx)
		})
	} catch (cause) {
		throw new OrmReplayError({ key: row.key, name: row.name, cause })
	}
}

export async function replay(
	repo: Repo<any>,
	registry: HandlerRegistry,
	opts?: { from?: Date },
): Promise<void> {
	let query = repo.on(EventLogSchema).all().orderBy('ts', 'asc')
	if (opts?.from) {
		query = query.where((q) => q.gte('ts', opts.from!.getTime()))
	}
	const rows = await query.find()

	for (const row of rows) {
		await executeReplay(repo, registry.get(row.name), row)
	}
}

export async function rerun(
	repo: Repo<any>,
	registry: HandlerRegistry,
	key: string,
): Promise<void> {
	const row = await repo.on(EventLogSchema).one().id(key).find()
	if (!row) {
		throw new OrmReplayError({ key, name: 'unknown', cause: new Error(`Event with key "${key}" not found`) })
	}
	await executeReplay(repo, registry.get(row.name), row)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { v } = await import('valleyed')
	const { InMemoryAdapter } = await import('../adapters/in-memory')
	const { Schema } = await import('../schema')
	const { Repo } = await import('../repo/repo')
	const { OrmReplayError } = await import('../errors/replay')
	const { HandlerRegistry } = await import('./registry')
	const { EventLogSchema } = await import('./schema')
	const { fire } = await import('./executor')
	type EventContext = import('./registry').EventContext

	const CounterSchema = Schema.from('counters')
		.pk('id', v.string(), () => `c-${Math.random()}`)
		.field('name', v.string())
		.field('count', v.number())
		.build()

	function makeRepo() {
		const adapter = InMemoryAdapter.create({})
		return new Repo({
			adapter,
			resolve: (name) => {
				if (name === EventLogSchema.name) return { table: 'events' }
				if (name === CounterSchema.name) return { table: 'counters' }
				return { table: name }
			},
		})
	}

	describe('ReplayWalker', () => {
		test('replay walks rows in ts-ascending order', async () => {
			const repo = makeRepo()
			const registry = new HandlerRegistry()
			const order: string[] = []

			const def = {
				pipe: v.object({ label: v.string() }),
				handle: async (payload: { label: string }) => {
					order.push(payload.label)
				},
			}
			registry.register('test', def)

			await fire(repo, 'test', def, { label: 'second' }, { at: new Date('2025-01-02') })
			await fire(repo, 'test', def, { label: 'first' }, { at: new Date('2025-01-01') })
			await fire(repo, 'test', def, { label: 'third' }, { at: new Date('2025-01-03') })

			order.length = 0
			await replay(repo, registry)

			expect(order).toEqual(['first', 'second', 'third'])
		})

		test('replay({ from }) skips rows with ts < from', async () => {
			const repo = makeRepo()
			const registry = new HandlerRegistry()
			const order: string[] = []

			const def = {
				pipe: v.object({ label: v.string() }),
				handle: async (payload: { label: string }) => {
					order.push(payload.label)
				},
			}
			registry.register('test', def)

			await fire(repo, 'test', def, { label: 'old' }, { at: new Date('2025-01-01') })
			await fire(repo, 'test', def, { label: 'new' }, { at: new Date('2025-01-03') })

			order.length = 0
			await replay(repo, registry, { from: new Date('2025-01-02') })

			expect(order).toEqual(['new'])
		})

		test('replay passes firstRun: false in EventContext', async () => {
			const repo = makeRepo()
			const registry = new HandlerRegistry()
			let captured: EventContext | undefined

			const def = {
				pipe: v.object({ x: v.number() }),
				handle: async (_payload: unknown, ctx: EventContext) => {
					captured = ctx
				},
			}
			registry.register('test', def)

			await fire(repo, 'test', def, { x: 1 })

			await replay(repo, registry)

			expect(captured).toBeDefined()
			expect(captured!.firstRun).toBe(false)
		})

		test('replay throws OrmReplayError on first failure with key/name/cause', async () => {
			const repo = makeRepo()
			const registry = new HandlerRegistry()

			const boom = new Error('handler exploded')
			const def = {
				pipe: v.object({ fail: v.boolean() }),
				handle: async (payload: { fail: boolean }, ctx: EventContext) => {
					if (!ctx.firstRun && payload.fail) throw boom
				},
			}
			registry.register('evt', def)

			await fire(repo, 'evt', def, { fail: false }, { at: new Date('2025-01-01') })
			await fire(repo, 'evt', def, { fail: true }, { at: new Date('2025-01-02') })
			await fire(repo, 'evt', def, { fail: false }, { at: new Date('2025-01-03') })

			const rows = await repo.on(EventLogSchema).all().orderBy('ts', 'asc').find()
			const failKey = rows[1].key

			await expect(replay(repo, registry)).rejects.toThrow(OrmReplayError)
			try {
				await replay(repo, registry)
			} catch (e: any) {
				expect(e.key).toBe(failKey)
				expect(e.eventName).toBe('evt')
				expect(e.cause).toBe(boom)
			}
		})

		test('replay stops on first failure — events after failure not attempted', async () => {
			const repo = makeRepo()
			const registry = new HandlerRegistry()
			const executed: string[] = []

			const def = {
				pipe: v.object({ label: v.string(), fail: v.boolean() }),
				handle: async (payload: { label: string; fail: boolean }, ctx: EventContext) => {
					executed.push(payload.label)
					if (!ctx.firstRun && payload.fail) throw new Error('boom')
				},
			}
			registry.register('test', def)

			await fire(repo, 'test', def, { label: 'A', fail: false }, { at: new Date('2025-01-01') })
			await fire(repo, 'test', def, { label: 'B', fail: true }, { at: new Date('2025-01-02') })
			await fire(repo, 'test', def, { label: 'C', fail: false }, { at: new Date('2025-01-03') })

			executed.length = 0
			await expect(replay(repo, registry)).rejects.toThrow(OrmReplayError)

			expect(executed).toEqual(['A', 'B'])
		})

		test('per-event session isolation: failure on event N does not roll back events 1..N−1', async () => {
			const repo = makeRepo()
			const registry = new HandlerRegistry()

			const def = {
				pipe: v.object({ name: v.string(), fail: v.boolean() }),
				handle: async (payload: { name: string; fail: boolean }, ctx: EventContext) => {
					await repo.on(CounterSchema).one().create({ name: payload.name, count: 1 })
					if (!ctx.firstRun && payload.fail) throw new Error('boom')
				},
			}
			registry.register('test', def)

			await fire(repo, 'test', def, { name: 'alpha', fail: false }, { at: new Date('2025-01-01') })
			await fire(repo, 'test', def, { name: 'beta', fail: true }, { at: new Date('2025-01-02') })

			const countersBefore = await repo.on(CounterSchema).all().find()
			expect(countersBefore).toHaveLength(2)

			await expect(replay(repo, registry)).rejects.toThrow(OrmReplayError)

			const countersAfter = await repo.on(CounterSchema).all().find()
			expect(countersAfter).toHaveLength(3)
			expect(countersAfter.filter((c) => c.name === 'alpha')).toHaveLength(2)
		})

		test('rerun re-executes a single event with firstRun: false', async () => {
			const repo = makeRepo()
			const registry = new HandlerRegistry()
			let captured: EventContext | undefined

			const def = {
				pipe: v.object({ x: v.number() }),
				handle: async (_payload: unknown, ctx: EventContext) => {
					captured = ctx
				},
			}
			registry.register('test', def)

			await fire(repo, 'test', def, { x: 42 })

			const rows = await repo.on(EventLogSchema).all().find()
			const key = rows[0].key

			await rerun(repo, registry, key)

			expect(captured).toBeDefined()
			expect(captured!.firstRun).toBe(false)
			expect(captured!.key).toBe(key)
			expect(captured!.body).toEqual({ x: 42 })
		})

		test('rerun throws OrmReplayError for missing key', async () => {
			const repo = makeRepo()
			const registry = new HandlerRegistry()

			await expect(rerun(repo, registry, 'nonexistent')).rejects.toThrow(OrmReplayError)
		})
	})
}
