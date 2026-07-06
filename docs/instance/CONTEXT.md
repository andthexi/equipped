# Instance — Context

This document is the long-lived reference for the `Instance` subsystem in
`equipped`. It defines the canonical vocabulary used across `Instance`, the
rules that govern its lifecycle hooks, and the items that are explicitly out
of scope.

`Instance` is the package's process-wide singleton: it holds runtime
settings, the logger, an environment ID, and the **lifecycle hook bus** that
adapters and application code register against. The lifecycle bus is what
this document is mostly about.

---

## 1. Definitions

### 1.1 Instance

The **Instance** is the singleton created by `Instance.create(settings)` and
retrieved by `Instance.get()`. There is exactly one per process. Settings
are validated against `instanceSettingsPipe()` at creation time; a second
`Instance.create(...)` call is a fatal error (`Instance.crash`).

The Instance is **not** a DI container, **not** a service registry, **not**
a configuration object users compose programmatically. It is a thin
process-wide handle that carries: validated settings (frozen), a `pino`
logger, an optional `id` alias, and the static hook registry.

### 1.1.1 Instance id generator

`Instance.createId()` is the package-level record id generator. It takes no
arguments and returns lowercase monotonic ULID strings, so callers that need a
prefix or other decoration compose that outside the generator.

### 1.2 Hook

A **hook** is a callback registered against one of three lifecycle
**events** — `setup`, `start`, `close`. The hook bus is process-global and
keyed by event. Hooks for an event run when that event fires:

- `setup` and `start` fire from `instance.start()` (in that order).
- `close` fires from `instance.close()` and from the SIGHUP/SIGINT/SIGTERM
  handler installed at `Instance` construction.

Each hook has:
- A **callback** (`HookCb`) — `() => void | Promise<void | unknown>` (or a
  raw promise; see §2.4).
- An optional **owner class** (`class: ClassRef`) — see §1.3.
- An optional **dependency list** (`after: ClassRef[]`) — see §1.3.

### 1.3 Class-keyed DAG and `ClassRef`

A **`ClassRef`** is any class constructor (`abstract new (...args: any[]) => any`).
Every hook's identity is its owner class; every dependency reference is
also a class. The hook registry forms a directed acyclic graph keyed by
class identity:

```ts
type HookOptions = {
  class?: ClassRef    // owns this hook; required if anything depends on it
  after?: ClassRef[]  // dependencies; each must already be a registered class hook
}

Instance.on(event, cb, options?: HookOptions)
```

A hook with a `class:` is **named**: the class identity is the name. A hook
without a `class:` is **anonymous**; it can declare dependencies (`after:`)
but cannot be the target of one.

The `after:` list takes class refs only — **no strings**. The reason is
type-safety and refactor-safety: a string name `'MongoAdapter'` decays to
nothing if the class is renamed, but `after: [MongoAdapter]` is checked by
the type system and updated by IDE rename. The cost is that anything you
want to be a dependency target must own a class identity (define a marker
class if necessary).

### 1.4 Registration vs firing

**Registration** is the call to `Instance.on(...)` — it adds the hook to
the static registry. **Firing** happens when `instance.start()` runs (for
`setup` and `start` events), when `instance.close()` runs (for `close`), or
when a termination signal is received (for `close`).

A hook may register at any point before its event fires; in practice
adapters register from their constructors at module-load time.

---

## 2. The hook DAG

### 2.1 Topo sort and parallel siblings

When an event fires, hooks for that event are topo-sorted by their
`after:` dependencies. Hooks at the same depth (no path between them) run
in **parallel** via `Promise.all`. Hooks at different depths run
**sequentially** — each level waits for the previous level to settle.

This is the partial-order model the previous numeric-`order` system
poorly approximated. `Instance.on(event, cb, 1)` would have run `cb` "early"
without specifying *what* `cb` actually depends on; the DAG model expresses
the dependency directly and lets the runtime compute the order.

### 2.2 Close-event inversion rule

The `close` event runs the DAG **inverted**: a hook that declared
`after: [X]` for start runs *before* `X` on close. So `DbChange after [Mongo, Kafka]`
declared once gives:

- start order: `Mongo` ‖ `Kafka` → `DbChange`
- close order: `DbChange` → `Mongo` ‖ `Kafka`

This matches the universal "tear down in reverse construction order" rule
without the user having to declare two graphs.

### 2.3 Multiple hooks per class

Multiple hooks may share an owner class — e.g., two `MongoAdapter` instances
each registering a `start` hook. `after: [MongoAdapter]` waits for **all**
hooks owned by `MongoAdapter` to complete. Class identity is the
dependency unit; per-instance hook identity is not exposed.

### 2.4 Async hook callback shape

`HookCb` accepts both functions returning a promise and raw promises:

```ts
type HookCb = Promise<unknown | void> | (() => void | unknown | Promise<void | unknown>)
```

The runtime awaits whichever it gets. Errors thrown inside a hook are
caught and routed to a per-event error handler; for `start`/`setup` errors
trigger `Instance.crash`, while `close` errors are logged and swallowed
(close is best-effort).

---

## 3. Registration-time invariants

The hook system fails **loud at registration time** for two classes of
errors. Both throw with a stack trace pointing at the broken
`Instance.on(...)` call.

### 3.1 Cycle-free invariant

