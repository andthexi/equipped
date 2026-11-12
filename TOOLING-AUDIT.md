# Tooling audit migration notes

This branch applies the reusable findings from the Valleyed tooling audit to Equipped.

## Applied

- Migrated `@k11/configs` to `xi-configs@0.1.0` for ESLint, Prettier, and TypeScript.
- Upgraded ESLint to 10, Commitlint to 21, and Vitest to 5.
- Replaced `standard-version` with `commit-and-tag-version`.
- Added explicit `format`, `format:check`, `typecheck`, and `prerelease` quality-gate scripts.
- Disabled automatic peer installation and retained explicit minimum-release-age exceptions.
- Replaced tsup and `esbuild-fix-imports-plugin` with tsdown.
- Raised the build runtime to Node 24.22.3 because tsdown requires Node 24.11 or newer on the Node 24 line.
- Preserved all 24 public subpaths, normal/minified ESM and CJS outputs, and format-specific declarations.
- Uses `tsc --emitDeclarationOnly` for declarations because tsdown's declaration bundler cannot safely handle Equipped's colliding `src/index.ts` and `src/types/index.ts` entries.
- Converted relative source imports to explicit `.js` specifiers for NodeNext-compatible declarations.
- Added `.d.cts` copies for CommonJS consumers.
- Consolidated release creation and npm OIDC publishing into the tag-triggered publish workflow.
- Added tag/package-version validation before publication.

## Local compatibility exceptions

The stricter shared ESLint and TypeScript presets exposed existing patterns. These remain local rather than weakening `xi-configs`:

- `noImplicitAny` remains disabled.
- Existing empty-object, namespace, dynamic import-type, broad function, and related patterns are allowed locally.
- Source-level fixes were limited to errors required for the stricter toolchain and declaration generation.

## Verification contract

Before merging, verify:

1. `pnpm prerelease`
2. All 24 exports and their 144 conditional targets exist.
3. `publint` has no errors.
4. `attw` passes Node16 ESM/CJS and bundler resolution. Legacy Node10 resolution is expected to fail for exports-only subpaths.
5. The packed package type-checks in a NodeNext consumer with the repository's supported dependency/type policy.
6. `actionlint .github/workflows/publish_to_npm.yml`

The branch intentionally remains isolated from the main checkout and must be rebased onto the latest `origin/main` only after concurrent work there is ready.
