import { Instance } from '../../../instance/index.js'
import type * as core from './core.js'
import type { DbConfig } from './types.js'

export type TableOptions = { skipAudit?: boolean }

export abstract class Db<IdKey extends core.IdType> {
	constructor(protected config: DbConfig) {}

	protected getScopedDb(db: string) {
		return Instance.get().getScopedName(db).replaceAll('.', '-')
	}

	abstract use<Model extends core.Model<IdKey>, Entity extends core.Entity>(
		config: core.Config<Model, Entity>,
	): core.Table<IdKey, Model, Entity>

	abstract session<T>(callback: () => Promise<T>): Promise<T>
}
