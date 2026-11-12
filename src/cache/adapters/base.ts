import { Instance } from '../../instance/index.js'

export abstract class Cache {
	abstract set(key: string, data: string, ttlInSecs?: number): Promise<void>
	abstract get(key: string): Promise<string | null>
	abstract delete(key: string): Promise<void>

	getScopedKey(key: string) {
		return Instance.get().getScopedName(key, ':')
	}

	async getOrSet<T>(key: string, fn: () => Promise<T>, ttlInSecs?: number): Promise<T> {
		const cached = await this.get(key)
		if (cached) return JSON.parse(cached) as T

		const result = await fn()
		await this.set(key, JSON.stringify(result), ttlInSecs)
		return result
	}
}
