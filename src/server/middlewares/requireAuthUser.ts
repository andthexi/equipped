import { NotAuthenticatedError } from '../../errors/index.js'
import type { AuthUser } from '../../types/index.js'
import { BaseRequestAuthMethod } from '../requests-auth-methods/index.js'
import { makeMiddleware } from '../types.js'

export const requireAuthUser = (methods: BaseRequestAuthMethod<AuthUser>[]) =>
	makeMiddleware(
		async (request) => {
			request.authUser = await BaseRequestAuthMethod.process(methods, request.headers)
			if (!request.authUser) throw new NotAuthenticatedError()
		},
		(route) => {
			route.security ??= []
			for (const method of methods) {
				const schemeName = method.routeSecuritySchemeName()
				if (schemeName) route.security.push({ [schemeName]: [] })
			}

			route.descriptions ??= []
			route.descriptions.push('Requires a valid means of authentication.')
		},
	)
