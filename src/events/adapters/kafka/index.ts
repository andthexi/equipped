import { KafkaJS } from '@confluentinc/kafka-javascript'
import { v } from 'valleyed'

import { EquippedError } from '../../../errors/index.js'
import { Instance } from '../../../instance/index.js'
import type { Events } from '../../../types/index.js'
import { Random, configurable, parseJSONValue } from '../../../utilities/index.js'
import { EventBus, type Stream, type StreamOptions } from '../base.js'

export const kafkaConfigPipe = () =>
	v.meta(
		v.object({
			brokers: v.array(v.string()),
			ssl: v.optional(v.boolean()),
			sasl: v.optional(
				v.object({
					mechanism: v.is('plain' as const),
					username: v.string(),
					password: v.string(),
				}),
			),
			clientId: v.optional(v.string()),
		}),
		{ title: 'Kafka Config', $refId: 'KafkaConfig' },
	)

export class KafkaEventBus extends configurable(kafkaConfigPipe, EventBus) {
	#client: KafkaJS.Kafka
	#admin: Promise<KafkaJS.Admin> | null = null

	protected constructor(config: typeof KafkaEventBus.Config) {
		super(config)
		this.#client = new KafkaJS.Kafka({
			kafkaJS: { ...config, logLevel: KafkaJS.logLevel.NOTHING },
		})
	}

	async #getAdmin() {
		if (!this.#admin)
			this.#admin = (async () => {
				const admin = this.#client.admin()
				await admin.connect()
				return admin
			})()
		return this.#admin
	}

	async #createTopic(topic: string) {
		const admin = await this.#getAdmin()
		await admin.createTopics({ topics: [{ topic }], timeout: 5000 })
	}

	async #deleteGroup(groupId: string) {
		const admin = await this.#getAdmin()
		await admin.deleteGroups([groupId]).catch(() => {})
	}

	stream<Event extends Events[keyof Events]>(
		topicName: Event['topic'],
		options: Partial<StreamOptions> = {},
	): Stream<Event['data']> {
		const topic = options.skipScope ? topicName : Instance.get().getScopedName(topicName)
		return {
			publish: async (data) => {
				const producer = this.#client.producer()
				await producer.connect()
				await producer.send({
					topic,
					messages: [{ value: JSON.stringify(data) }],
				})
				return true
			},
			subscribe: (onMessage) => {
				const subscribe = async () => {
					await this.#createTopic(topic)
					const groupId = options.fanout
						? Instance.get().getScopedName(`${Instance.get().id}-fanout-${Random.string(10)}`)
						: topic
					const consumer = this.#client.consumer({ kafkaJS: { groupId } })

					await consumer.connect()
					await consumer.subscribe({ topic })

					await consumer.run({
						eachMessage: async ({ message }) => {
							await Instance.resolveBeforeCrash(async () => {
								if (!message.value) return
								await onMessage(parseJSONValue(message.value.toString()))
							}).catch((error) =>
								Instance.crash(
									new EquippedError(
										'Error processing kafka event',
										{ topic, groupId, options },
										error,
									),
								),
							)
						},
					})

					if (options.fanout)
						Instance.on(
							'close',
							async () => {
								await consumer.disconnect()
								await this.#deleteGroup(groupId)
							},
							{ class: KafkaEventBus },
						)
				}
				Instance.on('start', subscribe, { class: KafkaEventBus })
			},
		}
	}
}
