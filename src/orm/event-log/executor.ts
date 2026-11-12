import { v } from 'valleyed'

import { Instance } from '../../instance'
import { OrmValidationError } from '../errors'
import type { EventContext, HandlerDef } from './registry'
import { EventLogSchema } from './schema'
import type { Repo } from '../repo/repo'

export async function fire<R>(
	repo: Repo<any>,
	name: string,
	def: HandlerDef,
	payload: unknown,
	ctx?: { by?: string; at?: Date },
): Promise<R> {
	const validated = v.validate(def.pipe, payload)
	if (!validated.valid) {
		throw new OrmValidationError('validation', 'event_log', 'fire', [
			{ cause: validated.error },
		])
	}

	return repo.session(async () => {
		const at = ctx?.at ?? new Date()
		const ts = at.getTime()
		const key = Instance.createId()
		const by = ctx?.by ?? null

		await repo.on(EventLogSchema).one().create({
			key,
			name,
			ts,
			body: validated.value,
			by,
		})

		const evCtx: EventContext = {
			key,
			name,
			ts,
			body: validated.value,
			by,
			at,
			firstRun: true,
		}

		return await def.handle(validated.value, evCtx) as R
	})
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { v } = await import('valleyed')
	const { InMemoryAdapter } = await import('../adapters/in-memory')
	const { Repo } = await import('../repo/repo')
	const { OrmValidationError } = await import('../errors')
	type EventContext = import('./registry').EventContext
	const { EventLogSchema } = await import('./schema')

	function makeRepo() {
		const adapter = InMemoryAdapter.create({})
		return new Repo({
			adapter,
			resolve: (name) => {
				if (name === EventLogSchema.name) return { table: 'events' }
				return { table: name }
			},
		})
	}

	describe('FireExecutor', () => {
		test('payload validation rejects → throws OrmValidationError, no row persisted', async () => {
			const repo = makeRepo()
			const def = {
				pipe: v.object({ email: v.string() }),
				handle: async () => 'ok',
			}
			await expect(fire(repo, 'test', def, { email: 123 })).rejects.toThrow(OrmValidationError)
			const rows = await repo.on(EventLogSchema).all().find()
			expect(rows).toHaveLength(0)
		})

		test('happy path persists row and runs handler', async () => {
			const repo = makeRepo()
			let called = false
			const def = {
				pipe: v.object({ email: v.string() }),
				handle: async (payload: { email: string }) => {
					called = true
					return `created-${payload.email}`
				},
			}

			const result = await fire(repo, 'user.signup', def, { email: 'a@b.com' }, { by: 'admin' })

			expect(result).toBe('created-a@b.com')
			expect(called).toBe(true)

			const rows = await repo.on(EventLogSchema).all().find()
			expect(rows).toHaveLength(1)
			expect(rows[0].name).toBe('user.signup')
			expect(rows[0].body).toEqual({ email: 'a@b.com' })
			expect(rows[0].by).toBe('admin')
			expect(typeof rows[0].ts).toBe('number')
			expect(rows[0].key).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
		})

		test('handler receives EventContext with firstRun: true', async () => {
			const repo = makeRepo()
			let captured: EventContext | undefined
			const def = {
				pipe: v.object({ x: v.number() }),
				handle: async (_payload: unknown, ctx: EventContext) => {
					captured = ctx
				},
			}
			const at = new Date('2025-01-15T12:00:00Z')

			await fire(repo, 'test.event', def, { x: 42 }, { by: 'user-1', at })

			expect(captured).toBeDefined()
			expect(captured!.firstRun).toBe(true)
			expect(captured!.name).toBe('test.event')
			expect(captured!.by).toBe('user-1')
			expect(captured!.at).toEqual(at)
			expect(captured!.ts).toBe(at.getTime())
			expect(captured!.body).toEqual({ x: 42 })
			expect(captured!.key).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
		})

		test('handler throws → no EventLogSchema row remains', async () => {
			const repo = makeRepo()
			const def = {
				pipe: v.object({ val: v.string() }),
				handle: async () => {
					throw new Error('handler blew up')
				},
			}

			await expect(fire(repo, 'boom', def, { val: 'x' })).rejects.toThrow('handler blew up')

			const rows = await repo.on(EventLogSchema).all().find()
			expect(rows).toHaveLength(0)
		})

		test('by defaults to null when not provided', async () => {
			const repo = makeRepo()
			const def = {
				pipe: v.string(),
				handle: async () => {},
			}

			await fire(repo, 'test', def, 'hello')

			const rows = await repo.on(EventLogSchema).all().find()
			expect(rows).toHaveLength(1)
			expect(rows[0].by).toBeNull()
		})
	})
}
