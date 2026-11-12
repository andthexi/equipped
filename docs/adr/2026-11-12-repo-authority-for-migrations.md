# Repo authority for migrations and codegen

Migration artifacts now accept only a `Repo`. The Repo is authoritative for
both the adapter instance and schema-config resolution, so migration history,
declarative changes, execute callbacks, and codegen introspection all target the
same resolved database scope. Supplying an adapter separately is intentionally
removed without a compatibility overload; even structurally compatible adapter
instances could represent different connections.

Runtime resolver transforms remain AsyncLocalStorage-backed, but each entry is
tagged with its Repo. Nested scopes for one Repo compose, parallel async scopes
remain isolated, and other Repos in the same flow retain their own base config.
An explicit migration-history-scope API was rejected because it could diverge
history from the Repo-resolved changes it records.

`Migrator.from(repo)` requires an immediate lock-policy decision. `withLock()`
is exposed only when the Repo's adapter declares the correctly scoped
`acquireMigrationLock` method; `withoutLock()` is always available so opting out
is explicit. The built surface is capability-narrowed: status and dry-run need
`loadMigrations`, while applying also needs `recordMigration`. Construction
still succeeds for unsupported adapters and yields no terminal methods.

`MigrationCodegen.from(repo)` follows the same rule. Construction is always
available; `diff` and `discover` are independently narrowed by targeted and
broad introspection capabilities instead of rejecting construction.

The migration tracker name remains adapter-owned. Changes to an adapter's
tracker name are therefore intentional breaks rather than aliases requiring a
compatibility layer.
