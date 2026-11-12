# Equipped ORM — Context

This document is the long-lived reference for the ORM in `equipped`. It defines
the canonical vocabulary used across the ORM, the rules that govern every layer,
and the items that are explicitly out of scope.

The ORM is a typed, capability-aware Repo over adapters. The package ships a
small set of in-tree reference adapters (in-memory, json, postgresql,
mongodb); production targets it doesn't cover are user-supplied. The
conceptual stack is **Schema → Relations → Adapter → Repo**, with Repo
construction taking a base resolver and an optional runtime override stack
for per-query config transforms (`repo.resolve(transform, fn)`). The
TypeScript type system narrows the Repo's surface to exactly what the adapter
declares it can do; any mismatch is a compile error, not a runtime throw.
Validation runs once, in the package, at the Repo-entry boundary; the adapter
is handed validated input.

Each section below is the canonical reference for one layer or cross-cutting
concern. Sections 13 and 14 cover principles and explicit non-goals.

---

## 1. Definitions (the four artifact kinds)

The ORM has exactly four top-level **definitions**. Each is constructed by a
static factory method `X.from(args)` that returns a builder, terminated by
`.build()` (the **builder-chain rule** — see §2).

### 1.1 Schema

A **Schema** is a typed description of a single document shape — its name, its
PK field, its data fields, and any computed fields. A Schema is
adapter-agnostic and relations-agnostic; it carries valleyed pipes for
validation and TypeScript types for compile-time inference.

A Schema is **not** a table, a collection, a model class, a row object, or an
instance. It is not bound to a database. It is not aware of relations. It is
not aware of adapters.

```ts
const UserSchema = Schema.from('users')
  .pk('id', v.string(), () => crypto.randomUUID())
  .field('email', v.string())
  .field('age', v.number())
  .field('createdAt', v.number(), { onCreate: () => Date.now() })
  .field('updatedAt', v.number(), { onUpdate: () => Date.now() })
  .build()
```

Vocabulary:

- A **field** is a schema-side declaration (`schema.fields.email`). Never call
  these "columns" — that leaks SQL framing.
- A **document** is a runtime row returned by a Repo method. Adapter-neutral
  (works for SQL rows, Mongo docs, Firebase docs).
- The schema's `fields` accessor returns **schema-tagged Field** instances —
  each `Field<T, N, S>` carries a phantom parent-schema parameter `S` (see
  §9.2) that lets the type system constrain FK refs and filter ops to the
  correct parent schema.

### 1.2 Relations

A **Relations** is a typed description of how one schema connects to others.
Relations are stored in a separate artifact from the schema and wire `hasMany`
/ `hasOne` / `belongsTo` descriptors keyed by name. The plural form is
intentional: a single `Relations.from(...)` call declares multiple relations,
so the artifact is *a Relations* (singular noun, plural form).

Relations are **not** part of the schema, **not** enforced by the database (no
DDL), and **not** automatically bidirectional. A `User → posts` `hasMany` does
not imply `Post → user` `belongsTo`; both must be declared if both are wanted.

```ts
const UserRels = Relations.from(UserSchema)
  .hasMany('posts', PostSchema.fields.userId)
  .belongsTo('org', UserSchema.fields.orgId, OrgSchema)
  .hasOne('profile', ProfileSchema.fields.userId)
  .build()
```

Vocabulary:

- A **relation** is one entry inside a Relations (e.g. `UserRels.posts`).
- The three **relation kinds** are `hasMany`, `hasOne`, `belongsTo`.
- The **source schema** is the schema passed first to `Relations.from(...)`;
  the **target schema** is the schema being related to.
- See §9 for full Relations vocabulary.

### 1.3 Adapter

An **Adapter** is a class — a subclass of the abstract `OrmAdapter` base —
that the framework instantiates and calls to talk to a specific database.
Adapters are typically bound to a specific database driver/SDK. The package
ships a small set of in-tree reference adapters (in-memory, json, postgresql,
mongodb); production targets the package doesn't cover are user-supplied. The
JSON reference adapter is local-file persistence: every adapter operation
acquires the file lock, reloads the latest JSON snapshot, applies its read or
write, and persists only write operations. `disconnect()` waits for pending work
but does not write a stale in-memory snapshot.

