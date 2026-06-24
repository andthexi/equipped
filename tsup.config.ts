import { fixImportsPlugin } from 'esbuild-fix-imports-plugin'
import { defineConfig, Options } from 'tsup'

const entry = [
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

const commonOptions: Options = {
	entry,
	sourcemap: true,
	clean: true,
	dts: false,
	minify: false,
	platform: 'node',
	define: { 'import.meta.vitest': 'undefined' },
	esbuildPlugins: [fixImportsPlugin()],
	esbuildOptions(options) {
		options.platform = 'node'
	},
}

export default defineConfig([
	{
		...commonOptions,
		format: 'esm',
		outDir: 'dist/esm',
		outExtension: () => ({ js: '.mjs' }),
	},
	{
		...commonOptions,
		format: 'esm',
		outDir: 'dist/esm',
		minify: true,
		outExtension: () => ({ js: '.min.mjs' }),
		clean: false,
	},
	{
		...commonOptions,
		format: 'cjs',
		outDir: 'dist/cjs',
		outExtension: () => ({ js: '.cjs' }),
	},
	{
		...commonOptions,
		format: 'cjs',
		outDir: 'dist/cjs',
		minify: true,
		outExtension: () => ({ js: '.min.cjs' }),
		clean: false,
	},
	{
		...commonOptions,
		format: 'esm',
		outDir: 'dist/types',
		sourcemap: false,
		dts: { entry },
	},
])
