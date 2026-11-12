export * from 'valleyed'
export * as ve from './valleyed.js'
import type { PipeError, Pipe, PipeOutput } from 'valleyed'
import { v } from 'valleyed'

import { ValidationError } from '../errors/index.js'

export function pipeErrorToValidationError(error: PipeError) {
	const errorsObject = error.messages.reduce<Record<string, { field: string; messages: string[] }>>(
		(acc, { path = '', message }) => {
			if (acc[path]) acc[path].messages.push(message)
			else acc[path] = { field: path, messages: [message] }
			return acc
		},
		{},
	)

	return new ValidationError(Object.values(errorsObject))
}

export function validate<T extends Pipe<unknown, unknown>>(pipe: T, value: unknown): PipeOutput<T> {
	const validity = v.validate(pipe, value)
	if (validity.valid) return validity.value
	throw pipeErrorToValidationError(validity.error)
}
