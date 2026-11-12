# equipped

## Agent skills

### Domain docs

Multi-context: `docs/CONTEXT-MAP.md` points at per-module `CONTEXT.md` files under `docs/<context>/CONTEXT.md` (e.g. `docs/orm/CONTEXT.md`). All ADRs live at `docs/adr/`. See `docs/DOMAIN.md`.

### Commit convention

This repo follows `@commitlint/config-conventional` (Conventional Commits), enforced by a Husky `commit-msg` hook. Use `<type>(<scope>)?: <subject>` with imperative-mood lowercase subjects and no trailing period.
