# PostgreSQL Adapter

In-tree PostgreSQL adapter using the `class-via-configurable` pattern, extending `OrmAdapter`.

## Usage

```ts
import { PostgresAdapter } from 'equipped/orm/adapters/postgresql'
import { Repo } from 'equipped/orm'

const adapter = PostgresAdapter.create({
	host: 'localhost',
	port: 5432,
	username: 'admin',
	password: 'secret',
	database: 'myapp',
})

const repo = Repo.from(adapter)
	.resolve((name) => ({ table: name }))
	.build()
```

SSL connections are enabled via the `ssl` option (defaults to `false`):

```ts
const adapter = PostgresAdapter.create({ host, port, username, password, database, ssl: true })
```

## Typed driver escape hatch

The underlying `pg.Pool` is exposed as a `readonly` instance field for consumers who need direct driver access:

```ts
const result = await adapter.pool.query('SELECT NOW()')
```

## Capabilities

| Category              | Declared                                                            |
| --------------------- | ------------------------------------------------------------------- |
| `supportedFieldTypes` | `string`, `number`, `boolean`, `null`, `object`, `array`, `date`    |
| `queryableOps`        | all 13 canonical ops                                                |
| `updateOps`           | `set`, `inc`, `mul`, `min`, `max`, `unset`, `push`, `pull`, `patch` |
| `schemaConfigPipe`    | `{ schema?: string, table: string }`                                |

## Session nesting behaviour

`session(fn)` acquires a `PoolClient`, runs `BEGIN`, executes `fn`, then `COMMIT` on success or `ROLLBACK` on throw. Nested sessions (calling `session` inside another `session`) are flat: the inner call detects an active client via `AsyncLocalStorage` and executes `fn()` directly without starting a new transaction or savepoint. A throw in the inner callback propagates up and rolls back the entire outer transaction.

## Upsert-compatible filter shapes

PostgreSQL upsert uses `INSERT ... ON CONFLICT (col) DO UPDATE SET ...`, which requires a single column with a UNIQUE constraint as the conflict target.

The adapter enforces this at the filter level: the filter passed to `upsertOne` must be a **single `eq` filter on one field** (the UNIQUE-indexed column). Any other filter shape throws `OrmValidationError { kind: 'upsert-filter-incompatible' }` with a message describing the received filter shape.

Valid:

```ts
repo.on(Schema)
	.one()
	.where((q) => q.eq('email', 'a@b.com'))
	.upsert({ create })
```

Invalid (throws):

```ts
repo.on(Schema)
	.one()
	.where((q) => q.eq('a', 1).eq('b', 2))
	.upsert({ create }) // multiple filters
repo.on(Schema)
	.one()
	.where((q) => q.gt('age', 10))
	.upsert({ create }) // non-eq filter
repo.on(Schema).one().upsert({ create }) // empty filter
```

The adapter does not validate that the filter field has a UNIQUE index — that responsibility lies with the database schema design. Without a unique constraint on the conflict column, the `ON CONFLICT` clause will fail at the database level.

## Migrations

The PostgreSQL adapter implements the full migrations capability surface:

### Migration tracker table

For every `up()`, `status()`, and `dry()` call, the Repo resolves the reserved logical name `_equipped_migrations`. The resulting `{ schema?, table }` config is the physical history identity. There is no fallback to `equipped_migrations`.

Applied migrations are stored in the resolved table, which is created automatically on the first `loadMigrations()` call. The schema and table identifiers are quoted independently. A configured schema must already exist; the adapter does not provision it, and PostgreSQL's missing-schema error is surfaced.

```sql
CREATE TABLE IF NOT EXISTS "resolved_schema"."_equipped_migrations" (
  id text PRIMARY KEY,
  applied_at bigint NOT NULL
)
```

### Cluster-safe lock

`acquireMigrationLock(historyConfig, fn)` uses PostgreSQL advisory locks (`pg_advisory_lock` / `pg_advisory_unlock`). Its deterministic key is derived from the full physical history identity: database, schema (defaulting to `public`), and table. Runs for the same history serialize; runs for distinct histories do not block each other.

Lock and unlock always use the same `PoolClient`. An active transaction client is reused. Otherwise the adapter checks out a dedicated client, routes migration history and transaction work through it for the callback's lifetime, unlocks after the callback commits or rolls back, and then releases the client.

```ts
const migrator = Migrator.from(repo).withLock().migrations(migrations).build()
const codegen = MigrationCodegen.from(repo).target(schemas).build()
```

### Declarative change support

All 11 `apply*` methods are implemented:

| Method                | SQL generated                                          |
| --------------------- | ------------------------------------------------------ |
| `applyCreateTable`    | `CREATE TABLE` with typed columns                      |
| `applyDropTable`      | `DROP TABLE`                                           |
| `applyAddField`       | `ALTER TABLE ADD COLUMN`                               |
| `applyDropField`      | `ALTER TABLE DROP COLUMN`                              |
| `applyModifyField`    | `ALTER COLUMN TYPE/NULL/DEFAULT` (multiple statements) |
| `applyRenameTable`    | `ALTER TABLE RENAME TO`                                |
| `applyRenameField`    | `ALTER TABLE RENAME COLUMN`                            |
| `applyAddIndex`       | `CREATE [UNIQUE] INDEX`                                |
| `applyDropIndex`      | `DROP INDEX`                                           |
| `applyAddForeignKey`  | `ALTER TABLE ADD CONSTRAINT ... FOREIGN KEY`           |
| `applyDropForeignKey` | `ALTER TABLE DROP CONSTRAINT`                          |

### Type mapping

| FieldType | PostgreSQL type    |
| --------- | ------------------ |
| `string`  | `text`             |
| `number`  | `double precision` |
| `boolean` | `boolean`          |
| `date`    | `timestamptz`      |
| `null`    | `text`             |
| `object`  | `jsonb`            |
| `array`   | `jsonb`            |

### Auto-derived names

- **Index**: `idx_<table>_<col1>_<col2>[_unique]` (when `change.name` is absent)
- **Foreign key**: `fk_<table>_<column>` (when `change.name` is absent)

### Introspection

`introspect()` queries `information_schema.columns`, `information_schema.table_constraints`, and `pg_indexes` to build `DiscoveredSchema[]`. Throws `OrmIntrospectionError` on columns with unsupported PostgreSQL types (e.g. `bytea`, `bigint`).
