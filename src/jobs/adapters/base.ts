import type { CronTypes, DelayedJobs, RepeatableJobs } from '../../types/index.js'

export enum JobNames {
	CronJob = 'CronJob',
	RepeatableJob = 'RepeatableJob',
	DelayedJob = 'DelayedJob',
}

export type Cron = CronTypes[keyof CronTypes]
export type DelayedJobEvent = DelayedJobs[keyof DelayedJobs]
export type RepeatableJobEvent = RepeatableJobs[keyof RepeatableJobs]
export type DelayedJobCallback = (data: DelayedJobEvent) => Promise<void> | void
export type CronJobCallback = (name: CronTypes[keyof CronTypes]) => Promise<void> | void
export type RepeatableJobCallback = (data: RepeatableJobEvent) => Promise<void> | void
export type JobCallbacks = {
	onDelayed?: DelayedJobCallback
	onCron?: CronJobCallback
	onRepeatable?: RepeatableJobCallback
}

export abstract class Job {
	#crons: { name: Cron; cron: string }[] = []
	#callbacks: JobCallbacks = {}

	abstract addDelayed(data: DelayedJobEvent, delayInMs: number): Promise<string>
	abstract addRepeatable(data: RepeatableJobEvent, cron: string, tz?: string): Promise<string>
	abstract removeDelayed(jobId: string): Promise<void>
	abstract retryAllFailedJobs(): Promise<void>

	get callbacks() {
		return this.#callbacks
	}
	set callbacks(newCallbacks: JobCallbacks) {
		this.#callbacks = newCallbacks
	}
	get crons() {
		return this.#crons
	}
	set crons(newCrons: { name: Cron; cron: string }[]) {
		this.#crons = newCrons
	}
}
