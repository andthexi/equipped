import { v, type PipeOutput } from 'valleyed'

import { KafkaEventBus } from '../../../events/adapters/kafka/index.js'

export const dbChangeConfigPipe = () =>
	v.object({
		debeziumUrl: v.string(),
		eventBus: v.instanceOf(KafkaEventBus as unknown as abstract new (...args: any[]) => KafkaEventBus),
	})

export type DbChangeConfig = PipeOutput<ReturnType<typeof dbChangeConfigPipe>>

export type DbConfig = {
	changes?: DbChangeConfig
}
