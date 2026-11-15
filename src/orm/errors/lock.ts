import { EquippedError } from '../../errors/index.js'

export type OrmLockReason = 'busy' | 'acquisition-failed' | 'ownership-lost' | 'release-failed' | 'invalid-use'

export class OrmLockError extends EquippedError {
	constructor(
		readonly reason: OrmLockReason,
		readonly target: string,
		options: { cause?: unknown; callbackCause?: unknown } = {},
	) {
		super(
			`ORM storage lock ${reason}: ${target}`,
			{ reason, target, callbackCause: options.callbackCause },
			options.cause,
		)
	}
}
