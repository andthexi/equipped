declare module 'fs-native-extensions' {
	export function tryLock(fd: number, options?: { shared?: boolean }): boolean
	export function waitForLock(fd: number, options?: { shared?: boolean }): Promise<void>
	export function unlock(fd: number): void
}
