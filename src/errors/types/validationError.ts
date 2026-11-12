import { StatusCodes } from '../../server/index.js'
import { RequestError } from '../requestError.js'

type ValidError = {
	messages: string[]
	field: string
}

export class ValidationError extends RequestError {
	constructor(errors: ValidError[], cause?: unknown) {
		super(
			'Unprocessable Entity',
			StatusCodes.ValidationError,
			errors.flatMap(({ field, messages }) => messages.map((message) => ({ message, field }))),
			cause,
		)
	}
}
