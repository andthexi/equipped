import type { Collection, Filter } from 'mongodb'
import { differ } from 'valleyed'

import { EquippedError } from '../../../errors/index.js'
import { Instance } from '../../../instance/index.js'
import { retry } from '../../../utilities/index.js'
import { DbChange, TopicPrefix } from '../base/changes.js'
import type * as core from '../base/core.js'
import type { DbChangeConfig } from '../base/types.js'
import type { MongoDbConfig } from './pipes.js'

export class MongoDbChange<Model extends core.Model<{ _id: string }>, Entity extends core.Entity> extends DbChange<
	Model,
	Entity
> {
	#started = false

	constructor(
		config: MongoDbConfig,
		change: DbChangeConfig,
		collection: Collection<Model>,
		callbacks: core.DbChangeCallbacks<Model, Entity>,
		mapper: (model: Model) => Entity,
	) {
		super(change, callbacks, mapper)

		const hydrate = (data: any) =>
			data._id
				? {
						...data,
						_id: data._id['$oid'] ?? data._id,
					}
				: undefined

		const dbName = collection.dbName
		const colName = collection.collectionName
		const dbColName = `${dbName}.${colName}`
		const topic = `${TopicPrefix}.${dbColName}`

		const TestId = '5f5f65717569707065645f5f' // __equipped__
		const condition = { _id: TestId } as Filter<Model>

		change.eventBus.stream(topic as never, { skipScope: true }).subscribe(async (data: DbDocumentChange) => {
			const op = data.op

			let before = JSON.parse(data.before ?? 'null')
			let after = JSON.parse(data.after ?? 'null')

			if (before) before = hydrate(before)
			if (after) after = hydrate(after)
			if (before?._id === TestId || after?._id === TestId) return

			if (op === 'c' && this.callbacks.created && after)
				await this.callbacks.created({
					before: null,
					after: this.mapper(after)!,
				})
			else if (op === 'u' && this.callbacks.updated && before && after)
				await this.callbacks.updated({
					before: this.mapper(before)!,
					after: this.mapper(after)!,
					changes: differ.from(differ.diff(before, after)),
				})
			else if (op === 'd' && this.callbacks.deleted && before)
				await this.callbacks.deleted({
					before: this.mapper(before)!,
					after: null,
				})
		})

		Instance.on('start', async () => {
			if (this.#started) return
			this.#started = true

			await retry(
				async () => {
					const started = await this.configureConnector(topic, {
						'connector.class': 'io.debezium.connector.mongodb.MongoDbConnector',
						'capture.mode': 'change_streams_update_full_with_pre_image',
						'mongodb.connection.string': config.uri,
						'collection.include.list': dbColName,
						'snapshot.mode': 'when_needed',
						'capture.scope': 'collection',
						'capture.target': dbColName,
						'heartbeat.interval.ms': '60000',
						'errors.max.retries': '3',
					})

					if (started) return { done: true, value: true }
					await collection.findOneAndUpdate(condition, { $set: { colName } as any }, { upsert: true })
					await collection.findOneAndDelete(condition)
					Instance.get().log.warn(`Waiting for db changes for ${dbColName} to start...`)
					return { done: false }
				},
				6,
				30_000,
			).catch((err) => Instance.crash(new EquippedError(`Failed to start db changes`, { dbColName }, err)))
		})
	}
}

type DbDocumentChange = {
	before: string | null
	after: string | null
	op: 'c' | 'u' | 'd'
}
