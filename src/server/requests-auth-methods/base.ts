import { type IncomingHttpHeaders } from 'node:http2'

import { BadRequestError, RequestError } from '../../errors/index.js'

export abstract class BaseRequestAuthMethod<T extends { id: string }> {
	public abstract parse(headers: IncomingHttpHeaders): Promise<T>
	public abstract routeSecuritySchemeName(): string | null

	static async process<T extends { id: string }>(methods: BaseRequestAuthMethod<T>[], headers: IncomingHttpHeaders) {
		if (methods.length === 0) return null
		let error: Error | undefined
		for (const method of methods) {
			try {
				return await method.parse(headers)
			} catch (err) {
				error = err as Error
			}
		}
		throw error instanceof RequestError ? error : new BadRequestError('failed to parse auth user', error)
	}
}