An Adapter is **not** a builder (Schema, Relations, and Repo are; Adapter is
not — see §2.2 for the carve-out). It is **not** a connection (the connection
client is an instance field on the adapter). It is **not** a Repo (Repo wraps
an adapter instance; an Adapter doesn't know about Repo).

Each adapter class is constructed via the package-level `configurable(pipe, Base)`
primitive (`src/utilities/configurable.ts`): it extends `configurable(connectionPipe, OrmAdapter)`,
so the `connectionPipe` validates the connection-level config at
`MyAdapter.create(rawConfig, ...extras)`, and the validated value is exposed
as `this.config` (typed via the phantom `typeof MyAdapter.Config` marker).
Per-call schema-level config is declared separately as a required
`readonly schemaConfigPipe` on the adapter — see §6.1 (two-tier config
split).

```ts
const mongoConnectionPipe = () => v.object({
  uri: v.string(),
  // ...other connection-level fields
})

export class MongoAdapter extends configurable(mongoConnectionPipe, OrmAdapter) {
  readonly schemaConfigPipe = v.object({ db: v.string(), col: v.string() })

  readonly queryableOps = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'like', 'exists', 'notExists', 'contains', 'notContains'] as const
  readonly updateOps = ['set', 'inc', 'mul', 'min', 'max', 'unset', 'push', 'pull', 'patch'] as const
  readonly supportedFieldTypes = ['string', 'number', 'boolean', 'null', 'object', 'array', 'date'] as const

  #client: MongoClient
  protected constructor(config: typeof MongoAdapter.Config, options?: MongoOptions) {
    super(config)
    this.#client = new MongoClient(config.uri, options)
  }

  async connect()    { await this.#client.connect() }
  async disconnect() { await this.#client.close() }

  async findByPk(schema, schemaCfg, pk)        { /* ... */ }
  async createMany(schema, schemaCfg, data)    { /* ... */ }
  async findMany(schema, schemaCfg, filter, options?) { /* ... */ }
  async session<T>(fn: () => Promise<T>)       { /* ... */ }
  // ...optional methods the adapter chooses to implement
}

const adapter = MongoAdapter.create({ uri: 'mongodb://...' })
```

Vocabulary:

- The Adapter has two kinds of named parts: **methods** (flat optional
  instance methods on `OrmAdapter`: `connect`, `disconnect`, `findByPk`,
  `createMany`, `updateByPk`, `deleteByPk`, `raw`, `findMany`, `count`,
  `iterateMany`, `updateMany`, `deleteMany`, `upsertOne`, `session`) and **capability declarations**
  (literal-typed `readonly` instance fields: `queryableOps`, `updateOps`,
  `supportedFieldTypes`, plus the required `schemaConfigPipe`).
- The historical bag groupings (`lifecycle`, `crud`, `queryable`,
  `transactional`) survive **only as documentation labels** — see §3.1. They
  no longer carry runtime or type-system structure.
- Cross-cutting effects (e.g. `updateOps` gating ops on update methods) are
  described by their declaration.
- See §3 for the full Adapter surface vocabulary.

### 1.4 Repo

A **Repo** is the user-facing object built around an adapter and a base
resolver. A single Repo handles all schemas via the **schema-bound chain**
`repo.on(Schema)...` (see **schema-per-call**, §5.2).

A Repo is **not** per-schema (no `userRepo` / `postRepo` split). It is **not** a
connection. It is **not** a database client. It is **not** aware of
multi-tenancy directly — tenant context flows through `repo.resolve(transform,
fn)` (§6).

```ts
const repo = Repo.from(PostgresAdapter)
  .resolve((name) => ({ table: name }))
  .build()

await repo.on(UserSchema).one().id('u1').find()
await repo.on(UserSchema).all().where(q => q.gt(UserSchema.fields.age, 18)).find()
await repo.session(async () => {
  await repo.on(UserSchema).one().create({ ... })
  await repo.on(OrderSchema).one()
    .where(q => q.eq(OrderSchema.fields.id, 'o1'))
    .update({ ... })
})
```

Vocabulary:

- The **Repo surface** is the typed shape of `repo.on(Schema)`'s chain plus
  Repo-level methods (`session`, `resolve`).
- **schema-per-call** is the calling pattern (`repo.on(UserSchema).one().id('u1').find()`
  rather than `userRepo.one().id('u1').find()`).
- **`repo.on(schema)`** is the **schema-bound entry**: returns a `SchemaRef`
  that exposes per-schema chains (`one()`, `all()`, `raw(...)`).
- See §5 for the full Repo surface vocabulary.

### 1.5 Cross-artifact conventions

- The three **declarative-data artifacts** (`Schema`, `Relations`, `Repo`) are
  constructed via `X.from(args).step()...build()`. Each exports a static
  `.from(...)` factory that returns a builder; `.build()` is the explicit
  terminal step that returns the artifact instance. The fourth artifact —
  `Adapter` — is **behavioural** and uses the class-via-`configurable` form
  instead of a builder chain (see §2.2 carve-out and §1.3).
- Each `.from(...)` takes only its **constructor-essential** input(s):
  - `Schema.from(name)` — name positional
  - `Relations.from(source)` — source schema positional
  - `Repo.from(adapter)` — adapter positional
  Everything else (fields, FK descriptors, resolver) goes into builder steps.
  Adapters take the connection-config pipe as the first argument to
  `configurable(connectionPipe, OrmAdapter)`; everything else (capability
  declarations, methods, `schemaConfigPipe`) is class body.
- Pluralisation uses natural English plurals (`schemas`, `adapters`, `repos`).
  `Relations` is a singular noun in plural form; capitalise when ambiguous.
- The collective term for "things produced by `.from(...).build()`" is
  **definition**.
- **Cross-schema field-set composition is a userland pattern.** Schemas
  that share field sets (timestamps, tenant ids, soft-delete columns) are
  expressed as a userland factory function that takes a name and returns
  a partially-built `SchemaBuilder`, e.g.
  `withCommonFields(name) => Schema.from(name).pk(...).field('createdAt', ...).field('updatedAt', ...)`,
  consumed as `withCommonFields('users').field('email', v.string()).build()`.
  The library ships **no** Mixin artifact, no `.use(fieldSet)` builder
  step, and no other composition primitive — the typed accumulator on
  `SchemaBuilder` flows through factory-function returns naturally, and
  every alternative shape considered (fifth artifact, `.use()` step,
  plain transformer fn) added vocabulary or typing surface for what is
  morally a typed dict of fields. See ADR
  `2026-05-09-event-log-rework.md` for the full discussion (the
  composition concern surfaced as a sub-thread there).

---

## 2. Builder-chain factory pattern

The pattern `X.from(args).step1().step2().build()` is the canonical shape for
all artifact construction in the package. This section locks the vocabulary
and rules of the pattern.

### 2.1 Vocabulary

- A **factory** is the static factory method (`Schema.from`, `Relations.from`,
  `Repo.from`). Calling it returns a **builder**. Adapter has no `.from` —
  it's class-via-`configurable` (§1.3, §2.2).
- The **builder** is the object returned by `.from(...)`. Each builder method
  returns a new builder whose accumulator type includes the declarations from
  prior steps.
- A **builder step** is a method on the builder (`.field()`, `.pk()`,
  `.computed()`, `.hasMany()`, `.belongsTo()`, `.resolve()`).
- The **terminal step** is `.build()` — the only step that returns the
  artifact instance. `.build()`'s availability is gated on the accumulator
  satisfying the artifact's prerequisites (§2.6).
- The **accumulator type** is the generic on the builder that grows as steps
  are called. Used to gate later steps and `.build()`.

### 2.2 Rules

- **Builder-chain rule.** Static-factory builder chains are the canonical
  shape for **declarative-data** artifact construction (Schema, Relations,
  Repo). New declarative-data artifacts follow `X.from(args).step1().step2().build()`;
  flat-object factories deferred unless a concrete reason to deviate.
  **Behavioural artifacts** (Adapter, plus package-level adapters in
  cache/jobs/events/server) use the class-via-`configurable` form instead —
  `class X extends configurable(pipe, Base) {...}` with a `protected constructor`
  and inherited `static create(input, ...args)`. The split is deliberate: a
  builder chain is the right tool for accumulating typed declarations
  (fields, FK descriptors, capability lists); a class is the right tool for
  encapsulating behaviour (instance state, methods, lifecycle). See ADR
  2026-05-06 for the decision and the alternatives considered.
- **Once-per-step rule.** Each builder step is callable at most once. Calling
  the same step twice is a compile error via the **uniqueness guard**
  (see §2.3).
- **Per-step coherence.** Later steps reference earlier accumulator state.
  Example: `.computed({...})`'s `deps` are constrained to prior `.field(...)`
  names. Violations fire at the offending call line, not at the end of the
  chain.
- **Rest-args convention.** Where a builder step takes a fixed-shape list,
  rest-args are preferred over array literals (mostly applicable to
  schema/relations builder steps; the analogous rule on Adapter classes is
  that capability arrays use `as const` literal types).
  Uses TS 5.0+ `const` type parameters
  (`<const Ops extends readonly OpName[]>`) to preserve literal types in
  rest-args without `as const`.
- **Omission-equals-empty rule.** A builder step not called means the
  artifact doesn't declare that capability. Op-list fields default to
  `readonly []`; absent steps default to absent. The same rule applies to
  Adapter classes — undeclared capability arrays default to `readonly []` on
  `OrmAdapter`; unimplemented methods stay undeclared.
- **Build-gated materialisation rule.** The artifact instance only exists
  after `.build()`. The builder is *not* the artifact; reading runtime methods
  off a non-built builder is a type error.
- **Clone-on-step rule.** Every builder step returns a *new* builder
  instance, not a mutated `this`. This applies uniformly across module-load
  artifact builders (`SchemaBuilder`, `RelationsBuilder`, `RepoBuilder`),
  filter sub-builders (`FilterGroup`), and per-call query builders
  (`OneBuilder`, `AllBuilder`). The reason is divergent reuse: a user holding
  a partially-built builder must be able to fan out from it
  (`const base = X.from(...).step1(...); const a = base.step2(p); const b = base.step3(q)`)
  without `a` and `b` polluting each other or the shared base. In-place
  mutation would break this. The cost is one allocation per step — small
  compared to the bug class it eliminates.

### 2.3 Uniqueness guard

The TypeScript pattern that makes duplicate keys fail at compile time:

```ts
class XBuilder<Acc extends Record<string, unknown> = {}> {
  step<K extends string>(
    name: K extends keyof Acc ? never : K,
    ...
  ): XBuilder<Acc & Record<K, ...>> { ... }
}
```

If the user attempts `.step('foo', ...).step('foo', ...)`, the second `'foo'`
resolves to `never` and TS errors at the offending line. This is the
**uniqueness guard**; it underpins the once-per-step rule and duplicate-key
safety throughout the package.

### 2.4 Non-construction calls

Builder-chain is only for *declarative artifact construction*. The following
are **non-construction calls** and use direct function/method calls:

- **Schema-bound entry** (schema-per-call): `repo.on(schema)` — returns a
  `SchemaRef`, the entry point to the per-call query chain.
- **Session entry**: `repo.session(fn)`.
- **Runtime resolver override**: `repo.resolve(transform, fn)` — pushes a
  config transform for the duration of `fn` (§6).
- **Op helpers**: `set(...)`, `inc(...)`, etc. These construct operation
  values used as arguments to other calls; they are single-shot and a chain
  would add ceremony for no benefit.

The query chain itself (`repo.on(Schema).one().id(pk).find()`) is a
sub-pattern of the builder-chain rule — see §2.5.

### 2.5 Query builder and FilterFactory

The query chain `repo.on(Schema).one().id(pk).find()` (and its `.all()`
variant) is itself a builder chain — the **query builder** — terminated by
`.find()` / `.create()` / `.update()` / `.delete()` / `.upsert()` instead of
`.build()`. Steps like `.where()`, `.select()`, `.preload()`, `.orderBy()`,
`.limit()`, `.offset()` accumulate state; the terminal verb executes against
the adapter.

The `FilterFactory` callback `q => q.eq(...).and(...)` (see §11) is a
**filter sub-builder** on `FilterGroup`, used inside `.where(...)`. Same
vocabulary applies (steps, rest-args, etc.); the difference is what's being
constructed (filter trees) and the recursive nesting via `and([(g) => ...])`
/ `or([(g) => ...])`.

### 2.6 `.build()` prerequisites

Each artifact's `.build()` enforces accumulator prerequisites at the type
level. `.build()` is gated as `build(this: { _acc: SatisfiedAcc }): X` — if
the accumulator doesn't satisfy, `this` doesn't bind and TS errors at the
`.build()` call site.

| Artifact | `.build()` requires |
|---|---|
| `Schema` | `.pk(...)` was called (PK-less schemas have no meaning) |
| `Relations` | nothing enforced — empty Relations is a valid no-op |
| `Repo` | `.resolve(...)` was called (the only thing that produces a config) |

(Adapter is constructed via class-via-`configurable`, not a builder — see
§1.3. The equivalent prerequisite for an Adapter class is "extends
`configurable(connectionPipe, OrmAdapter)` and declares `schemaConfigPipe`,"
both enforced at the type level.)

---

## 3. Adapter surface & narrowing

This section describes the rules and vocabulary around the Adapter class's
methods and capability declarations, and how they narrow the Repo's surface.

### 3.1 Methods (and the historical bag groupings)

The Adapter exposes exactly fourteen **optional methods** declared on the
abstract `OrmAdapter` base. Each subclass implements the ones it supports and
omits the rest:

| Method-group label | Methods (each independently optional) |
|---|---|
| `lifecycle` | `connect`, `disconnect` |
| `crud` | `findByPk`, `createMany`, `updateByPk`, `deleteByPk`, `raw` |
| `queryable` | `findMany`, `count`, `iterateMany`, `updateMany`, `deleteMany`, `upsertOne` |
| `transactional` | `session` |

The four group labels (`lifecycle`, `crud`, `queryable`, `transactional`)
survive **only as documentation** — they are vocabulary for discussing related
methods together. They are *not* runtime objects, *not* type-system bags, and
*not* required to be implemented as a unit. The methods themselves are flat
on the class. An adapter that implements `findByPk` and `raw` and nothing else
is a valid adapter (read-only PK-keyed access plus an escape hatch).

Many adapter targets (Firestore, DynamoDB, edge serverless drivers, in-memory
mocks, REST-API adapters) have no meaningful connect/disconnect — leaving
`connect`/`disconnect` unimplemented is silent and structural; no no-op stubs
required.

`findMany`'s `options?` parameter is typed `QueryOptions<Sel>`, defined in
`query-options.ts`.

### 3.2 Capability declarations

A **capability declaration** is a literal-typed `readonly` instance field on
the Adapter that gates ops or field types. There are exactly four plus one
required pipe:

| Declaration | Canonical set | Gates |
|---|---|---|
| `queryableOps` | filter ops | which filter ops the adapter supports |
| `updateOps` | update ops | which update ops `update*` and `upsertOne` accept |
| `aggregateOps` | aggregate ops | which aggregator funcs `aggregate` accepts (§5.8) |
| `supportedFieldTypes` | field types | which schemas can pair with the adapter |
| `schemaConfigPipe` | (a valleyed pipe) | the per-call schema config's shape; validated at the Repo→Adapter boundary every query (§6.3) |

`queryableOps`, `updateOps`, `aggregateOps`, and `supportedFieldTypes` default
to `readonly []` on `OrmAdapter`; subclasses override with `as const` literal
arrays to declare what they support. `schemaConfigPipe` is **abstract** on
`OrmAdapter` — every adapter subclass must declare it.

`updateOps` is a value-level union of `AnyUpdateOp` variants the adapter
supports. It is not a capability registry — surface methods like `upsertOne`
are gated on method-presence, not on `updateOps` membership (§5.1, §12.2).

Each op-list declaration's values are drawn from a closed canonical set (§4).
Adapters **subset** the canonical set; they cannot add new members.

The Adapter's **connection config type** is *not* a capability declaration —
it flows from the `connectionPipe` argument to `configurable(connectionPipe, OrmAdapter)`,
exposed on each subclass as the phantom `static Config` type marker
(`typeof MyAdapter.Config`) and as the `this.config` instance property
(§1.3). The Repo's `.resolve(fn)` step (§6) returns the per-call **schema
config** (typed by `schemaConfigPipe`), not the connection config.

### 3.3 Surface narrowing and structural inference

The **Adapter surface** is the union of all methods and capability
declarations on the Adapter class. The Adapter **declares** a method or op
when it appears on the class (instance method present; literal-typed array
contains the op); an absent method or op is **undeclared**.

**Surface narrowing** is the process by which the Repo's typed methods are
reduced based on the Adapter's declarations. The result of narrowing is the
Repo surface; methods whose required method or op is undeclared are
**narrowed-out methods** — their type resolves to `never`, so calling them is
a compile error.

The mechanism is purely structural: the Repo's per-verb gates read off the
class's instance type via `keyof InstanceType<A>` (method presence) and
`A['queryableOps'][number]` / `A['updateOps'][number]` /
`A['supportedFieldTypes'][number]` (capability membership). There is no
accumulator, no explicit `capabilities: [...]` array, and no separate
"declared methods" registry. Presence on the class is the declaration.

The historical "co-required pair" between the `queryable` bag and a non-empty
`queryableOps` is **self-policing** under structural narrowing: if an adapter
implements `findMany` but leaves `queryableOps = []`, the filter chain
(`q.eq(...)` etc.) is unreachable type-wise (each filter-method is gated on
`'eq' extends queryableOps[number]`, which resolves to `never`), so
`findMany` is effectively narrowed-out at the consumer with no construction-
time check needed.

### 3.4 Per-op gating, parity, and the no-emulation rule

**Per-op gating** is the TypeScript-level mechanism by which an undeclared op
becomes a compile error. The op-list declarations (`queryableOps`, `updateOps`)
drive per-op gating; the field-type declaration (`supportedFieldTypes`) drives
schema-arg gating.

**Declaration-implementation parity** is the invariant that the type system
compile-errors on any mismatch between a declaration and its implementation
on the adapter class. The mechanism is structural method override: the
optional method signatures inherited from `OrmAdapter` constrain each
subclass's method bodies, so a misplaced parameter or wrong return type is
caught at the subclass definition site, not at the Repo dispatch site.
Implementation cannot exceed declaration; declaration cannot lack
implementation.

**No-emulation rule.** The framework never emulates a missing method or op
client-side. If an adapter doesn't declare an op, calling it is a compile
error. Adapter-specific power lives in the adapter's `raw` method only. The
framework does not silently fall back to `findMany` + filter to emulate
unsupported ops.

---

## 4. Canonical sets

The three capability declarations take values from closed canonical sets. This
section locks the canonical sets, naming conventions for their members, and the
rules for adding to them.

### 4.1 Canonical filter-op set

A **filter op** is one of:

```
eq · ne · gt · gte · lt · lte · in · notIn · like · exists · notExists · contains · notContains
```

The **notX-prefix convention**: positive ops keep short natural names (`in`,
`exists`, `contains`); negative ops use a `notX` English prefix (`notIn`,
`notExists`, `notContains`) — never SQL-style `nX` shorthand (no `nin` /
`nexists` / `ncontains`).

The **name-parity rule**: a filter op's string-literal value is identical to
the corresponding method/helper name. The `eq` method on `FilterGroup` writes
`'eq'` to `Filter.op`; the `notExists` method writes `'notExists'`. The wire
form is self-describing.

`notExists` is its own enum value, **not** a boolean form of `'exists'`. Each
op has at most one `value` payload; no op overloads its `value` field as a
flag. The `like` op means case-insensitive literal substring matching;
adapters must not expose SQL wildcard or regular-expression semantics through
`like` values.

### 4.2 Canonical update-op set

An **update op** is one of:

```
set · inc · mul · min · max · unset · push · pull · patch
```

The **lowercase-verb convention**: all update ops are lowercase, mostly
verb-form. Future additions must respect this. `Set`, `INC`, `addToSet`,
`arrayPush` are all rejected by the convention.

Every member of the canonical update-op set has a corresponding op variant
(§10.1) and an op helper (§10.2). The set is closed (§4.4) — adapters subset
it; method-shape capabilities (e.g. `upsertOne`) are gated on method
presence on the adapter class, not by adding members to this set.

### 4.3 Canonical field-type set

A **field type** is one of:

```
string · number · boolean · null · object · array · date
```

The **JS-aligned field-type naming**: members match a JS primitive or
built-in constructor name in lowercase. `'null'` is explicit despite
`typeof null === 'object'`; `'array'` is explicit despite arrays being objects;
`'date'` is named after the `Date` constructor. Future additions must align
the same way. `'str'`, `'int'`, `'timestamp'`, `'json'` are all rejected.

The set is exposed as `type FieldType = 'string' | 'number' | ...` and the
inference helper `FieldTypeOf<P>` derives a field type from a valleyed pipe's
output. `SchemaFieldTypes<S>` is the union of all field types in a schema.

### 4.4 Canonical aggregate-op set

An **aggregate op** is one of:

```
count · countDistinct · sum · avg · min · max
```

The **lowercase-verb / camelCase-compound convention**: bare aggregator
functions are lowercase (`count`, `sum`, `avg`, `min`, `max`); compound
variants use camelCase (`countDistinct`, never `count_distinct` or
`countdistinct`). Future additions must respect this. `Sum`, `COUNT`,
`count_distinct`, `cnt` are all rejected by the convention.

Every member of the canonical aggregate-op set has a corresponding
`AggregateBuilder` step (§5.8) of the same name. The set is closed (§4.5) —
adapters subset it via `aggregateOps`. **Out-of-set aggregations** —
window functions (`row_number`, `rank`, `lag`, `lead`, `dense_rank`),
statistical aggregates (`stddev_pop`, `stddev_samp`, `variance`,
`percentile_cont`), set-builder aggregates (`array_agg`, `string_agg`,
`json_agg`), `FILTER (WHERE ...)` per-aggregate clauses, and grouping sets
(`ROLLUP`, `CUBE`) — are explicitly out of scope. They go through the
adapter's `raw` method.

The **alias-required rule**: every aggregator step takes a string literal
alias as its last argument; the alias is the output key in the result row
and the once-per-step uniqueness key (§2.3) preventing duplicate output
columns. There is no auto-aliasing.

### 4.5 Closed-set rule and extensions

**Closed-set rule.** Adapters subset the canonical sets. They cannot add new
filter ops, update ops, aggregate ops, field types, or relation kinds. Custom
adapter-specific power goes through the adapter's `raw` method only.

A **canonical-set extension** (adding a new member to one of the canonical
sets) is a maintainer-side process. The **canonical-extension contract**
requires:

- (a) the canonical type literal is added to the union;
- (b) the corresponding method or helper is added (filter ops get FilterGroup
  methods; update ops get op helpers; aggregate ops get AggregateBuilder
  steps; field types get FieldTypeOf branches);
- (c) at minimum, the in-memory adapter is updated;
- (d) all locked rules in §4.1–4.4 are respected (notX-prefix,
  lowercase-verb, camelCase-compound, JS-aligned naming, name-parity).

A canonical-set extension is a breaking change and requires a major-or-minor
package version bump per semver.

### 4.6 Out-of-scope field types

`'binary'` (Uint8Array / Buffer) and `'bigint'` are explicitly **out-of-scope
field types**. They are not part of the canonical field-type set and not
planned for inclusion. Adapters must not invent unofficial field types for
them. Users who need binary blobs or arbitrary-precision integers either:

- Encode them as a supported type (binary → base64 string; bigint → string), or
- Go through the adapter's `raw` method for adapter-native handling.

These items are out of scope, not deferred. See §14 for the full out-of-scope
inventory.

---

## 5. Repo surface & schema-per-call

### 5.1 Repo surface and gated chain verbs

The **Repo surface** is the typed shape of `repo.on(Schema)`'s chain plus
Repo-level methods (`session`, `resolve`).

Each query-chain verb is a **gated verb** — its presence depends on the
Adapter's declarations:

| Chain verb | Gate |
|---|---|
| `repo.on(S).one().id(pk).find()` | `crud.findByPk` declared |
| `repo.on(S).one().create(d)` / `repo.on(S).all().create(d[])` | `crud.createMany` declared |
| `repo.on(S).one().id(pk).update(d)` | `crud.updateByPk` declared AND non-empty `updateOps` |
| `repo.on(S).one().id(pk).delete()` | `crud.deleteByPk` declared |
| `repo.on(S).raw(...args)` | `crud.raw` declared |
| `repo.on(S).one().where(q).find()` / `.all().where(q).find()` | `queryable.findMany` declared |
| `repo.on(S).all().<where?>.count()` | `queryable.count` declared |
| `repo.on(S).all().<where?>.<orderBy?>.<limit?>.<page?>.iterate()` | `queryable.iterateMany` declared |
| `repo.on(S).one().where(q).update(d)` / `.all().where(q).update(d)` | `queryable.updateMany` declared AND non-empty `updateOps` |
| `repo.on(S).one().where(q).delete()` / `.all().where(q).delete()` | `queryable.deleteMany` declared |
| `repo.on(S).one().where(q).upsert(d)` | `queryable.upsertOne` declared |
| `repo.on(S).aggregate().<aggs>.<groupBy?>.<where?>.<having?>.run()` | `queryable.aggregate` declared AND non-empty `aggregateOps` |
| `repo.on(S).all().<where?>.<orderBy?>.<limit?>.<page?>.paginate()` | `queryable.findMany` declared AND `queryable.count` declared |
| `repo.session(fn)` | `transactional.session` declared |

There is no truly "always-on" verb; every verb is gated by something. Verbs
whose gates aren't satisfied are narrowed-out (§3.3) — their type resolves to
`never` and calling them is a compile error.

### 5.2 Schema-per-call

**Schema-per-call** is the calling pattern: every per-schema operation enters
through `repo.on(Schema)`, instead of being baked into a per-schema Repo:

```ts
await repo.on(UserSchema).one().id('u1').find()
await repo.on(UserSchema).one().where(q => q.eq(UserSchema.fields.email, 'a@b.com')).find()
await repo.on(UserSchema).one().create({ name: 'Alice', email: 'a@b.com' })
await repo.on(UserSchema).one().where(q).update({ name: 'Alicia' })
```

The schema passed to `repo.on(...)` is the **schema arg**. `repo.on(...)`
returns a `SchemaRef<S>` carrying the schema's type forward through the chain.

**Per-call type narrowing**: each terminal verb's return type narrows to
`SchemaOutput<S>` (or `SchemaOutput<S> | null`, `SchemaOutput<S>[]`) based on
the schema arg captured at `repo.on(Schema)`. The Repo is parameterised by
Adapter only (`Repo<A>`); per-call return types flow through the `S` generic
threaded through `SchemaRef<S>`.

### 5.3 SchemaCompatible

`SchemaCompatible<A, S>` is the TypeScript guard that wraps the schema arg at
`repo.on(Schema)`. It resolves to `S` if every field type in the schema is in
`A['supportedFieldTypes'][number]`, and to `never` otherwise.

```ts
on<S extends AnySchema>(schema: SchemaCompatible<A, S>): SchemaRef<S>
```

Pairing an Adapter with a schema using a field type the Adapter doesn't
declare produces a **schema-incompatibility error** — TS error 2345 at the
`repo.on(...)` call site, blocking the entire chain that follows.

### 5.4 PK-keyed chains vs filter-based chains

Query chains split into two families based on which intermediate verb is
chosen:

- **PK-keyed chains** start with `.one().id(pk)` — they identify a document
  directly by primary key. Backed by the adapter's PK-keyed CRUD methods
  (label `crud` — `findByPk`, `createMany`, `updateByPk`, `deleteByPk`,
  `raw`).
- **Filter-based chains** use `.one().where(q)` / `.all().where(q)` — they
  identify documents via a `FilterGroup` filter (§11). Backed by the
  adapter's filter-based methods (label `queryable` — `findMany`, `count`,
  `iterateMany`, `updateMany`, `deleteMany`, `upsertOne`).

