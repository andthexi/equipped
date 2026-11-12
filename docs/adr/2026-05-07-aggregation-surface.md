# Aggregation surface (`.aggregate()` chain) with a tight canonical op set

The legacy `dbs` layer had no aggregation surface (only `countDocuments` for
its paginated envelope). The orm has the same gap: anything beyond
filter-based reads (counts, rollups, group-bys, joined aggregates) has to
drop to `repo.on(S).raw(...)`. The decision: add a **first-class aggregation
surface** as a new sibling cardinality entry verb on `SchemaRef` —
`repo.on(S).aggregate()` returning an `AggregateBuilder` — terminated by
`.run()`. The canonical aggregate-op set is **tight by design**:
`count · countDistinct · sum · avg · min · max`. Group-by is supported via
multi-key rest-args over schema fields; pre-aggregation filtering uses the
existing `FilterFactory`; post-aggregation filtering uses a `.having()` step
typed over the alias-and-group-key map. Cardinality is typestate-driven via
a `HasGroupBy extends boolean` parameter on the builder — `run()` returns
`R` if no `.groupBy()` was called, `R[]` if one was. Field-type
constraints are enforced at the type level (sum/avg → `number` only,
min/max → `number | string | date`, group-by keys → scalar). Adapter
contract: one new method `aggregate(schema, schemaCfg, spec)` plus one new
capability declaration `aggregateOps`. The chain verb `repo.on(S).aggregate()`
is gated on the method being declared **AND** non-empty `aggregateOps`,
parallel to the `update*` rule (§5.1). Validation lands at the Repo-entry
boundary as a single new `OrmValidationErrorKind: 'aggregate'`. Documented
in CONTEXT.md §3.2 (capability table), §4.4 (new canonical aggregate-op
set), §5.1 (gated-verb table), §5.8 (the aggregation surface),
§7.5 (error kind).

## Considered Options

- **Stay in `raw` indefinitely.** Close the TODO as out-of-scope.
  Aggregations require backend-specific power (window functions, having on
  expressions, joins inside aggregates) that don't generalise across SQL,
  Mongo, in-memory, JSON. Smallest canonical-set surface; most honest about
  portability. Rejected: the universal core (count/sum/avg/min/max +
  group-by + pre-filter + post-filter) maps cleanly to every backend in our
  adapter set — PG via SQL `GROUP BY`/aggregate funcs, Mongo via the
  aggregation pipeline (`$match` → `$group` → `$match`), in-memory/JSON via
  trivial JS reduce. Forcing every "count rows" query through `raw` for a
  feature six aggregator functions wide is undershoot.
- **Phased rollout: `.count()` only first, sum/avg/min/max/groupBy later.**
  The smallest viable step; many ORMs treat count specially because it's the
  80% case. Rejected: once you've paid the architectural cost of a new
  adapter method and capability declaration for count, adding the other five
  aggregators is nearly free — they share the same dispatch path, the same
  groupBy/having logic, the same result-row inference. Splitting into two
  ADRs would just defer the work without simplifying it.
- **Drizzle-class scope: tight 6-op set + expression-based group keys +
  `SUM(price * qty)` projection via a small expression DSL.** Power-user
  friendly; matches Drizzle and Kysely's surface. Rejected: an expression
  DSL is unbounded by definition — it breaks the closed-set rule (§4.4),
  forces every adapter to ship a DSL compiler (PG: SQL emitter; Mongo:
  pipeline expression compiler; in-memory/JSON: JS evaluator), and inflates
  the aggregation-op set indefinitely. Users who need `SUM(price * qty)`
  can compute the product as a virtual schema field or go to `raw`. The
  tight set keeps every adapter at parity for free.
- **Kysely-class scope: above + window functions via `.over()`.** First-
  class window functions are powerful but only PG (in our adapter set)
  supports them natively; Mongo's `$setWindowFields` is shaped completely
  differently; in-memory/JSON would need their own window-frame
  implementation. Rejected on the same closed-set / cross-adapter-parity
  grounds as the expression-DSL option. Window functions go through `raw`
  for now; revisit if a concrete in-tree need surfaces.
