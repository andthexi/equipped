# Separate schema input and output contracts

**Status:** Accepted design; implemented in Equipped Slices #198–#200, with atomic-mutation behavior assigned to a later slice.

Schema field pipes can transform write input into a different persisted representation. Replaying that pipe on a database result can reject a valid stored value, transform it again, or hide missing data through defaults. Schema-aware Repo operations will instead validate results using schema-owned output pipes before using or exposing them. The complete accepted behavior is recorded in [ORM context §18](../orm/CONTEXT.md#18-output-validation-and-atomic-mutations--accepted-design).

## Decision

- Replace `.field(name, pipe, options?)` with `.field(name, { input, output?, onCreate?, onUpdate? })`. The options object and `input` are required.
- Require `output` when the input pipe's input and output types differ. Allow an output override when they match. If omitted, the author guarantees the input pipe is safe to reuse on stored values; type equality alone cannot establish that guarantee.
- Require the output pipe to accept and return the input pipe's output type. Output validation must preserve the persisted representation, apart from native object stripping; authors must not introduce read-time transformations or defaults that conceal invalid stored values.
- Use `.pk(name, { input, output?, generate })` for primary keys, preserving the required generator. Use `.computed(name, { deps, output, compute })` for computed fields, which have no write input.
- Caller values pass through input pipes. Generated persisted values from `generate`, `onCreate` and `onUpdate` pass through output pipes before writing, without replaying input transformations. Database-returned values pass through output pipes after storage decoding.
- Validate the actual query result shape, including fetched dependencies before internal use. A partial select does not certify unselected state, and a mutation does not implicitly read back additional fields solely to validate every changed value.
- Preserve Valleyed's native stripping and use its all-errors mode rather than implementing another nested-error collector. Retain its `PipeError` details and rejected values in `OrmValidationError` with `kind: 'output'`; Consumers own sanitization before logging or exposure.
- Explicit `raw()` and direct adapter/driver calls remain outside automatic output validation. `PatchOp` remains an explicit nested-input validation escape, not an output-validation escape for ordinary Repo results.

## Considered options

- **Require only `Pipe<T, T>`.** Rejected: matching types still permit non-idempotent transformations and defaults, while disallowing useful type-changing write inputs.
- **Always require two pipes.** Rejected: simple validation-only fields can safely share a pipe. Conditional requirement preserves that economy with an explicit author-owned reuse contract.
- **Validate in Consumer handlers after each call.** Rejected: omission is easy, and internal computed/preload/helper operations can consume invalid data before the handler gets the result.
- **Validate all mutated fields regardless of selection.** Not part of this guarantee: it would require additional readback and certify mutation state rather than the promised result.

## Consequences

This extends the input-only validate-once rule in ORM context §7 and principle §13.5. Input validation remains at Repo entry; output validation belongs at schema-aware return boundaries, before internal consumption or public exposure. There is no compatibility overload or legacy `.pipe` alias. Slices #198 and #199 implement the field and computed declaration APIs and the corresponding validation boundaries. Slice #200 implements scalar and aggregate output validation; atomic-mutation contracts remain assigned to a later slice.

Top-level selection is unchanged. Selected JSON fields validate their complete returned nested value. Computed dependencies, relation keys, related documents, result containers and cardinality must also be covered; a final response-only validator is insufficient. Schema validity does not establish ownership, authorization, domain relationships or transaction settlement.
