# Utilities — Context

This document is the long-lived reference for the `utilities` subsystem in
`equipped`. Utilities are package-level primitives that cross-cut other
features — they have no domain of their own, but other contexts (`orm`,
`instance`, cache/events/jobs/server adapters) depend on them.

The bulk of this doc covers **`configurable`**, the
configuration-validation primitive that backs every adapter class in the
package. The other utilities (`Hash`, `Random`, `parseJSONValue`, `retry`,
`getMediaDuration`, `AuthProviders`) are small, self-explanatory helpers
and do not need their own vocabulary section.

---

## 1. `configurable` — the adapter class wrapper

`configurable(pipeFn, base)` is the package-level primitive that turns an
abstract base class plus a valleyed config pipe into a class with:

- A **`protected constructor`** taking the validated config (and optionally
  base-class arguments).
- An inherited **`static create(input, ...extras)`** that validates the
  raw input against the pipe and constructs the leaf with the validated
  value plus any extras.
- A phantom **`static Config`** type marker for ergonomic typing of
  constructor parameters in subclasses.
- The validated config exposed as **`protected readonly this.config`**.

It is the canonical construction shape for every behavioural artifact in
the package: cache adapters, event-bus adapters, job adapters, server
adapters, and orm adapters.

### 1.1 Definitions

A **configurable class** is any class whose direct ancestor in the chain
is the result of `configurable(pipeFn, base)`. Every adapter in the
package is a configurable class.

A **base class** in this context is the abstract class passed as the
second argument to `configurable(...)` — `Cache`, `EventBus`, `Job`,
`Server`, `OrmAdapter`. The base supplies the runtime contract (abstract
or optional methods); `configurable` adds the construction discipline.

The **config pipe** is the valleyed `Pipe<Input, Output>` passed as the
first argument (via a thunk: `() => pipe`). The thunk shape lets the pipe
reference lazily-resolved settings (e.g.
`Instance.get().settings.utils.paginationDefaultLimit`) without forcing
eager initialisation at module load.

### 1.2 The construction discipline

Every configurable class follows this discipline:

```ts
export class RedisCache extends configurable(redisConfigPipe, Cache) {
  protected constructor(config: typeof RedisCache.Config, extra?: RedisOptions) {
    super(config)
    // setup using `config` (or `this.config`)
  }
}

const cache = RedisCache.create({ host: 'localhost', port: 6379 }, { ... })
```

- Constructor is **`protected`**: external `new RedisCache(...)` is a
  compile error. The single canonical construction path is `RedisCache.create(...)`.
- The leaf constructor's `config` parameter is typed as
  **`typeof RedisCache.Config`** — the phantom `static Config` marker
  inherited from the wrapper, which carries the pipe's output type. Leaf
  authors don't write `PipeOutput<ReturnType<typeof redisConfigPipe>>`.
- Validation runs **before** construction. `static create` calls
  `v.assert(pipe, input)` and passes the validated value to the
  constructor; the constructor body never sees raw input.
- **Validation is layer-boundary**, not in-constructor. The constructor
  receives validated config; the assertion lives in the inherited
  `static create` so leaf authors never duplicate it. This matches the
  package's "every layer boundary gets a pipe" rule.

### 1.3 Phantom `static Config` marker

The wrapper's class declares:

```ts
declare static readonly Config: PipeOutput<P>
```

`declare` makes it type-only — no runtime field exists. `typeof RedisCache.Config`
resolves at the type level to the pipe's output type, even though
`RedisCache.Config` is `undefined` at runtime. This collapses the
otherwise-verbose `PipeOutput<ReturnType<typeof redisConfigPipe>>` to a
short, uniform `typeof Class.Config` reference inside leaf constructors.

The marker is visible to package consumers (e.g. tooling exporting
JSON-Schema from valleyed pipes can read it), but it carries no runtime
state.

### 1.4 Polymorphic-`this` inherited static

`static create` is defined once on the wrapper and inherited by every leaf
class. Its signature uses polymorphic `this` plus
`ConstructorParameters<This>` to slice the leaf's constructor parameter
list, dropping the first parameter (the validated config) so the call
site sees only the leaf-specific extras:

```ts
static create<This extends new (...args: any[]) => any>(
  this: This,
  input: PipeInput<P>,
  ...args: ConstructorParameters<This> extends [PipeOutput<P>, ...infer R] ? R : never
): InstanceType<This>
```

Net result: `RedisCache.create(rawInput, redisOpts)` is fully typed
without leaf authors writing a per-class static factory. The `(this as any)`
inside the wrapper body is an unavoidable internal narrowing — the
polymorphic-`this` constructor cannot be expressed without it.

### 1.5 Base-args forwarding

The wrapper's signature is `Base extends new (...args: any[]) => any`,
allowing bases that take constructor arguments. The inherited
`protected constructor(validated, ...baseArgs)` forwards `baseArgs` via
`super(...baseArgs)`. Today's package bases (`Cache`, `EventBus`, `Job`,
`Server`, `OrmAdapter`) all take zero base args, but the design supports
non-trivial bases without a future rewrite.

Leaf classes whose own constructor adds extras beyond base args declare
the extras as additional parameters:
`(config, ...baseArgs, leafExtra?)`. The `static create`'s
`ConstructorParameters<This>` slicing infers the call-site shape
correctly regardless.

---

