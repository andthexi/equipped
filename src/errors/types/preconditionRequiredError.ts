import { StatusCodes } from '../../server'
import { RequestError } from '../requestError'

export class PreconditionRequiredError extends RequestError {
	constructor(message = 'Precondition required', cause?: unknown) {
		super(message, StatusCodes.PreconditionRequired, [{ message }], cause)
	}
}
