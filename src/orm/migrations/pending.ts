import { OrmMigrationError } from '../errors/migration.js'
import type { AnyMigration } from './types.js'

export type PendingOpts = { to?: string; steps?: number }

export function computePending(
	declared: ReadonlyArray<AnyMigration>,
	applied: ReadonlyArray<{ id: string; appliedAt: number }>,
	opts?: PendingOpts,
): { pending: AnyMigration[]; skipped: string[] } {
	const appliedIds = new Set(applied.map((a) => a.id))
	const declaredIds = new Set(declared.map((d) => d.id))

	const orphans = applied.filter((a) => !declaredIds.has(a.id)).map((a) => a.id)
	if (orphans.length > 0) {
		throw new OrmMigrationError({
			id: orphans[0],
			phase: 'load',
			cause: `orphan migrations: [${orphans.join(', ')}]`,
		})
	}

	const sorted = [...declared].sort((a, b) => a.id.localeCompare(b.id))

	const pending: AnyMigration[] = []
	const skipped: string[] = []
	for (const m of sorted) {
		if (appliedIds.has(m.id)) {
			skipped.push(m.id)
		} else {
			pending.push(m)
		}
	}

	if (opts?.to !== undefined) {
		const toIdx = pending.findIndex((m) => m.id === opts.to)
		if (toIdx === -1) {
			if (appliedIds.has(opts.to)) return { pending: [], skipped }
			throw new OrmMigrationError({
				id: opts.to,
				phase: 'load',
				cause: `unknown migration id: ${opts.to}`,
			})
		}
		pending.splice(toIdx + 1)
	}

	if (opts?.steps !== undefined) {
		pending.splice(opts.steps)
	}

	return { pending, skipped }
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { OrmMigrationError } = await import('../errors/migration.js')

	describe('computePending', () => {
		test('returns all as pending when none applied', () => {
			const declared = [
				{ id: '0002-add-index', changes: [] },
				{ id: '0001-create-table', changes: [] },
			]
			const result = computePending(declared, [])
			expect(result.pending.map((m) => m.id)).toEqual(['0001-create-table', '0002-add-index'])
			expect(result.skipped).toEqual([])
		})

		test('skips already applied migrations', () => {
			const declared = [
				{ id: '0001', changes: [] },
				{ id: '0002', changes: [] },
				{ id: '0003', changes: [] },
			]
			const applied = [{ id: '0001', appliedAt: 1 }]
			const result = computePending(declared, applied)
			expect(result.pending.map((m) => m.id)).toEqual(['0002', '0003'])
			expect(result.skipped).toEqual(['0001'])
		})

		test('throws on orphan migrations', () => {
			const declared = [{ id: '0001', changes: [] }]
			const applied = [
				{ id: '0001', appliedAt: 1 },
				{ id: 'ghost', appliedAt: 2 },
			]
			expect(() => computePending(declared, applied)).toThrow(OrmMigrationError)
			try {
				computePending(declared, applied)
			} catch (err: any) {
				expect(err.phase).toBe('load')
				expect(err.cause).toContain('ghost')
			}
		})

		test('returns empty pending when all applied', () => {
			const declared = [{ id: '0001', changes: [] }]
			const applied = [{ id: '0001', appliedAt: 1 }]
			const result = computePending(declared, applied)
			expect(result.pending).toEqual([])
			expect(result.skipped).toEqual(['0001'])
		})

		test('sorts by lex id order', () => {
			const declared = [
				{ id: 'c', changes: [] },
				{ id: 'a', changes: [] },
				{ id: 'b', changes: [] },
			]
			const result = computePending(declared, [])
			expect(result.pending.map((m) => m.id)).toEqual(['a', 'b', 'c'])
		})

		test('to: returns pending up to and including the named id', () => {
			const declared = [
				{ id: '0001', changes: [] },
				{ id: '0002', changes: [] },
				{ id: '0003', changes: [] },
			]
			const result = computePending(declared, [], { to: '0002' })
			expect(result.pending.map((m) => m.id)).toEqual(['0001', '0002'])
		})

		test('to: no-op when target id already applied', () => {
			const declared = [
				{ id: '0001', changes: [] },
				{ id: '0002', changes: [] },
				{ id: '0003', changes: [] },
			]
			const applied = [
				{ id: '0001', appliedAt: 1 },
				{ id: '0002', appliedAt: 2 },
			]
			const result = computePending(declared, applied, { to: '0002' })
			expect(result.pending).toEqual([])
		})

		test('to: throws on unknown id', () => {
			const declared = [{ id: '0001', changes: [] }]
			expect(() => computePending(declared, [], { to: 'unknown' })).toThrow(OrmMigrationError)
			try {
				computePending(declared, [], { to: 'unknown' })
			} catch (err: any) {
				expect(err.phase).toBe('load')
				expect(err.id).toBe('unknown')
			}
		})

		test('steps: returns the first N pending', () => {
			const declared = [
				{ id: '0001', changes: [] },
				{ id: '0002', changes: [] },
				{ id: '0003', changes: [] },
			]
			const result = computePending(declared, [], { steps: 1 })
			expect(result.pending.map((m) => m.id)).toEqual(['0001'])
		})

		test('steps: returns all pending when N exceeds count', () => {
			const declared = [
				{ id: '0001', changes: [] },
				{ id: '0002', changes: [] },
			]
			const result = computePending(declared, [], { steps: 5 })
			expect(result.pending.map((m) => m.id)).toEqual(['0001', '0002'])
		})
	})
}
