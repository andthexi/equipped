# Migration and codegen upgrade guide

This release makes migrations and code generation use the same logical-to-physical
table routing as Repo queries. The contracts below are breaking; review existing
migrations before upgrading.

## Resolver callbacks receive names

The Repo base resolver receives a logical schema name string, not a `Schema`
object:

```ts
Repo.from(adapter)
	.resolve((name) => ({ table: `app_${name}` }))
	.build()
```

The same resolver and active `repo.resolve(...)` transforms run at migration
execution time and at `MigrationCodegen.diff()` time. Migration payloads remain
historical plain data: they do not retain a live Schema or a previously resolved
physical name. Keep logical names in `Change` payloads. Review migrations that
already contain prefixes, mapped names, or schema-qualified names; those values
are now resolved again and may otherwise be double-mapped.

## Adapter migration contracts

Custom adapters must accept resolved targets after each historical Change
payload. Table and field renderers receive the owning target; `renameTable`
receives independently resolved source and destination targets;
`addForeignKey` receives independently resolved owner and referenced targets.
Index and constraint column/name strings are literal object names and are not
passed through the table resolver. Generated index and constraint names use the
resolved physical owner.

PostgreSQL supports `{ schema?, table }`. It quotes the namespace and table as
separate identifiers, but it does not create schemas. Create supported namespaces
before running migrations. A table rename may change the table name inside one
namespace, but it cannot move a table between namespaces.

Every `dropIndex` Change now requires its owning logical `table`:

```ts
{ kind: 'dropIndex', table: 'users', name: 'users_email_idx' }
```

This prevents adapters from searching or deleting an identically named index on
an unrelated table.

## Targeted code generation

Codegen adapters must implement `introspectTarget(config)`,
`physicalTargetIdentity(config)`, and broad diagnostic `introspect()`. Diffing
uses targeted introspection only: each supplied logical Schema is resolved and
compared with its one physical target. Duplicate logical ownership of one
physical identity fails loudly.

The target list is a managed subset, not a complete database inventory. Unlisted
tables are ignored; removing a Schema from `.target(...)` never emits
`dropTable`. Table removal must be an explicit reviewed migration. Generated
changes retain logical table names so applying them performs exactly one
execution-time resolution.

Review generated output before use. Codegen matches literal names, does not infer
renames, does not derive foreign keys from Relations, and does not manage
long-tail database features. Convert intended drop/add pairs to explicit rename
changes and author foreign-key or explicit table-removal changes yourself.

## Migration history is not routed

Resolver consistency is tracked by [issue #149](https://github.com/andthexi/equipped/issues/149).
Routing tables to a tenant, prefix, or PostgreSQL schema does not partition the
migration tracker or advisory lock: all routes still share the adapter's
`equipped_migrations` history and lock. Independent per-route ledgers and locking
remain deferred to [issue #150](https://github.com/andthexi/equipped/issues/150);
this release does not implement them.

## Live PostgreSQL verification

The upgrade suite now runs against a configured isolated database by setting
`PG_TEST_URL`:

```sh
PG_TEST_URL='postgresql://user:password@127.0.0.1:5432/equipped_test' \
	pnpm exec vitest run tests/orm/adapters/postgresql/migrations.test.ts
```

The URL must name a test-owned database, never a shared development or production
database. The suite exercises identity, mapped base and scoped table routing,
PostgreSQL namespaces, migration-time Repo writes, independently resolved rename
and foreign-key endpoints, owning-table index changes, and targeted codegen
round trips. Fixtures use unique owned schemas and migration ids; teardown checks
that pre-existing public tables remain untouched.
