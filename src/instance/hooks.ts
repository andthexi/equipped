export type HookEvent = 'setup' | 'start' | 'close'
export type HookCb = Promise<unknown | void> | (() => void | unknown | Promise<void | unknown>)

export type ClassRef = Function & { prototype: unknown; name: string }
export type HookOptions = {
	class?: ClassRef
	after?: ClassRef[]
}
export type HookRecord = { cb: HookCb; class?: ClassRef; after: ClassRef[] }

export function registerHook(hooks: HookRecord[], record: HookRecord): void {
	for (const dep of record.after) {
		if (!hooks.some((h) => h.class === dep)) {
			const depName = dep.name || 'unknown'
			const ownerName = record.class?.name || 'anonymous'
			throw new Error(
				`Missing dependency: ${ownerName} declares after: [${depName}], but ${depName} is not registered`,
			)
		}
	}

	if (record.class) {
		const tentative = [...hooks, record]
		detectCycle(tentative)
	}

	hooks.push(record)
}

function detectCycle(hooks: HookRecord[]): void {
	const classToAfter = new Map<ClassRef, ClassRef[]>()
	for (const h of hooks) {
		if (!h.class) continue
		const existing = classToAfter.get(h.class)
		if (existing) {
			for (const dep of h.after) {
				if (!existing.includes(dep)) existing.push(dep)
			}
		} else {
			classToAfter.set(h.class, [...h.after])
		}
	}

	const visited = new Set<ClassRef>()
	const stack = new Set<ClassRef>()

	function visit(cls: ClassRef, path: ClassRef[]): void {
		if (stack.has(cls)) {
			const cycleStart = path.indexOf(cls)
			const cycle = [...path.slice(cycleStart), cls]
			const names = cycle.map((c) => c.name || 'unknown')
			throw new Error(`Cycle detected: ${names.join(' → ')}`)
		}
		if (visited.has(cls)) return
		stack.add(cls)
		path.push(cls)
		for (const dep of classToAfter.get(cls) ?? []) {
			visit(dep, path)
		}
		path.pop()
		stack.delete(cls)
		visited.add(cls)
	}

	for (const cls of classToAfter.keys()) {
		visit(cls, [])
	}
}

export type HookLayer = HookRecord[]

export function resolveHookDAG(hooks: HookRecord[], invert: boolean = false): HookLayer[] {
	if (hooks.length === 0) return []

	const classToHooks = new Map<ClassRef, HookRecord[]>()
	const anonymous: HookRecord[] = []

	for (const h of hooks) {
		if (h.class) {
			const list = classToHooks.get(h.class)
			if (list) list.push(h)
			else classToHooks.set(h.class, [h])
		} else {
			anonymous.push(h)
		}
	}

	const classes = [...classToHooks.keys()]

	const inDegree = new Map<ClassRef, number>()
	const graph = new Map<ClassRef, ClassRef[]>()

	for (const cls of classes) {
		inDegree.set(cls, 0)
		graph.set(cls, [])
	}

	for (const h of hooks) {
		if (!h.class) continue
		for (const dep of h.after) {
			const [from, to] = invert ? [h.class, dep] : [dep, h.class]
			const edges = graph.get(from)!
			if (!edges.includes(to)) {
				edges.push(to)
				inDegree.set(to, inDegree.get(to)! + 1)
			}
		}
	}

	const layers: HookLayer[] = []
	let queue = classes.filter((c) => inDegree.get(c) === 0)

	while (queue.length > 0) {
		const layer: HookRecord[] = []
		const next: ClassRef[] = []

		for (const cls of queue) {
			layer.push(...(classToHooks.get(cls) ?? []))
		}
		layers.push(layer)

		for (const cls of queue) {
			for (const neighbor of graph.get(cls) ?? []) {
				const d = inDegree.get(neighbor)! - 1
				inDegree.set(neighbor, d)
				if (d === 0) next.push(neighbor)
			}
		}

		queue = next
	}

	if (anonymous.length > 0) {
		const anonWithDeps = anonymous.filter((h) => h.after.length > 0)
		const anonWithoutDeps = anonymous.filter((h) => h.after.length === 0)

		if (anonWithDeps.length > 0) {
			let maxLayer = -1
			for (const h of anonWithDeps) {
				for (const dep of h.after) {
					const depLayer = layers.findIndex((l) => l.some((r) => r.class === dep))
					if (depLayer > maxLayer) maxLayer = depLayer
				}
			}
			const insertAt = maxLayer + 1
			if (insertAt < layers.length) {
				layers[insertAt].push(...anonWithDeps)
			} else {
				layers.push(anonWithDeps)
			}
		}

		if (anonWithoutDeps.length > 0) {
			if (layers.length > 0) {
				layers[layers.length - 1].push(...anonWithoutDeps)
			} else {
				layers.push(anonWithoutDeps)
			}
		}
	}

	return layers
}

