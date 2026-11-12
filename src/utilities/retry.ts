import { EquippedError } from '../errors/index.js'

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const retry = async <T>(
	cb: () => Promise<{ done: true; value: T } | { done: false }>,
	tries: number,
	waitTimeInMs: number,
) => {
	if (tries <= 0) throw new EquippedError('out of tries', { tries, waitTimeInMs })
	const result = await cb()
	if (result.done === true) return result.value
	await sleep(waitTimeInMs)
	return await retry(cb, tries - 1, waitTimeInMs)
}
