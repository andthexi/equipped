# Required-row contract via `.required()` modifier on `OneBuilder`

`OneBuilder`'s nullable verbs (`find`, `update`, `delete`) silently return
`T | null` when the query produces no row. This violates the spirit of the
_always-throw-never-silently-drop_ principle (§13 #6) for user-meaningful
"no match" cases, but tightening the default would be a breaking change.
The decision: introduce a **`.required()` modifier** on `OneBuilder` that
opts the chain into a **required-row contract** — return types narrow from
`T | null` to `T`, and a new `OrmNotFoundError` (sibling of
`OrmValidationError`) is thrown post-adapter when no row matched. The
modifier is once-per-chain, free-floating, and a runtime no-op for
`create` / `upsert` (whose return types are already non-null). Default
behaviour is unchanged — silent-drop is preserved for callers who don't
opt in. Documented in CONTEXT.md §5.7. Both error classes are relocated
to `src/orm/errors/` (one file per class, barrel-exported via
`src/orm/errors/index.ts`).

## Considered Options

- **Terminal-verb suffix `findOrThrow()` / `updateOrThrow()` / `deleteOrThrow()`.**
  Matches Prisma (`findFirstOrThrow`), TypeORM (`findOneOrFail`),
  Kysely (`executeTakeFirstOrThrow`) — the dominant TS-ORM convention.
  Rejected: requires three new terminal verbs symmetric across find/update/
  delete; the modifier shape is cheaper (one builder step, single typestate
  parameter, return-type narrowing flows automatically) and keeps the
  builder-chain rule (§2.2) clean — `.required()` slots in alongside
  `.where()` / `.select()` / `.preload()` without inventing a new verb
  family.
- **Cardinality-pair entry `.exactlyOne()` next to `.one()` / `.all()`.**
  Mirrors Supabase's `.single()` / `.maybeSingle()`. Rejected: doesn't
  extend symmetrically to `update` / `delete` — Supabase doesn't have this
  problem because their writes return arrays of affected rows. Adopting
  the pattern would either leave update/delete silent (defeating the goal)
  or require a separate mechanism for writes anyway.
- **Change `update` / `delete` defaults to throw on no-match (Prisma-style
  always-throw-on-write).** The cleanest fix to the underlying silent-drop
  concern. Rejected for _this_ PR: it's a breaking change to existing
  callers and a much larger decision than adding an opt-in modifier — left
  for a future ADR if/when the in-tree need surfaces. The required-row
  contract is purely additive and reversible; the default change is not.
- **Name `.expect()` (Rust idiom).** What was originally proposed.
  Rejected: vitest's globally-imported `expect` is used in the same files
  via `import.meta.vitest` (see `builders.ts:327`). Side-by-side
  `repo.on(S).one().expect().find()` and `expect(found).toBe(...)` is a
  visual collision; `.required()` reads as a chain-shape modifier
  (grammatical class of `.where()` / `.select()`) and avoids the clash.
- **Reuse `OrmValidationError` with a new `kind: 'not-found'`.** Smaller
  surface (one error class instead of two). Rejected: `OrmValidationError`
  is documented as the _Repo-entry boundary_ error class (§7.5), and its
  carrier shape (`failures: [{ opIndex, rowIndex, field, cause }]`) is
  meaningless for a not-found case. Conflating boundary-input failures
  with post-adapter result failures dilutes both. Every comparable ORM
  uses a dedicated class (Prisma `NotFoundError`, TypeORM
  `EntityNotFoundError`, Kysely `NoResultError`).
- **Throw inside the executors** (`runOneRead` / `runOneUpdate` /
  `runOneDelete`). Centralises the throw with the adapter call and the
  schema/where context. Rejected: the executors today are pure shape
  pipelines — threading a `required` flag through their state types
  muddies their responsibility, and the builder already has all the
  context (`this._context.schema`, `this._where`, the verb name as a
  literal) at the call site. The diff is smaller in the builder.
- **Carrier shape with discriminated `selector` (pk-vs-filter union) or
  flat optional `pk` + `filter` fields.** Both require the builder to
  remember which form (`.id(pk)` vs `.where(q)`) the user used.
  Rejected: at the throw site there's only a `FilterGroup` regardless
  (`.id(pk)` is sugar for `.where(q => q.eq(pkField, pk))`), so a single
  `where: FilterGroup` field matches the runtime reality and matches the
  codebase's existing `where`-naming convention (`OneBuilder._where`,
  executor state `where`, user-facing `.where(...)` verb).
- **`AllBuilder.required()` counterpart.** "Throw on empty array".
  Rejected for this PR: scoped out by the _required-row scope rule_ —
  empty arrays are a different domain (no inherent silent-drop; the empty
  array is a _real_ answer, unlike `null`-on-no-match for OneBuilder).
  Can be revisited if a concrete need surfaces.