The split mirrors the method-group split on the adapter. PK-keyed and
filter-based chains can be declared independently — an adapter can be PK-only
(no `queryable` methods declared) or query-only (only `queryable` methods).

### 5.5 The `raw` escape hatch

`repo.on(Schema).raw(...args)` is the **escape hatch** for adapter-specific
power. There is exactly one entry point — `raw` on the schema-bound chain;
there is no Repo-level `repo.raw(...)`.

The adapter declares `raw`'s arg-tuple and default result type via its
function signature; the framework infers both. The Repo's chain propagates
the inferred shape and exposes a per-call `<T>` override on the result type:

```ts
// Adapter-side: method signature declares args + result
class PostgresAdapter extends configurable(pgConnectionPipe, OrmAdapter) {
  readonly schemaConfigPipe = v.object({ table: v.string() })
  // ...
  async raw(schema, schemaCfg, command: string, params: unknown[]) {
    const r = await this.#client.query(command, params)
    return r.rows                                // adapter-default result: unknown[]
  }
}

// Call site: args spread, optional <T> override on result
const orgs = await pgRepo.on(OrgSchema).raw<Org[]>('SELECT * FROM orgs WHERE id = $1', ['o1'])
```

Different adapters declare different arg-tuples — Postgres has
`[command: string, params: unknown[]]`, Mongo has
`[pipeline: Record<string, unknown>[]]`, a hypothetical ping adapter has
`[]`. The framework reads the adapter's `raw` signature, drops the
framework-supplied `(schema, schemaCfg, ...)` prefix, and uses the rest as
the chain's call-site args.

All adapter-specific filter shapes, server-side joins, aggregates, and
out-of-scope features go through `raw`.

### 5.6 Session method

The **session method** is `repo.session(fn)`. It is the only transaction
surface in the package. Inside a **session**, every `repo.on(Schema)...` chain
routes through the same adapter and joins the active tx connection
automatically. The function passed to `session(fn)` is the **session callback**.

See §8 for the full session vocabulary.

### 5.7 Required-row contract (`.required()`)

The **required-row contract** is the user-opt-in tightening of §13 principle
#6 (*always-throw-never-silently-drop*) for `OneBuilder`'s nullable verbs. A
chain **marked required** via `.required()` promises that the eventual
`find()` / `update()` / `delete()` will produce a row; if none does, the
framework throws `OrmNotFoundError` instead of returning `null`.

```ts
const user = await repo.on(UserSchema).one().id('u-abc').required().find()
// user: User                            — non-null; throws if no row matched

await repo.on(UserSchema).one()
  .where(q => q.eq(UserSchema.fields.email, 'a@b.com'))
  .required('user must exist')
  .update({ name: 'Alice' })             // throws if no row matched
```

`.required(message?: string)` is a **once-per-chain** modifier on
`OneBuilder`, free-floating in position like `.where()` / `.select()` /
`.preload()`. It flips a typestate parameter `Req` on the builder so the
return types of `find` / `update` / `delete` narrow from `T | null` to `T`.
`create` and `upsert` ignore it (their return types are unconditionally
non-null; `.required()` before them is a runtime no-op — see the *required-row
no-op rule* below).

The optional `message` argument replaces the framework-generated default in
the thrown error's `message` field. The default is generated from `schema` +
`operation` + filter shape — single-`eq`-on-PK chains render as
`"users.findOne: no row matched id=u-abc"`, filter-based chains render the
filter tree.

The runtime null check fires inside the `OneBuilder` verb, **post-adapter**.
The executors (`runOneRead`, `runOneUpdate`, `runOneDelete`) keep their
`T | null` return signatures unchanged; the throw is a builder-level concern.

`OrmNotFoundError extends EquippedError` is the error class:

```ts
class OrmNotFoundError extends EquippedError {
  schema: string                                    // schema.name
  operation: 'findOne' | 'updateOne' | 'deleteOne'  // sibling-consistent with OrmValidationError (§7.5)
  where: FilterGroup                                // the live FilterGroup that produced no match
}
```

Three rules govern the contract:

- **Required-row throw rule.** When `.required()` is on the chain and the
  verb's adapter call produces no row, the framework throws
  `OrmNotFoundError` from the builder layer (not from the executor).
- **Required-row no-op rule.** `.required()` before `create` or `upsert` is a
  runtime no-op — those verbs already return non-null, so the typestate flip
  has no effect. Compiles, doesn't throw, doesn't error.
- **Required-row scope rule.** The `.required()` modifier exists on
  `OneBuilder` only. There is no `AllBuilder` counterpart; "throw on empty
  array" is not in the model.

**Default-on-miss rule.** Without `.required()`, the existing silent-drop on
`update` / `delete` for "no row matched" is preserved by design — the
required-row contract is purely additive opt-in. Changing the default
behaviour would be a separate, breaking change.

### 5.8 Aggregation surface

The **aggregation surface** is `repo.on(S).aggregate()` and its chain — a
sibling cardinality entry verb, peer of `.one()` and `.all()`, terminating
in `.run()`:

```ts
// Single-bucket aggregation (no groupBy → returns one object).
const totals = await repo.on(OrderSchema).aggregate()
  .count('orders')
  .sum(OrderSchema.fields.total, 'revenue')
  .where(q => q.eq(OrderSchema.fields.year, 2026))
  .run()
// totals: { orders: number, revenue: number }

// Grouped aggregation (groupBy → returns an array of group rows).
const byRegion = await repo.on(OrderSchema).aggregate()
  .count('orders')
  .sum(OrderSchema.fields.total, 'revenue')
  .groupBy(OrderSchema.fields.region, OrderSchema.fields.year)
  .where(q => q.gte(OrderSchema.fields.year, 2024))
  .having(q => q.gt('revenue', 1000))
  .run()
// byRegion: Array<{ orders: number, revenue: number, region: string, year: number }>
```

Vocabulary:

- An **aggregator step** is a `.count(alias)` / `.countDistinct(field, alias)`
  / `.sum(field, alias)` / `.avg(field, alias)` / `.min(field, alias)` /
  `.max(field, alias)` call on the `AggregateBuilder`. Each adds one
  output column to the result row.
- The **alias** is the string literal at the aggregator step's last argument
  position; it becomes the result row's key and is the §2.3 uniqueness-guard
  key — duplicates are a compile error at the offending call.
- A **group key** is a schema-`Field` ref passed to `.groupBy(...)`. Group
  keys flow into the result row alongside the aliases, with their declared
  schema field types preserved.
- The **pre-filter** is `.where(q)` — applied to schema rows before
  aggregation. Same `FilterFactory` and `FilterGroup` (§11) as the rest of
  the package.
- The **post-filter** is `.having(q)` — applied to aggregated rows after
  aggregation. Typed over `(Aliases ∪ GroupKeys)`, not over the schema —
  the `FilterGroup` runtime class is reused but parameterised over the
  alias-and-group-key map.

Five rules govern the surface:

- **Aggregation cardinality rule.** The result cardinality is determined by
  whether `.groupBy(...)` was called. The `AggregateBuilder` carries a
  `HasGroupBy extends boolean` typestate parameter; `.run()` narrows the
  return type to `R` when `HasGroupBy = false`, `R[]` when `HasGroupBy = true`.
  No-`groupBy` aggregations return a single object directly, never a
  one-element array.
- **Field-type-per-aggregator rule.** Each aggregator step's field-arg
  generic is constrained at the type level: `sum` and `avg` accept
  `Field<'number', ...>` only; `min` and `max` accept
  `Field<'number' | 'string' | 'date', ...>`; `countDistinct` accepts any
  `Field`; `count(alias)` takes no field arg. `groupBy` keys must be
  `Field<'string' | 'number' | 'boolean' | 'date', ...>` — `'object'`,
  `'array'`, `'null'` are rejected at the type level. Direct parallel to
  §10.3's update-op field-category constraints.
- **Pre/post-filter split rule.** `.where(q)` filters schema rows pre-
  aggregation and is typed over `SchemaFields<S>` — the standard
  `FilterFactory`. `.having(q)` filters aggregated rows post-aggregation
  and is typed over the alias-and-group-key map; aggregator aliases are
  typed by the aggregator's return type (count/countDistinct/sum/avg
  always `number`; min/max keep the source field's type), group-key
  aliases keep the schema-declared type. Both are once-per-step.
- **Terminal-aggregator-required rule.** `.run()` is gated on at least one
  aggregator step having been called — `.aggregate().run()` with zero
  aggregators is a compile error (the build-prerequisite mechanism of
  §2.6, applied to a query-chain terminal instead of `.build()`).
- **Always-array adapter rule.** The adapter's `aggregate(schema, schemaCfg, spec)`
  method always returns `Array<Record<string, unknown>>` — even for
  no-groupBy single-bucket aggregations (length-1 array). The cardinality
  narrowing to `R | R[]` happens **post-adapter**, in the `AggregateBuilder.run()`
  method, by reading the `HasGroupBy` typestate. Same architectural shape
  as the post-adapter throw under the required-row contract (§5.7) — the
  builder layer does the user-facing return-type adjustment, not the
  adapter.

The adapter contract:

```ts
type AggregateSpec = {
  where?: FilterGroup                                   // pre-filter, schema-typed
  aggregates: ReadonlyArray<{
    fn: 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max'
    field?: string                                      // logical field name; absent for count
    alias: string                                       // output key
  }>
  groupBy: readonly string[]                            // logical field names
  having?: FilterGroup                                  // post-filter, alias-map-typed
}

aggregate?(
  schema: AnySchema,
  schemaCfg: SchemaConfig,
  spec: AggregateSpec,
): Promise<Array<Record<string, unknown>>>
```

Validation is single-shot at the Repo-entry boundary via
`assertNormalisedAggregate(schema, adapter, spec)`. Failures are collected
under `OrmValidationError` with `kind: 'aggregate'` (§7.5). Specific failure
flavours — alias collision with a group-key name, undeclared aggregator op,
field-type mismatch (defense-in-depth for the type-level constraints), having-
filter referencing an unknown alias — all collapse to the single `'aggregate'`
kind, with detail in the per-failure carrier.

**Out-of-aggregation-surface escapes.** Window functions, expression-based
group keys (`GROUP BY lower(name)`), expression-based aggregator inputs
(`SUM(price * qty)`), arbitrary projection of computed columns, joined
aggregations, statistical aggregates, and `FILTER (WHERE ...)` per-aggregate
clauses are all out of the canonical surface. They go through the adapter's
`raw` method (§5.5).

### 5.9 Paginated query envelope

The **paginated query envelope** is the result shape returned by the `AllBuilder`
terminal `repo.on(S).all().paginate()`: it wraps the selected and preloaded
**page items** with page metadata and document counts instead of returning the
flat array produced by `.find()`. `.paginate()` exists on `AllBuilder` only;
there is no `OneBuilder` pagination surface.

A **page step** is `.page(page)`, a chain step on `AllBuilder` that records a
1-based page number. It is page-number sugar over offset pagination.

The **offset-source rule**: `AllBuilder` stores a terminal-evaluated offset
source. `.offset(n)` sets the source to `(_limit) => n`; `.page(page)` sets the
source to `(limit) => (page - 1) * limit`; the last source-setting step wins by
replacement. Any terminal that consumes an offset source requires an explicit
`.limit(...)` step, so `.page(2).find()`, `.offset(10).paginate()`, and
`.page(2).iterate()` are query-shape errors. If no offset source is present,
`.paginate()` behaves as page `1` and flat `.find()` uses no offset.

The **page limit** is the maximum number of page items requested for the page.
It comes from `.limit(n)` when present. Duplicate `.limit(...)` calls are
allowed; the latest limit wins. The envelope's `docs.limit` reports the
effective page limit for bounded pages. An unbounded `.paginate()` call with no
`.limit(...)` returns every matching item in one envelope and reports
`docs.limit` as `items.length`.

The **count method** is the adapter method `count(schema, schemaCfg, filter):
Promise<number>`. It receives only the filter, not select/order/limit/offset,
because `docs.total` means "all documents matching the filter before
pagination." It consumes the same `FilterGroup` shape and `queryableOps` gates
as `findMany`; there is no separate count-specific filter-op capability.
Bounded `.paginate()` uses it to compute `docs.total` without loading all
matching rows; the framework never emulates count by calling `findMany` without
pagination. Unbounded `.paginate()` with no `.limit(...)` loads all matching
rows and uses `items.length` for `docs.limit`, `docs.total`, and `docs.count`.
`docs.count` is the number of returned page items (`items.length`). `.paginate()`
is gated on both `findMany` and `count`.

The **count terminal** is `repo.on(S).all().count()`, an `AllBuilder` terminal
that returns the number of documents matching the chain's filter. It exists on
`AllBuilder` only; there is no `OneBuilder` count surface. It ignores
select/preload/order/limit/offset/page state and counts only the filter. Because
that query-shape state is ignored, invalid ignored options do not affect
`.count()`; the terminal validates only the filter. It is gated on the
adapter's `count` method and exists as a lightweight convenience for the same
filter-only count primitive that powers `.paginate()`.

The **count-vs-aggregation distinction**: `all().count()` is a single-purpose
row-count terminal returning `number`; `aggregate().count(alias).run()` belongs
to the aggregation surface and returns an aggregate row, composes with multiple
aggregators, group keys, and having filters.

`.paginate()` takes no `{ page, limit, offset }` argument. Page and limit come
from the existing query-shape chain (`.page(...)`, `.limit(...)`) so the
terminal only means "return the current all-query as a paginated query
envelope". `.offset(...)` is also allowed before `.paginate()` for callers
that already think in row offsets; with an explicit limit, the builder derives
the effective page from the evaluated offset as `Math.floor(offset / limit) + 1`.
`.page(...)` is the preferred semantic step for paginated queries.

A **page item** is one selected and preloaded document in the current page. The
`items` array has the same selected/preloaded row shape as the equivalent
`.find()` call. The paginated query envelope uses `items` for the page-item
array — not legacy `results`, because `results` is overloaded with the whole
query result in the ORM.

```ts
export type Paginated<T> = {
  pages: { current: number; start: number; last: number; previous: number | null; next: number | null }
  docs: { limit: number; total: number; count: number }
  items: T[]
}
```

`Paginated<T>` is exported from `equipped/orm`. There is no `PageRequest` type
because pagination inputs live as builder steps (`.page(...)`, `.limit(...)`),
not as a terminal payload object.

```ts
const page = await repo.on(UserSchema).all()
  .where(q => q.eq(UserSchema.fields.active, true))
  .orderBy('createdAt', 'desc') // deterministic ordering keeps pages stable
  .page(2)
  .limit(25)
  .paginate()

page.items // selected/preloaded documents for page 2
page.pages // { current, start, last, previous, next }
page.docs  // { limit, total, count }
```

The **last-page floor rule**: for bounded pages, `pages.last` is
`Math.ceil(total / limit) || 1`, so an empty result set still reports
`pages.last = 1`. For unbounded `.paginate()` with no `.limit(...)`, the envelope
always reports one page: `{ current: 1, start: 1, last: 1, previous: null, next:
null }`.

The **past-last-page no-neighbors rule**: requesting a page past `pages.last`
returns an empty `items` array, preserves `pages.current` as the
requested/effective page, sets `pages.last` from the total (with the last-page
floor rule), and sets both `pages.previous` and `pages.next` to `null`. The
framework never clamps the requested page down to the last page, and navigation
links only describe adjacent real pages.

The **parallel pagination reads rule**: after validation and config
resolution, bounded `.paginate()` runs the page-item `findMany` and the
filter-only `count` concurrently with `Promise.all`; they are independent reads
over the same filter. Unbounded `.paginate()` performs only the all-matching
`findMany` read.

The **stable-pagination order rule**: `.paginate()` does not require
`.orderBy(...)`, matching `.find().limit().offset()`; callers who need stable
pages across writes must provide a deterministic order explicitly. Multiple
`.orderBy(...)` calls append in order and form a multi-field sort.

`.page(...)` also affects flat `.find()` queries as pure offset sugar; e.g.
`.limit(25).page(2).find()` returns the second page as a flat array with no
count query and no envelope. `.page(...)` and `.offset(...)` require an explicit
`.limit(...)` for `.find()`, `.paginate()`, and `.iterate()`.

