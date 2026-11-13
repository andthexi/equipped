# MongoDB Adapter

In-tree MongoDB adapter using the class-via-`configurable` shape.

## Usage

```ts
import { MongoDbAdapter } from 'equipped/orm/adapters/mongodb'
import { Repo } from 'equipped/orm'

const adapter = MongoDbAdapter.create({ uri: 'mongodb://localhost:27017' })

const repo = Repo.from(adapter)
	.resolve((name) => ({ db: 'myapp', col: name }))
	.build()

// MongoClient is exposed as a readonly field for change streams, aggregations, etc.
const client = adapter.client
```

## Capabilities

| Category              | Declared                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supportedFieldTypes` | `string`, `number`, `boolean`, `null`, `object`, `array`, `date`                                                                                                                                   |
| `queryableOps`        | all 13 canonical ops                                                                                                                                                                               |
| `updateOps`           | `set`, `inc`, `mul`, `min`, `max`, `unset`, `push`, `pull`, `patch`                                                                                                                                |
| Methods               | `connect`, `disconnect`, `findByPk`, `createMany`, `updateByPk`, `deleteByPk`, `raw`, `findMany`, `iterateMany`, `updateMany`, `deleteMany`, `upsertOne`, `session`, migration history and locking |

## Migrations

The Mongo adapter supports a narrow migration surface: storage methods, index operations, and introspection. DDL methods (`applyCreateTable`, `applyAddField`, etc.) are intentionally absent — Mongo is schemaless, so structural Change variants are compile-time errors via `ChangeFor<MongoDbAdapter>`.

### Tracker collection

Migration records are stored in the database and collection produced by resolving the logical `_equipped_migrations` name. Each document uses `{ _id: <migration-id>, appliedAt: <timestamp> }`. Recording joins the active MongoDB session, so a transactional migration and its history record commit or roll back together. The adapter never falls back to a fixed tracker collection.

### Supported Change kinds

| Kind        | Method                                                          |
| ----------- | --------------------------------------------------------------- |
| `addIndex`  | `applyAddIndex` — `createIndex({ field: 1 }, { unique, name })` |
| `dropIndex` | `applyDropIndex` — drops by name from the resolved collection   |
| `execute`   | User callback receives the `Repo`                               |

### Distributed migration lock

The adapter stores lock documents in `_equipped_migration_locks` in the resolved history database. A lock document's `_id` is the full physical history identity (`db` and collection), so runners sharing one history serialize while different histories remain independent. Acquisition atomically inserts a unique owner token and polls for up to 10 seconds; release deletes only the document carrying that token, including when the migration run throws.

Locks have no lease, expiry, renewal, or stale-owner takeover. If a process crashes while holding a lock, an administrator must delete that exact lock document after confirming the owner is gone. Migration callbacks are not retried.

```ts
const migrator = Migrator.from(repo).withLock().migrations(migrations).build()
const codegen = MigrationCodegen.from(repo).target(schemas).build()
```

### Introspection

`introspectTarget({ db, col })` inspects only the resolved database and collection, returning `null` when it is absent. `physicalTargetIdentity({ db, col })` includes both names so collections in different databases remain distinct. `introspect()` remains the broad diagnostic discovery surface and returns `DiscoveredSchema[]` with `fields: []`, `pk: undefined`, `foreignKeys: []` per the Mongo-introspection rule. Only indexes are discovered (the implicit `_id_` index is skipped). The default tracker and lock collections are excluded from broad results.

## Session nesting behaviour

`session(fn)` uses MongoDB driver's `ClientSession` + `withTransaction`. Nested sessions (calling `session` inside another `session`) are flat: the inner call detects an active session via `AsyncLocalStorage` and executes `fn()` directly without starting a new transaction. A throw in the inner callback propagates up and rolls back the entire outer transaction.

## Upsert-compatible filter shapes

MongoDB's native upsert (`findOneAndUpdate` with `{ upsert: true }`) accepts any filter shape expressible as a Mongo query document. Unlike PostgreSQL (which requires `ON CONFLICT (col)` targeting a unique constraint), MongoDB does not restrict the filter to unique-indexed fields. Any `FilterGroup` that compiles to a valid Mongo query is accepted.

However, for correctness in concurrent environments, the filter should target fields covered by a unique index. Without a unique index, concurrent upserts with the same filter may both insert (race condition). The adapter does not validate index coverage — that responsibility lies with the database schema design.
