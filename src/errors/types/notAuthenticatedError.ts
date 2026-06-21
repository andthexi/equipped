import { StatusCodes } from '../../server'
import { RequestError } from '../requestError'

export class NotAuthenticatedError extends RequestError {
	constructor(message = 'Not authenticated', cause?: unknown) {
		super(message, StatusCodes.NotAuthenticated, [{ message }], cause)
	}
}
