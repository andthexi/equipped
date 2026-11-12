import { StatusCodes } from '../../server/index.js'
import { RequestError } from '../requestError.js'

export class NotAuthenticatedError extends RequestError {
	constructor(message = 'Not authenticated', cause?: unknown) {
		super(message, StatusCodes.NotAuthenticated, [{ message }], cause)
	}
}
