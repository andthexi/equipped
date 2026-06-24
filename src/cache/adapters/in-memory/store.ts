export type CacheEntry = {
	data: string
	expiredAt?: number
}

export type CacheLookup = {
	data: string | null
	deletedExpired: boolean
}

export class InMemoryCacheStore {
	readonly entries = new Map<string, CacheEntry>()

	delete(key: string) {
		return this.entries.delete(key)
	}

	get(key: string, now = Date.now()): CacheLookup {
		const record = this.entries.get(key)
		if (!record) return { data: null, deletedExpired: false }
		if (record.expiredAt !== undefined && record.expiredAt <= now) {
			this.entries.delete(key)
			return { data: null, deletedExpired: true }
		}
		return { data: record.data, deletedExpired: false }
	}

	set(key: string, data: string, ttlInSecs?: number, now = Date.now()) {
		this.entries.set(key, { data, expiredAt: ttlInSecs ? now + ttlInSecs * 1000 : undefined })
	}

	sweepExpired(now = Date.now()) {
		let deleted = false
		for (const [key, record] of this.entries.entries()) {
			if (record.expiredAt !== undefined && record.expiredAt <= now) {
				this.entries.delete(key)
				deleted = true
			}
		}
		return deleted
	}

	snapshot(): Record<string, CacheEntry> {
		const entries: Record<string, CacheEntry> = {}
		for (const [key, record] of this.entries.entries()) {
			entries[key] = { data: record.data, ...(record.expiredAt === undefined ? {} : { expiredAt: record.expiredAt }) }
		}
		return entries
	}

	restore(entries: Record<string, CacheEntry>) {
		this.entries.clear()
		for (const [key, record] of Object.entries(entries)) {
			this.entries.set(key, { data: record.data, ...(record.expiredAt === undefined ? {} : { expiredAt: record.expiredAt }) })
		}
	}
}
