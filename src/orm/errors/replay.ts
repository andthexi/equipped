import { EquippedError } from '../../errors/index.js'

export class OrmReplayError extends EquippedError {
	readonly key: string
	readonly eventName: string

	constructor(opts: { key: string; name: string; cause: unknown }) {
		super(
			`EventLog replay failed on event ${opts.name} (key=${opts.key})`,
			{ key: opts.key, name: opts.name },
			opts.cause,
		)
		this.key = opts.key
		this.eventName = opts.name
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { EquippedError } = await import('../../errors/index.js')
	const { OrmValidationError } = await import('./validation.js')
	const { OrmNotFoundError } = await import('./not-found.js')

	describe('OrmReplayError', () => {
		test('stores key, eventName, and cause on the instance', () => {
			const cause = new Error('handler blew up')
			const err = new OrmReplayError({ key: 'evt-123', name: 'user.signup', cause })
			expect(err.key).toBe('evt-123')
			expect(err.eventName).toBe('user.signup')
			expect(err.cause).toBe(cause)
		})

		test('message includes handler name and key', () => {
			const err = new OrmReplayError({ key: 'evt-456', name: 'order.placed', cause: 'boom' })
			expect(err.message).toBe('EventLog replay failed on event order.placed (key=evt-456)')
		})

		test('instanceof EquippedError is true', () => {
			const err = new OrmReplayError({ key: 'k', name: 'n', cause: null })
			expect(err).toBeInstanceOf(OrmReplayError)
			expect(err).toBeInstanceOf(EquippedError)
		})

		test('discriminates from OrmValidationError and OrmNotFoundError', () => {
			const err = new OrmReplayError({ key: 'k', name: 'n', cause: null })
			expect(err).not.toBeInstanceOf(OrmValidationError)
			expect(err).not.toBeInstanceOf(OrmNotFoundError)
		})

		test('context carries key and name', () => {
			const err = new OrmReplayError({ key: 'evt-789', name: 'payment.charged', cause: 'fail' })
			expect((err.context as any).key).toBe('evt-789')
			expect((err.context as any).name).toBe('payment.charged')
		})
	})
}
