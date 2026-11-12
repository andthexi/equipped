import type { IncomingHttpHeaders } from 'node:http2'

import { fastifyCookie } from '@fastify/cookie'
import jwt from 'jsonwebtoken'

import { NotAuthenticatedError, TokenExpired } from '../../errors/index.js'
import { BaseRequestAuthMethod } from './base.js'

export interface BaseJwtRequestAuthMethodOptions {
	signingKey: string
	storageTTL: number
	storagePrefix?: string
	enforceSingleSession?: boolean
}

export abstract class BaseJwtRequestAuthMethod<T extends { id: string }> extends BaseRequestAuthMethod<T> {
	protected readonly options: BaseJwtRequestAuthMethodOptions
	protected abstract parseHeader(headers: IncomingHttpHeaders): Promise<string>
	protected abstract store(key: string, token: string, ttl: number): Promise<void>
	protected abstract retrieve(key: string): Promise<string | null>
	protected abstract delete(key: string): Promise<void>

	constructor(options: BaseJwtRequestAuthMethodOptions) {
		super()
		this.options = options
	}

	#getKey(userId: string) {
		return `${this.options.storagePrefix ?? ''}${userId}`
	}

	async createToken(payload: T) {
		const token = jwt.sign(payload, this.options.signingKey, { expiresIn: this.options.storageTTL })
		await this.store(this.#getKey(payload.id), token, this.options.storageTTL)
		return token
	}

	async parse(headers: IncomingHttpHeaders) {
		try {
			const token = await this.parseHeader(headers)
			const user = jwt.verify(token, this.options.signingKey) as T
			if (!user) throw new NotAuthenticatedError()

			if (this.options.enforceSingleSession) {
				const cachedToken = await this.retrieve(this.#getKey(user.id))
				if (token && token !== cachedToken) throw new TokenExpired()
			}

			return user
		} catch (err) {
			if (err instanceof TokenExpired) throw err
			if (err instanceof jwt.TokenExpiredError) throw new TokenExpired(undefined, err)
			else throw new NotAuthenticatedError(undefined, err)
		}
	}

	async retrieveFor(userId: string) {
		return this.retrieve(this.#getKey(userId))
	}

	async deleteFor(userId: string) {
		await this.delete(this.#getKey(userId))
	}
}

interface BaseJwtHeaderRequestAuthMethodOptions<T extends string> extends BaseJwtRequestAuthMethodOptions {
	headerName: T
}

export abstract class BaseJwtHeaderRequestAuthMethod<
	T extends { id: string },
	Name extends string = string,
> extends BaseJwtRequestAuthMethod<T> {
	protected readonly options: BaseJwtHeaderRequestAuthMethodOptions<Name>

	constructor(options: BaseJwtHeaderRequestAuthMethodOptions<Name>) {
		super(options)
		this.options = options
	}

	async parseHeader(headers: IncomingHttpHeaders) {
		const value = headers[this.options.headerName]
		if (!value || typeof value !== 'string') throw new NotAuthenticatedError()
		return value.startsWith('Bearer ') ? value.slice(7) : value
	}

	routeSecuritySchemeName() {
		return this.options.headerName
	}
}

interface BaseJwtCookieRequestAuthMethodOptions<T extends string> extends BaseJwtRequestAuthMethodOptions {
	cookieName: T
}

export abstract class BaseJwtCookieRequestAuthMethod<
	T extends { id: string },
	Name extends string = string,
> extends BaseJwtRequestAuthMethod<T> {
	protected readonly options: BaseJwtCookieRequestAuthMethodOptions<Name>

	constructor(options: BaseJwtCookieRequestAuthMethodOptions<Name>) {
		super(options)
		this.options = options
	}

	async parseHeader(headers: IncomingHttpHeaders) {
		const cookies = fastifyCookie.parse(headers.cookie || '') ?? {}
		const value = cookies[this.options.cookieName]
		if (!value || typeof value !== 'string') throw new NotAuthenticatedError()
		return value
	}

	routeSecuritySchemeName() {
		return `cookie:${this.options.cookieName}`
	}
}
