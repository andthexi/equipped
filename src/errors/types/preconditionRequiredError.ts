import { StatusCodes } from '../../server/index.js'
import { RequestError } from '../requestError.js'

export class PreconditionRequiredError extends RequestError {
	constructor(message = 'Precondition required', cause?: unknown) {
		super(message, StatusCodes.PreconditionRequired, [{ message }], cause)
	}
}