- **Separate `count` verb + general `aggregate` verb.** Many ORMs special-
  case count (Prisma `_count`; Drizzle has both `count()` and a top-level
  `$count` helper; Mongoose has `.count()` shortcut). Rejected: count is
  not architecturally distinct from sum/avg/min/max — same return type
  (`number`), same group-by / having / where semantics. Special-casing it
  fragments the surface for ergonomic gain that's already covered by
  `.aggregate().count('total').run()` (one call, no chain ceremony in the
  trivial case).
- **No `countDistinct`; users filter-then-count or go to `raw`.** Smaller
  canonical set (5 ops, not 6). Rejected: `countDistinct` is the universal
  ask after `count` — every comparable ORM exposes it as first-class
  (Drizzle `countDistinct`, Kysely `eb.fn.count(col).distinct()`,
  Prisma `_count: { field: ..., distinct: [...] }`). Maps to
  `COUNT(DISTINCT)` in PG, `$addToSet` + `$size` in Mongo, JS `Set` in
  in-memory/JSON — all four adapters do it cheaply. Punting it to `raw`
  would force the most common non-`count(*)` use case (unique-user counts,
  unique-event counts) through the escape hatch for no architectural gain.
- **Composite "no-flavour" `count`: `count(field?, alias)` covering both
  `COUNT(*)` and `COUNT(field)` (non-null count).** SQL distinguishes
  `COUNT(*)` (rows) from `COUNT(field)` (non-null). Drizzle exposes both
  via overload (`count()` vs `count(column)`). Rejected: non-null count is
  niche in app code — the common cases are total rows (COUNT(*)) and
  unique values (COUNT DISTINCT). Users who want non-null count can
  `.where(q => q.exists(field))` then `.count(alias)`. Keeping `count(alias)`
  field-arg-less keeps the canonical set's per-op semantics each one-line
  and unambiguous.
- **Verb shape: terminal verb on `.all()` (`repo.on(S).all().where(q).aggregate({...})`)
  composing with the existing filter chain.** Smaller surface — no new
  entry verb. Rejected: the `.all()` cardinality contract says "returns
  `T[]` of schema rows"; aggregation returns aggregate-shaped rows
  (different shape, different field set), breaking that promise. Cardinality
  of the result depends on whether `groupBy` is in the spec object —
  hidden inside a value, not visible in the chain. And no typestate
  accumulator on a flat-config blob means alias uniqueness can't be
  caught at the type level.
- **Verb shape: direct flat-config call (`repo.on(S).aggregate({ where, aggs, groupBy, having })`).**
  Most Prisma-like; smallest API surface. Rejected: §2.4's non-construction
  call inventory is closed (`repo.on`, `repo.session`, `repo.resolve`, op
  helpers) — aggregation isn't an entry/session/resolver/helper, it's a
  query. The fluent builder shape gives free typestate (alias uniqueness
  via §2.3 uniqueness guard, cardinality narrowing via `HasGroupBy`,
  result-row inference via the accumulator) that a flat-config call can't
  match.
- **Result cardinality: always-array terminal (no typestate split).**
  `.run()` always returns `R[]`; no-groupBy returns a single-element array.
  Matches Drizzle's `db.select(...).from(t)` shape, Mongo's `aggregate()`,
  and SQL's "no GROUP BY = one implicit group". Rejected: ergonomically
  worse for the most common case (a bare `count` or `sum` without group-by)
  — `(await repo.on(S).aggregate().count('total').run())[0].total` is
  needless ceremony when the typestate already knows the cardinality is
  one.
- **Result cardinality: split terminal verbs `.runOne()` vs `.runMany()`.**
  Mirrors `.one()` / `.all()` on the entry side. Rejected: doubles the
  terminal-verb surface for no type-safety win — the typestate already
  prevents calling `.runMany()` without groupBy and `.runOne()` with
  groupBy; collapsing to a single `.run()` whose return type narrows
  automatically is cleaner.
