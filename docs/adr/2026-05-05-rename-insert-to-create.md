# Rename `insert` → `create` to align with `onCreate` lifecycle hook

The action verb for inserting documents is renamed from `insert` to `create`
across the entire ORM surface — chain terminal (`repo.on(S).one().create(d)`),
adapter bag method (`crud.createMany`), validators (`validateCreate`,
`validateCreateMany`), input type (`SchemaCreateInput`), upsert payload key
(`{ create, ops }`), and `OrmValidationError.operation` enum (`'createOne' |
'createMany' | ...`). This resolves a long-standing vocabulary clash inside
the framework: the field-level lifecycle hook is already named `onCreate`
(`field('createdAt', v.number(), { onCreate: () => Date.now() })`), so
calling the action `insert` while the hook is `onCreate` left users
guessing whether they're the same thing.

## Considered Options

- **Keep `insert` as the action verb; rename `onCreate` → `onInsert`.**
  Aligns the other direction. Rejected: `onCreate` reads more naturally for
  a default-value generator (the field is _created_ with this value), and
  `onInsert` would also clash with the existing `onUpdate` hook's naming
  convention (which uses the lifecycle event, not the SQL/Mongo verb).
- **Leave both as-is.** Rejected: the inconsistency was never resolved
  because nobody had a forcing function; the larger redesign is the
  forcing function.

## Consequences

- Diverges from the JS-ORM industry vocabulary (Drizzle, Kysely, TypeORM,
  Prisma, Knex all use `insert`/`insertOne`/`insertMany`). Users coming
  from other ORMs will need to re-learn one verb. Acceptable cost for
  internal consistency.
- Renames touch ~50+ call sites across `src/orm/**` plus all in-tree
  adapters' bag methods (`insertMany` → `createMany`).
- Major version bump (combined with the broader redesign).
- CONTEXT.md §7.2 (validation pipelines), §12 (upsert), §3.1 (crud bag)
  all renamed inline.
