import type { Pipe, PipeInput, PipeOutput } from 'valleyed'

import { EquippedError } from '../../errors/index.js'

export type EventContext = {
	key: string
	name: string
	ts: number
	body: unknown
	by: string | null
	at: Date
	firstRun: boolean
}

export type HandlerDef<P extends Pipe<any, any> = Pipe<any, any>, R = unknown> = {
	pipe: P
	handle: (payload: PipeOutput<P>, ctx: EventContext) => R | Promise<R>
}

export type FireFn<P extends Pipe<any, any>, R> = (
	payload: PipeInput<P>,
	ctx?: { by?: string; at?: Date },
) => Promise<R>

export class HandlerRegistry {
	readonly #handlers = new Map<string, HandlerDef>()
	readonly #order: string[] = []

	register(name: string, def: HandlerDef): void {
		if (this.#handlers.has(name)) {
			throw new EquippedError(`EventLog handler "${name}" is already registered`, { name })
		}
		this.#handlers.set(name, def)
		this.#order.push(name)
	}

	get(name: string): HandlerDef {
		const def = this.#handlers.get(name)
		if (!def) {
			throw new EquippedError(`EventLog handler "${name}" is not registered`, { name })
		}
		return def
	}

	list(): string[] {
		return [...this.#order]
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { v } = await import('valleyed')
	const { EquippedError } = await import('../../errors/index.js')

	describe('HandlerRegistry', () => {
		test('register and get a handler', () => {
			const registry = new HandlerRegistry()
			const def: HandlerDef = { pipe: v.string(), handle: () => {} }
			registry.register('user.signup', def)
			expect(registry.get('user.signup')).toBe(def)
		})

		test('register duplicate name throws', () => {
			const registry = new HandlerRegistry()
			const def: HandlerDef = { pipe: v.string(), handle: () => {} }
			registry.register('user.signup', def)
			expect(() => registry.register('user.signup', def)).toThrow(EquippedError)
			expect(() => registry.register('user.signup', def)).toThrow('already registered')
		})

		test('get missing name throws', () => {
			const registry = new HandlerRegistry()
			expect(() => registry.get('nonexistent')).toThrow(EquippedError)
			expect(() => registry.get('nonexistent')).toThrow('not registered')
		})

		test('list returns names in registration order', () => {
			const registry = new HandlerRegistry()
			registry.register('c', { pipe: v.string(), handle: () => {} })
			registry.register('a', { pipe: v.string(), handle: () => {} })
			registry.register('b', { pipe: v.string(), handle: () => {} })
			expect(registry.list()).toEqual(['c', 'a', 'b'])
		})

		test('list returns a copy, not a reference', () => {
			const registry = new HandlerRegistry()
			registry.register('x', { pipe: v.string(), handle: () => {} })
			const list = registry.list()
			list.push('y')
			expect(registry.list()).toEqual(['x'])
		})
	})
}
