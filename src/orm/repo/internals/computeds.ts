import { v, type Pipe } from 'valleyed'

import { EquippedError } from '../../../errors/index.js'
import type { AnySchema } from '../../schema.js'

export type ComputedSelectionPlan = {
	requestedSelect: Set<string> | null
	adapterSelect?: string[]
	computeNames: string[]
}

export function planSelection(schema: AnySchema, select?: readonly string[]): ComputedSelectionPlan {
	const computedDefs = schema.computedDefs as Record<string, { deps: readonly string[] }>
	const computedNames = new Set(Object.keys(computedDefs))
	const persistedNames = new Set(Object.keys(schema.fields))

	if (!select || select.length === 0) {
		return {
			requestedSelect: null,
			adapterSelect: undefined,
			computeNames: [...computedNames],
		}
	}

	const requestedSelect = new Set(select)
	const adapterSelect = new Set<string>()
	const selectedComputeNames = new Set<string>()

	for (const key of select) {
		if (persistedNames.has(key)) {
			adapterSelect.add(key)
			continue
		}
		if (computedNames.has(key)) {
			selectedComputeNames.add(key)
			for (const dep of computedDefs[key].deps) adapterSelect.add(dep)
			continue
		}
		throw new EquippedError('Unknown selected field', {
			schema: schema.name,
			selectedField: key,
			availableFields: [...persistedNames, ...computedNames],
		})
	}

	return {
		requestedSelect,
		adapterSelect: [...adapterSelect],
		computeNames: [...selectedComputeNames],
	}
}

type ComputedDef = {
	pipe: Pipe<any, any>
	deps: readonly string[]
	compute: (data: Record<string, unknown>) => unknown
}

export function applyComputedSelection(
	schema: AnySchema,
	rows: Record<string, unknown>[],
	plan: ComputedSelectionPlan,
): Record<string, unknown>[] {
	const computedDefs = schema.computedDefs as Record<string, ComputedDef>

	return rows.map((row) => {
		const enriched: Record<string, unknown> = { ...row }
		for (const computeName of plan.computeNames) {
			const def = computedDefs[computeName]
			const depInput: Record<string, unknown> = {}
			for (const dep of def.deps) {
				if (!(dep in row)) {
					throw new EquippedError('Computed field dependency missing from adapter result', {
						schema: schema.name,
						computedField: computeName,
						dependency: dep,
						dependencies: def.deps,
					})
				}
				depInput[dep] = row[dep]
			}
			const r = v.validate(def.pipe, def.compute(depInput))
			if (!r.valid)
				throw new EquippedError('Computed field validation failed', {
					schema: schema.name,
					computedField: computeName,
					cause: r.error,
				})
			enriched[computeName] = r.value
		}

		if (!plan.requestedSelect) return enriched

		const shaped: Record<string, unknown> = {}
		for (const key of plan.requestedSelect) {
			if (key in enriched) shaped[key] = enriched[key]
		}
		return shaped
	})
}
