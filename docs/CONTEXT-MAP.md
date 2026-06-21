# Context Map

All agent-facing docs live under `docs/`; code lives under `src/`. Per-subsystem
domain docs sit at `docs/<context>/CONTEXT.md` (mirroring the `src/` layout);
ADRs live at `docs/adr/` regardless of which subsystem they affect (single
canonical location).

## Contexts

| Context     | Domain doc                  |
| ----------- | --------------------------- |
| `orm`       | `docs/orm/CONTEXT.md`       |
| `instance`  | `docs/instance/CONTEXT.md`  |
| `server`    | `docs/server/CONTEXT.md`    |
| `utilities` | `docs/utilities/CONTEXT.md` |

Add a new row when a subsystem's vocabulary stabilises enough to deserve its own
`CONTEXT.md`. `/grill-with-docs` creates these lazily as terms get resolved.

## ADRs

All architectural decision records live at `docs/adr/`, named with an
ISO-date prefix (`YYYY-MM-DD-slug.md`) so parallel branches can land
without renumbering conflicts. Each ADR's title or first paragraph should
make clear which context(s) it affects.
