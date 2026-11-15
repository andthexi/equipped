# JSON native storage locking

The JSON ORM adapter coordinates explicit storage locks with OS-owned native file locks on a stable sidecar file. The data file remains independently atomically replaceable. A second stable sidecar serializes data-file reload, mutation, and publication, so compatible shared explicit holders may coexist without permitting stale snapshots to overwrite each other.

The canonical backing-file path is resolved before either sidecar is selected. Existing files resolve symbolic links and reject link counts above one; absent files resolve their real parent directory and stable basename. This lets relative, absolute, and symbolic aliases coordinate while preventing hard-link identities from splitting after atomic replacement. Every logical table in one backing file intentionally shares one explicit lock identity.

Acquisition is non-waiting and reports contention as `OrmLockError` with reason `busy`. Native locking is required; loading or operating the native module fails rather than falling back to marker polling, expiry, or takeover. Ownership closes after callback settlement, drains operations admitted from that ownership context through transaction publication, and then unlocks. Shared-inside-shared and either mode inside exclusive reuse ownership; shared-to-exclusive upgrades and new acquisition from an active transaction are invalid.

The guarantee is for local filesystems. Network filesystems are not qualified. The packaged native module provides Linux x64, macOS arm64, and Windows x64 builds; this change was executed on Linux x64 only, so the other target platforms require their own qualification runs before release claims.
