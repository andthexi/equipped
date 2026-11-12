import type { OrmAdapterLike } from '../adapters/base.js'
import type { OrmAdapter } from '../orm-adapter.js'
import type { Repo } from '../repo/repo.js'

export type FieldSpec<A extends OrmAdapter> = {
	name: string
	type: A['supportedFieldTypes'][number]
	nullable?: boolean
	default?: string | number | boolean | null
	unique?: boolean
}

export type CreateTableChange<A extends OrmAdapter = OrmAdapter> = {
	kind: 'createTable'
	name: string
	pk: { name: string; type: A['supportedFieldTypes'][number] }
	fields: FieldSpec<A>[]
}

export type DropTableChange = {
	kind: 'dropTable'
	name: string
}

export type AddFieldChange<A extends OrmAdapter = OrmAdapter> = {
	kind: 'addField'
	table: string
	field: FieldSpec<A>
}

export type DropFieldChange = {
	kind: 'dropField'
	table: string
	name: string
}

export type ModifyFieldChange<A extends OrmAdapter = OrmAdapter> = {
	kind: 'modifyField'
	table: string
	name: string
	to: FieldSpec<A>
}

export type RenameTableChange = {
	kind: 'renameTable'
	from: string
	to: string
}

export type RenameFieldChange = {
	kind: 'renameField'
	table: string
	from: string
	to: string
}

export type AddIndexChange = {
	kind: 'addIndex'
	table: string
	on: ReadonlyArray<string>
	unique?: boolean
	name?: string
}

export type DropIndexChange = {
	kind: 'dropIndex'
	table: string
	name: string
}

export type AddForeignKeyChange = {
	kind: 'addForeignKey'
	table: string
	on: string
	references: { table: string; column: string }
	onDelete?: string
	onUpdate?: string
	name?: string
}

export type DropForeignKeyChange = {
	kind: 'dropForeignKey'
	table: string
	name: string
}

export type ExecuteChange<A extends OrmAdapterLike<any> = OrmAdapterLike<any>> = {
	kind: 'execute'
	up: (repo: Repo<A>) => Promise<void>
}

export type Change<A extends OrmAdapterLike<any> = OrmAdapterLike<any>> =
	| CreateTableChange<A extends OrmAdapter ? A : OrmAdapter>
	| DropTableChange
	| AddFieldChange<A extends OrmAdapter ? A : OrmAdapter>
	| DropFieldChange
	| ModifyFieldChange<A extends OrmAdapter ? A : OrmAdapter>
	| RenameTableChange
	| RenameFieldChange
	| AddIndexChange
	| DropIndexChange
	| AddForeignKeyChange
	| DropForeignKeyChange
	| ExecuteChange<A>

export type AnyFieldSpec = {
	name: string
	type: string
	nullable?: boolean
	default?: string | number | boolean | null
	unique?: boolean
}

export type AnyChange =
	| { kind: 'createTable'; name: string; pk: { name: string; type: string }; fields: AnyFieldSpec[] }
	| DropTableChange
	| { kind: 'addField'; table: string; field: AnyFieldSpec }
	| DropFieldChange
	| { kind: 'modifyField'; table: string; name: string; to: AnyFieldSpec }
	| RenameTableChange
	| RenameFieldChange
	| AddIndexChange
	| DropIndexChange
	| AddForeignKeyChange
	| DropForeignKeyChange
	| ExecuteChange<OrmAdapterLike<any>>

export type ApplyMethodKey<A> = Extract<keyof A, `apply${string}`>
export type KindFromMethod<M> = M extends `apply${infer K}` ? Uncapitalize<K> : never
type ConcreteApplyKey<A> = {
	[K in ApplyMethodKey<A>]: A[K] extends (...args: any) => any ? K : never
}[ApplyMethodKey<A>]
export type ChangeKindFor<A> = KindFromMethod<ConcreteApplyKey<A>> | 'execute'
export type ChangeFor<A extends OrmAdapterLike<any>> = Extract<Change<A>, { kind: ChangeKindFor<A> }>

export type AnyMigration = {
	id: string
	changes: ReadonlyArray<AnyChange>
	tx?: boolean
}

export type Migration<A extends OrmAdapterLike<any>> = {
	id: string
	changes: ReadonlyArray<ChangeFor<A>>
	tx?: boolean
}
