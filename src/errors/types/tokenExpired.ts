import { StatusCodes } from '../../server/index.js'
import { RequestError } from '../requestError.js'

export class TokenExpired extends RequestError {
	constructor(message = 'Token expired', cause?: unknown) {
		super(message, StatusCodes.TokenExpired, [{ message }], cause)
	}
}
