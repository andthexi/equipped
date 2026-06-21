import { StatusCodes } from '../../server'
import { RequestError } from '../requestError'

export class BadRequestError extends RequestError {
	constructor(message: string, cause?: unknown) {
		super(message, StatusCodes.BadRequest, [{ message }], cause)
	}
}
