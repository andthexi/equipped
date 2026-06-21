import { StatusCodes } from '../../server'
import { RequestError } from '../requestError'

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
