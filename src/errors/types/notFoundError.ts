import { StatusCodes } from '../../server'
import { RequestError } from '../requestError'

export class NotFoundError extends RequestError {
	statusCode = StatusCodes.NotFound

	constructor(message = 'Not found', cause?: unknown) {
		super(message, StatusCodes.NotFound, [{ message }], cause)
	}
}