## 2. Configurable's relationship to other contexts

### 2.1 Orm adapters

Every orm adapter is a configurable class. See
[`docs/orm/CONTEXT.md` §1.3](../orm/CONTEXT.md). The orm-specific
`OrmAdapter` base adds optional behaviour methods, capability
declarations, and `schemaConfigPipe` on top of what `configurable`
provides.

### 2.2 Instance lifecycle

Configurable classes do **not** auto-register with `Instance` — lifecycle
integration is conceptually orthogonal to config validation. The
`OrmAdapter` base wires `Instance.on(...)` from its constructor; cache /
events / jobs adapter bases register manually in their leaf constructors.
See [`docs/instance/CONTEXT.md` §4.2](../instance/CONTEXT.md).

### 2.3 Server adapters

`ExpressServer` and `FastifyServer` are configurable classes whose base is
the abstract `Server`. The pre-refactor `configurableFn` (function form)
is gone; the function-returning factories were lifted to classes during
the `configurable` consolidation.

---

## 3. Construction-discipline rules

### 3.1 Single-canonical-path rule

**Single-canonical-path rule.** A configurable class is constructed
exclusively via `Class.create(input, ...extras)`. External `new` is a
compile error (`protected constructor`). Subclassing is allowed; an
intermediate subclass must keep its own constructor `protected`.

### 3.2 Validate-before-construct rule

**Validate-before-construct rule.** Validation runs in `static create`
_before_ the constructor is called. The constructor body never sees
unvalidated input. Adapter authors do not — and must not — call
`v.assert(pipe, ...)` from inside their constructors.

### 3.3 Pipe-thunk rule

**Pipe-thunk rule.** The first argument to `configurable(...)` is a
function returning a pipe (`() => Pipe`), not a pipe directly. The thunk
defers pipe construction to the first `Class.create(...)` call so pipes
that depend on lazily-resolved settings (e.g. `Instance.get()`) work
without bootstrap-order constraints.

### 3.4 Type-marker-not-runtime-field rule

**Type-marker-not-runtime-field rule.** `static Config` is `declare`-only.
Reading `Class.Config` at runtime returns `undefined`. The marker exists
solely for type-position use (`typeof Class.Config`).

### 3.5 No-bypass rule

**No-bypass rule.** There is no escape hatch for skipping validation —
no `Class.createUnsafe(validated)`, no exposed inner constructor. If you
have a validated config and want to construct without re-validating, you
still go through `static create`; the second validation is a microsecond
cost in exchange for the discipline.

### 3.6 No-`v.assert` rule (package-wide)

**No-`v.assert` rule.** `v.assert(pipe, value)` is banned across the
package. Inside `static create` the inherited implementation uses
`v.validate` and throws on failure; leaf authors invoke neither directly.
Outside this construction path, callers use `v.validate(pipe, value)` and
branch on the `.valid` discriminant to throw a context-specific error
class:

```ts
const r = v.validate(pipe, value)
if (!r.valid) throw new <SubsystemError>(r.error)
// use r.value
```

Rationale: throwing forces stack-frame capture even when the validation
failure is immediately reformatted into a structured error class
(`OrmValidationError`, `EquippedError`, etc.). The inline branch keeps the
throw opt-in per call site, lets each subsystem name its own error class
with its own carrier shape, and surfaces the validation flow in code
rather than hiding it behind an `assert` helper. Enforcement is
**convention only** — no lint rule. New code should not introduce
`v.assert` calls; existing call sites migrate as they're touched.

---

## 4. What's not in the model

- **No-async-validation rule.** `v.assert(pipe, input)` is synchronous;
  the constructor runs in the same tick. Async-validated config (e.g.
  config that requires a network round-trip to verify) is out of scope —
  do that work yourself before calling `Class.create(...)`.
- **No-decorator-form rule.** `configurable` is a class factory, not a
  TS-5 stage-3 class decorator. Decorators cannot transform constructor
  parameter types in current TypeScript, which would regress the
  `static create` typing discipline. See ADR
  `2026-05-06-adapter-as-class-via-configurable.md` for the rejected
  alternatives.
- **No-mutable-config rule.** `this.config` is `protected readonly`.
  Configurable classes whose configuration legitimately needs to change
  at runtime use a separate mutable field (or `repo.resolve(transform, fn)`
  in the orm context) — not `this.config`.
- **No-multi-pipe-per-class rule.** A configurable class has exactly one
  config pipe (passed once to `configurable(...)`). Per-call validation
  needs (e.g. orm `schemaConfigPipe`) are declared on the leaf or on a
  more specific base; `configurable` itself handles only the
  one-shot construction-time pipe.

---

## 5. Other utilities (pointer)

The `src/utilities/` directory also exposes:

- **`Hash`** — password and token hashing helpers.
- **`Random`** — random bytes / strings / IDs.
- **`parseJSONValue`** — strict JSON parser used by JSON-shaped event
  payloads.
- **`retry(fn, attempts, intervalMs)`** — exponential-style retry helper
  used by adapter startup hooks.
- **`getMediaDuration`** — ffprobe-backed media-duration probe used by
  the server adapters.
- **`AuthProviders`** — namespace of OAuth-style auth-provider clients.

These are small, self-explanatory helpers and do not have their own
domain vocabulary. They are documented at the source level (JSDoc on
each export) when needed.
