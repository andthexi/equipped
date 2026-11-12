import { StatusCodes } from '../../server/index.js'
import { RequestError } from '../requestError.js'

export class NotFoundError extends RequestError {
	statusCode = StatusCodes.NotFound

	constructor(message = 'Not found', cause?: unknown) {
		super(message, StatusCodes.NotFound, [{ message }], cause)
	}
}