export async function runHooks(
	hooks: HookRecord[],
	onError: (error: Error) => void = (error) => {
		throw error
	},
	invert: boolean = false,
) {
	const layers = resolveHookDAG(hooks, invert)
	for (const layer of layers)
		await Promise.all(
			layer.map(async (h) => {
				try {
					if (typeof h.cb === 'function') return await h.cb()
					return await h.cb
				} catch (error) {
					return onError(error instanceof Error ? error : new Error(`${error}`))
				}
			}),
		)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	class A {}
	class B {}
	class C {}
	class D {}

	const noop = () => {}

	describe('registerHook', () => {
		test('registers a hook with no dependencies', () => {
			const hooks: HookRecord[] = []
			registerHook(hooks, { cb: noop, class: A, after: [] })
			expect(hooks).toHaveLength(1)
		})

		test('throws on missing dependency', () => {
			const hooks: HookRecord[] = []
			expect(() => registerHook(hooks, { cb: noop, class: B, after: [A] })).toThrow(/Missing dependency.*B.*A/)
		})

		test('throws on cycle: A→B→A', () => {
			const hooks: HookRecord[] = []
			registerHook(hooks, { cb: noop, class: A, after: [] })
			registerHook(hooks, { cb: noop, class: B, after: [A] })
			expect(() => registerHook(hooks, { cb: noop, class: A, after: [B] })).toThrow(/Cycle detected/)
		})

		test('throws on transitive cycle: A→B→C→A', () => {
			const hooks: HookRecord[] = []
			registerHook(hooks, { cb: noop, class: A, after: [] })
			registerHook(hooks, { cb: noop, class: B, after: [A] })
			registerHook(hooks, { cb: noop, class: C, after: [B] })
			expect(() => registerHook(hooks, { cb: noop, class: A, after: [C] })).toThrow(/Cycle detected/)
		})

		test('allows anonymous hooks with dependencies', () => {
			const hooks: HookRecord[] = []
			registerHook(hooks, { cb: noop, class: A, after: [] })
			registerHook(hooks, { cb: noop, after: [A] })
			expect(hooks).toHaveLength(2)
		})

		test('anonymous hook throws on missing dependency', () => {
			const hooks: HookRecord[] = []
			expect(() => registerHook(hooks, { cb: noop, after: [A] })).toThrow(/Missing dependency.*anonymous.*A/)
		})
	})

	describe('resolveHookDAG', () => {
		test('linear chain: A → B → C', () => {
			const hooks: HookRecord[] = [
				{ cb: noop, class: A, after: [] },
				{ cb: noop, class: B, after: [A] },
				{ cb: noop, class: C, after: [B] },
			]
			const layers = resolveHookDAG(hooks)
			expect(layers).toHaveLength(3)
			expect(layers[0].every((h) => h.class === A)).toBe(true)
			expect(layers[1].every((h) => h.class === B)).toBe(true)
			expect(layers[2].every((h) => h.class === C)).toBe(true)
		})

		test('fan-out: A → B, A → C (B and C are parallel)', () => {
			const hooks: HookRecord[] = [
				{ cb: noop, class: A, after: [] },
				{ cb: noop, class: B, after: [A] },
				{ cb: noop, class: C, after: [A] },
			]
			const layers = resolveHookDAG(hooks)
			expect(layers).toHaveLength(2)
			expect(layers[0].every((h) => h.class === A)).toBe(true)
			const secondClasses = layers[1].map((h) => h.class)
			expect(secondClasses).toContain(B)
			expect(secondClasses).toContain(C)
		})

		test('fan-in: B → D, C → D', () => {
			const hooks: HookRecord[] = [
				{ cb: noop, class: B, after: [] },
				{ cb: noop, class: C, after: [] },
				{ cb: noop, class: D, after: [B, C] },
			]
			const layers = resolveHookDAG(hooks)
			expect(layers).toHaveLength(2)
			const firstClasses = layers[0].map((h) => h.class)
			expect(firstClasses).toContain(B)
			expect(firstClasses).toContain(C)
			expect(layers[1].every((h) => h.class === D)).toBe(true)
		})

		test('diamond: A → B, A → C, B → D, C → D', () => {
			const hooks: HookRecord[] = [
				{ cb: noop, class: A, after: [] },
				{ cb: noop, class: B, after: [A] },
				{ cb: noop, class: C, after: [A] },
				{ cb: noop, class: D, after: [B, C] },
			]
			const layers = resolveHookDAG(hooks)
			expect(layers).toHaveLength(3)
			expect(layers[0][0].class).toBe(A)
			const midClasses = layers[1].map((h) => h.class)
			expect(midClasses).toContain(B)
			expect(midClasses).toContain(C)
			expect(layers[2][0].class).toBe(D)
		})

		test('close-event inversion reverses the graph', () => {
			const hooks: HookRecord[] = [
				{ cb: noop, class: A, after: [] },
				{ cb: noop, class: B, after: [A] },
				{ cb: noop, class: C, after: [B] },
			]
			const layers = resolveHookDAG(hooks, true)
			expect(layers).toHaveLength(3)
			expect(layers[0].every((h) => h.class === C)).toBe(true)
			expect(layers[1].every((h) => h.class === B)).toBe(true)
			expect(layers[2].every((h) => h.class === A)).toBe(true)
		})

		test('close inversion: fan-out becomes fan-in', () => {
			const hooks: HookRecord[] = [
				{ cb: noop, class: A, after: [] },
				{ cb: noop, class: B, after: [A] },
				{ cb: noop, class: C, after: [A] },
			]
			const layers = resolveHookDAG(hooks, true)
			expect(layers).toHaveLength(2)
			const firstClasses = layers[0].map((h) => h.class)
			expect(firstClasses).toContain(B)
			expect(firstClasses).toContain(C)
			expect(layers[1].every((h) => h.class === A)).toBe(true)
		})

		test('multiple hooks per class are all in the same layer', () => {
			const cb1 = () => {}
			const cb2 = () => {}
			const hooks: HookRecord[] = [
				{ cb: cb1, class: A, after: [] },
				{ cb: cb2, class: A, after: [] },
				{ cb: noop, class: B, after: [A] },
			]
			const layers = resolveHookDAG(hooks)
			expect(layers).toHaveLength(2)
			expect(layers[0]).toHaveLength(2)
			expect(layers[0].every((h) => h.class === A)).toBe(true)
		})

		test('anonymous hooks without deps run at deepest level', () => {
			const hooks: HookRecord[] = [
				{ cb: noop, class: A, after: [] },
				{ cb: noop, class: B, after: [A] },
				{ cb: noop, after: [] },
			]
			const layers = resolveHookDAG(hooks)
			expect(layers).toHaveLength(2)
			const lastLayer = layers[layers.length - 1]
			expect(lastLayer.some((h) => h.class === undefined)).toBe(true)
		})

		test('anonymous hooks with deps run after their dependencies', () => {
			const hooks: HookRecord[] = [
				{ cb: noop, class: A, after: [] },
				{ cb: noop, class: B, after: [A] },
				{ cb: noop, class: C, after: [B] },
				{ cb: noop, after: [A] },
			]
			const layers = resolveHookDAG(hooks)
			const anonLayer = layers.findIndex((l) => l.some((h) => h.class === undefined))
			const aLayer = layers.findIndex((l) => l.some((h) => h.class === A))
			expect(anonLayer).toBeGreaterThan(aLayer)
		})

		test('empty hooks returns empty layers', () => {
			expect(resolveHookDAG([])).toEqual([])
		})
	})

	describe('runHooks', () => {
		test('same-depth siblings observably overlap', async () => {
			const log: string[] = []
			const hooks: HookRecord[] = [
				{
					cb: async () => {
						log.push('B-start')
						await new Promise((r) => setTimeout(r, 20))
						log.push('B-end')
					},
					class: B,
					after: [],
				},
				{
					cb: async () => {
						log.push('C-start')
						await new Promise((r) => setTimeout(r, 20))
						log.push('C-end')
					},
					class: C,
					after: [],
				},
			]
			await runHooks(hooks)
			expect(log[0]).toBe('B-start')
			expect(log[1]).toBe('C-start')
		})

		test('different depths run sequentially', async () => {
			const log: string[] = []
			const hooks: HookRecord[] = [
				{
					cb: async () => {
						log.push('A')
					},
					class: A,
					after: [],
				},
				{
					cb: async () => {
						log.push('B')
					},
					class: B,
					after: [A],
				},
			]
			await runHooks(hooks)
			expect(log).toEqual(['A', 'B'])
		})

		test('close inversion runs hooks in reverse dependency order', async () => {
			const log: string[] = []
			const hooks: HookRecord[] = [
				{ cb: async () => log.push('A'), class: A, after: [] },
				{ cb: async () => log.push('B'), class: B, after: [A] },
				{ cb: async () => log.push('C'), class: C, after: [B] },
			]
			await runHooks(hooks, undefined, true)
			expect(log).toEqual(['C', 'B', 'A'])
		})

		test('errors are routed to onError handler', async () => {
			const errors: Error[] = []
			const hooks: HookRecord[] = [
				{
					cb: () => {
						throw new Error('boom')
					},
					class: A,
					after: [],
				},
			]
			await runHooks(hooks, (e) => {
				errors.push(e)
			})
			expect(errors).toHaveLength(1)
			expect(errors[0].message).toBe('boom')
		})

		test('raw promise callbacks are awaited', async () => {
			const log: string[] = []
			const hooks: HookRecord[] = [
				{
					cb: Promise.resolve().then(() => log.push('resolved')),
					class: A,
					after: [],
				},
			]
			await runHooks(hooks)
			expect(log).toContain('resolved')
		})
	})
}
