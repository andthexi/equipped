import type { StatusCode } from '../server/index.js'
import { EquippedError } from './equippedError.js'

export abstract class RequestError extends EquippedError {
	protected constructor(
		public readonly message: string,
		public readonly statusCode: StatusCode,
		public readonly serializedErrors: { message: string; field?: string }[],
		cause?: unknown,
	) {
		super(message, { serializedErrors }, cause)
	}
}
