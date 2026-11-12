# In-memory root-session serialization

`InMemoryAdapter` serializes root sessions FIFO per adapter instance. A root session crosses the **admission boundary** before taking its adapter-wide snapshot, so it observes the committed state or restored rollback state left by the preceding root. This policy is serialization rather than concurrent execution with conflict detection.

Same-instance nested sessions are flat: they join the active transaction without reacquiring admission and without taking a snapshot or savepoint. A session on another adapter instance is an independent root with its own admission queue, snapshot, commit, and rollback lifecycle.

## Considered options

- **Concurrent roots with conflict detection.** Rejected because detecting conflicts across all mutable adapter metadata and stores would add complexity while still requiring a deterministic commit policy.
- **Savepoints for nested sessions.** Rejected because the in-memory adapter's transaction is an adapter-wide snapshot; flat nesting matches its simple reference-adapter role.
- **One process-wide queue.** Rejected because unrelated adapter instances own disjoint state and should progress independently.

## Consequences

- A thrown root restores its own adapter-wide snapshot before releasing admission, then queued roots continue in FIFO order.
- Different adapter instances can run concurrently. Acyclic cross-instance nesting works, but no cross-adapter atomicity is provided.
- The adapter performs no deadlock detection. Cyclic cross-instance nesting can deadlock and is caller error.
