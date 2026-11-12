import { connect, type ChannelWrapper } from 'amqp-connection-manager'
import type { ConfirmChannel } from 'amqplib'
import { v } from 'valleyed'

import { Instance } from '../../../instance/index.js'
import type { Events } from '../../../types/index.js'
import { configurable, parseJSONValue, Random } from '../../../utilities/index.js'
import { EventBus, type Stream, type StreamOptions } from '../base.js'

export const rabbitmqConfigPipe = () =>
	v.meta(
		v.object({
			uri: v.string(),
			eventColumnName: v.string(),
		}),
		{ title: 'Rabbitmq Config', $refId: 'RabbitmqConfig' },
	)

export class RabbitMQEventBus extends configurable(rabbitmqConfigPipe, EventBus) {
	#client: ChannelWrapper
	#columnName: string

	protected constructor(config: typeof RabbitMQEventBus.Config) {
		super(config)

		this.#columnName = config.eventColumnName
		this.#client = connect([config.uri]).createChannel({
			json: false,
			setup: async (channel: ConfirmChannel) => {
				await channel.assertExchange(this.#columnName, 'direct', { durable: true })
				await channel.prefetch(1)
			},
		})
	}

	stream<Event extends Events[keyof Events]>(
		topicName: Event['topic'],
		options: Partial<StreamOptions> = {},
	): Stream<Event['data']> {
		const topic = options.skipScope ? topicName : Instance.get().getScopedName(topicName)

		return {
			publish: async (data) =>
				await this.#client.publish(this.#columnName, topic, JSON.stringify(data), { persistent: true }),
			subscribe: async (onMessage) => {
				const subscribe = async () => {
					await this.#client.addSetup(async (channel: ConfirmChannel) => {
						const queueName = options.fanout
							? Instance.get().getScopedName(`${Instance.get().id}-fanout-${Random.string(10)}`)
							: topic
						const { queue } = await channel.assertQueue(queueName, {
							durable: !options.fanout,
							exclusive: options.fanout,
						})
						await channel.bindQueue(queue, this.#columnName, topic)
						channel.consume(
							queue,
							async (msg) => {
								await Instance.resolveBeforeCrash(async () => {
									if (!msg) return
									try {
										await onMessage(parseJSONValue(msg.content.toString()))
										channel.ack(msg)
									} catch {
										channel.nack(msg)
									}
								})
							},
							{ noAck: false },
						)
					})
				}

				Instance.on('start', subscribe, { class: RabbitMQEventBus })
			},
		}
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, expectTypeOf } = import.meta.vitest

	describe('RabbitMQEventBus', () => {
		test('create returns an instance with stream method', () => {
			const bus = RabbitMQEventBus.create({ uri: 'amqp://localhost', eventColumnName: 'events' })
			expect(bus).toBeInstanceOf(RabbitMQEventBus)
			expect(bus.stream).toBeTypeOf('function')
		})

		test('external new is a compile error', () => {
			// @ts-expect-error — external `new` on a class with protected constructor is a compile error
			void (() => new RabbitMQEventBus({ uri: 'amqp://localhost', eventColumnName: 'events' }))
		})

		test('static Config resolves to the pipe output type', () => {
			expectTypeOf<typeof RabbitMQEventBus.Config>().toHaveProperty('uri')
			expectTypeOf<typeof RabbitMQEventBus.Config>().toHaveProperty('eventColumnName')
		})

		test('create rejects invalid config', () => {
			// @ts-expect-error — missing required field
			expect(() => RabbitMQEventBus.create({ uri: 'amqp://localhost' })).toThrow()
		})
	})
}
