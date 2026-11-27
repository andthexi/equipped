import type { Pipe } from 'valleyed'

import { EquippedError } from '../../../errors/index.js'
import { validateComputedOutput } from '../../schema-validations.js'
import type { AnySchema } from '../../schema.js'

export type ComputedSelectionPlan = {
	requestedSelect: Set<string> | null
	adapterSelect?: string[]
	computeNames: string[]
}

export function planSelection(
	schema: AnySchema,
	select?: readonly string[],
	additionallyRequired: readonly string[] = [],
): ComputedSelectionPlan {
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

	for (const field of additionallyRequired) adapterSelect.add(field)

	return {
		requestedSelect,
		adapterSelect: [...adapterSelect],
		computeNames: [...selectedComputeNames],
	}
}

type ComputedDef = {
	output: Pipe<any, any>
	deps: readonly string[]
	compute: (data: Record<string, unknown>) => unknown
}

export function applyComputedSelection(
	schema: AnySchema,
	rows: Record<string, unknown>[],
	plan: ComputedSelectionPlan,
	operation: string,
): Record<string, unknown>[] {
	const computedDefs = schema.computedDefs as Record<string, ComputedDef>

	return rows.map((row, rowIndex) => {
		const enriched: Record<string, unknown> = { ...row }
		for (const computeName of plan.computeNames) {
			const def = computedDefs[computeName]
			const depInput: Record<string, unknown> = {}
			for (const dep of def.deps) depInput[dep] = row[dep]

			const computedValue = def.compute(depInput)
			enriched[computeName] = validateComputedOutput(
				schema,
				computeName,
				def.output,
				computedValue,
				operation,
				rowIndex,
			)
		}
		return enriched
	})
}

export function applyRequestedProjection(
	rows: Record<string, unknown>[],
	plan: ComputedSelectionPlan,
	includedFields: readonly string[] = [],
): Record<string, unknown>[] {
	if (!plan.requestedSelect) return rows

	const projection = new Set([...plan.requestedSelect, ...includedFields])
	return rows.map((row) => {
		const projected: Record<string, unknown> = {}
		for (const key of projection) {
			if (key in row) projected[key] = row[key]
		}
		return projected
	})
}
