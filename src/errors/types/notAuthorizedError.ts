import { StatusCodes } from '../../server'
import { RequestError } from '../requestError'

export class NotAuthorizedError extends RequestError {
	constructor(message = 'Not authorized', cause?: unknown) {
		super(message, StatusCodes.NotAuthorized, [{ message }], cause)
	}
}
