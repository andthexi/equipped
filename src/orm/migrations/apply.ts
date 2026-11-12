import type { OrmAdapterLike } from '../adapters/base.js'
import type { OrmAdapter } from '../orm-adapter.js'
import type { Repo } from '../repo/repo.js'
import type { AnyChange } from './types.js'

export async function applyChange(
	adapter: OrmAdapter,
	repo: Repo<OrmAdapterLike<any>>,
	change: AnyChange,
): Promise<void> {
	if (change.kind === 'execute') {
		await change.up(repo)
		return
	}

	const methodName = `apply${change.kind[0].toUpperCase()}${change.kind.slice(1)}`
	const method = (adapter as any)[methodName]
	if (typeof method !== 'function') {
		throw new Error(`Adapter does not support change kind '${change.kind}'`)
	}
	await method.call(adapter, change)
}

if (import.meta.vitest) {
	const { describe, test, expect, vi } = import.meta.vitest

	describe('applyChange', () => {
		test('routes addIndex to adapter.applyAddIndex', async () => {
			const applyAddIndex = vi.fn().mockResolvedValue(undefined)
			const adapter = { applyAddIndex } as any
			const repo = {} as any
			await applyChange(adapter, repo, { kind: 'addIndex', table: 'users', on: ['email'] })
			expect(applyAddIndex).toHaveBeenCalledWith({ kind: 'addIndex', table: 'users', on: ['email'] })
		})

		test('routes execute to change.up(repo)', async () => {
			const up = vi.fn().mockResolvedValue(undefined)
			const adapter = {} as any
			const repo = {} as any
			await applyChange(adapter, repo, { kind: 'execute', up })
			expect(up).toHaveBeenCalledWith(repo)
		})

		test('throws when adapter lacks the apply method for a declarative change', async () => {
			const adapter = {} as any
			const repo = {} as any
			await expect(applyChange(adapter, repo, { kind: 'addIndex', table: 't', on: ['a'] })).rejects.toThrow(
				"Adapter does not support change kind 'addIndex'",
			)
		})

		test('routes createTable to adapter.applyCreateTable', async () => {
			const applyCreateTable = vi.fn().mockResolvedValue(undefined)
			const adapter = { applyCreateTable } as any
			const change = {
				kind: 'createTable' as const,
				name: 'users',
				pk: { name: 'id', type: 'string' },
				fields: [],
			}
			await applyChange(adapter, {} as any, change)
			expect(applyCreateTable).toHaveBeenCalledWith(change)
		})

		test('routes dropTable to adapter.applyDropTable', async () => {
			const applyDropTable = vi.fn().mockResolvedValue(undefined)
			const adapter = { applyDropTable } as any
			const change = { kind: 'dropTable' as const, name: 'users' }
			await applyChange(adapter, {} as any, change)
			expect(applyDropTable).toHaveBeenCalledWith(change)
		})

		test('routes addField to adapter.applyAddField', async () => {
			const applyAddField = vi.fn().mockResolvedValue(undefined)
			const adapter = { applyAddField } as any
			const change = { kind: 'addField' as const, table: 'users', field: { name: 'age', type: 'number' } }
			await applyChange(adapter, {} as any, change)
			expect(applyAddField).toHaveBeenCalledWith(change)
		})

		test('routes dropField to adapter.applyDropField', async () => {
			const applyDropField = vi.fn().mockResolvedValue(undefined)
			const adapter = { applyDropField } as any
			const change = { kind: 'dropField' as const, table: 'users', name: 'age' }
			await applyChange(adapter, {} as any, change)
			expect(applyDropField).toHaveBeenCalledWith(change)
		})

		test('routes modifyField to adapter.applyModifyField', async () => {
			const applyModifyField = vi.fn().mockResolvedValue(undefined)
			const adapter = { applyModifyField } as any
			const change = {
				kind: 'modifyField' as const,
				table: 'users',
				name: 'age',
				to: { name: 'age', type: 'string' },
			}
			await applyChange(adapter, {} as any, change)
			expect(applyModifyField).toHaveBeenCalledWith(change)
		})

		test('routes renameTable to adapter.applyRenameTable', async () => {
			const applyRenameTable = vi.fn().mockResolvedValue(undefined)
			const adapter = { applyRenameTable } as any
			const change = { kind: 'renameTable' as const, from: 'users', to: 'accounts' }
			await applyChange(adapter, {} as any, change)
			expect(applyRenameTable).toHaveBeenCalledWith(change)
		})

		test('routes renameField to adapter.applyRenameField', async () => {
			const applyRenameField = vi.fn().mockResolvedValue(undefined)
			const adapter = { applyRenameField } as any
			const change = { kind: 'renameField' as const, table: 'users', from: 'name', to: 'fullName' }
			await applyChange(adapter, {} as any, change)
			expect(applyRenameField).toHaveBeenCalledWith(change)
		})

		test('routes dropIndex to adapter.applyDropIndex', async () => {
			const applyDropIndex = vi.fn().mockResolvedValue(undefined)
			const adapter = { applyDropIndex } as any
			const change = { kind: 'dropIndex' as const, name: 'users_email_idx' }
			await applyChange(adapter, {} as any, change)
			expect(applyDropIndex).toHaveBeenCalledWith(change)
		})

		test('routes addForeignKey to adapter.applyAddForeignKey', async () => {
			const applyAddForeignKey = vi.fn().mockResolvedValue(undefined)
			const adapter = { applyAddForeignKey } as any
			const change = {
				kind: 'addForeignKey' as const,
				table: 'posts',
				on: 'authorId',
				references: { table: 'users', column: 'id' },
			}
			await applyChange(adapter, {} as any, change)
			expect(applyAddForeignKey).toHaveBeenCalledWith(change)
		})

		test('routes dropForeignKey to adapter.applyDropForeignKey', async () => {
			const applyDropForeignKey = vi.fn().mockResolvedValue(undefined)
			const adapter = { applyDropForeignKey } as any
			const change = { kind: 'dropForeignKey' as const, table: 'posts', name: 'posts_authorId_fk' }
			await applyChange(adapter, {} as any, change)
			expect(applyDropForeignKey).toHaveBeenCalledWith(change)
		})
	})
}
