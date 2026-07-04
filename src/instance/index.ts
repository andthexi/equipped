import pino, { type Logger } from 'pino'
import { ulid } from 'ulid'
import { type Pipe, v } from 'valleyed'

import { EquippedError } from '../errors'
import { type ClassRef, type HookCb, type HookEvent, type HookOptions, type HookRecord, registerHook, runHooks } from './hooks'
import { instanceSettingsPipe, type Settings, type SettingsInput } from './settings'

export type { ClassRef, HookCb, HookEvent, HookOptions }

export class Instance {
	static #id: string | undefined
	static #instance: Instance | undefined
	static #hooks: Partial<Record<HookEvent, HookRecord[]>> = {}
	readonly settings: Readonly<Settings>
	readonly log: Logger<never>
	#closed = false
	#closing: Promise<void> | null = null

	private constructor(settings: Settings) {
		Instance.#instance = this
		this.settings = Object.freeze(settings)
		this.log = pino<never>({
			level: this.settings.log.level,
			serializers: {
				err: pino.stdSerializers.err,
				error: pino.stdSerializers.err,
				req: pino.stdSerializers.req,
				res: pino.stdSerializers.res,
			},
			mixin: () => ({
				instanceId: Instance.#id,
			}),
		})
		Instance.#registerOnExitHandler()
	}

	alias(id: string) {
		if (Instance.#id !== undefined) return Instance.crash(new EquippedError('Instance already has an alias', {}))
		Instance.#id = id
	}

	get id() {
		if (Instance.#id === undefined) return Instance.crash(new EquippedError('Instance doesnt have an alias yet', {}))
		return Instance.#id
	}

	getScopedName(name: string, key = '.') {
		return [this.settings.app.name, name].join(key)
	}

	async start() {
		try {
			await runHooks(Instance.#hooks['setup'] ?? [])
			await runHooks(Instance.#hooks['start'] ?? [])
		} catch (error) {
			Instance.crash(new EquippedError(`Error starting instance`, {}, error))
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closing ??= runHooks(Instance.#hooks['close'] ?? [], () => {}, true).then(() => {
			this.#closed = true
		})
		return this.#closing
	}

	static envs<E extends object>(envsPipe: Pipe<unknown, E>): E {
		const envValidity = v.validate(envsPipe, process.env)
		if (!envValidity.valid) {
			Instance.crash(
				new EquippedError(`Environment variables are not valid\n${envValidity.error.toString()}`, {
					messages: envValidity.error.messages,
				}),
			)
		}
		return envValidity.value
	}

	static create(settings: SettingsInput) {
		if (Instance.#instance) return Instance.crash(new EquippedError('Instance has been initialized already', {}))
		const settingsValidity = v.validate(instanceSettingsPipe(), settings)
		if (!settingsValidity.valid) {
			Instance.crash(
				new EquippedError(`Settings are not valid\n${settingsValidity.error.toString()}`, {
					messages: settingsValidity.error.messages,
				}),
			)
		}
		return new Instance(settingsValidity.value)
	}

	static get() {
		if (!Instance.#instance)
			return Instance.crash(
				new EquippedError('Has not been initialized. Make sure an instance has been created before you get an instance', {}),
			)
		return Instance.#instance
	}

	static maybeGet() {
		return Instance.#instance
	}

	static on(event: HookEvent, cb: HookCb, options?: HookOptions) {
		Instance.#hooks[event] ??= []
		const record: HookRecord = { cb, class: options?.class, after: options?.after ?? [] }
		registerHook(Instance.#hooks[event], record)
	}

	static #registerOnExitHandler() {
		const signals = {
			SIGHUP: 1,
			SIGINT: 2,
			SIGTERM: 15,
		}

		Object.entries(signals).forEach(([signal, code]) => {
			process.on(signal, async () => {
				await Instance.get().close()
				process.exit(128 + code)
			})
		})
	}

	static resolveBeforeCrash<T>(cb: () => Promise<T>) {
		const value = cb()
		Instance.on('close', async () => await value)
		return value
	}

	static crash(error: EquippedError): never {
		// eslint-disable-next-line no-console
		console.error(error)
		process.exit(1)
	}

	static createId(opts?: { prefix?: string; time?: Date }) {
		return `${opts?.prefix ?? ''}${ulid(opts?.time?.getTime())}`
	}
}

if (import.meta.vitest) {
	const { describe, expect, it } = import.meta.vitest

	describe('Instance close', () => {
		it('runs close hooks through public close without exiting and does not run them twice', async () => {
			const instance = Instance.maybeGet() ?? Instance.create({ app: { name: 'instance-close-test' }, log: { level: 'silent' } })
			let callCount = 0

			Instance.on('close', () => {
				callCount += 1
			})

			await instance.close()
			await instance.close()

			expect(callCount).toBe(1)
		})
	})
}
