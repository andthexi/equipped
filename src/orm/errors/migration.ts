import { EquippedError } from '../../errors/index.js'

export type OrmMigrationPhase = 'lock' | 'load' | 'session' | 'user' | 'record'

export class OrmMigrationError extends EquippedError {
	readonly id: string
	readonly phase: OrmMigrationPhase

	constructor(opts: { id: string; phase: OrmMigrationPhase; cause: unknown }) {
		super(
			`Migration failed at phase '${opts.phase}' for migration '${opts.id}'`,
			{ id: opts.id, phase: opts.phase },
			opts.cause,
		)
		this.id = opts.id
		this.phase = opts.phase
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { EquippedError } = await import('../../errors/index.js')

	describe('OrmMigrationError', () => {
		test('stores id, phase, and cause on the instance', () => {
			const cause = new Error('connection lost')
			const err = new OrmMigrationError({ id: '0001-add-users', phase: 'user', cause })
			expect(err.id).toBe('0001-add-users')
			expect(err.phase).toBe('user')
			expect(err.cause).toBe(cause)
		})

		test('message includes phase and migration id', () => {
			const err = new OrmMigrationError({ id: '0002-add-index', phase: 'session', cause: 'boom' })
			expect(err.message).toBe("Migration failed at phase 'session' for migration '0002-add-index'")
		})

		test('instanceof EquippedError is true', () => {
			const err = new OrmMigrationError({ id: 'x', phase: 'lock', cause: null })
			expect(err).toBeInstanceOf(OrmMigrationError)
			expect(err).toBeInstanceOf(EquippedError)
		})

		test('discriminates from sibling error classes', async () => {
			const { OrmValidationError } = await import('./validation.js')
			const { OrmNotFoundError } = await import('./not-found.js')
			const { OrmReplayError } = await import('./replay.js')
			const err = new OrmMigrationError({ id: 'x', phase: 'load', cause: null })
			expect(err).not.toBeInstanceOf(OrmValidationError)
			expect(err).not.toBeInstanceOf(OrmNotFoundError)
			expect(err).not.toBeInstanceOf(OrmReplayError)
		})

		test('context carries id and phase', () => {
			const err = new OrmMigrationError({ id: '0003-drop-table', phase: 'record', cause: 'fail' })
			expect((err.context as any).id).toBe('0003-drop-table')
			expect((err.context as any).phase).toBe('record')
		})

		test.each(['lock', 'load', 'session', 'user', 'record'] as const)('phase %s works', (phase) => {
			const err = new OrmMigrationError({ id: 'test', phase, cause: null })
			expect(err.phase).toBe(phase)
		})
	})
}