`.paginate()` is a separate terminal from `.find()`. Calling `.find()` with
`.limit()` / `.offset()` / `.page()` remains a flat-array query; it never
changes shape into a paginated envelope.

### 5.10 Document iteration terminal

The **document iteration terminal** is `repo.on(S).all().iterate(options?)`: an
`AllBuilder` terminal that returns an async generator over the current query's
selected and preloaded documents, yielding one document at a time. The name is
deliberately **iterate**, not `stream`, because "stream" is reserved in this
context for change-feeds / CDC-style realtime subscription semantics.

```ts
for await (const doc of repo.on(UserSchema).all().iterate({ batchSize: 500 })) {
  // doc has the same selected/preloaded shape as an item from .find()
}
```

The **iteration options object** is `{ batchSize?: number }`. `batchSize` is a
positive safe integer that tells adapters how many rows to fetch from their
underlying cursor per backend round trip. It is not a result-set cap: `.limit(n)`
still controls the maximum number of yielded documents, and `batchSize` only
controls how many rows the adapter asks the backend cursor for at once. Every
in-tree adapter honors `batchSize` where its backend exposes chunk sizing:
PostgreSQL passes it to `pg-cursor` reads, MongoDB passes it to the Mongo cursor,
and in-memory/json preserve the same yielded order/cardinality while using the
value only as internal iteration chunk size. Invalid `batchSize` values throw
`OrmValidationError` with `kind: 'query-shape'` and operation `'iterate'` at the
Repo-entry boundary. Omitted `batchSize` means the adapter uses its
backend/default cursor batch size.

The **iteration parity rule**: for the same `.where()`, `.orderBy()`, `.limit()`,
`.offset()`, `.page()`, `.select()`, and `.preload()` chain, `.iterate(options?)`
yields the same documents, in the same order, with the same selected/preloaded
shape as `.find()`. It differs only in delivery mode and backend fetch chunk
size.

The **per-document preload rule**: when `.iterate()` is used with preloads,
preloads are resolved for each yielded document independently. This preserves
one-document-at-a-time iteration but may issue more preload queries than
`.find()` / `.paginate()`, which batch preloads across their result arrays.

`.iterate()` is a one-shot read traversal over matching documents. It is not a
change feed, not CDC, not a realtime listener, and not a subscription.

The **iterate method** is the adapter method
`iterateMany(schema, schemaCfg, filter, options): AsyncGenerator<Record<string,
unknown>>`, where `options` is an iteration-only options type layered over the
normal read query options with `batchSize?: number`. `batchSize` is not added to
shared `QueryOptions`, so `findMany`, `paginate`, and `count` never receive it.
It is the only implementation path for `AllBuilder.iterate(options?)`; the
framework never emulates iteration by repeatedly calling `findMany`. `iterate()`
is gated on `iterateMany` method presence.

The **cursor lifetime rule** for PostgreSQL iteration: `iterateMany` owns a
backend cursor for the lifetime of the async generator. Outside a session, it
acquires a dedicated client for the cursor, reads rows in `batchSize` chunks when
provided, closes the cursor, and releases the client in a `finally` block so
early `break` and consumer-thrown errors do not leak pool clients. Inside
`repo.session(...)`, it uses the active session client for transaction
consistency, closes only the cursor in `finally`, and does not release the
session-owned client.

---

## 6. Configuration resolution

The Repo holds two pieces of config-machinery: a **base resolver** that maps
a schema's logical name to a config (build-time, required), and a **runtime override stack**
that lets callers temporarily transform the base config (call-time, optional).

### 6.1 Two-tier config and the base resolver

Adapter configuration splits into two tiers:

- **Connection config** — connection-level (URI, credentials, pool options).
  Lives on the adapter instance (`this.config`), validated **once** at
  `MyAdapter.create(...)` against the `connectionPipe` declared in
  `configurable(connectionPipe, OrmAdapter)` (§1.3). Not produced by the
  resolver; not transformed per query.
- **Schema config** — per-schema (table name, collection name, mapper
  options). Produced **per query** by the Repo's base resolver (and possibly
  transformed by the runtime override stack, §6.2). Validated against
  `adapter.schemaConfigPipe` at the Repo→Adapter boundary every query (§6.3).

The **base resolver** is the function passed to `Repo.from(adapter).resolve(...)`
at build time. It produces a **base schema config** per schema. The
resolver's return type is constrained to `PipeInput<typeof adapter.schemaConfigPipe>`
— the framework enforces `(name: string) => SchemaConfigInput`. This is a
breaking callback contract: resolvers receive the logical name, not a Schema
object, and there is no legacy Schema fallback.

```ts
const adapter = PostgresAdapter.create({ host, port, user, password })
//      ^^^^^^^ connection config validated here, exposed as adapter.config

const repo = Repo.from(adapter)
  .resolve((name) => ({ table: name }))   // schema-config; typed by adapter.schemaConfigPipe
  .build()
```

The base resolver is the only thing that *produces* a schema config from a
schema. Without `.resolve(...)`, `.build()` is unavailable (§2.6).

### 6.2 Runtime override: `repo.resolve(transform, fn)`

A `ConfigTransform<C>` is a function `(cfg: C, name: string) => C` that
transforms a base config per query.

`repo.resolve(transform, fn)` is the **runtime override mechanism**. It pushes
`transform` onto an internal stack for the duration of `fn`; every query made
inside `fn` (including async children and nested `repo.resolve` calls) picks
up the transform automatically. The stack is popped on `fn`'s settlement
(success or throw).

```ts
await repo.resolve(
  (cfg, name) => ({ ...cfg, table: `t_${tenantId}_${name}` }),
  async () => {
    await repo.on(UserSchema).all().find()       // sees transformed config
  },
)
```

The stack is backed by `AsyncLocalStorage` so concurrent async chains see
their own scopes — `Promise.all([repo.resolve(t1, ...), repo.resolve(t2, ...)])`
works correctly without leakage.

`repo.resolve(transform, fn)` is the **only** runtime config-transform
mechanism. There is no separate `ContextSource` builder step; users wanting
DI- or middleware-driven scope-entry call `repo.resolve(transform, fn)` from
their own scope-entry layer (§6.5).

### 6.3 Config resolution pipeline

The **config resolution pipeline** is the per-query process that produces the
**effective schema config** — the schema-level config actually handed to the
adapter method:

1. **Base resolve.** `.resolve(...)` runs against the schema's logical name → base schema config.
2. **Stack apply.** Every transform currently active on the runtime stack
   (pushed via `repo.resolve(transform, fn)`) is applied in push order on top
   of the base.
3. **Pipe validate.** The composed result is validated against
   `adapter.schemaConfigPipe` (§3.2). Failure throws an `OrmValidationError`
   from the Repo dispatch layer — pointing at the resolver/transform stack,
   not the adapter internals. Validation runs at the Repo→Adapter boundary,
   consistent with the package's "every layer boundary gets a pipe" rule
   (§7.1).

The **per-query resolution rule**: this pipeline runs for every query —
top-level chains, preload sub-queries (§9.8), and queries inside a session.
There is no session-level or Repo-level schema-config caching that bypasses
the pipeline.

Connection config (`adapter.config`) is **not** part of this pipeline. It is
validated once at `Adapter.create(...)` and stays put for the lifetime of the
adapter instance.

### 6.4 Library-owned ALS scope (config only)

