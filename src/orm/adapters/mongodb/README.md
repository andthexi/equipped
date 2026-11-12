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

| Category | Declared |
|----------|----------|
| `supportedFieldTypes` | `string`, `number`, `boolean`, `null`, `object`, `array`, `date` |
| `queryableOps` | all 13 canonical ops |
| `updateOps` | `set`, `inc`, `mul`, `min`, `max`, `unset`, `push`, `pull`, `patch` |
| Methods | `connect`, `disconnect`, `findByPk`, `createMany`, `updateByPk`, `deleteByPk`, `raw`, `findMany`, `iterateMany`, `updateMany`, `deleteMany`, `upsertOne`, `session` |

## Migrations

The Mongo adapter supports a narrow migration surface: storage methods, index operations, and introspection. DDL methods (`applyCreateTable`, `applyAddField`, etc.) are intentionally absent — Mongo is schemaless, so structural Change variants are compile-time errors via `ChangeFor<MongoDbAdapter>`.

### Tracker collection

Migration records are stored in `equipped_migrations` (default database from the connection URI). Each document uses `{ _id: <migration-id>, appliedAt: <timestamp> }`.

### Supported Change kinds

| Kind | Method |
|------|--------|
| `addIndex` | `applyAddIndex` — `createIndex({ field: 1 }, { unique, name })` |
| `dropIndex` | `applyDropIndex` — scans collections to find and drop by name |
| `execute` | User callback receives the `Repo` |

### No lock support

The Mongo adapter does not implement `acquireMigrationLock` (no native advisory-lock equivalent). Since the adapter lacks the lock method, `Migrator.from(repo, adapter).migrations([...]).build()` compiles without `.withoutLock()`. Both paths work:

```ts
// Direct — compiles because adapter lacks acquireMigrationLock
const migrator = Migrator.from(repo, adapter).migrations(migrations).build()

// Explicit opt-out — also compiles
const migrator = Migrator.from(repo, adapter).migrations(migrations).withoutLock().build()
```

### Introspection

`introspect()` returns `DiscoveredSchema[]` with `fields: []`, `pk: undefined`, `foreignKeys: []` per the Mongo-introspection rule. Only indexes are discovered (the implicit `_id_` index is skipped). The tracker collection is excluded from results.

## Session nesting behaviour

`session(fn)` uses MongoDB driver's `ClientSession` + `withTransaction`. Nested sessions (calling `session` inside another `session`) are flat: the inner call detects an active session via `AsyncLocalStorage` and executes `fn()` directly without starting a new transaction. A throw in the inner callback propagates up and rolls back the entire outer transaction.

## Upsert-compatible filter shapes

MongoDB's native upsert (`findOneAndUpdate` with `{ upsert: true }`) accepts any filter shape expressible as a Mongo query document. Unlike PostgreSQL (which requires `ON CONFLICT (col)` targeting a unique constraint), MongoDB does not restrict the filter to unique-indexed fields. Any `FilterGroup` that compiles to a valid Mongo query is accepted.

However, for correctness in concurrent environments, the filter should target fields covered by a unique index. Without a unique index, concurrent upserts with the same filter may both insert (race condition). The adapter does not validate index coverage — that responsibility lies with the database schema design.
