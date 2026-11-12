import axios from 'axios'
import { v } from 'valleyed'

import { EquippedError } from '../../../errors/index.js'
import type * as core from './core.js'
import { dbChangeConfigPipe, type DbChangeConfig } from './types.js'

export const TopicPrefix = 'db-changes'

export abstract class DbChange<Model extends core.Model<core.IdType>, Entity extends core.Entity> {
	constructor(
		protected config: DbChangeConfig,
		protected callbacks: core.DbChangeCallbacks<Model, Entity>,
		protected mapper: (model: Model) => Entity,
	) {
		this.config = v.assert(dbChangeConfigPipe(), config)
	}

	protected async configureConnector(key: string, data: Record<string, string>) {
		const instance = axios.create({ baseURL: this.config.debeziumUrl })
		return await instance
			.put(`/connectors/${key}/config`, {
				'topic.prefix': TopicPrefix,
				'topic.creation.enable': 'false',
				'topic.creation.default.replication.factor': `-1`,
				'topic.creation.default.partitions': '-1',
				'key.converter': 'org.apache.kafka.connect.json.JsonConverter',
				'key.converter.schemas.enable': 'false',
				'value.converter': 'org.apache.kafka.connect.json.JsonConverter',
				'value.converter.schemas.enable': 'false',
				...data,
			})
			.then(async () => {
				const topics = await instance.get(`/connectors/${key}/topics`)
				return topics.data[key]?.topics?.includes?.(key) ?? false
			})
			.catch((err) => {
				throw new EquippedError(`Failed to configure watcher`, { key }, err)
			})
	}
}
