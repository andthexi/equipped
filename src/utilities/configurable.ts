import { v, type ConditionalObjectKeys, type Pipe, type PipeInput, type PipeOutput } from 'valleyed'

type CtorParams<T> = ConstructorParameters<T & (abstract new (...args: any[]) => any)>
type BaseCtorParams<T> = T extends abstract new (...args: infer A) => any ? A : never

export function configurable<P extends Pipe<any, any>, Base extends abstract new (...args: any[]) => any>(
	pipeFn: () => P,
	base: Base,
) {
	const pipe = pipeFn()
	v.compile(pipe)

	abstract class Configurable extends (base as unknown as new (...args: any[]) => any) {
		declare static readonly Config: PipeOutput<P>

		protected constructor(
			protected readonly config: PipeOutput<P>,
			...baseArgs: BaseCtorParams<Base>
		) {
			super(...baseArgs)
		}

		static create<This extends Function & { prototype: any }>(
			this: This,
			input: ConditionalObjectKeys<PipeInput<P>>,
			...args: CtorParams<This> extends [PipeOutput<P>, ...infer R] ? R : never
		): This['prototype'] {
			const r = v.validate(pipe, input)
			if (!r.valid) throw r.error
			return new (this as any)(r.value, ...args) as This['prototype']
		}
	}

	return Configurable as unknown as (abstract new (
		validated: PipeOutput<P>,
		...baseArgs: BaseCtorParams<Base>
	) => InstanceType<Base> & { readonly config: PipeOutput<P> }) & {
		readonly Config: PipeOutput<P>
		create<This extends Function & { prototype: any }>(
			this: This,
			input: ConditionalObjectKeys<PipeInput<P>>,
			...args: CtorParams<This> extends [PipeOutput<P>, ...infer R] ? R : never
		): This['prototype']
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf } = import.meta.vitest
	const { v } = await import('valleyed')

	const testPipe = () =>
		v.object({
			host: v.string(),
			port: v.number(),
		})

	type TestConfig = PipeOutput<ReturnType<typeof testPipe>>

	class TestBase {
		baseValue: string
		constructor() {
			this.baseValue = 'base'
		}
	}

	class TestBaseWithArgs {
		label: string
		constructor(label: string) {
			this.label = label
		}
	}

	describe('configurable', () => {
		test('validation runs in static create before constructor body executes', () => {
			let constructorRan = false

			const Wrapped = configurable(testPipe, TestBase)
			class MyClass extends Wrapped {
				protected constructor(config: typeof MyClass.Config) {
					super(config)
					constructorRan = true
				}
			}

			expect(() => MyClass.create({ host: 123, port: 'bad' } as any)).toThrow()
			expect(constructorRan).toBe(false)

			MyClass.create({ host: 'localhost', port: 3000 })
			expect(constructorRan).toBe(true)
		})

		test('constructor receives validated value', () => {
			const Wrapped = configurable(testPipe, TestBase)
			let receivedConfig: unknown

			class MyClass extends Wrapped {
				protected constructor(config: typeof MyClass.Config) {
					super(config)
					receivedConfig = this.config
				}
			}

			MyClass.create({ host: 'localhost', port: 3000 })

			expect(receivedConfig).toEqual({ host: 'localhost', port: 3000 })
		})

		test('external new is a compile error', () => {
			const Wrapped = configurable(testPipe, TestBase)
			class MyClass extends Wrapped {
				protected constructor(config: typeof MyClass.Config) {
					super(config)
				}
			}

			// @ts-expect-error — external `new` on a class with protected constructor is a compile error
			void (() => new MyClass({ host: 'localhost', port: 3000 }))
		})

		test('static Config resolves to PipeOutput<P> at the type level', () => {
			const Wrapped = configurable(testPipe, TestBase)
			class MyClass extends Wrapped {
				protected constructor(config: typeof MyClass.Config) {
					super(config)
				}
			}

			expectTypeOf<typeof MyClass.Config>().toEqualTypeOf<TestConfig>()
			expect(MyClass.create).toBeTypeOf('function')
		})

		test('ConstructorParameters<This>-based extras inference works for non-zero-arg leaf signatures', () => {
			const Wrapped = configurable(testPipe, TestBase)
			class MyClass extends Wrapped {
				extra: number
				protected constructor(config: typeof MyClass.Config, extra: number) {
					super(config)
					this.extra = extra
				}
			}

			const instance = MyClass.create({ host: 'localhost', port: 3000 }, 42)

			expect(instance.extra).toBe(42)
			expectTypeOf(instance).toHaveProperty('extra')
			expectTypeOf(instance.extra).toEqualTypeOf<number>()

			// @ts-expect-error — wrong extra type
			void (() => MyClass.create({ host: 'localhost', port: 3000 }, 'not-a-number'))
		})

		test('base-args forwarding works for non-zero-arg bases', () => {
			const Wrapped = configurable(testPipe, TestBaseWithArgs)
			class MyClass extends Wrapped {
				protected constructor(config: typeof MyClass.Config, label: string) {
					super(config, label)
				}
			}

			const instance = MyClass.create({ host: 'localhost', port: 3000 }, 'test-label')

			expect(instance.label).toBe('test-label')
		})

		test('config is accessible as protected readonly on instances', () => {
			const Wrapped = configurable(testPipe, TestBase)
			class MyClass extends Wrapped {
				protected constructor(config: typeof MyClass.Config) {
					super(config)
				}

				getHost() {
					return this.config.host
				}
			}

			const instance = MyClass.create({ host: 'localhost', port: 3000 })
			expect(instance.getHost()).toBe('localhost')
		})

		test('accepts an abstract base class', () => {
			abstract class AbstractBase {
				abstract greet(): string
			}

			const Wrapped = configurable(testPipe, AbstractBase)
			class Concrete extends Wrapped {
				protected constructor(config: typeof Concrete.Config) {
					super(config)
				}
				greet() {
					return `hello from ${this.config.host}`
				}
			}

			const instance = Concrete.create({ host: 'localhost', port: 3000 })
			expect(instance.greet()).toBe('hello from localhost')
			expectTypeOf(instance).toHaveProperty('config')
		})
	})
}
