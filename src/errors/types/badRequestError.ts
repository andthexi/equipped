import { StatusCodes } from '../../server/index.js'
import { RequestError } from '../requestError.js'

export class BadRequestError extends RequestError {
	constructor(message: string, cause?: unknown) {
		super(message, StatusCodes.BadRequest, [{ message }], cause)
	}
}