The library uses `AsyncLocalStorage` internally to back the
`repo.resolve(transform, fn)` stack. This is **scoped to config resolution
only** — adapters still own their own tx-context propagation (§8.2,
principle #13.8 in the cross-cutting principles table), and the framework
does not enter or run ALS scopes for any purpose other than `repo.resolve`.

Adapters are free to use any mechanism for tx-context propagation: ALS on
Node/Bun/Deno/Workers, runtime equivalents on edge platforms, or explicit
threading. The framework's use of ALS for `repo.resolve` does not constrain
adapter implementations.

### 6.5 Tenant scoping

**Tenant scoping** is the canonical use case for `repo.resolve`. Pattern:
middleware wraps the request handler in `repo.resolve(transform, fn)` so every
chain inside the handler picks up the transform automatically.

```ts
const repo = Repo.from(PgAdapter)
  .resolve((name) => ({ table: name }))
  .build()

// Middleware: wrap each request in repo.resolve
app.use(async (req, _res, next) => {
  const tenantId = req.header('x-tenant')!
  await repo.resolve(
    (cfg) => ({ ...cfg, table: `t_${tenantId}_${cfg.table}` }),
    async () => next(),
  )
})

// Handler — uses the module-imported `repo` directly
async function getUser(req, res) {
  const u = await repo.on(UserSchema).one().id(req.params.id).find()
  // tenant transform applied automatically via the active repo.resolve scope
}
```

The **untenanted-query footgun**: if the user forgets to wrap a route in
`repo.resolve(...)`, queries silently hit the base config (unprefixed table).
Two documented mitigations:

- **Fail-loud pattern.** Define a base resolver that throws when no scope is
  active (track a sentinel in the transform stack and check for it at the
  base).
- **Sentinel scope pattern.** Wrap legitimate non-tenant code (admin routes,
  migrations) in `repo.resolve(noOpTransform, fn)` so missing-tenant is
  impossible by construction.

The library doesn't enforce either; admin and migration routes have
legitimate non-tenant uses.

### 6.6 Cross-schema sessions and scope-session composition

**Scope-session composition**: when a tenant `repo.resolve(...)` scope wraps
a `repo.session(...)`, every query inside picks up both the tenant transform
(framework-owned via the ALS-backed stack) and the tx connection
(adapter-internal via tx-context propagation, see §8). The two layers
compose without interaction — the tenant transform runs in the config
resolution pipeline; the tx connection routing happens inside the adapter.

### 6.7 What's not in the model

- **Single-Repo rule.** A Repo is built once around a single adapter with a
  single base resolver. Per-tenant or per-context derivation is achieved via
  `repo.resolve(transform, fn)`, not by deriving sub-Repos. There is no
  `repo.withConfig(transform)` chain that returns a new Repo.
- **No-registry rule.** There is no global registry mapping schemas to Repos.
  A Repo handles all schemas it can compatibility-narrow against.
- **Adapter-only-typed-Repo rule.** A Repo is parameterised by Adapter only
  (`Repo<A>`), not `Repo<S, A>`. Per-call return types narrow via the schema
  arg's `S` generic threaded through `SchemaRef<S>`.

---

## 7. Validation flow

Validation runs once, in the package, at the Repo-entry boundary. Adapters
never re-validate.

### 7.1 Repo-entry boundary and the validate-once rule

The **Repo-entry boundary** is the location where validation runs: at the
entry of every Repo method, before any adapter call. The **validate-once rule**:
validation runs exactly once, at the Repo-entry boundary; the adapter receives
**validated input** and is not expected to re-validate.

### 7.2 Create, update, and filter validation

Four families of validation, each named by its function:

- **`validateCreate(schema, document)`** runs on `createOne` / `createMany`
  inputs. Validates the full document against schema pipes; injects `onCreate`
  defaults for missing fields. Rule: **create-validates-full-document**.
- **Op-list walk** runs on `updateOne` / `updateMany` / `updateByPk` /
  `upsertOne` ops. Each `SetOp.values` is pipe-validated per-field; atomic op
  operands are not validated. The **set-only-validation rule**: only set-shape
  values are pipe-validated, because they describe the resulting field value
  directly. Atomic ops (`inc`, `mul`, `push`, etc.) describe a transformation;
  the resulting value depends on existing storage state which the schema
  doesn't own.
- **`assertNormalisedFilter(schema, q)`** runs on every `FilterGroup` filter
  arg. Enforces the **filter normalisation contract** (§11.6): field-existence
  invariant, op-closure invariant, logical-name invariant. No filter value
  validation.
- **`assertNormalisedQueryShape(schema, state)`** runs on read-side query
  shape before `OneBuilder.find()`, `AllBuilder.find()`, `.paginate()` item reads, and `.iterate()` reads. It enforces valid selected
  fields, valid preload definitions, preload source-chain coherence, positive
  integer `limit`, non-negative integer `offset`, and positive integer `page`;
  failures throw `OrmValidationError` with `kind: 'query-shape'` at the
  Repo-entry boundary. `orderBy(string)` remains a raw-string escape hatch and
  is not field-existence-validated by query-shape validation. The **preload source-chain coherence rule** requires
  each top-level preload relation's `source` to match the current schema, and
  each nested preload relation's `source` to match its parent relation's
  `target`. Post-adapter computed-field invariant failures remain
  `EquippedError` because they indicate adapter/framework inconsistency, not
  user input shape.

### 7.3 Auto-bump (Q7.α)

**Auto-bump** is the implicit op-append behaviour for fields with `onUpdate`
generators on update calls. Two rules govern it:

- **onUpdate suppression rule.** If any user op (SetOp or atomic) touches a
  field, that field's `onUpdate` generator is suppressed for this update call.
- **Auto-bump injection.** For each schema field with `onUpdate` whose name is
  not in the **touched-fields set**, the framework appends an implicit
  `set({ <field>: <onUpdate()> })` op to the op list.

The **auto-bump validation rule**: auto-bumped SetOp values are pipe-validated
(same rule as user-supplied set values — generators can return invalid data;
the framework catches that).

### 7.4 Field-conflict rejection

**Field-conflict rejection rule.** If an update has multiple ops touching the
same field (e.g. `set({views: 0})` + `inc(views, 1)`), the framework throws at
the boundary. Cross-kind conflicts (e.g. `unset(x)` + `push(x)`) also throw.

Rationale: order-dependent semantics across adapters (Mongo / PG / Firebase
apply set+inc in different orders) is exactly the silent inconsistency the
framework bans. Conflicts are almost always bugs; loud failure beats a wrong
number in production. Users wanting sequential semantics use two calls inside
`session()`.

### 7.5 Collect-all rule and OrmValidationError

The **collect-all rule**: when validation finds errors, the framework
accumulates them across the input (multiple rows in `createMany`, multiple ops
in update calls) and throws a single error at the end — never fail-fast on the
first.

`OrmValidationError extends EquippedError` is the error class for all
Repo-entry boundary throws. It has a `kind` discriminant for programmatic
classification:

```ts
class OrmValidationError extends EquippedError {
  kind: 'validation' | 'conflicting-ops' | 'empty-group' | 'undeclared-op' | 'upsert-filter-incompatible' | 'aggregate' | 'changes' | 'query-shape'
  schema: string
  operation: 'createOne' | 'createMany' | 'findOne' | 'findMany' | 'paginate' | 'iterate' | 'updateOne' | 'updateMany' | 'updateByPk' | 'upsertOne' | 'aggregate'
  failures: Array<{
    opIndex?: number
    rowIndex?: number
    field?: string                                      // validation/query-shape: offending schema field
    alias?: string                                      // aggregate-only: offending alias / group-key name
    option?: 'limit' | 'offset' | 'page' | 'batchSize'   // query-shape-only: offending query option
    preload?: string                                    // query-shape-only: offending preload path or relation name
    cause: PipeError | string
  }>
}
```

Each entry in `failures` is a **failure entry**. The `kind` field is the
**error kind**. Users catch `OrmValidationError` for boundary-specific
handling, or `EquippedError` for any package-thrown error.

`OrmValidationError` is the error class for **Repo-entry boundary** throws
(input-shape failures caught before any adapter call). For **post-adapter**
"no row matched" throws under the required-row contract, see
`OrmNotFoundError` in §5.7 — a sibling `EquippedError` subclass with its own
carrier shape. Both classes live under `src/orm/errors/`.

### 7.6 Validation pipelines

The **update-validation pipeline** runs in order on every update call:

1. Walk ops to build the touched-fields set.
2. Inject auto-bump ops for un-touched `onUpdate` fields.
3. Check for field conflicts (across user ops + auto-bump ops).
4. Pipe-validate all SetOp values.
5. Run `assertNormalisedFilter` on the filter arg.
6. Hand off to the adapter.

Errors are collected throughout; one `OrmValidationError` is thrown at the end
if any failures were collected.

The **create-validation pipeline** runs `validateCreate` per document, collects
all failures across documents, and throws one `OrmValidationError` if any.

---

## 8. Transactions & sessions

### 8.1 Session contract

The **session method** is `repo.session<T>(fn: () => Promise<T>): Promise<T>`.
The **session contract**:

- The **session callback** runs inside a transaction.
- **Return-to-commit rule.** Successful return commits the transaction;
  `session(fn)` resolves with the callback's return value.
- **Throw-to-rollback rule.** Any uncaught throw in the callback rolls back
  the transaction; `session(fn)` rejects with the same throw.
- **No-explicit-rollback rule.** There is no `tx.rollback()` API. Rollback is
  triggered exclusively by throwing.
- **Sentinel rollback pattern.** Users wanting silent rollback throw a
  sentinel error and catch it outside `session()`. One mechanism, idiomatic
  JS.

### 8.2 Tx-context propagation

**Tx-context propagation** is the adapter's mechanism for routing methods to
the active tx connection during a session. The **adapter-owned tx propagation
rule**: tx-context propagation lives entirely inside the adapter, not in the
framework. Tx semantics genuinely differ per adapter (PG savepoints, Mongo
subtransactions, Firebase no-ops, edge runtimes' per-request tx model); the
framework has no business dictating the mechanism.

A **tx-aware adapter method** is one that, on entry, checks for an active
session context and routes through the tx connection if one exists; otherwise
it grabs from the pool. **Every adapter method must be tx-aware.** The adapter
is free to use Node ALS, runtime equivalents on edge platforms (Workers'
tx-per-request, Deno's runtime, etc.), or any other mechanism.

(The framework itself uses ALS internally for `repo.resolve(...)` config
scoping, §6.4 — but that scope is config-only and does not interact with
adapter tx-context propagation.)

### 8.3 Cross-schema session rule

**Cross-schema session rule.** All schema-per-call methods inside one session
share one tx, automatically. Because a single Repo handles all schemas
(single-Repo rule, §6.7), every `repo.<method>(schema, ...)` call inside
`session(fn)` routes through the same adapter — which tx-binds them via
adapter-internal tx-context propagation.

Combined with §6.6 (scope-session composition): tenant scopes and sessions
compose. A tenant scope wrapping a session applies the tenant transform to
every query inside, while the session keeps every query on the same tx
connection.

### 8.4 Nested sessions

**Adapter-defines-nesting rule.** A `repo.session(...)` inside another
`repo.session(...)` is delegated to the adapter. The framework calls
`adapter.transactional.session(fn)` again; the adapter decides its own nesting
behaviour (PG savepoints, Mongo subtransactions, Firebase no-ops or rejection).

The **nesting documentation contract**: adapter authors must document their
nesting behaviour in the adapter's README.

### 8.5 Isolation

**DB-default isolation rule.** Each adapter uses whatever default level its
`BEGIN` (or equivalent) implies — PG: `READ COMMITTED`; MySQL InnoDB:
`REPEATABLE READ`; SQLite: `SERIALIZABLE`; Mongo 5.0+: snapshot. There is no
`isolation` argument on `session(fn)`.

Inconsistent across adapters by design; the same behaviour every other JS ORM
has. Users needing specific isolation use the **isolation escape**:
`raw('BEGIN ISOLATION LEVEL ...')` or adapter-specific session config.

### 8.6 Session return-value rule

`session<T>(fn): Promise<T>` returns the callback's return value after a
successful commit. If commit fails (e.g. serialization error, deadlock retry
exhaustion), `session` rejects with the commit error rather than the callback's
return value. The **session return-value rule** locks both the success and
commit-failure cases.

### 8.7 What's not in the model

- **No-tx-argument rule.** The session callback signature is
  `() => Promise<T>`, not `(tx) => Promise<T>`. The active tx flows through
  adapter-internal context, not through an argument.
- **Single-DB-tx-only rule.** No two-phase commit, distributed transactions,
  or saga primitives. Single-DB transactions only.
- **No-session-options rule.** No `session(fn, options)` overload. Covers
  isolation, retry, deadlock strategy, nesting policy — all out of scope.

---

## 9. Relations

Relations live in a separate artifact from the schema (§1.2). This section
covers the relation kinds, FK Field refs, the build-callback shape, and the
preload runtime.

### 9.1 Source schema, target schema, FK ownership rule

The **source schema** is the schema passed first to `Relations.from(SourceSchema)`.
The **target schema** is the schema being related to.

The **FK ownership rule**: `hasMany` and `hasOne` have the FK on the target
schema; `belongsTo` has the FK on the source schema. This drives the
per-kind builder shape — `hasMany`/`hasOne` infer the target from the FK
Field's parent, while `belongsTo` requires an explicit target argument.

### 9.2 Field<T,N,S> and the Field-only-FK rule

The **phantom parent-schema parameter** `S` on `Field<T, N, S>` carries the
parent schema at the type level with zero runtime cost:

```ts
class Field<T = unknown, Name extends string = string, S extends AnySchema = AnySchema> {
  declare readonly __valueType?: T
  declare readonly __schema?: S      // phantom; type-only
  readonly name: Name
  readonly path: readonly string[]
}
```

A Field returned by a schema's `fields` accessor is a **schema-tagged Field** —
its `S` parameter is the parent schema. The schema is "tagged" onto the Field
at the type level via the phantom parameter.

The **Field-only-FK rule**: FK refs in `Relations.from(...)` must be
`Field<T, N, S>` refs from the relevant schema's `fields` accessor — not raw
string keys. A string FK pointing at a number PK is now a compile error; the
**FK-PK type-match guarantee** flows from this rule.

### 9.3 Source-positional construction

`Relations.from(source)` takes the source schema as its positional first arg.
The source variable is a const in the outer lexical scope, so FK refs that
point at the source (`belongsTo`'s FK) reference it directly:

```ts
const UserSchema = Schema.from('users')
  .pk('id', v.string())
  .field('orgId', v.string())
  .build()

const UserRels = Relations.from(UserSchema)
  .hasMany('posts', PostSchema.fields.userId)
  .belongsTo('org', UserSchema.fields.orgId, OrgSchema)
  .build()
```

There is no "source binding" alias — the source is the same variable users
already declared, so reference it by name.

### 9.4 Per-kind builder shapes

```ts
hasMany<K extends string, T extends AnySchema, FK extends Field<any, any, T>>(
  name: K extends keyof R ? never : K,
  fk: FK,
)

hasOne<K extends string, T extends AnySchema, FK extends Field<any, any, T>>(
  name: K extends keyof R ? never : K,
  fk: FK,
)

belongsTo<K extends string, FK extends Field<any, any, S>, T extends AnySchema>(
  name: K extends keyof R ? never : K,
  fk: FK,
  target: T,
  references?: Field<any, any, T>,
)
```

- `hasMany(name, fk)` and `hasOne(name, fk)` use **FK-driven target inference**:
  the target schema `T` is inferred from the FK Field's phantom parent
  (`Field<any, any, T>`), so the user only passes the FK Field. The kind
  difference between `hasMany` and `hasOne` is purely cardinality on the
  result type.
- `belongsTo(name, fk, target, references?)` requires an explicit target
  because the FK is on the source (its phantom parent is `S`, not the
  target). The optional `references` is the **references field** — the field
  on the target that the FK references; defaults to the target's PK Field.

### 9.5 Self-referential relations

A **self-referential relation** is a relation to the same schema as the source
(e.g. `User.manager → User`). It works without special-casing — pass the same
schema as both source and target:

```ts
const UserRels = Relations.from(UserSchema)
  .belongsTo('mgr', UserSchema.fields.managerId, UserSchema)
  .build()
```

### 9.6 Schema relations-agnosticism rule

**Schema relations-agnosticism rule.** The Schema artifact contains no
relational information. There is no `.references()` chain on `.field()`, no
FK→target hint on the schema declaration. All relational concerns live in the
Relations artifact. This avoids cyclic forward-reference problems that inline
declarations would force in JS without macros.

### 9.7 Many-to-many (explicit join schemas)

**Explicit-join rule.** Many-to-many is modelled with explicit **join schemas**
— a third schema that joins two others. There is no `manyToMany` or
`hasManyThrough` sugar.

```ts
const PostTagSchema = Schema.from('post_tags')
  .pk('id', v.string(), () => 'pt-id')
  .field('postId', v.string())
  .field('tagId', v.string())
  .build()

const PostRels = Relations.from(PostSchema)
  .hasMany('postTags', PostTagSchema.fields.postId)
  .build()

const PostTagRels = Relations.from(PostTagSchema)
  .belongsTo('post', PostTagSchema.fields.postId, PostSchema)
  .belongsTo('tag', PostTagSchema.fields.tagId, TagSchema)
  .build()
```

Users access tags from a post via a **two-step preload** (`post.postTags[].tag`).
No sugar exists because join schemas frequently carry their own data
(`created_at`, role on a `user_roles` join). Sugar that hides the join schema
obscures this; the explicit form keeps the join as a first-class entity.

### 9.8 Preloads

**Preload** is the framework-side mechanism for loading related documents:
`repo.on(UserSchema).all().preload([UserRels.posts, ...]).find()`.

**Package-side preload.** Preloads run package-side via `findMany` against any
queryable adapter. Cycle detection, max depth, and N+1 dispatch all live in the
package. Server-side joins (PG `JOIN`, Mongo `$lookup`) are out of scope; users
go through `raw`.

Vocabulary:

- **Cycle detection** stops infinite preloading via cyclic relations.
- **Max preload depth** is the per-request limit on preload chain depth.
- **Batched dispatch** is the framework batching N child queries into one
  `findMany(schema, q.in(fk, parentIds))` call (avoids N+1).
- **Preload context-flow rule.** Preloads honour `repo.resolve(...)` transforms
  (§6) — every preload sub-query goes through the same per-query config
  resolution pipeline as the top-level query. Tenant prefixes etc. flow
  through preloads automatically.

---

## 10. Update operations

### 10.1 UpdateOp<S, A>, op variants, op kind

`UpdateOp<S, A>` is the discriminated-union TS type that represents a single
update op at the type level. Each branch of the union is an **op variant**:
`SetOp<S>`, `IncOp<S>`, `MulOp<S>`, `MinOp<S>`, `MaxOp<S>`, `UnsetOp<S>`,
`PushOp<S>`, `PullOp<S>`, `PatchOp<S>`. Each variant has a **op kind**
discriminant — a `kind: 'set' | 'inc' | ...` field — that names the op.

```ts
interface SetOp<S>   { kind: 'set';   values: Partial<SchemaInput<S>> }
interface IncOp<S>   { kind: 'inc';   field: NumericFieldOf<S>; value: number }
interface MulOp<S>   { kind: 'mul';   field: NumericFieldOf<S>; value: number }
interface MinOp<S>   { kind: 'min';   field: ComparableFieldOf<S>; value: unknown }
interface MaxOp<S>   { kind: 'max';   field: ComparableFieldOf<S>; value: unknown }
interface UnsetOp<S> { kind: 'unset'; field: OptionalFieldOf<S> }
interface PushOp<S>  { kind: 'push';  field: ArrayFieldOf<S>; value: unknown | unknown[] }
interface PullOp<S>  { kind: 'pull';  field: ArrayFieldOf<S>; value: unknown | unknown[] }
interface PatchOp<S> { kind: 'patch'; field: ObjectFieldOf<S>; value: Partial<unknown> }
```

`UpdateOp<S, A>` resolves a variant to the variant type if `A['updateOps']`
includes the kind, and to `never` otherwise — per-op gating (§3.4).

### 10.2 Op helpers, helper-kind parity, narrowed-out helpers

**Op helpers** are user-facing functions that construct op variants. Imported
from `equipped/orm`:

```ts
import { set, inc, mul, min, max, unset, push, pull, patch } from 'equipped/orm'
```

The **helper-kind parity rule**: each op helper's name is identical to the
corresponding op kind literal (`set` helper produces `kind: 'set'`). Instance
of the broader name-parity rule (§4.1).

A **narrowed-out helper** is an op helper that produces a `never` type because
the adapter doesn't declare its op kind. Calling it is a compile error — same
mechanic as narrowed-out methods (§3.3), at the helper layer.

### 10.3 Field-category constraints

Each op variant constrains which fields it accepts via field-category type
helpers:

| Helper | Accepted fields | Used by |
|---|---|---|
| `NumericFieldOf<S>` | numeric fields | `IncOp`, `MulOp` |
| `ComparableFieldOf<S>` | comparable fields | `MinOp`, `MaxOp` |
| `OptionalFieldOf<S>` | optional fields | `UnsetOp` |
| `ArrayFieldOf<S>` | array fields | `PushOp`, `PullOp` |
| `ObjectFieldOf<S>` | object fields | `PatchOp` |

The **field-category constraint rule** locks this asymmetry: each op-variant's
field arg is constrained to fields of a specific category.

`SetOp<S>` accepts a **set-payload** — `Partial<SchemaInput<S>>` — and
constrains values per-field via the schema's pipes.

### 10.4 Set ops vs atomic ops

A **set op** (`SetOp<S>`) describes the resulting field value directly. Its
values are pipe-validated.

**Atomic ops** (`inc`, `mul`, `min`, `max`, `unset`, `push`, `pull`, `patch`)
describe a transformation; the adapter applies the op as one storage
operation. Their operands are not pipe-validated, because the resulting value
depends on existing storage state which the schema doesn't own.

This asymmetry is the **set-only-validation rule** (§7.2).

### 10.5 Op-list-shape rules

- **Non-empty op-list rule.** `update*` signatures require ≥1 op via
  `op0: UpdateOp<S, A>, ...rest: UpdateOp<S, A>[]`. An update with no ops is a
  compile error.
- **Field-conflict rejection rule** (§7.4). Same field touched by multiple ops
  → throws at the boundary.
- **Op-order-irrelevance rule.** Op-list order is irrelevant (follows from
  field-conflict rejection — no field is touched twice, so order can't
  matter). Contributors must not write code that depends on op order.

The `[op0, ...rest]` array passed to a single update call is the **op list**.

### 10.6 The `equipped/orm` export rule

Every member of the canonical update-op set has a corresponding op helper
(§10.2). There are no gating-only ops — method-shape capabilities (e.g.
`upsertOne`) are gated on method presence on the adapter class, not on
`updateOps` membership.

Op helpers are exported top-level from `equipped/orm`. Users who collide with
JS built-in `Set` rename on import (`import { set as setOp } from 'equipped/orm'`).
The package does not provide an `ops.*` namespace.

---

## 11. Filter / FilterGroup

Filter args to Repo methods are `FilterFactory` callbacks (`q => q.eq(...).and(...)`).
The package guarantees a normalisation contract on the `FilterGroup` before
handing it to the adapter.

### 11.1 Filter-tree vocabulary

- **`FilterGroup`** is the runtime tree class.
- A **filter group** is one branch in the tree.
- A **filter clause** is one leaf in the tree — a `Filter` instance with
  `field`, `op`, `value`. The class is named `Filter`.
- The **filter tree** is the whole tree (a top-level `FilterGroup` with all
  its branches and leaves).
- `OrderBy` and `QueryOptions` (the query-shape types passed to adapter
  methods alongside the filter) live in a peer Module `query-options.ts`,
  distinct from the filter-tree Module `filter.ts`.

### 11.2 FilterFactory callback

A `FilterFactory` is the callback type passed to filter-based Repo methods.
The callback receives an empty `FilterGroup` — the **filter root** — builds it
up via filter-op methods and structural combinators, and returns it. Prose
term: **filter callback**.

```ts
type FilterFactory = (q: FilterGroup) => FilterGroup
```

### 11.3 Filter-op methods and structural combinators

`FilterGroup` exposes one method per filter op (§4.1) — these are the
**filter-op methods** (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`,
`like`, `exists`, `notExists`, `contains`, `notContains`).

It also exposes **structural combinators**: `and(facFns)` and `or(facFns)`.

- **Combinators-always-available rule.** `and` and `or` are always available
  on any `FilterGroup`, regardless of `queryableOps` declarations. They build
  sub-tree structure, not field-ops; the per-op gating rule (§3.4) applies to
  filter ops only.
- **Empty-combinator rejection rule.** `and([])` and `or([])` throw at the
  moment `FilterGroup.and([])` / `FilterGroup.or([])` is called — at builder
  time, not at the boundary. The stack trace points at the offending call.
  `FilterGroup` is well-formed by construction; the boundary doesn't need to
  recheck.

### 11.4 Logical names and physical mapping

`Filter.field` carries the **logical field name** — the schema-declared field
name (`field.name` if a `Field<T>` ref was passed; raw string verbatim
otherwise).

The adapter is responsible for **physical mapping**: `id` → `_id`, snake_case
columns, document-path conversion, etc. The package boundary uses logical
names; the adapter translates to physical names before issuing the query.

### 11.5 Raw-string field overload

The **raw-string field overload escape rule**: filter-op methods accept either
a `Field<T>` ref (typed) or a raw string field name (untyped — `T` collapses
to `unknown`). The string form is an escape hatch for dynamic queries; users
who pass wrong-typed values bypass the TS contract, and the wrong-typed value
flows through to the adapter as-is (the package does not coerce filter
values — see no-runtime-value-coercion below).

### 11.6 Filter normalisation contract

`assertNormalisedFilter(schema, q)` runs at the Repo-entry boundary on every
filter arg. The **filter normalisation contract** has six **normalisation
invariants** — three enforced and three inverted (the package guarantees it
does NOT do them):

| Invariant | Name | Enforced or inverted |
|---|---|---|
| A | **field-existence invariant** | enforced (every `Field<T>`-resolved name must exist in the schema; unknown names rejected at boundary) |
| B | **op-closure invariant** | enforced for free (filter ops are an enum) |
| C | **no-runtime-value-coercion invariant** | inverted (the package does not run pipes on filter values; type-only contract) |
| D | **no-tree-flattening invariant** | inverted (the adapter receives the tree shape verbatim) |
| E | **empty-combinator rejection invariant** | enforced at builder time (preempted before reaching the boundary) |
| F | **logical-name invariant** | enforced (`Filter.field` is the schema-declared field name; physical mapping is adapter responsibility) |

### 11.7 No-FilterGroup-raw rule

There is no `FilterGroup.raw(...)` filter-shape escape hatch. Custom
adapter-specific filter shapes go via the adapter's `raw(...)` method
(Repo-level), not via the FilterGroup tree. The **no-FilterGroup-raw rule**
locks this — consistent with the no-emulation rule (§3.4) and the closed-set
rule (§4.4).

### 11.8 Filter-tree clone

`FilterGroup.clone()` deep-clones the tree, including `structuredClone` of
values, so callers can safely mutate the result.

---

## 12. Upsert

`upsert` is a filter-based chain verb gated by `queryable.upsertOne` declared
on the adapter, reached via the schema-bound chain.

### 12.1 API shape

```ts
await repo.on(UserSchema)
  .one()
  .where(q => q.eq(UserSchema.fields.email, 'a@b.com'))
  .upsert({
    create: { name: 'Alice', email: 'a@b.com' },
    ops: [set({ lastSeen: Date.now() }), inc(UserSchema.fields.loginCount, 1)],
  })
```

Three argument roles:

- The **filter callback** (the `q => ...` arg passed to `.where(...)`). See §11.
- The **create payload** (`{ name, email }`). The **full-create-payload rule**
  locks this as `SchemaInput<S>` (full document, same as `create`), not
  `Partial`.
- The **op list** (`set(...)`, `inc(...)`). See §10.

### 12.2 Gate rule

**Upsert gate rule.** `upsertOne` exists when `upsertOne` is declared as a
method on the adapter class. Missing → narrowed-out. Symmetric with every
other filter-based Repo method (§5.1) — gate is method presence, no separate
capability flag.

`upsertOne` is meaningful only when `queryableOps` is non-empty, and the
filter chain it consumes is gated on those ops; with `queryableOps = []` the
filter argument is unreachable and `upsertOne` is effectively narrowed-out at
the consumer (self-policing — see §3.3). It accepts the adapter's declared
`updateOps` for its op-list arg. Both flow through the existing filter and
update machinery; no upsert-specific declaration exists.

The **query-only-upsert rule**: there is no `upsertByPk` variant. Real-world
upserts identify by natural key (email, slug, FK), not PK. PK-keyed upsert is
expressible as `q.eq(schema.pkField, pk)` if needed.

The **upsert-in-queryable rule**: `upsertOne` is grouped with the filter-
based methods (label `queryable`), not with PK-keyed CRUD (label `crud`).
Important for adapter authors — its filter argument flows through the same
machinery as `findMany` / `updateMany` / `deleteMany`.

### 12.3 Dual-path semantics

`upsertOne` has two execution paths depending on whether the row exists:

- **Create-then-ops semantics.** Row missing: validate the create payload via
  `createOne` rules (`onCreate` defaults injected), create it, then apply
  atomic ops on top. SetOp values override created fields; atomic ops apply
  to the created values (e.g. `inc(views, 1)` on create with `views: 0` →
  `views: 1`).
- **Update-only-on-exists semantics.** Row exists: ignore the create payload
  entirely; apply ops to the existing row. The Q7.α auto-bump rule applies on
  this path — fields with `onUpdate` not touched by user ops get implicit
  `set` ops.

The pair together is **upsert dual-path semantics**.

The **upsert auto-bump rule**: auto-bump (§7.3) applies on the update path of
upsert. Fields with `onUpdate` not in the touched-fields set get implicit
`set({ <field>: <onUpdate()> })` ops.

The **upsert create-vs-op conflict rule**: an extension of the field-conflict
rejection rule (§7.4). If the create payload sets `views: 0` AND an op
`inc(views, 1)` is also passed, the framework throws (because in the
row-missing case both touch `views`).

### 12.4 Upsert-compatible filter

Not every adapter can implement upsert against arbitrary filter shapes. An
**upsert-compatible filter** is a filter shape an adapter can natively turn
into an upsert.

**Upsert-filter incompatibility error.** If the adapter receives a filter
shape it can't upsert against, it throws an `OrmValidationError` with
`kind: 'upsert-filter-incompatible'` at the adapter boundary, naming the
filter shape it received and what it requires.

The **upsert-filter documentation contract**: adapter authors must document
their upsert-compatible filter shapes in the adapter's README.

Cross-adapter compatibility table (informational; adapter implementations
must match):

| Adapter | Upsert-compatible filter |
|---|---|
| MongoDB | Any filter (native `findOneAndUpdate` with `upsert: true`) |
| PostgreSQL | Single `eq` on a UNIQUE-indexed column (compiles to `ON CONFLICT (col) DO UPDATE`) |
| SQLite | Same as PG |
| Firebase | Single `eq` on the PK field (compiles to `setDoc(ref, ..., { merge: true })`) |

### 12.5 Bulk upsert and other exclusions

**Single-document upsert rule.** `upsertMany` is not supported. Single-document
upsert only. Bulk find-or-create requires adapter-specific implementations
(Mongo `bulkWrite`, PG bulk `ON CONFLICT`); users go through the adapter's
`raw` method.

Bulk upsert is **out of scope** for the framework, distinct from deferred (see
§14).

### 12.6 Return value and what's not in the model

**Upsert-returns-document rule.** `upsertOne` always returns the resulting
document, whether created or updated. The two paths are not distinguishable
from the return value.

- **No-creation-discriminator rule.** The return value is just the document.
  There is no `{ document, created: boolean }` shape.
- **Empty-ops-allowed-on-upsert rule.** `.upsert({ create })` with no ops is
  allowed — it's "upsert this; if it exists do nothing." This is distinct
  from the non-empty op-list rule (§10.5) for `.update(...)`, where the ops
  are the only thing the call does.

---

## 13. Cross-cutting principles

A **principle** is a rule that constrains code in three or more layer-sections
of this document, or is a fundamental non-goal. Layer-local rules stay in
their layer-section. The **spans-three-sections rule** is the admission
criterion: a rule earns a place here if it crosses three or more sections.

| # | Principle | Statement |
|---|---|---|
| 1 | **Builder-chain rule** | Static-factory builder chains (`X.from(args).step()...build()`) are the canonical shape for all artifact construction; direct calls for invocation/operations. (§2.2) |
| 2 | **No-emulation rule** | The framework never emulates a missing op or method client-side. Adapter-specific power lives in the adapter's `raw` method only. (§3.4) |
| 3 | **Closed-set rule** | Adapters subset the canonical sets (filter ops, update ops, field types, relation kinds); they cannot extend them. Extension requires a package version bump. (§4.4) |
| 4 | **Type-system-is-the-contract rule** | Capability mismatches are compile errors wherever feasible, not runtime throws. The TypeScript surface is the load-bearing contract. |
| 5 | **Validate-once rule** | Validation runs exactly once, at the Repo-entry boundary; adapters receive validated input and never re-validate. (§7.1) |
| 6 | **Always-throw-never-silently-drop rule** | Empty filter groups, missing fields, unknown ops, conflicting ops fail loudly. No silent short-circuits, no "match-all" / "match-none" fallbacks at boundaries. |
| 7 | **No-runtime-value-coercion rule** | Filter values are a TS-only contract. The framework does not run pipes on filter values. (§11.6 invariant C) |
| 8 | **Adapter-owned tx propagation rule** | Tx-context propagation lives entirely inside the adapter, not in the framework. (§8.2) |
| 9 | **Schema relations-agnosticism rule** | Schemas contain no relational information. All relational concerns live in the Relations artifact. (§9.6) |
| 10 | **Single-Repo rule** | A Repo handles all schemas it can compatibility-narrow against. No registry, no per-Repo derivation, no per-schema typed Repos. (§6.7) |
| 11 | **Forward-only migrations rule** | The `Migrator` runs migrations forward only. There is no `down()`, no auto-inverse, no reversibility metadata in the `Change` algebra. Mistakes are corrected by writing additional forward migrations or by manual recovery. (§16) |

---

## 14. Out of scope

Out-of-scope items are decided-against, not "future work." There is no
**deferred** bucket — the **no-deferred bucket rule**: every concept either has
a locked design or is out of scope.

The **out-of-scope revisit policy**: items are revisited only when a real,
in-tree user need surfaces with no acceptable workaround through `raw`.
Speculative additions (e.g. "someone might want bulk upsert someday") are
rejected. The bar for promotion is concrete, not speculative.

| # | Out-of-scope item | Statement | Escape |
|---|---|---|---|
| 1 | **Composite foreign keys** | Multi-column FKs not supported. Single FK only. | Surrogate UUIDs + composite UNIQUE indexes; `raw` for genuine cases. |
| 2 | **Composite primary keys** | Multi-column PKs not supported. Single PK only. | Same as composite FKs. |
| 3 | **`'binary'` field type** | Binary blobs (Uint8Array / Buffer) not in the canonical field-type set. | Encode as base64 string; or `raw`. |
| 4 | **`'bigint'` field type** | Arbitrary-precision integers not in the canonical field-type set. | Encode as string; or `raw`. |
| 5 | **Bulk upsert** | `upsertMany` not supported. Single-document upsert only. | `raw` (Mongo `bulkWrite`, PG bulk `ON CONFLICT`). |
| 6 | **Adapter-typed extensions** | Adapter-contributed typed namespaces on the Repo (e.g. `repo.pg.fts`) not supported. | Adapter's `raw` method. |
| 7 | **Migrations / DDL** | Schema migration, table creation, DDL operations out of scope. | User-managed (dedicated migration tools); `raw` for ad-hoc DDL. |
| 8 | **Aggregates** | `count` / `sum` / `avg` / `groupBy` out of scope. | `raw`. |
| 9 | **Change-feeds / CDC** | Mongo change streams, Firebase realtime listeners, Debezium-style CDC, and realtime subscriptions remain out of scope. Bounded row iteration is in scope via `AllBuilder.iterate()` (§5.10). | `raw` for change-feeds / CDC. |
| 10 | **Server-side joins** | Joined queries (`findManyJoined`, PG `JOIN`, Mongo `$lookup`) out of scope. Preloads run package-side via `findMany`. | `raw`. |
| 11 | **Per-field adapter config** | Per-field adapter-specific config (PG types, Mongo index hints) out of scope. | None — accept the constraint or use `raw`. |
| 12 | **Schema-side adapter binding** | Schemas are fully adapter-agnostic; binding to an adapter happens at Repo construction. No `Schema.boundTo(Adapter)`. | Adapter binding is a Repo concern; use multiple Repos for schemas needing different adapters. |
| 13 | **Two-phase commit / distributed tx / sagas** | XA, 2PC, saga primitives out of scope. Single-DB transactions only. | None. |
| 14 | **Session options** | `session(fn, options)` overload not supported (covers isolation, retry, deadlock, nesting). | None for retry/deadlock; `raw('BEGIN ISOLATION LEVEL ...')` for isolation. |
| 15 | **Query-level isolation** | No `isolation` arg on `session()`. Each adapter uses its DB's default. | `raw('BEGIN ISOLATION LEVEL ...')` or adapter-specific session config. |
| 16 | **Migration rollback (`down()`)** | The migrations runtime is forward-only by design (§16). No auto-inverse, no `from:` payloads, no reversibility metadata. | Write a new forward fix-it migration; for local dev, manually delete the tracker row from the adapter's storage. |
| 17 | **Migration codegen long-tail** | The §16.11 codegen ships in v1 but is intentionally narrow: no auto-rename detection, no auto-FK derivation from `Relations`, no file emission, no long-tail Change variants (CHECK constraints, partial indexes, GIN/GIST/TTL/text), no historical-snapshot drift detection. | Post-edit the codegen's returned `Change[]` to use `renameField`/`renameTable`; hand-author FK Changes when Relations change; serialize the returned `Migration<A>` to a file in user code; use `execute` for long-tail features. |

---

## 15. EventLog (event-sourcing log)

`EventLog` is a typed write-ahead log of named operations, persisted via the
orm's `Repo` and replay-able. Lives at `src/orm/event-log/`. Replaces the
legacy `src/audit/EventAudit` (deleted). See ADR
`2026-05-09-event-log-rework.md` for the full design rationale.

### 15.1 Construction

`EventLog` is constructed via the builder-chain rule (§2.2):

```ts
const log = EventLog.from(repo).build()
```

`EventLog.from(repo)` takes a `Repo` instance positional. `.build()` is the
terminal step. There are no other builder steps today; `EventLog` exists
solely to host the post-build handler registry.

### 15.2 EventLogSchema (library-owned)

The library owns a fixed `EventLogSchema` exported from
`src/orm/event-log/schema.ts`:

```ts
const EventLogSchema = Schema.from('event_log')
  .pk('key', v.string())                                // time-sortable id
  .field('name', v.string())                            // handler name
  .field('ts', v.number())                              // ms timestamp
  .field('body', v.object({}).passthrough())            // validated payload
  .field('by', v.optional(v.string()))                  // who fired (nullable)
  .build()
```

Users wire `EventLogSchema` into their `Repo`'s resolver alongside their own
schemas. The library does not pick a table/collection name — the user's
resolver does.

### 15.3 Handler registry

Handlers register **post-build** on the live `EventLog` instance. Each
`log.handler(name, def)` call returns a typed `fire` function for that one
handler:

```ts
const fireUserSignup = log.handler('user.signup', {
  pipe: v.object({ email: v.string(), name: v.string() }),
  handle: async (payload, evCtx) => {
    await repo.on(UserSchema).one().create({
      ...payload,
      createdAt: evCtx.at.getTime(),    // see §15.6 replay determinism
    })
  },
})

await fireUserSignup({ email: 'a@b.com', name: 'Alice' }, { by: 'admin-42' })
```

Vocabulary:

- A **handler def** is `{ pipe, handle }`. There is no `sync`/`async`
  callback split — async post-processing is `src/jobs/`'s job.
- The **fire fn** is what `log.handler(name, def)` returns. Its input type
  is `PipeInput<def.pipe>`; its second arg is a partial `EventContext`
  (`{ by?, at? }` — caller supplies these; the library fills the rest).
- The **handler name** is the string passed to `log.handler(...)` — used
  as the `EventLogSchema.name` value persisted to the row, and as the
  registry key on replay.
- A handler may be registered at most once per `name`; duplicate
  registration throws.

### 15.4 EventContext

The `EventContext` is the second arg passed to `handle`:

```ts
type EventContext = {
  key: string                  // the event row's PK
  name: string                 // the handler name
  ts: number                   // ms timestamp the row was persisted with
  body: unknown                // the validated payload (same as handle's first arg)
  by: string | null            // who fired
  at: Date                     // ts as a Date — convenience
  firstRun: boolean            // true on initial fire; false during replay/rerun
}
```

**`firstRun`** is the only way for a handler to distinguish first-run from
replay. Handlers that have one-shot side effects (sending an email,
charging a card, calling a non-idempotent external API) gate them on
`firstRun`. Forgetting to gate is a documented footgun: replay re-fires
those side effects.

### 15.5 Fire semantics — atomic in one session

`fire(payload, ctx)` runs in a single `repo.session()`:

1. Validate `payload` against the handler's `pipe` (Repo-entry boundary,
   §7).
2. Persist a new `EventLogSchema` row (`createOne`).
3. Run `handle(validatedPayload, evCtx)` with `firstRun: true`.
4. Commit the session.

If any step throws, the entire session rolls back — **the event row is not
persisted**, and no side effects landed. Replay will not see the failed
event because it was never persisted. This is the intended semantics:
replay is for re-deriving state from successful events, not for retrying
failed handlers.

### 15.6 Replay-determinism rule (handler-side discipline)

**Replay-determinism rule.** Field generators that produce non-deterministic
values (`onCreate: () => Date.now()`, `onCreate: () => crypto.randomUUID()`)
will produce different values on first-run vs. replay. Rows persisted from
inside an EventLog handler that rely on such generators will *diverge across
replay* — `createdAt` will differ, PKs will differ, downstream lookups will
break.

The library does **not** introduce a `GeneratorContext`, a `repo.with()`
scope, or any other context-flow mechanism to fix this. The rule is
handler-side discipline:

- **Time-derived values**: thread `evCtx.at.getTime()` (or `evCtx.ts`) into
  the create payload explicitly. Schema-level `onCreate: () => Date.now()`
  is fine for non-EventLog use; the explicit payload field overrides it
  during EventLog calls.
- **Identity-derived values**: thread `evCtx.by` into the payload. Same
  override pattern.
- **Randomness / PKs**: derive deterministically from `evCtx.key` (e.g.
  `crypto.createHash('sha256').update(evCtx.key + 'salt').digest('hex')`),
  or supply PKs in the payload directly, or accept that replay will mint
  fresh PKs.

The library makes the failure mode loud (timestamps and PKs visibly diverge
on replay), debuggable in tests, but does not enforce determinism. See ADR
`2026-05-09-event-log-rework.md` for why every alternative
(library-driven generator-context with various subsets of `now`/`by`/`id`)
was rejected.

### 15.7 Replay

`log.replay({ from?: Date })` walks `EventLogSchema` rows ordered by `ts`
ascending and re-runs each one's handler with `firstRun: false`. `from`
filters the starting point.

`log.rerun(key: string)` re-runs a single event by its `key`.

Both run **per-event sessions**: each event's handler executes inside its
own `repo.session(...)`. Failure on event N rolls back N alone; events
1..N−1 are durably applied; events N+1.. are not attempted.

**Replay-stop-on-failure rule.** On the first event that throws, replay
throws an `OrmReplayError` (sibling of `OrmValidationError`,
`OrmNotFoundError`) carrying:

```ts
class OrmReplayError extends EquippedError {
  key: string                   // the offending event's key
  name: string                  // the handler name
  cause: unknown                // the original throw
}
```

The caller fixes the issue and re-runs `replay({ from:
new Date(lastSuccessTs + 1) })` to continue. There is no skip-and-continue
mode and no caller-supplied error handler.

A caller wanting **atomic replay** (all-or-nothing across events) wraps the
call: `await repo.session(() => log.replay())` — this composes naturally
with §8.4 (adapter-defines-nesting) since the per-event sessions delegate
to the adapter inside the outer session.

### 15.8 What's not in the model

- **No async post-processing.** The legacy `def.async` callback and the
  `setInterval`-backed batch queue are deleted. Async work belongs in
  `src/jobs/`.
- **No library-driven replay determinism.** `GeneratorContext`,
  `repo.with()`, ALS-backed scope for generator inputs — all rejected.
  Determinism is handler-side discipline (§15.6).
- **No library-level event versioning.** Single handler per name; pipe
  shape changes that reject old persisted bodies throw loudly at replay
  time. Users encode version in `body` via discriminated-union pipes if
  they need to.
- **No bulk fire.** `fire(payload)` is one event per call. Bulk goes
  through `repo.session(() => Promise.all([fire(p1), fire(p2), ...]))` if
  the user wants atomicity.
- **No automatic retry.** Replay-stop-on-failure means caller fixes the
  bug and re-runs. There is no exponential backoff, no `maxAttempts`, no
  failure queue.
- **No cross-EventLog dependencies.** A package may construct multiple
  `EventLog` instances (e.g. one per Repo); the library does not order
  them or coordinate their replays.

---

## 16. Migrations

The migrations subsystem is a typed, capability-gated, **forward-only**
runner for evolving the underlying database. A migration is a typed
description of a set of `Change`s; the `Migrator` walks pending migrations
in order, holds a cluster-safe lock, wraps each in a tx (where the adapter
supports one), and records each as applied via the adapter's storage
capability. There is no `down()`. The runtime is **A** in the C-hybrid
scope; codegen ("B") is deferred — see `docs/orm/TODO.md`. See ADR
`2026-05-09-migrations-runtime.md` for the decision tree.

### 16.1 Migration unit

A **migration** is a plain typed object — *not* a builder-chain artifact.
§1.5 precedent (no 5th declarative artifact for things that are morally
typed dicts of fields) applies; the once-per-step uniqueness guard buys
nothing here.

```ts
type Migration<A extends OrmAdapter> = {
  id: string                                       // unique, lex-sortable
  changes: ReadonlyArray<ChangeFor<A>>
  tx?: boolean                                     // default true
}
```

Vocabulary:

- The **migration id** is a non-empty string the user picks. Lex order is
  execution order. Convention is timestamp-prefix (`20260509120000-add-users`)
  or counter (`0001-add-users`); the framework enforces neither — only
  *unique within a Migrator's `.migrations(...)` array*.
- The **changes array** is the migration's body. Empty arrays are allowed
  (no-op baseline migrations).
- The **tx flag** opts out of the per-migration session wrap — needed for
  ops that can't run inside a tx (PG `CREATE INDEX CONCURRENTLY`, `ALTER
  TYPE ADD VALUE`, large data backfills). Default `true`.

### 16.2 Change algebra (the canonical change-variant set)

A **change** is one entry in a migration's `changes` array. The
**`Change` algebra** is a closed discriminated union (closed-set rule
§4.4) with **12 variants**:

```ts
type Change<A extends OrmAdapter> =
  | { kind: 'createTable'; name: string; pk: { name; type: A['supportedFieldTypes'][number] }; fields: FieldSpec<A>[] }
  | { kind: 'dropTable'; name: string }
  | { kind: 'addField'; table: string; field: FieldSpec<A> }
  | { kind: 'dropField'; table: string; name: string }
  | { kind: 'modifyField'; table: string; name: string; to: FieldSpec<A> }
  | { kind: 'renameTable'; from: string; to: string }
  | { kind: 'renameField'; table: string; from: string; to: string }
  | { kind: 'addIndex'; table: string; on: ReadonlyArray<string>; unique?: boolean; name?: string }
  | { kind: 'dropIndex'; name: string }
  | { kind: 'addForeignKey'; table; on: string; references: { table; column }; onDelete?; onUpdate?; name? }
  | { kind: 'dropForeignKey'; table: string; name: string }
  | { kind: 'execute'; up: (repo: Repo) => Promise<void> }

type FieldSpec<A extends OrmAdapter> = {
  name: string
  type: A['supportedFieldTypes'][number]            // §4.3 canonical set, narrowed per adapter
  nullable?: boolean                                // default false
  default?: string | number | boolean | null        // DB-side literal only
  unique?: boolean
}
```

Vocabulary:

- A **declarative change** is any non-`execute` variant. Rendered by the
  adapter's per-variant `apply*` method.
- The **execute escape** is the `execute` variant. Universal — every
  adapter that ships migrations supports it (it just runs `change.up(repo)`,
  no adapter method needed).
- A **logical name** in `Change` (`table`, `field.name`, `on[*]`,
  `references.column`) is the schema-declared name. Adapter does
  physical mapping (same convention as §11.4 filter logical names).
- **Long-tail features** — partial indexes, functional indexes, GIN/GIST,
  TTL, text indexes, CHECK constraints, triggers, views, sequences,
  composite PKs/FKs — are explicitly out of the canonical algebra. They
  go through `execute` with raw SQL/driver calls. No-emulation rule
  (§13 #2) applies.

The **lowest-common-denominator rule**: each variant's payload contains
only what every adapter in the canonical set can render natively.
Richer features are escape-hatch territory (`execute`).

The **canonical change-variant set** is closed (§4.4). Adapters subset
the set via the structural-inference rule (§16.4); they cannot extend it.
Extension is a maintainer-side process with the canonical-extension
contract (variant added to union, per-adapter renderer added, in-memory
adapter updated, semver bumped).

### 16.3 Migrator artifact

The **Migrator** is constructed via the builder-chain rule (§2.2). It is
the only verb-bearing entity in this subsystem.

```ts
const migrator = Migrator.from(repo)
  .migrations([m1, m2, m3])                        // explicit array; lex-sorted by id; dupes throw
  .withoutLock?()                                  // optional opt-out; only allowed when adapter lacks acquireMigrationLock
  .build()
```

`.build()` prerequisites (per §2.6):
- `.migrations(...)` was called (empty array is allowed).

Migration registration is **explicit-array-only**. There is no filesystem
discovery (`fs.readdir` breaks edge runtimes) and no post-build
registration (EventLog-style `migrator.migration(id, def)` adds ceremony
without payoff — there's no per-migration return value to import).

The **`withoutLock` opt-out rule**: the builder step is a compile error
unless the adapter doesn't declare `acquireMigrationLock`. Calling it
when the adapter *does* declare locking is a type-system rejection —
locking is the cluster-safety primitive and silently disabling it would
violate §13 #6 always-throw-never-silently-drop.

### 16.4 Adapter surface for migrations

The adapter declares two flat capability groups (§3.1):

**Migration storage methods** (verb-first prefix):

| Method | Required? | Purpose |
|---|---|---|
| `loadMigrations()` | yes (for any migrations) | returns applied `[{ id, appliedAt }]` |
| `recordMigration(id, appliedAt)` | yes | marks one migration as applied |
| `acquireMigrationLock<T>(fn)` | optional | wraps `fn` in cluster-safe lock; signature mirrors `session(fn)` (§8.1) |

There is no `forgetMigration` — forward-only, no automatic un-record.
Local-dev recovery is manual (delete the tracker row directly).

**Per-variant `apply*` methods** (one per declarative `Change` kind):

```ts
class PgAdapter extends configurable(pgConnPipe, OrmAdapter) {
  // ... existing methods

  // migration storage
  async loadMigrations(): Promise<{ id: string; appliedAt: number }[]>
  async recordMigration(id: string, appliedAt: number): Promise<void>
  async acquireMigrationLock<T>(fn: () => Promise<T>): Promise<T>

  // declarative variant renderers (full SQL set: 11 methods)
  async applyCreateTable(change: CreateTableChange): Promise<void>
  async applyDropTable(change: DropTableChange): Promise<void>
  async applyAddField(change: AddFieldChange): Promise<void>
  async applyDropField(change: DropFieldChange): Promise<void>
  async applyModifyField(change: ModifyFieldChange): Promise<void>
  async applyRenameTable(change: RenameTableChange): Promise<void>
  async applyRenameField(change: RenameFieldChange): Promise<void>
  async applyAddIndex(change: AddIndexChange): Promise<void>
  async applyDropIndex(change: DropIndexChange): Promise<void>
  async applyAddForeignKey(change: AddForeignKeyChange): Promise<void>
  async applyDropForeignKey(change: DropForeignKeyChange): Promise<void>
}

class MongoAdapter extends configurable(mongoConnPipe, OrmAdapter) {
  // mongo subset
  async loadMigrations(): Promise<{ id; appliedAt }[]>
  async recordMigration(id, appliedAt): Promise<void>
  // no acquireMigrationLock — Mongo session has no advisory-lock equivalent
  async applyAddIndex(change): Promise<void>
  async applyDropIndex(change): Promise<void>
  // no applyCreateTable etc — Mongo is schemaless
}
```

The **structural-inference rule for migrations**: which `Change` variants
the adapter supports is read off `keyof InstanceType<A>` filtered to
`apply${Capitalize<Kind>}`. There is no `migrationOps` capability array —
that would be redundant with method presence (per the §3.3 rule
"presence on the class is the declaration"). Op-list arrays
(`queryableOps`, `updateOps`, `aggregateOps`) only earn their keep when a
single method handles many ops; here it's one method per variant, so
structural inference is sufficient.

The **type derivation** is:

```ts
type ApplyMethodKey<A> = Extract<keyof A, `apply${string}`>
type KindFromMethod<M> = M extends `apply${infer K}` ? Uncapitalize<K> : never
type ChangeKindFor<A> = KindFromMethod<ApplyMethodKey<A>> | 'execute'
type ChangeFor<A> = Extract<Change, { kind: ChangeKindFor<A> }>
```

User puts `{ kind: 'addField' }` in a Mongo migration → TS error 2322 at
the offending Change literal. Type-system-is-the-contract (§13 #4) at
work.

The **adapter-owned storage rule**: each adapter owns its tracker table's
name, schema, and physical layout. PG might use a single `equipped_migrations`
table with `id` + `applied_at` columns; Mongo might use a sentinel
collection; Firebase might use a single doc with an applied-id list. The
shape is the adapter's choice and is documented in the adapter's README.
The framework only sees the typed `{ id, appliedAt }` payload returned by
`loadMigrations`.

### 16.5 Migrator runtime API

```ts
type RunResult = { ran: string[]; skipped: string[] }              // ids run + ids already-applied skipped
type StatusEntry = { id: string; applied: boolean; appliedAt?: number }
type DryResult = { would: string[] }

migrator.up(opts?: { to?: string; steps?: number }): Promise<RunResult>
migrator.status(): Promise<StatusEntry[]>                          // sorted by id (lex), pending and applied interleaved
migrator.dry(opts?: { to?: string; steps?: number }): Promise<DryResult>
```

`.up()` defaults to all-pending. `{ to }` runs up to (and including) a
specific id; `{ steps }` runs exactly N pending migrations. `.dry(...)`
takes the same options and returns the plan without executing — useful in
CI before applying.

`.status()` returns one entry per migration in the user's array, sorted
lex by `id`. Pending migrations have `applied: false` and no `appliedAt`;
applied ones have `applied: true` and the recorded timestamp.

The **id-targeting rules**:
- `up({ to: id })` where `id` is unknown to the user's array → throw
  `OrmMigrationError({ phase: 'load', cause: 'unknown id' })` before
  lock acquired.
- `up({ to: id })` where `id` is already applied → no-op for that id;
  still walks pending migrations between current state and `id`.
- `up()` when nothing is pending → no-op, returns `{ ran: [], skipped: [...] }`.

### 16.6 Lock + tx wrapping

The runtime applies one **cluster-safe lock** for the entire run plus
**per-migration tx**:

```ts
await adapter.acquireMigrationLock(async () => {
  for (const m of pending) {
    const wrap = (m.tx !== false && hasSession)
      ? (fn) => repo.session(fn)
      : (fn) => fn()

    await wrap(async () => {
      for (const c of m.changes) await applyChange(adapter, repo, c)
      await adapter.recordMigration(m.id, Date.now())
    })
  }
})
```

The **one-lock-per-run rule**: lock acquired once at run start, released
at run end. Cheaper than per-migration locks (Mongo sentinel-doc style is
expensive per acquire) and equally cluster-safe — another node hitting
the lock waits until the entire run completes, which is the desired
behaviour.

The **per-migration tx rule**: each migration gets its own
`repo.session(...)` (when the adapter declares `transactional.session`
and `m.tx !== false`). Failure at migration N rolls back N alone;
migrations 1..N-1 stay durably applied. Matches industry standard
(Knex/Sequelize/Ecto) and supports partial-deploy retry workflows.

The **record-in-tx rule**: `recordMigration(id, ts)` runs inside the same
`repo.session(...)` as the user's changes. A failed `change` rolls back
both the user's effects AND the tracker row. There is no half-state
where user code committed but the tracker didn't (or vice versa) for
`tx: true` migrations.

The **`tx: false` partial-apply footgun**: when `tx: false` is set and
the migration partially succeeds before throwing, the user's effects are
durable but the tracker row was not written. Re-running `.up()` retries
the same migration from scratch. Authors of `tx: false` migrations
should make them idempotent (which they often must be anyway — `CREATE
INDEX CONCURRENTLY`, `ALTER TYPE ADD VALUE`).

The **atomic-across-migrations escape** (mirrors §15.7 atomic-replay):
```ts
await repo.session(() => migrator.up())
```
Wraps the entire run in one outer tx (per §8.4 adapter-defines-nesting).
Default behaviour stays per-migration; this is opt-in for callers who
need all-or-nothing.

### 16.7 Failure semantics

The **migration-stop-on-failure rule**: on the first migration that
throws, the runtime throws `OrmMigrationError` carrying the failed id
and the failure phase. Already-applied migrations remain durably applied
(the tx rolled back the failed migration's effects + tracker row). The
caller fixes the underlying issue and re-invokes `.up()` to resume from
the same point.

`OrmMigrationError extends EquippedError` is the error class:

```ts
class OrmMigrationError extends EquippedError {
  id: string                                                       // failed migration's id
  phase: 'lock' | 'load' | 'session' | 'user' | 'record'           // where it threw
  cause: unknown                                                   // original throw
}
```

`phase` discriminates failure location:
- `'lock'` — `acquireMigrationLock` threw (cluster contention, network)
- `'load'` — `loadMigrations` threw, OR an orphan id was detected, OR
  `up({ to })` named an unknown id
- `'session'` — `repo.session(...)` open/commit failed
- `'user'` — `change.up(repo)` (for `execute`) or an `apply*` method threw
- `'record'` — `recordMigration` threw after user code succeeded
  (the awkward case for `tx: false`)

Lives at `src/orm/errors/OrmMigrationError.ts` alongside
`OrmValidationError`, `OrmNotFoundError`, `OrmReplayError`.

The **orphan-migration rule**: if `loadMigrations()` returns an `id` not
present in the user's `.migrations([...])` array, the framework throws
`OrmMigrationError({ phase: 'load', cause: 'orphan migrations: [...]' })`
on every `.up()` invocation as a pre-flight check (§13 #6
always-throw-never-silently-drop). Orphans signal something went wrong
(deleted file, botched cherry-pick, manual edit) — loud failure forces
investigation before applying more changes. The user reconciles by
adding the orphan back to the array, OR manually deleting the orphan
tracker row from the adapter's storage.

### 16.8 Validation flow

Validation runs once at `Migrator.from(repo).migrations(arr).build()` —
the **validate-once rule** (§7.1) applies to migrations too. The
**`assertNormalisedChanges` function** walks every Change in every
Migration and enforces:

| # | Invariant | Enforced or inverted |
|---|---|---|
| A | **id-non-empty invariant** | enforced (every Migration has non-empty `id` string) |
| B | **id-uniqueness invariant** | enforced (no two Migrations share an `id`) |
| C | **field-type-supported invariant** | enforced (every `FieldSpec.type` ∈ `adapter.supportedFieldTypes`) — defense-in-depth for the compile-time §13 #4 guard |
| D | **field-name-uniqueness invariant** | enforced (within a single `createTable.fields[]` no duplicate `name`; `pk.name` not in `fields[]`) |
| E | **logical-name-non-empty invariant** | enforced (table/column/index names non-empty) |
| F | **non-empty-on invariant** | enforced (`addIndex.on` and `addForeignKey.on` non-empty) |
| G | **adapter-supports-variant invariant** | enforced (adapter has the corresponding `apply*` method) — defense-in-depth for the compile-time structural narrowing |
| H | **changes-non-empty invariant** | inverted (a Migration with `changes: []` is allowed — no-op baseline migration) |
| I | **collect-all rule** | enforced (per §7.5) — accumulate all failures, throw single `OrmValidationError` with `kind: 'changes'` |

Add `'changes'` to `OrmValidationError.kind` (§7.5). The failure entry
shape extends with `migrationId` and `changeIndex`:

```ts
class OrmValidationError extends EquippedError {
  kind: ... | 'changes'
  failures: Array<{
    migrationId?: string                                            // new — which migration's change failed
    changeIndex?: number                                            // new — index in the migration's changes[]
    field?: string
    cause: PipeError | string
  }>
}
```

### 16.9 Cross-cutting interactions

- **`repo.resolve(transform, fn)` wrapping `migrator.up()`.** The config
  transform applies to every query inside `up()` — including `apply*`
  method calls if the adapter routes through `this.config`. Tenant-aware
  migrations ARE expressible via `repo.resolve` wrap, but at the
  conceptual level `Change.name` is a literal DB name; tenant prefixing
  belongs to the resolver, not the algebra.
- **`repo.session(...)` wrapping `migrator.up()`** — see §16.6
  atomic-across-migrations escape.
- **EventLog interactions** — none. Migrations and the EventLog (§15) are
  orthogonal subsystems sharing only the `OrmValidationError` error
  family.
- **`repo.on(EquippedMigrationsSchema)`** — does NOT exist. Migration
  storage is adapter-owned (§16.4), not piggybacked on a library-owned
  Schema like `EventLogSchema`. The asymmetry with §15.2 is deliberate:
  EventLog rows are domain-meaningful entries the user may want to query
  via the orm; migration tracker rows are pure plumbing and stay
  invisible.

### 16.10 What's not in the model

- **No `down()`.** Forward-only. No auto-inverse, no reversibility
  metadata in the algebra. Recovery is "ship a forward fix-it
  migration" or manually delete the tracker row for local-dev
  rollback. See §13 cross-cutting principles for the
  forward-only-migrations rule and §14 for the rollback out-of-scope
  entry.
- **No CLI in v1.** Programmatic only. Same precedent as
  `EventLog.replay()` (§15.7). User wraps `migrator.up()` in their
  own script (`bun migrate.ts`). CLI may ship as a thin layer in a
  follow-up.
- **No filesystem migration discovery.** Edge-runtime safety. Userland
  helpers can produce arrays from disk if needed.
- **No post-build migration registration** (`migrator.migration(id, def)`).
  Adds ceremony without payoff — there's no per-migration return value
  to import.
- **No retry / skip / configurable error handler.** Stop-on-first-failure
  with explicit re-invocation (mirrors §15.7's replay-stop-on-failure).
  Skip-and-continue silently leaves a hole in the migration history —
  exactly the §13 #6 always-throw-never-silently-drop violation.
- **No `markApplied` / `markUnapplied` escape hatches** in v1.
  Adapter-owned tracker tables keep recovery adapter-specific by
  construction. Users who need to remove a tracker row do so directly
  via the adapter's documented storage shape.
- **No drift detection.** The runtime trusts user-supplied `Change`
  payloads. If the live DB diverges from the migration sequence
  (manual edits, restores from backup, partially-rolled-back changes),
  the next `.up()` may fail loud (`apply*` errors) but doesn't
  proactively detect drift. Drift detection is a B (codegen) concern
  — see `docs/orm/TODO.md`.
### 16.11 Migration codegen ("B" in the C-hybrid scope)

The codegen subsystem produces a `ReadonlyArray<ChangeFor<A>>` from a
diff between the user's declared Schemas (the **target state**) and the
live DB (the **current state** recovered via the adapter's
`introspect()` capability). It is the second half of the C-hybrid scope
(§16.1's runtime is the first); both ship in v1.

The **MigrationCodegen artifact** is constructed via the builder-chain
rule (§2.2):

```ts
const codegen = MigrationCodegen.from(repo)
  .target([UserSchema, PostSchema, …])           // declared schemas = desired state
  .build()
```

`.build()` prerequisite (per §2.6): `.target(...)` was called.

The **codegen capability gate** narrows `MigrationCodegen.from(repo)` at
the type level — adapter without `introspect?()` declared resolves to a
type error at the `.from(...)` call. Symmetric with §5.3
`SchemaCompatible<A, S>`:

```ts
type IntrospectableAdapter<A extends OrmAdapter> =
  A extends { introspect(): Promise<DiscoveredSchema[]> } ? A : never

class MigrationCodegen {
  static from<A extends OrmAdapter>(
    repo: Repo<IntrospectableAdapter<A>>,
  ): MigrationCodegenBuilder<A>
}
```

### 16.12 Codegen runtime API

```ts
codegen.diff(): Promise<ReadonlyArray<ChangeFor<A>> | null>      // null = no diff
codegen.discover(): Promise<ReadonlyArray<DiscoveredSchema>>     // raw introspection result
```

`codegen.diff()` returns the `Change[]` that, when applied via the
runtime, would bring the DB from `current` to `target`. `null` means the
DB already matches target. The user wraps the result with their own
`id` to produce a `Migration<A>`:

```ts
const changes = await codegen.diff()
if (!changes) { console.log('no changes'); return }
const migration: Migration<typeof adapter> = {
  id: '20260509-add-nickname',                   // user-supplied
  changes,
}
// User serializes `migration` to a file, holds in memory, etc.
```

The **no-auto-id rule**: codegen does not generate an `id`.
Id-conventions (timestamp prefix vs counter vs slug) are user-domain.
Picking a default in the library invites either acceptance or
override-at-every-call — friction either way. Symmetric with the
no-file-emission decision (§16.13).

### 16.13 What codegen does NOT do (deliberate omissions)

- **No file emission.** Codegen returns objects, not file paths. Filesystem
  serialization is userland — same constraint as the programmatic-only
  Migrator API (§16.5). Edge runtimes (Workers, Deno) can't `fs.writeFile`,
  and filename conventions (timestamp vs slug vs counter) are
  user-specific.
- **No auto-rename detection.** Diff matches by literal name only.
  Renames surface as `dropField` + `addField` pairs (or
  `dropTable` + `createTable`). User post-edits the returned `Change[]`
  to use `renameField` / `renameTable` if intended. Heuristic
  rename detection (name+type matching) is rejected because false
  positives are catastrophic — replacing `firstName: string` with
  `lastName: string` would silently misread as a rename.
- **No auto-FK derivation from Relations.** The `Relations` artifact
  (§9) lives separately from Schemas. v1 codegen reads only Schemas
  and ignores Relations. Users add `addForeignKey` / `dropForeignKey`
  Changes manually when their Relations change. Future enhancement
  (post-v1): walk Relations alongside Schemas.
- **No long-tail variant emission.** Codegen emits only the §16.2 LCD
  Change variants. CHECK constraints, partial indexes, functional
  indexes, GIN/GIST/TTL/text indexes, server-default expressions
  (`gen_random_uuid()`) all stay in `execute` escape territory — same
  closed-set rule (§4.4) the runtime obeys.
- **No drift detection beyond the natural diff.** v1 codegen produces a
  diff *current → target*; if the DB has drifted from a prior migration
  history, the diff reflects current state, not the drift. User reviews
  the emitted Changes and accepts/rejects. Drift detection that
  compares historical `from:` snapshots against the live DB is
  explicitly out of scope (and the runtime is forward-only, so `from:`
  payloads don't exist anyway).

### 16.14 DiscoveredSchema and adapter introspection

Introspection returns one **DiscoveredSchema** per top-level container
(table for SQL, collection for Mongo) the adapter finds in the live DB:

```ts
type DiscoveredField = {
  name: string
  type: FieldType                                // §4.3 canonical set
  nullable: boolean
  default?: string | number | boolean | null     // primitive only
  unique?: boolean
}

type DiscoveredIndex = {
  name: string                                   // adapter-derived if originally auto-named
  on: ReadonlyArray<string>
  unique: boolean
}

type DiscoveredForeignKey = {
  name: string
  on: string                                     // single column FK only — composite §14 #1
  references: { table: string; column: string }
  onDelete?: 'cascade' | 'restrict' | 'setNull' | 'noAction'
  onUpdate?: 'cascade' | 'restrict' | 'setNull' | 'noAction'
}

type DiscoveredSchema = {
  name: string
  pk?: { name: string; type: FieldType }         // absent for Mongo, etc.
  fields: ReadonlyArray<DiscoveredField>          // empty for Mongo
  indexes: ReadonlyArray<DiscoveredIndex>
  foreignKeys: ReadonlyArray<DiscoveredForeignKey>  // empty for Mongo
}
```

The **single shared descriptor rule**: one `DiscoveredSchema` type
serves every adapter. Mongo populates only `name` + `indexes`; the
empty arrays for `fields`/`foreignKeys` and absent `pk` are honest
about Mongo's schemaless storage. Per-adapter descriptor types were
rejected — they'd double the surface for marginal precision since
`DiscoveredIndex` is identical across adapters.

The **Mongo-introspection rule** (referenced from §16.13): the Mongo
adapter's `introspect()` returns descriptors with `fields: []`,
`pk: undefined`, `foreignKeys: []`. Diff against Mongo therefore never
emits `createTable` / `addField` / `dropField` / `modifyField` /
`addForeignKey` / `dropForeignKey` — only `addIndex` / `dropIndex` are
produced. Field-level migrations on Mongo go through `execute` (data
backfills, `$set` / `$unset` operations).

The **introspection-error-loud rule**: when the adapter's
`introspect()` encounters a DB column type that doesn't map to the
canonical `FieldType` set (§4.3) — e.g. PG `bytea` (binary, §4.6
out-of-scope) — it throws `OrmIntrospectionError` immediately rather
than silently excluding the column. Silent skip would produce a
partial descriptor that the diff treats as ground truth, generating
Changes that fail at apply time. §13 #6 always-throw-never-silently-drop.

```ts
class OrmIntrospectionError extends EquippedError {
  adapter: string
  table: string                                  // the offending table/collection name
  cause: unknown                                 // unrecognized DB type, or driver error
}
```

Sibling of `OrmValidationError`, `OrmNotFoundError`, `OrmReplayError`,
`OrmMigrationError` under `src/orm/errors/`.

### 16.15 Diff algorithm

The **diff function** is pure — same `(adapter, target, current)`
inputs always produce the same `Change[]` output:

```ts
function diffSchemas<A extends OrmAdapter>(
  adapter: A,
  target: ReadonlyArray<AnySchema>,
  current: ReadonlyArray<DiscoveredSchema>,
): ReadonlyArray<ChangeFor<A>>
```

Reads `adapter` only to know which `Change` kinds are supported (per
§16.4 structural narrowing). No DB calls.

The **name-based-matching rule**: tables/columns/indexes/FKs match by
literal name only. Anything in `target` but not `current` → "add"
Change; anything in `current` but not `target` → "drop" Change; same
name with differing payload → "modify" or surfaces as
`drop` + `add` (e.g. index-shape change). Renames are NOT auto-detected
(per §16.13).

The **fixed-canonical-emission-order rule**: emitted Changes are
ordered to respect dependencies:

```
dropForeignKey  →  dropIndex  →  dropField  →  dropTable
renameTable     →  renameField                                 (rare; only if user post-edits)
createTable     →  addField   →  modifyField
addIndex        →  addForeignKey
```

This handles ~99% of cases. Self-referencing FKs and circular
inter-table dependencies are rare; for those, the user re-orders the
emitted Changes manually before constructing the Migration.
Topological sort is explicitly out of v1 scope — implementable later if
real-world cases surface.

The **adapter-aware filtering rule**: the diff function reads the
adapter's `apply*` method presence (§16.4 structural narrowing) and
filters its output to Change kinds the adapter supports. Mongo-targeting
diff never emits `addField` even when target schemas have fields the
descriptor doesn't see. Symmetric with the runtime's per-variant
narrowing — the same closed-set rule (§4.4) applies to codegen output
as to authored `Migration.changes`.
