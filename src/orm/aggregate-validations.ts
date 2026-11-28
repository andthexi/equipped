import { PipeError } from 'valleyed'

import { OrmValidationError, type OrmValidationFailure } from './errors/index.js'
import type { AggregateSpec } from './orm-adapter.js'
import { validateFieldOutput } from './schema-validations.js'
import type { AnySchema } from './schema.js'

function failure(cause: unknown, rowIndex?: number, field?: string, alias?: string): OrmValidationFailure {
	return {
		cause,
		...(rowIndex === undefined ? {} : { rowIndex }),
		...(field === undefined ? {} : { field }),
		...(alias === undefined ? {} : { alias }),
	}
}

export function validateNonNegativeSafeIntegerOutput(schema: AnySchema, value: unknown, operation: string): number {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value

	throw new OrmValidationError('output', schema.name, operation, [
		failure(PipeError.root('Expected a nonnegative safe integer output', value)),
	])
}

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key)
}

function validateNumericAggregate(
	value: unknown,
	aggregate: AggregateSpec['aggregates'][number],
	rowIndex: number,
	failures: OrmValidationFailure[],
): unknown {
	if (aggregate.fn === 'count' || aggregate.fn === 'countDistinct') {
		if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
		failures.push(
			failure(
				PipeError.root('Expected a nonnegative safe integer output', value),
				rowIndex,
				undefined,
				aggregate.alias,
			),
		)
		return undefined
	}

	if (value === null && (aggregate.fn === 'sum' || aggregate.fn === 'avg')) return null
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		failures.push(
			failure(
				PipeError.root('Expected a finite number or null output', value),
				rowIndex,
				undefined,
				aggregate.alias,
			),
		)
		return undefined
	}
	return value
}

export function validateAggregateOutput(
	schema: AnySchema,
	spec: AggregateSpec,
	value: unknown,
): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) {
		throw new OrmValidationError('output', schema.name, 'aggregate', [
			failure('Expected an aggregate result array'),
		])
	}

	const grouped = spec.groupBy.length > 0
	const hasHaving = (spec.having?.children.length ?? 0) > 0
	if (!grouped && ((!hasHaving && value.length !== 1) || (hasHaving && value.length > 1))) {
		const expected = hasHaving ? 'at most one ungrouped result row' : 'exactly one ungrouped result row'
		throw new OrmValidationError('output', schema.name, 'aggregate', [
			failure(PipeError.root(`Expected ${expected}`, value)),
		])
	}

	const results: Record<string, unknown>[] = []
	const failures: OrmValidationFailure[] = []

	for (let rowIndex = 0; rowIndex < value.length; rowIndex++) {
		const row = value[rowIndex]
		if (row === null || typeof row !== 'object' || Array.isArray(row)) {
			failures.push(failure(PipeError.root('Expected an aggregate result object', row), rowIndex))
			continue
		}

		const entries: Array<[string, unknown]> = []
		for (const field of spec.groupBy) {
			const raw = hasOwn(row, field) ? (row as Record<string, unknown>)[field] : undefined
			try {
				entries.push([field, validateFieldOutput(schema, field, raw, 'aggregate', rowIndex)])
			} catch (error) {
				if (!(error instanceof OrmValidationError)) throw error
				failures.push(...error.failures.map((item) => ({ ...item, rowIndex })))
			}
		}

		for (const aggregate of spec.aggregates) {
			if (!hasOwn(row, aggregate.alias)) {
				failures.push(failure('Missing aggregate alias output', rowIndex, undefined, aggregate.alias))
				continue
			}
			const raw = (row as Record<string, unknown>)[aggregate.alias]
			if (aggregate.fn === 'min' || aggregate.fn === 'max') {
				if (raw === null) {
					entries.push([aggregate.alias, null])
				} else if (raw === undefined) {
					failures.push(
						failure('Expected a source-field output or null', rowIndex, undefined, aggregate.alias),
					)
				} else {
					try {
						entries.push([
							aggregate.alias,
							validateFieldOutput(schema, aggregate.field!, raw, 'aggregate', rowIndex),
						])
					} catch (error) {
						if (!(error instanceof OrmValidationError)) throw error
						failures.push(...error.failures.map((item) => ({ ...item, alias: aggregate.alias, rowIndex })))
					}
				}
			} else {
				const validated = validateNumericAggregate(raw, aggregate, rowIndex, failures)
				if (validated !== undefined || raw === null) entries.push([aggregate.alias, validated])
			}
		}
		results.push(Object.fromEntries(entries))
	}

	if (failures.length > 0) throw new OrmValidationError('output', schema.name, 'aggregate', failures)
	return results
}
