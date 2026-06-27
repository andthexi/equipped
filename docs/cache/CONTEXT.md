# Equipped Cache — Context

The Cache context defines Equipped's key-value caching vocabulary and the persistence roles behind cache implementations.

## Language

**Cache**:
A key-value store for string data that may expire entries after a time-to-live.
_Avoid_: store, map, memo

**Cache Adapter**:
A package-level adapter that provides Cache behavior against a specific backing store.
_Avoid_: cache driver, cache provider

**JSON Cache**:
A Cache Adapter whose backing store is a local JSON file while retaining in-process cache behavior. Each operation reloads the latest file snapshot under a lock and persists only when the operation changes cache state, so separate same-file adapter instances do not overwrite each other's keys with stale snapshots.
_Avoid_: json adapter, file cache
