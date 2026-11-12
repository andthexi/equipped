# Rework `src/audit/EventAudit` into `src/orm/event-log/EventLog`

`src/audit/EventAudit` is replaced by `src/orm/event-log/EventLog` — a typed
event-sourcing log built on the orm's `Repo`, with handler registration that
returns typed fire functions, atomic per-event sessions, and per-event
replay-with-stop-on-failure. The legacy module conflated three concerns:
event sourcing (replay), an audit-trail shape, and async post-processing (the
`setInterval` queue + `def.async` hook). The rework keeps **event sourcing
only** — async post-processing belongs in `src/jobs/`, and audit trail is a
free side-effect of the persisted log. The legacy module also depended on
`src/dbs/` (the deprecating layer); the rework persists via a library-owned
`EventLogSchema` through any orm `Repo`, so the persistence side
automatically benefits from the orm's adapter narrowing, validation, and
session machinery. Replay determinism for non-deterministic field values
(timestamps, identity, randomness) is a **handler-side discipline**:
handlers thread the persisted `EventContext` (`{ key, name, ts, body, by,
firstRun }`) into create/update payloads explicitly. The library does not
introduce a `GeneratorContext`, a `repo.with()` scope, or any other
context-flow mechanism — every alternative shape produced too much library
surface for an ergonomic problem solvable by handler discipline.

## Considered Options

### Where it lives

- **Top-level `src/<new>/` peer of orm/cache/events/jobs/server.** Mirrors
  the legacy `src/audit/` location. Rejected: unlike its peers it has no
  adapter abstraction — it is pure logic plus a persistence dependency.
  Doesn't justify a top-level family.
- **Drop from the package entirely as userland.** Rejected: replay-driven
  state derivation is a real recurring need; punting to userland loses the
  typed-fire and library-owned schema that make the abstraction worth
  shipping.

### Concern set (single vs three)

- **Keep all three legacy concerns: event sourcing + audit trail + async
  post-processing.** Rejected: async post-processing duplicates `src/jobs/`;
  audit trail is just "query the persisted log" and needs no new surface.
- **Audit trail only.** Rejected: collapses to "the user defines a Schema
  and writes to it" — no library value-add.
- **Async post-processing only.** Rejected: `src/jobs/` already exists.

### Naming

- **`EventStore`.** DDD-flavoured. Rejected: implies aggregate streams +
  per-aggregate event ordering, which this isn't. Misleading to readers
  familiar with the pattern.
- **`CommandLog`.** More accurate (each entry is a command invocation, not
  a domain event). Rejected: "command" is unfamiliar in JS/TS land; users
  will reach for "event" first.
- **Keep "Audit".** Rejected: continues the legacy misnaming; "audit" is
  overloaded in `dbs` with the implicit-timestamp meaning.
- **`EventLog` (picked).** Descriptive: it is a persistent log of events.
  No DDD baggage. Avoids the `src/events/` EventBus collision (which is
  pub/sub).

### Persistence schema ownership

- **User provides their own Schema.** Rejected: every consumer reinvents the
  same shape; library can't evolve the shape without coordination.
- **Library exports a default Schema; user can override.** Rejected: opens
  a shape-divergence problem (replay tooling has to handle multiple
  shapes); not paying for itself given how stable the shape is.
- **Library-owned fixed `EventLogSchema` (picked).** 5 fields: `key`,
  `name`, `ts`, `body`, `by`. Users wire it into their Repo's resolver
  like any other schema.

### Registry shape

- **Declarative builder step `.handler(name, def)` returning a `{ builder,
fire }` tuple.** Type-safe replay-by-construction. Rejected: forces every
  handler def into one assembly site; cross-cutting modules can't register
  via side-effect imports; awkward tuple return.
- **`log.fire(name, payload)` (no per-handler fire fn).** Rejected: less
  ergonomic; loses per-name type-narrowing.
- **Imperative post-build `log.handler(name, def)` returning a typed fire
  fn (picked).** Matches legacy ergonomics (`fireUserCreated(payload)`
  reads cleaner than `log.fire('user.created', payload)`). The
  registration-order footgun (replay before full registration) surfaces as
  a loud throw on any event whose handler name isn't registered at replay
  time — same failure mode as legacy.

### `firstRun` in EventContext

- **Drop `firstRun`; force handlers to be replay-safe by construction.**
  Cleaner; matches §13 #6 fail-loud orthodoxy. Rejected: handlers that
  legitimately want one-shot side effects (sending one welcome email,
  charging a card) need a way to express "this is the first run." Forcing
  every handler to dedup is more friction than the `firstRun` footgun
  saves.
- **Split into `handle` (always-run) + `onFirst` (first-run only).**
  Rejected: leaks the legacy's three-callback shape this rework deletes.
- **Keep `firstRun` (picked).** Handlers gate non-idempotent side effects
  on it; forgetting is a documented footgun.

### Persistence semantics

- **Durable log: persist event row first (commit), run handle separately,
  on failure mark row `failed` for retry.** Rejected: requires a status
  column + retry policy; handler side-effects on external services don't
  benefit from atomic-with-db semantics anyway. Out of scope unless a
  concrete need surfaces.
