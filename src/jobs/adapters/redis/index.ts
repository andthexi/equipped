import { Queue, Worker } from 'bullmq'
import { v } from 'valleyed'

import { RedisCache, redisConfigPipe } from '../../../cache/adapters/redis/index.js'
import { Instance } from '../../../instance/index.js'
import { Random, configurable } from '../../../utilities/index.js'
import { Job, JobNames, type Cron, type DelayedJobEvent, type RepeatableJobEvent } from '../base.js'

export const redisJobsConfigPipe = () =>
	v.meta(
		v.object({
			redisConfig: redisConfigPipe(),
			queueName: v.string(),
		}),
		{ title: 'Redis Jobs Config', $refId: 'RedisJobsConfig' },
	)

export class RedisJob extends configurable(redisJobsConfigPipe, Job) {
	#queue: Queue

	protected constructor(config: typeof RedisJob.Config) {
		super(config)

		const redisCache = (RedisCache.create as any)(config.redisConfig, {
			maxRetriesPerRequest: null,
			enableReadyCheck: false,
		})
		const queueName = Instance.get().getScopedName(config.queueName)
		this.#queue = new Queue(queueName, { connection: redisCache.connectionOptions, skipVersionCheck: true })

		const worker = new Worker(
			queueName,
			async (job) => {
				switch (job.name) {
					case JobNames.DelayedJob:
						return (this.callbacks.onDelayed as any)?.(job.data)
					case JobNames.CronJob:
						return (this.callbacks.onCron as any)?.(job.data.type)
					case JobNames.RepeatableJob:
						return (this.callbacks.onRepeatable as any)?.(job.data)
				}
			},
			{ connection: redisCache.connectionOptions, autorun: false, skipVersionCheck: true },
		)

		Instance.on(
			'start',
			async () => {
				await this.#cleanup()
				await Promise.all(this.crons.map(({ cron, name }) => this.#addCron(name, cron)))
				worker.run()
			},
			{ class: RedisJob },
		)
	}

	#getNewId() {
		return [Date.now(), Random.string()].join('_')
	}

	async #addCron(type: Cron | string, cron: string) {
		const job = await this.#queue.add(
			JobNames.CronJob,
			{ type },
			{
				jobId: this.#getNewId(),
				repeat: { pattern: cron },
				removeOnComplete: true,
				backoff: 1000,
				attempts: 3,
			},
		)
		return job.id!.toString()
	}

	async #cleanup() {
		await this.retryAllFailedJobs()
		const repeatableJobs = await this.#queue.getJobSchedulers()
		await Promise.all(repeatableJobs.map((job) => this.#queue.removeJobScheduler(job.key)))
	}

	async addDelayed(data: DelayedJobEvent, delayInMs: number): Promise<string> {
		const job = await this.#queue.add(JobNames.DelayedJob, data, {
			jobId: this.#getNewId(),
			delay: delayInMs,
			removeOnComplete: true,
			backoff: 1000,
			attempts: 3,
		})
		return job.id!.toString()
	}
	async addRepeatable(data: RepeatableJobEvent, cron: string, tz?: string): Promise<string> {
		const job = await this.#queue.add(JobNames.RepeatableJob, data, {
			jobId: this.#getNewId(),
			repeat: { pattern: cron, ...(tz ? { tz } : {}) },
			removeOnComplete: true,
			backoff: 1000,
			attempts: 3,
		})
		return job.opts?.repeat?.key ?? ''
	}
	async removeDelayed(jobId: string) {
		const job = await this.#queue.getJob(jobId)
		if (job) await job.remove()
	}
	async retryAllFailedJobs() {
		const failedJobs = await this.#queue.getFailed()
		await Promise.all(failedJobs.map((job) => job.retry()))
	}
}

if (import.meta.vitest) {
	const { test, expectTypeOf } = import.meta.vitest
	type PipeOutput<P> = import('valleyed').PipeOutput<P>

	test('external new is a compile error', () => {
		// @ts-expect-error — protected constructor prevents external instantiation
		void (() => new RedisJob({ redisConfig: { host: '' }, queueName: '' }))
	})

	test('Config type matches pipe output', () => {
		expectTypeOf<typeof RedisJob.Config>().toEqualTypeOf<PipeOutput<ReturnType<typeof redisJobsConfigPipe>>>()
	})
}
