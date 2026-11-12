import { AsyncLocalStorage } from 'node:async_hooks'

import { type Pipe, PipeError, type PipeInput, type PipeOutput, v } from 'valleyed'

import { Instance } from '../instance/index.js'
import type { IncomingFile, Request, Response, RouteDef, RouteDefToReqRes } from '../server/index.js'

const filePipe = (err?: string) =>
	v.array(
		v.file<IncomingFile>(err).pipe((input) => {
			const err = `is larger than allowed limit of ${Instance.get().settings.utils.maxFileUploadSizeInMb}mb`
			const valid = input ? !input.isTruncated : true
			if (valid) return input
			throw PipeError.root(err, input)
		}),
	)

export const incomingFile = (err?: string) =>
	v.define<unknown, IncomingFile>(
		v.compile(
			filePipe(err)
				.pipe(v.min(1, 'no file provided'))
				.pipe((files) => files[0]),
		),
		{ schema: () => ({ type: 'string', format: 'binary' }) },
	)

export const incomingFiles = (err?: string) =>
	v.define<unknown, IncomingFile[]>(v.compile(filePipe(err)), {
		schema: () => ({ type: 'string', format: 'binary' }),
	})

export const requestLocalStorage = new AsyncLocalStorage<Request<RouteDefToReqRes<RouteDef>>>()
export const responseLocalStorage = new AsyncLocalStorage<Response<RouteDefToReqRes<RouteDef>>>()

export const withRequest = <T extends Pipe<any, any>>(fn: (req: Request<RouteDefToReqRes<RouteDef>>) => T) =>
	v.define<PipeInput<T>, PipeOutput<T>>((input) => {
		const req = requestLocalStorage.getStore()
		if (!req) throw new Error('Request not found in context')
		const validated = v.validate(fn(req), input)
		return validated.valid ? validated.value : validated.error
	})

export const withResponse = <T extends Pipe<any, any>>(fn: (req: Response<RouteDefToReqRes<RouteDef>>) => T) =>
	v.define<PipeInput<T>, PipeOutput<T>>((input) => {
		const res = responseLocalStorage.getStore()
		if (!res) throw new Error('Response not found in context')
		const validated = v.validate(fn(res), input)
		return validated.valid ? validated.value : validated.error
	})
