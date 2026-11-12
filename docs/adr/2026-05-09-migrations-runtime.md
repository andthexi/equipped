# Migrations runtime — forward-only, change-AST, capability-gated

The orm gains an in-tree migrations subsystem ("A" in the C-hybrid scope;
codegen "B" now ships alongside it). A migration is a typed
`Migration<A> = { id, changes: Change[], tx? }` plain object the user passes
in an array to `Migrator.from(repo, adapter).migrations([...]).build()`. The
`changes` field is a closed discriminated-union AST (12 variants —
`createTable`, `addField`, `addIndex`, …, plus `execute` for raw escape)
that adapters render via per-variant `apply*` methods structurally inferred
from method presence. The runtime is **forward-only** — there is no
`down()`, no auto-inverse, no reversibility metadata in the algebra; rollback
is achieved by writing additional forward migrations or, for local-dev
mistakes, by deleting the tracker row from the adapter-owned storage table
manually. Storage and locking are adapter capabilities (`loadMigrations`,
`recordMigration`, `acquireMigrationLock?`) rather than the orm-driven
piggyback over its own crud surface that was initially considered. The full
v1 spec lives in `docs/orm/CONTEXT.md` §16.

## Considered Options

- **D — pure declarative (Atlas-style "schema apply" direct-to-DB).**
  Rejected: silent destructive operations conflict with §13 #6
  always-throw-never-silently-drop, and "no migration history" rules out
  reproducible deploys.
- **E — snapshot-diff (Drizzle Kit `meta/_journal.json`).** Rejected:
  the snapshot file is a second source of truth alongside `Schema`,
  contradicting the schema-as-SoT principle, and snapshot-diff is
  drift-blind by construction.
- **(I) function-only `Migration` (no `Change` AST).** Initially
  recommended for v1 simplicity, then displaced when the user picked
  (III). Discarded because the type-system-is-the-contract principle is
  served better by a closed discriminated union; B (codegen) cleanly
  emits pure data.
- **(II) function + optional `changes` two-channel content.** Rejected:
  ambiguous precedence ("if both present, which wins?"), no single
  source of truth, worst-of-both ergonomics.
- **(γ) Full Ecto-parity algebra with constraints, triggers, views,
  sequences.** Rejected: most variants are PG-only, mostly already
  expressible via `execute`, and the closed-set rule (§4.4) discourages
  growing the canonical set when escape exists.
- **Bidirectional `up`/`down` with auto-inverse via `from:` payloads.**
  Rejected late in the grilling. Real prod rollback is "ship a forward
  fix-it migration," not "walk back the AST." Drizzle/Atlas/Sqitch are
  all forward-only; Ecto retains `down` but the community guidance
  ("Safe Ecto Migrations") is don't trust it in prod. Dropping `down`
  removed `from:` payloads, the framework `inverse()` function,
  pre-flight irreversibility checks, the `forgetMigration` adapter
  method, and roughly 40% of the design surface.
- **Library-owned `EquippedMigrationsSchema` (storage piggybacks on
  the orm's own crud).** Initially recommended (mirrored the §15
  `EventLogSchema` precedent); displaced when the user pushed back —
  adapters owning their own storage table avoids forcing the user to
  wire a plumbing schema into their resolver, and lets adapters use
  natural primitives (PG advisory locks + UPSERT, Mongo sentinel docs,
  Firebase single-doc with applied-id list).
- **`migrationOps: readonly [...] as const` capability array on the
  adapter.** Rejected mid-grill: redundant with method presence. §3.3
  already locks "presence on the class is the declaration"; op-list
  arrays only earn their keep when _one method handles many ops_
  (filter trees, op lists). For migrations it's one method per
  variant — structural inference from `apply*` keys is sufficient.
- **CLI in v1.** Rejected: zero new dependencies, edge-runtime safe,
  same precedent as `EventLog.replay()` (§15.7) which is
  programmatic-only. CLI can ship later as a thin layer.
- **Filesystem migration discovery (`.migrationsDir('./migrations')`).**
  Rejected: `fs.readdir` breaks Workers/Deno-edge. Userland helper that
  produces an array remains trivially writable.
- **Configurable error handler / skip-and-continue / `down({ all })`.**
  All rejected as silent-state-mutation footguns; mirror §15.7's
  replay-stop-on-failure rule and lean on `OrmMigrationError` carrying
  `phase: 'lock' | 'load' | 'session' | 'user' | 'record'`.

## Consequences

- New cross-cutting principle in §13: **Forward-only migrations rule.**
- New entry in §14 out-of-scope: **Migration rollback (`down()`)** —
  forward-only by design; recovery is "ship a forward fix-it migration"
  or manually delete the tracker row.
- New canonical change-variant set in §16; closed-set rule (§4.4)
  applies. Extension is a maintainer-side process with the
  canonical-extension contract (variant added to union, per-adapter
  renderer added, in-memory adapter updated, semver bumped).
- New error class `OrmMigrationError extends EquippedError` joining
  `OrmValidationError`, `OrmNotFoundError`, `OrmReplayError` under
  `src/orm/errors/`.
- New `'changes'` kind on `OrmValidationError` (§7.5) for boundary
  validation failures at `Migrator.from(repo).migrations(arr).build()`.
- Codegen ("B") ships with targeted introspection, adapter-aware diffing,
  and no file emission; see `2026-05-09-migrations-codegen.md` and
  `docs/orm/CONTEXT.md` §16.11.
- In-tree adapters (in-memory, json, postgresql, mongodb) gain
  `loadMigrations`/`recordMigration`/`acquireMigrationLock?` plus
  per-variant `apply*` methods for the variants they support
  (postgresql: all 11 declarative variants; mongodb:
  `applyAddIndex`/`applyDropIndex` only).