- **Atomic event in one session (picked).** `fire(payload)` wraps
  `repo.session(async () => { create event row; run handle })`. Failure
  rolls everything back. Replay is for re-deriving state from _successful_
  events only — not for retrying failed ones. Matches the orm's session
  contract and §13 #6 fail-loud rule.

### Replay error handling

- **Skip-and-continue, return failures array.** Rejected: silent partial
  success; violates §13 #6.
- **Caller-supplied error handler (`onError`).** Rejected: more API surface
  for a corner case; users who need per-event control can wrap individual
  `rerun(key)` calls in their own try/catch loop.
- **Stop-on-first-failure (picked).** Throw with the offending event's
  `key` in the error; caller fixes and re-runs `replay({ from:
lastSuccessTs + 1 })`.

### Replay session boundary

- **One session for the whole replay.** Rejected: a 10k-event replay holds
  a single tx; PG/Mongo lock contention and memory; not viable past
  trivial scale.
- **Per-event session (picked).** Each event's row update + handler in its
  own session. Caller wraps in outer session for atomic replay; composes
  naturally with §8.4.

### Schema versioning

- **Library-level `version` field on row Schema; per-(name, version)
  registry.** Rejected: introduces real machinery (per-version handler
  dispatch, optional migration functions) for a problem the body-level
  discriminated-union pattern solves at zero library cost.
- **Body-level versioning via discriminated-union pipes (no library
  field).** Discussed but explicitly deferred — users can encode version
  in body if they need to.
- **Deferred (picked).** Single handler per name; pipe shape changes
  throw loudly at replay time when an old row doesn't validate. Revisit
  if a concrete need surfaces.

### Replay determinism mechanism

- **Library-driven via `repo.with({by, at}, fn)` + `GeneratorContext` arg
  on every field generator.** Was the leading proposal during design.
  Sketch: ALS-backed scope holds `{ by, at }`; field generators take
  `(ctx) => T` and call `ctx.now()` / `ctx.by()`; library pins the scope
  from each event row during fire and replay. Rejected for three reasons:
  (i) requires a breaking signature change to every field generator
  (`() => T` → `(ctx) => T`); (ii) introduces PK type-tracking gymnastics
  (`ctx.id()` would have to type to the schema's PK pipe-output), or
  drops PK support entirely and is asymmetric; (iii) once `ctx.id` and
  `ctx.by` and `ctx.now` are each individually shown to be solvable by
  handler discipline (handlers thread `evCtx.at` / `evCtx.by` /
  `evCtx.key` into payloads), nothing remains for the library to
  contribute. The minimal honest design is **no library mechanism**.
- **Library-driven, only `ctx.now()` and `ctx.by()` (drop `ctx.id()`).**
  Middle ground. Rejected: still requires the entire `repo.with` + ALS +
  GeneratorContext machinery for two methods both solvable by the same
  handler discipline.
- **Handler-side discipline (picked).** Handlers receive the
  `EventContext` and thread `evCtx.at`, `evCtx.by`, `evCtx.key` into
  payloads explicitly when persisting rows from inside a handler.
  Schema-level generators that call `Date.now()` / `crypto.randomUUID()`
  will diverge across replay; documented but not enforced. Loud-on-replay
  (timestamps and PKs visibly diverge) keeps the failure mode debuggable
  in tests/QA.

## Consequences

- `src/audit/` is deleted in favour of `src/orm/event-log/`.
- A new library-owned `EventLogSchema` lives at
  `src/orm/event-log/schema.ts` with the canonical 5-field shape (`key`,
  `name`, `ts`, `body`, `by`). Users wire it into their Repo's resolver
  alongside their own schemas.
- `EventAudit`'s dependency on `src/dbs/` is removed; the deprecating
  layer loses one consumer.
- `def.async` and the `setInterval`-backed batch queue from the legacy
  are deleted. EventLog has no `Instance.on('start', ...)` hook; per-tick
  processing is gone.
- TODO.md item "Rework db audits" closes.
- TODO.md item "Hooks/Lifecycle Events" remains open but is narrowed:
  query-level hooks and per-model `beforeInsert`/`afterDelete` callbacks
  are not addressed by EventLog.
- TODO.md item "Audit-by (createdBy/updatedBy)" stays open but is
  reframed: the library does not ship a context-flow mechanism; users
  thread `by` through their own request middleware (or via the
  EventContext when inside an EventLog handler). No library work is
  committed.
- The implicit-timestamp aspect of "Rework db audits" closes: the orm
  already resolves it via explicit field hooks; the cross-schema
  composition concern that surfaced during this design is documented as
  a userland pattern in CONTEXT.md §1.5 (no library Mixin / `.use()` /
  composition primitive ships).
- CONTEXT.md gains a new §15 (EventLog vocabulary, fire/replay
  semantics, replay-determinism rule).
- Major version bump; users of `EventAudit` migrate from
  `new EventAudit(db, dbName).register(name, def)(payload, ctx)` to
  `EventLog.from(repo).build().handler(name, def)(payload, ctx)`.
