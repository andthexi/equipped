import { StatusCodes } from '../../server'
import { RequestError } from '../requestError'

export class TokenExpired extends RequestError {
	constructor(message = 'Token expired', cause?: unknown) {
		super(message, StatusCodes.TokenExpired, [{ message }], cause)
	}
}
