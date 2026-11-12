import { defineConfig, type UserConfig } from 'tsdown'

const entryFiles = [
	'src/index.ts',
	'src/cache/index.ts',
	'src/cache/adapters/in-memory/index.ts',
	'src/cache/adapters/json/index.ts',
	'src/cache/adapters/redis/index.ts',
	'src/dbs/index.ts',
	'src/dbs/adapters/mongodb/index.ts',
	'src/errors/index.ts',
	'src/events/index.ts',
	'src/events/adapters/kafka/index.ts',
	'src/events/adapters/rabbitmq/index.ts',
	'src/instance/index.ts',
	'src/jobs/index.ts',
	'src/jobs/adapters/redis/index.ts',
	'src/orm/index.ts',
	'src/orm/adapters/in-memory/index.ts',
	'src/orm/adapters/json/index.ts',
	'src/orm/adapters/mongodb/index.ts',
	'src/orm/adapters/postgresql/index.ts',
	'src/server/index.ts',
	'src/server/adapters/express/index.ts',
	'src/server/adapters/fastify/index.ts',
	'src/types/index.ts',
	'src/utilities/index.ts',
	'src/validations/index.ts',
]

const entry = Object.fromEntries(entryFiles.map((file) => [file.replace(/^src\//, '').replace(/\.ts$/, ''), file]))

const commonOptions = {
	entry,
	platform: 'node',
	target: false,
	hash: false,
	dts: false,
	deps: { neverBundle: true },
	define: { 'import.meta.vitest': 'undefined' },
} satisfies UserConfig

export default defineConfig([
	{
		...commonOptions,
		name: 'esm',
		format: 'esm',
		outDir: 'dist/esm',
		sourcemap: true,
		clean: true,
		minify: false,
		outExtensions: () => ({ js: '.mjs' }),
	},
	{
		...commonOptions,
		name: 'esm-min',
		format: 'esm',
		outDir: 'dist/esm',
		sourcemap: true,
		clean: false,
		minify: true,
		outExtensions: () => ({ js: '.min.mjs' }),
	},
	{
		...commonOptions,
		name: 'cjs',
		format: 'cjs',
		outDir: 'dist/cjs',
		sourcemap: true,
		clean: true,
		minify: false,
		outExtensions: () => ({ js: '.cjs' }),
	},
	{
		...commonOptions,
		name: 'cjs-min',
		format: 'cjs',
		outDir: 'dist/cjs',
		sourcemap: true,
		clean: false,
		minify: true,
		outExtensions: () => ({ js: '.min.cjs' }),
	},
])