- **Aggregator step shape: single declarative map (Drizzle/Prisma-style).**
  `.aggregates({ total: count(), revenue: sum(field) })` — one step, all
  aggregators in an object map. Rejected: loses the per-step typestate
  accumulator and the §2.3 uniqueness guard pattern (alias collision
  becomes a type-system shape problem, not a fail-at-the-offending-call
  problem); breaks the clone-on-step / fan-out story (§2.2) where users
  hold a partially-built builder and branch from it.
- **Aggregator step shape: auto-aliased steps (Prisma `_count: true`).**
  `.count()` produces alias `_count`; `.sum(field)` produces `sum_field`.
  Rejected: too magic for a closed-set ORM; ambiguous on `.sum(a).sum(b)`;
  conflicts with the explicit name-parity rule (§4.1).
- **Field-type constraints: runtime-only at the boundary.** Throw
  `OrmValidationError(kind: 'aggregate')` if user sums a string field.
  Rejected: §10.3 establishes type-level field-category as the codebase
  pattern for op-vs-field constraints; aggregators are the read-side
  parallel. Type-level constraints catch mistakes at the call site, not
  after the round-trip to the boundary.
- **Field-type constraints: trust the adapter.** PG throws on `SUM(text)`;
  Mongo silently returns `null`; in-memory coerces with `Number()`.
  Rejected: inconsistent across adapters (different errors per backend) —
  exactly the failure mode the canonical-set rule (§4.4) exists to
  prevent.
- **Validation: split into multiple `OrmValidationErrorKind` members
  (`'aggregate-alias-collision'`, `'aggregate-undeclared-op'`,
  `'aggregate-invalid-field'`, `'aggregate-having-invalid'`).** Granular
  programmatic discrimination. Rejected: most aggregate-validation cases
  are compile-time errors already (type-level field-type constraints,
  uniqueness guard for aliases, structural narrowing for undeclared ops);
  the runtime path is rare. Spending four enum members on rare paths is
  enum-explosion; per-failure detail belongs in the `failures[]` carrier.
- **Validation: reuse existing kinds (`undeclared-op`, `validation`,
  `conflicting-ops`).** Zero enum growth. Rejected: the existing kinds
  become semantically muddier (their carrier shape doesn't carry alias-
  specific context cleanly) and `'aggregate'` as one cohesive kind matches
  the operation-aligned kind cardinality of the existing five kinds.
- **`.having()` typing: raw-string fields only (no inference over
  aliases).** Smaller implementation. Rejected: the typestate accumulator
  already carries the alias-and-group-key map for the result-row inference;
  reusing it for `.having()` is nearly free at the type level. Drizzle /
  Kysely / Prisma all type having clauses; matching that bar is cheap.
- **`.having()` typing: skip `.having()` entirely; punt post-filter to
  client-side after `.run()`.** Simple. Rejected: the no-emulation rule
  (§3.4) cuts the other way for _server-side_ push-down. SQL/Mongo
  over-fetch (return all groups, even ones the user wants discarded);
  group cardinality can be unbounded. Aggregations are exactly where
  over-fetch hurts most.
- **Method-group placement: new `aggregational` method-group.** The
  current four documentation-group labels are `lifecycle`, `crud`,
  `queryable`, `transactional`. A fifth group could host `aggregate`.
  Rejected: §3.1 explicitly says the group labels are documentation-only
  vocabulary. `aggregate` is filter-based (where-clause + filter ops + no
  PK) — it sits naturally next to `findMany`/`updateMany`/`deleteMany`/
  `upsertOne` under the `queryable` label.
- **Documentation strategy: ADR only, no CONTEXT.md edits until
  implementation lands.** Smallest doc surface. Rejected: aggregation
  touches multiple existing tables/enums (§3.2 capability declarations,
  §5.1 gated-verb table, §7.5 error-kind enum). Allowing those tables to
  stale erodes their authority over time. The pattern from §5.7 (required-
  row contract) is the precedent — one dedicated sub-section + targeted
  surgical edits to the affected tables.