**Cycle-free invariant.** When a hook registers with `after: [...]`, the
runtime walks the existing DAG and throws if adding the new edges would
create a cycle. Cost is O(n) per registration (n = total hook count for
the event); total O(n²) across all registrations, which is meaningless at
typical scale (≲30 hooks).

### 3.2 No-missing-dependency invariant

**No-missing-dependency invariant.** When a hook registers with
`after: [X, Y]`, every entry must already be a registered class hook for
the same event. Forward references throw immediately.

This forces a **registration-order discipline**: a dependency module must
import (and therefore register) before its dependents. In practice this
mirrors normal JavaScript import ordering — a module that depends on
`MongoAdapter` typically imports `MongoAdapter`, which triggers its
registration. The strictness keeps typos and missing-import bugs loud.

### 3.3 Single-Instance invariant

**Single-Instance invariant.** Calling `Instance.create(...)` twice in one
process is a fatal error (`Instance.crash`). The first creation registers
process-level signal handlers; a second would either double-register or
silently shadow. The package allows neither.

---

## 4. Auto-registration from configurable adapters

Several package-level base classes auto-register their lifecycle methods
with `Instance` so adapter authors don't write `Instance.on(...)` by hand.
The pattern: the base constructor inspects `this.connect` / `this.disconnect`
(and similar lifecycle methods) and registers them keyed by
`this.constructor` if present.

### 4.1 OrmAdapter auto-wiring

```ts
abstract class OrmAdapter {
  constructor() {
    const cls = this.constructor as ClassRef
    if (this.connect)    Instance.on('start', () => this.connect!(),    { class: cls })
    if (this.disconnect) Instance.on('close', () => this.disconnect!(), { class: cls })
  }
  protected onFatalError(err: unknown): never {
    Instance.crash(new EquippedError(`${this.constructor.name} fatal error`, {}, err as Error))
  }
}
```

Adapter authors implement `connect()` / `disconnect()` as instance methods;
the base handles registration. `connect()` and `disconnect()` remain
callable directly (useful for tests that want explicit lifecycle control).

The `onFatalError(err)` hook is the **standard fatal-error response** for
orm adapters. Driver-specific error events (`client.on('error', ...)`) wire
into it via `this.onFatalError(err)`; the default routes to `Instance.crash`,
and subclasses may override (e.g., a test-only adapter that throws instead
of exiting).

### 4.2 Other auto-registering bases

Cache / EventBus / Job / Server bases keep their existing per-class
`Instance.on(...)` registrations (now using the class-keyed signature).
Auto-wiring is **not** lifted into the `configurable` primitive itself —
lifecycle integration is conceptually orthogonal to config validation, and
coupling them would force every `configurable` consumer onto the
`Instance` hook bus regardless of need.

---

## 5. Other Instance surfaces

### 5.1 Crash

`Instance.crash(error)` logs the error to stderr and calls `process.exit(1)`.
It is the canonical fatal-error response across the package; it returns
`never` so callers can use it in expression position. Recovery is not
supported — a crash means the process dies.

### 5.2 Scoped naming

`instance.getScopedName(name, key = '.')` returns `${app.name}${key}${name}`
— a per-app prefix for namespacing resources (database names, topic names,
cache key prefixes) across environments. Adapters and consumers use it to
keep multi-tenant or multi-environment resources isolated; the orm does
**not** auto-scope schema-config naming via this — the resolver
(`Repo.from(adapter).resolve(schema => ...)`) is the user's escape hatch
and they call `getScopedName` themselves if needed.

### 5.3 Settings and envs

`Instance.create(settings)` validates `settings` against
`instanceSettingsPipe()`. `Instance.envs(pipe)` validates `process.env`
against a user-provided pipe and returns the typed result; failure
crashes. Both are validate-once boundaries — same pattern as the orm
Repo-entry boundary.

### 5.4 Explicit close

`instance.close()` fires the `close` hook DAG without exiting the process.
It is idempotent: after close has completed once, later calls are no-ops.
Closing does not reset the singleton or permit another `Instance.create(...)`
in the same process.

The process signal handler delegates to `instance.close()` before exiting with
the signal-derived exit code.

### 5.5 `resolveBeforeCrash`

`Instance.resolveBeforeCrash(cb)` registers the in-flight promise as an
anonymous `close` hook so it gets awaited during shutdown. Used for "fire
this off in the background but don't let the process exit before it
finishes" patterns.

---

## 6. What's not in the model

- **No-DI rule.** `Instance` is not a dependency injection container. It
  doesn't resolve services by type, doesn't construct objects, doesn't
  manage a service graph. Hooks run things; they don't create things.
- **No-restart rule.** There is no "restart the instance" or "re-run
  start hooks" API. Lifecycle is one-shot per process.
- **No-priority-tiebreaker rule.** Within a topo level (parallel siblings),
  there is no further ordering — `Promise.all` semantics apply. Adapters
  that need ordering between siblings must declare a dependency edge.
- **No-ordering-for-anonymous-hooks rule.** Anonymous hooks (no `class:`)
  run at the deepest level of the topo sort by default — they have no
  dependents, so they can't constrain anything else's ordering. They can
  declare `after:` to constrain *themselves* relative to named hooks.
- **No-cross-event-dependencies rule.** A hook for `start` cannot
  `after:` a `close`-event hook or vice versa. Dependencies are scoped to
  the event the hook is registered against.
