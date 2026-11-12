import type { FieldTypeName } from '../adapter.js'

export type ForeignKeyAction = 'cascade' | 'restrict' | 'setNull' | 'noAction'

export type DiscoveredField = {
	name: string
	type: FieldTypeName
	nullable: boolean
	default?: string | number | boolean | null
	unique?: boolean
}

export type DiscoveredIndex = {
	name: string
	on: ReadonlyArray<string>
	unique: boolean
}

export type DiscoveredForeignKey = {
	name: string
	on: string
	references: { table: string; column: string }
	onDelete?: ForeignKeyAction
	onUpdate?: ForeignKeyAction
}

export type DiscoveredSchema = {
	name: string
	pk?: { name: string; type: FieldTypeName }
	fields: ReadonlyArray<DiscoveredField>
	indexes: ReadonlyArray<DiscoveredIndex>
	foreignKeys: ReadonlyArray<DiscoveredForeignKey>
}
