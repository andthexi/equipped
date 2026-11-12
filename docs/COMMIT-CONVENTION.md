# Commit convention: Conventional Commits

This repo follows [`@commitlint/config-conventional`](https://www.npmjs.com/package/@commitlint/config-conventional),
the standard Conventional Commits ruleset. A Husky `commit-msg` hook
enforces it on every commit, so non-conforming messages are rejected
before they land — but write conforming messages from the start rather
than relying on the hook to catch mistakes.

## Format

```
<type>(<scope>)?: <subject>

<body>?

<footer>?
```

- **`<type>`** — required. One of the canonical types listed below.
- **`<scope>`** — optional. A short noun in parentheses identifying the
  area of the codebase touched (e.g. `orm`, `instance`, `cache`,
  `events`). Lowercase. Omit if the change is repo-wide.
- **`<subject>`** — required. Imperative-mood description of the change
  ("add", "fix", "update" — not "added", "fixes", "updated"). Lowercase
  first letter. No trailing period.
- **`<body>`** — optional. Free-form prose, separated from the subject
  line by a blank line. Use for the _why_ of the change when non-obvious.
- **`<footer>`** — optional. Used for breaking-change markers and issue
  references.

## Canonical types

The conventional-config ruleset accepts exactly these types:

| Type       | When to use                                                               |
| ---------- | ------------------------------------------------------------------------- |
| `feat`     | A new feature (user-facing or API-surface addition).                      |
| `fix`      | A bug fix.                                                                |
| `docs`     | Documentation-only changes (CONTEXT.md, ADRs, READMEs, code comments).    |
| `style`    | Formatting, whitespace, import ordering — no logic change.                |
| `refactor` | Code change that neither fixes a bug nor adds a feature.                  |
| `perf`     | A performance improvement.                                                |
| `test`     | Adding or updating tests.                                                 |
| `build`    | Changes to the build system or external dependencies (npm, package.json). |
| `ci`       | Changes to CI configuration files and scripts.                            |
| `chore`    | Other repo-maintenance changes that don't fit elsewhere.                  |
| `revert`   | Reverts a previous commit.                                                |

When in doubt between two types, prefer the more specific one (e.g.
`refactor` over `chore` for a code restructure that's not user-facing).

## Subject rules

- **Imperative mood.** "add X", not "added X" or "adds X".
- **Lowercase start.** "add support for X", not "Add support for X".
- **No trailing period.** End at the last word.
- **Concise.** Aim for ≤72 characters in the header (`type(scope): subject`).
- **Subject describes the change, not the area.** "fix off-by-one in
  pagination" is better than "fix pagination" — the scope already says
  _where_, the subject should say _what_.

## Breaking changes

Breaking changes are marked **two ways**:

1. Append `!` to the type (or scope): `feat!: drop legacy adapter API`
   or `refactor(orm)!: replace Adapter.from with class-based shape`.
2. Add a `BREAKING CHANGE:` footer with details:

    ```
    refactor(orm)!: replace Adapter.from with class-based shape

    Adapters now extend `configurable(pipe, OrmAdapter)` instead of
    the builder chain. See ADR 2026-05-06.

    BREAKING CHANGE: out-of-tree adapter authors must rewrite adapters
    from `Adapter.from<Config>().build()` to class-based form.
    ```

Either signal alone is enough to trigger major-version bumps; using both
is conventional for clarity.

## Scope conventions

Scopes match the high-level subsystems in the repo. Common scopes:

- `orm` — anything under `src/orm/`.
- `instance` — anything under `src/instance/`.
- `cache`, `events`, `jobs`, `server` — package-level adapter folders.
- `utilities` — anything under `src/utilities/`.
- `dbs` — the legacy `src/dbs/` layer (under deprecation).
- `docs` — when paired with the `docs` type, drop the scope; otherwise
  scope by the area being documented (e.g. `docs(orm): update CONTEXT`).

If a change crosses subsystems, omit the scope.

## Examples

Good:

```
feat(orm): add schemaConfigPipe for per-call validation
fix(instance): throw at registration when after-dep is missing
refactor(orm)!: convert Adapter from builder to class via configurable
docs(orm): rewrite §3 around class-based adapter narrowing
test(events): cover RabbitMQ retry on connection drop
build: bump @commitlint/config-conventional to 20.4.1
```

Bad:

```
Updated stuff                          # no type, capitalized, vague
feat: Added new feature.               # capitalized subject, trailing period
fix(orm): bug                          # uninformative subject
refactor: refactor the orm             # tautological subject
WIP                                    # not a conventional commit
```

## When `Co-Authored-By:` trailers apply

When Claude (or any agent) authors a commit on the user's behalf, append
the standard trailer in the footer:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Trailers go in the footer block (separated from the body by a blank
line), alongside any `BREAKING CHANGE:` or issue-reference trailers.
