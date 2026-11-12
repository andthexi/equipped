import { cp, readdir } from 'node:fs/promises'
import path from 'node:path'

async function copyDeclarations(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const source = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			await copyDeclarations(source)
		} else if (entry.name.endsWith('.d.ts')) {
			await cp(source, source.replace(/\.d\.ts$/, '.d.cts'))
		}
	}
}

await copyDeclarations('dist/types')
