import { StatusCodes } from '../../server/index.js'
import { RequestError } from '../requestError.js'

export class NotAuthorizedError extends RequestError {
	constructor(message = 'Not authorized', cause?: unknown) {
		super(message, StatusCodes.NotAuthorized, [{ message }], cause)
	}
}
