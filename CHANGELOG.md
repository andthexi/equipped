# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [5.3.6](https://github.com/andthexi/equipped/compare/v5.3.5...v5.3.6) (2026-11-12)

### [5.3.5](https://github.com/andthexi/equipped/compare/v5.3.4...v5.3.5) (2026-11-12)

### Bug Fixes

- **orm:** preserve schema config types in repo builder ([#158](https://github.com/andthexi/equipped/issues/158)) ([db7c305](https://github.com/andthexi/equipped/commit/db7c3056abb2f24c3bfc7e2ce3384e2a525bbfe2))

### [5.3.4](https://github.com/kevinand11/equipped/compare/v5.3.3...v5.3.4) (2026-11-11)

### Features

- **cache:** add json cache adapter ([4f1ec32](https://github.com/kevinand11/equipped/commit/4f1ec3221c9c237627710ff673fc7d1f4a6931ef))
- **instance:** expose explicit close ([3bffda0](https://github.com/kevinand11/equipped/commit/3bffda0b8b9ab65c87a8c7172d41b19c3082a82a))
- **orm:** support nested field filters ([7e5da13](https://github.com/kevinand11/equipped/commit/7e5da1371e74cdb8a0aef1b23d1c72956c3f668e))
- **orm:** support unbounded pagination envelopes ([380d47d](https://github.com/kevinand11/equipped/commit/380d47d550d57b7f3b8b9bfdd45107641730cf36))
- **server:** add no content status support ([688a8ee](https://github.com/kevinand11/equipped/commit/688a8eee59f09917676af1bb18fe4c08496db9e3))
- **server:** add route contracts ([9e4fbb9](https://github.com/kevinand11/equipped/commit/9e4fbb91be2f0439ced39e7d4314eee5f1fdcb71))
- **server:** support extensible status codes ([1adc702](https://github.com/kevinand11/equipped/commit/1adc70259ccba966b2ac70a817a833f9e912792d))

### Bug Fixes

- **adapters:** serialize json file operations ([3865a00](https://github.com/kevinand11/equipped/commit/3865a00ad55d575bd8c01dee66bbf7ba1e30ef69))
- **orm:** make like match literal substrings ([f6aba4c](https://github.com/kevinand11/equipped/commit/f6aba4c0c3f1096e5c3dbc44580e5a9b943a9476))
- **orm:** synchronize in-memory table discovery and data ([fda615c](https://github.com/kevinand11/equipped/commit/fda615c1ceb08867420209ce1be6f37097f8031a))

### [5.3.3](https://github.com/kevinand11/equipped/compare/v5.3.2...v5.3.3) (2026-06-21)

### Features

- **server:** add precondition required error ([b4630f8](https://github.com/kevinand11/equipped/commit/b4630f841858858af23a4d7f498e7a3ddba83b5b))

### [5.3.2](https://github.com/kevinand11/equipped/compare/v5.3.1...v5.3.2) (2026-06-20)

### [5.3.1](https://github.com/kevinand11/equipped/compare/v5.3.0...v5.3.1) (2026-06-19)

### Features

- **server:** add before listen hook ([f72134c](https://github.com/kevinand11/equipped/commit/f72134c67273023a3e98351dd079fa6600b6a43d))

## [5.3.0](https://github.com/kevinand11/equipped/compare/v5.3.0-alpha.0...v5.3.0) (2026-06-19)

### Features

- **server:** add custom not found fallback ([6173b4f](https://github.com/kevinand11/equipped/commit/6173b4ffb7f14dd7f965507c972f9fb1434dc5d1))

## [5.3.0-alpha.0](https://github.com/kevinand11/equipped/compare/v5.2.9...v5.3.0-alpha.0) (2026-06-16)

### ⚠ BREAKING CHANGES

- **orm:** `Where`, `WhereOp`, `WhereGroupOp`, `QueryGroup`,
  `WhereFactory`, and `FilterOp` are removed from the public API.
  Use `Filter`, `FilterGroup`, and `FilterFactory` from `filter.ts`.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>

- **orm:** EventAudit class and all types exported from
  src/audit/ are removed. Migrate to EventLog via
  EventLog.from(repo).build().handler(name, def).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>

- bump version to 6.0.0 for breaking-change lockdown
- **orm:** delete Adapter.from builder; finalize class-based narrowing

### Features

- computed fields ([d1abd3e](https://github.com/kevinand11/equipped/commit/d1abd3ead8614490a5ca7c0b129e5ab4f59ede78))
- configurable ([01e3b32](https://github.com/kevinand11/equipped/commit/01e3b329fc5c828324b1e1d826d57c85b550805f))
- fields and schema fields ([e67a768](https://github.com/kevinand11/equipped/commit/e67a768e21a4d3720e85494be584d91260b31983))
- implement FilterGroup + queryable behaviour + filter normalisation ([507a8b2](https://github.com/kevinand11/equipped/commit/507a8b2dba27a0ad491b6876bf18f42c7a17a198)), closes [#1](https://github.com/kevinand11/equipped/issues/1) [#5](https://github.com/kevinand11/equipped/issues/5)
- orm adapters ([cc56149](https://github.com/kevinand11/equipped/commit/cc56149e5bde7fbc532eeede10b9bba2b7a68b20))
- orm insert path + validation pipeline + OrmValidationError ([9337445](https://github.com/kevinand11/equipped/commit/93374453817848c1cb419c45ec2ae56f593ba85d)), closes [#3](https://github.com/kevinand11/equipped/issues/3) [#1](https://github.com/kevinand11/equipped/issues/1)
- orm query ([c62f321](https://github.com/kevinand11/equipped/commit/c62f321108660b3843f6f38f81d8d597cb9a9236))
- orm repo ([0755998](https://github.com/kevinand11/equipped/commit/0755998819384e84e5666c6d2f7d30f3b86fabb8))
- orm schema ([a360b7e](https://github.com/kevinand11/equipped/commit/a360b7e3bf39a540eae2408cc78cc72abd51d9ea))
- **orm/postgresql:** migrate PG adapter to defineAdapter shape (issue [#12](https://github.com/kevinand11/equipped/issues/12), PRD [#1](https://github.com/kevinand11/equipped/issues/1)) ([492e1c8](https://github.com/kevinand11/equipped/commit/492e1c8ef715be7ae7d91ccd723a5df684e78f75))
- **orm:** add .required() modifier to OneBuilder with Req typestate ([e987ae9](https://github.com/kevinand11/equipped/commit/e987ae94c50a4e8d0e7e661f0fb0ad25989e1292))
- **orm:** add adapter iteration primitive ([6c7ef2b](https://github.com/kevinand11/equipped/commit/6c7ef2b37068bce46d094c054b8f7f2b75728089))
- **orm:** add AggregateBuilder with count-only end-to-end via in-memory ([e77e9da](https://github.com/kevinand11/equipped/commit/e77e9da81f5ea2ebd7ebb97868edcfb1a4266ab5))
- **orm:** add canonical AggregateOpName type and aggregateOps capability ([a67605c](https://github.com/kevinand11/equipped/commit/a67605cc9a4eadaf68d23cb71ea6d23b698fcf5c))
- **orm:** add EventLog foundations and atomic fire path ([9fe567e](https://github.com/kevinand11/equipped/commit/9fe567e02ee69ebec2fe7879233edf305aed95e4))
- **orm:** add EventLog replay and rerun with per-event session isolation ([ac1ad61](https://github.com/kevinand11/equipped/commit/ac1ad6103883438059c6a26294be048324880048))
- **orm:** add filter-only count terminal ([ff511be](https://github.com/kevinand11/equipped/commit/ff511be634112720ac4cb9506d2f13e9177e903c))
- **orm:** add full Change algebra (10 remaining variants) + full validation + migrationId/changeIndex ([2ec765f](https://github.com/kevinand11/equipped/commit/2ec765f2be31264a3cefd64f242d6eba2c5885e0)), closes [#1](https://github.com/kevinand11/equipped/issues/1) [#1](https://github.com/kevinand11/equipped/issues/1) [#1](https://github.com/kevinand11/equipped/issues/1)
- **orm:** add iteration options validation ([92bde6f](https://github.com/kevinand11/equipped/commit/92bde6f6ba54e2ed6b4ee84d658b7ab0e676ea18))
- **orm:** add MigrationCodegen + introspect (in-memory adapter) ([5897662](https://github.com/kevinand11/equipped/commit/58976620009ac2bd27488dd30f004460b010f3dd))
- **orm:** add migrations foundation tracer-bullet ([2c1602b](https://github.com/kevinand11/equipped/commit/2c1602b107fd4d4693246d26f7bc08d034dcf7e1)), closes [#103](https://github.com/kevinand11/equipped/issues/103)
- **orm:** add Migrator opts (to/steps), status(), dry(), orphan detection + error phases ([ba680b6](https://github.com/kevinand11/equipped/commit/ba680b6e5dd4c74ea3d69b681e90b02088514c45))
- **orm:** add Mongo adapter migration methods + structural narrowing fix ([3a60395](https://github.com/kevinand11/equipped/commit/3a603953e5301c722f2a985733251b5d7fe4ce5a))
- **orm:** add MongoDB adapter aggregate pipeline compiler ([f027e64](https://github.com/kevinand11/equipped/commit/f027e647bbe51e0cbed32b80e957c3c26dec3637))
- **orm:** add OrmAdapter abstract base class and Repo dispatch validator ([accff9f](https://github.com/kevinand11/equipped/commit/accff9f0260e6d473323e91c6bdf7b12d8056e84))
- **orm:** add OrmNotFoundError class ([18addab](https://github.com/kevinand11/equipped/commit/18addab294c66850e525f6030fe850bb98b3eb1b))
- **orm:** add paginated all-query envelope ([1defc89](https://github.com/kevinand11/equipped/commit/1defc89a33a0cd29634ab7ff41bf792d809e0c8e))
- **orm:** add per-migration tx + cluster-safe lock to Migrator ([88d6752](https://github.com/kevinand11/equipped/commit/88d6752b95f2c6af55e9e9bd55bae53b8af7152d)), closes [#104](https://github.com/kevinand11/equipped/issues/104)
- **orm:** add Postgres adapter migration implementation ([e6cde0c](https://github.com/kevinand11/equipped/commit/e6cde0c1bcbb77f797f37a3d812d8faffc6b9d3c))
- **orm:** add read query-shape pagination validation ([d2f3b00](https://github.com/kevinand11/equipped/commit/d2f3b00a67ffe053eab12b04e2145f4d899c3e5c))
- **orm:** complete AggregateBuilder surface (groupBy, aggregators, where/having) ([6bede84](https://github.com/kevinand11/equipped/commit/6bede84df409da31738f31cf4767cd871b2941f6))
- **orm:** complete walking skeleton type safety + remove adapter cast gap ([0a04718](https://github.com/kevinand11/equipped/commit/0a04718f0a03993ead6bd010e51ab305a867aa87)), closes [#2](https://github.com/kevinand11/equipped/issues/2) [#2](https://github.com/kevinand11/equipped/issues/2) [#5](https://github.com/kevinand11/equipped/issues/5)
- **orm:** export AggregateBuilder from public barrel ([2c312f7](https://github.com/kevinand11/equipped/commit/2c312f75bc60dd3025ff7852404a90d22e77053b))
- **orm:** extend OrmValidationError with aggregate kind and alias carrier ([39e4006](https://github.com/kevinand11/equipped/commit/39e4006890b8ce446799d73f93122ee04fd32c36))
- **orm:** filter-based mutations + deleteByPk + raw escape hatch ([5bbf877](https://github.com/kevinand11/equipped/commit/5bbf87742198709c513bf6f61fb3795798f8d9a2)), closes [#6](https://github.com/kevinand11/equipped/issues/6) [#1](https://github.com/kevinand11/equipped/issues/1)
- **orm:** implement JSON adapter migrations ([6b9ae13](https://github.com/kevinand11/equipped/commit/6b9ae132131b5776bc55c7dc0c680f606e94823d))
- **orm:** implement PostgreSQL adapter aggregate compiler ([3a06688](https://github.com/kevinand11/equipped/commit/3a06688a7474119ae1497382e4af8d5fbdad519a))
- **orm:** implement walking skeleton for defineSchema/defineAdapter/defineRepo ([2ab2c8e](https://github.com/kevinand11/equipped/commit/2ab2c8ea6ae5f8c3d299cf6d01e650ec32ce9d1e)), closes [#2](https://github.com/kevinand11/equipped/issues/2) [#2](https://github.com/kevinand11/equipped/issues/2)
- **orm:** json adapter aggregate delegation to in-memory ([dedb42c](https://github.com/kevinand11/equipped/commit/dedb42cc381a5eafdb6eafff357201da3f0d9ffb))
- **orm:** stream postgresql iteration through cursors ([ac18e17](https://github.com/kevinand11/equipped/commit/ac18e1757270dd77d21cae2f2e323003c888dd09))
- **orm:** update path + op helpers + auto-bump + conflict rejection ([2ee0bfa](https://github.com/kevinand11/equipped/commit/2ee0bfa5d63dc60b62a0621adbfbf120ada3f0a6)), closes [#4](https://github.com/kevinand11/equipped/issues/4)
- **orm:** upsert dual-path — schema-per-call upsertOne with insert+ops ([0d5f275](https://github.com/kevinand11/equipped/commit/0d5f27544a621916b4ed31753f56e854067203ff)), closes [#8](https://github.com/kevinand11/equipped/issues/8) [#1](https://github.com/kevinand11/equipped/issues/1)
- projection ([eac52a3](https://github.com/kevinand11/equipped/commit/eac52a3ddd7a385f77f522de811e724852dfd14c))
- raw command ([6a56326](https://github.com/kevinand11/equipped/commit/6a56326de92246f0d45ffe407fabd15aabbfcb1d))

### Bug Fixes

- align README with insert→create and repo.from→repo.on renames ([3378a84](https://github.com/kevinand11/equipped/commit/3378a84981919768eba0d6c0dad9328e95c683aa))
- one relation return type ([17f05f2](https://github.com/kevinand11/equipped/commit/17f05f273112ac18c85ad3fb3edb8c76dd341e0f))
- **orm:** drop past-last pagination neighbors ([6ff12da](https://github.com/kevinand11/equipped/commit/6ff12daa0224e180902e7ca6c56625597203d174))
- **orm:** honor batch size in non-postgres iteration ([acd605a](https://github.com/kevinand11/equipped/commit/acd605acd62bcb3aaeae9fea1b8f7dc489d0a386))
- **orm:** move ssl into postgresqlConnectionPipe with v.defaults ([a5aafe8](https://github.com/kevinand11/equipped/commit/a5aafe8ac41f90534de8f7ac9a6d2afc54f8f1f3))
- **orm:** narrow deleteOne fallback to PK filter and remove dead ordering getters ([0e56628](https://github.com/kevinand11/equipped/commit/0e56628074b8245f0ed10862ef577e6dc27e61fd))
- **orm:** remove unnecessary type cast in schema.pk() ([1cbda00](https://github.com/kevinand11/equipped/commit/1cbda00421223e00a5260eacd62a8f5d583dda23))
- **orm:** restore direct iterate generator ([bc8a33b](https://github.com/kevinand11/equipped/commit/bc8a33be0884bad22f73d2dbeb6d699d7ac0ba16))
- **orm:** validate explicit undefined read limits ([3d7c85f](https://github.com/kevinand11/equipped/commit/3d7c85f2c99827cfe0fbf879dc8a14448aa94c12))
- **postgresql:** use pg-cursor type package ([b6971c7](https://github.com/kevinand11/equipped/commit/b6971c7bed83b61772f58f5d8bd24281b5fc4fe8))
- pr cleanup ([cc306b6](https://github.com/kevinand11/equipped/commit/cc306b697c242110409703cb67f7c2849ece445d))
- resolve merge conflict with feature/orm ([e00169a](https://github.com/kevinand11/equipped/commit/e00169a9377a6418f7168f525a06df18c4a8006f))
- resolve merge conflicts with feature/orm (static-factory refactor) ([6ed7369](https://github.com/kevinand11/equipped/commit/6ed7369efa838ff0e9b54dd139658de5efe84154))

- bump version to 6.0.0 for breaking-change lockdown ([927b04a](https://github.com/kevinand11/equipped/commit/927b04a8a39ae06e41f89883183769f81fbecdbf)), closes [#45](https://github.com/kevinand11/equipped/issues/45) [#45](https://github.com/kevinand11/equipped/issues/45) [#46](https://github.com/kevinand11/equipped/issues/46) [#47](https://github.com/kevinand11/equipped/issues/47) [#48](https://github.com/kevinand11/equipped/issues/48) [#54](https://github.com/kevinand11/equipped/issues/54)
- **orm:** consolidate query.ts into filter.ts + query-options.ts ([f96b3b0](https://github.com/kevinand11/equipped/commit/f96b3b051d673f2c62833daa62c9b3c1e631ff5e))
- **orm:** delete Adapter.from builder; finalize class-based narrowing ([cec1fa0](https://github.com/kevinand11/equipped/commit/cec1fa0b9785d72f9f62bb1c9aaba6cc75f123df))
- **orm:** delete legacy src/audit/ EventAudit module ([e99d042](https://github.com/kevinand11/equipped/commit/e99d042eb339f58b1f6a40178b03d184a6ef0312))

### [5.2.9](https://github.com/kevinand11/equipped/compare/v5.2.8...v5.2.9) (2026-03-21)

### Bug Fixes

- skip bulk write if empty ([702c28f](https://github.com/kevinand11/equipped/commit/702c28f8c47f30b7c2f1b7334126632fe55197fc))

### [5.2.8](https://github.com/kevinand11/equipped/compare/v5.2.7...v5.2.8) (2026-03-02)

### Bug Fixes

- dont covert undefined to null in mongo ([81b3870](https://github.com/kevinand11/equipped/commit/81b3870e4f84220a0f5022816d8c3954f19751fd))

### [5.2.7](https://github.com/kevinand11/equipped/compare/v5.2.6...v5.2.7) (2026-03-02)

### [5.2.6](https://github.com/kevinand11/equipped/compare/v5.2.5...v5.2.6) (2026-02-26)

### Bug Fixes

- not found handler running before path handlers in express ([9088562](https://github.com/kevinand11/equipped/commit/9088562f6ad53c5accfa79a3c9f658cc606cf9ae))

### [5.2.5](https://github.com/kevinand11/equipped/compare/v5.2.4...v5.2.5) (2026-02-25)

### Features

- add support for response middlewares ([0c75845](https://github.com/kevinand11/equipped/commit/0c75845f65c6fcce941adaa8610cd46783b25707))

### [5.2.4](https://github.com/kevinand11/equipped/compare/v5.2.3...v5.2.4) (2026-02-23)

### Bug Fixes

- on error, if equipped error, make badRequest with error message ([52501b3](https://github.com/kevinand11/equipped/commit/52501b3bc93881557cdea54f7b1a888531e0a7b6))

### [5.2.3](https://github.com/kevinand11/equipped/compare/v5.2.2...v5.2.3) (2026-02-08)

### Bug Fixes

- type of cors should be true not boolean ([60cad5e](https://github.com/kevinand11/equipped/commit/60cad5eb3a99f99e57a2363461fe96fb830045ca))

### [5.2.2](https://github.com/kevinand11/equipped/compare/v5.2.1...v5.2.2) (2026-02-08)

### Features

- support allow all domains for cors ([bf12ed4](https://github.com/kevinand11/equipped/commit/bf12ed451970c5946f819c9ea2ae43471b640c85))

### [5.2.1](https://github.com/kevinand11/equipped/compare/v5.2.0...v5.2.1) (2026-02-03)

### Bug Fixes

- only log error if it is not an equipped error ([ab8f517](https://github.com/kevinand11/equipped/commit/ab8f517b0ea4412453a89df759943e9d2c9df736))

## [5.2.0](https://github.com/kevinand11/equipped/compare/v5.1.11...v5.2.0) (2026-02-03)

### Features

- auth methods support registering route security ([49ae6de](https://github.com/kevinand11/equipped/commit/49ae6de0a73c5e9ae112d1c26e938e68041195c6))
- impl cookie request auth ([996e6ce](https://github.com/kevinand11/equipped/commit/996e6ce34943749a3ebc900a38c70119c5f0670e))

### Bug Fixes

- cors behavior ([c48a35a](https://github.com/kevinand11/equipped/commit/c48a35ac61d59c3274a484cc7758cc561e303a95))
- remove unused context from request object and schema ([cf771a0](https://github.com/kevinand11/equipped/commit/cf771a0521ba98b54bbd2aec3b6a203ffd362c56))
- types of instance.createX ([b8589e7](https://github.com/kevinand11/equipped/commit/b8589e76dcdb31f7536777f3c1042c42a9265ea2))
- validate response cookie value not whole cookie object ([289496a](https://github.com/kevinand11/equipped/commit/289496a8192aa3f4f05fc500561131fd269e5698))

### [5.1.11](https://github.com/kevinand11/equipped/compare/v5.1.10...v5.1.11) (2026-01-25)

### Bug Fixes

- enable heartbeats for cdc ([f29c586](https://github.com/kevinand11/equipped/commit/f29c586c330f34a7e9e646531bc183fb3b610ec5))

### [5.1.10](https://github.com/kevinand11/equipped/compare/v5.1.9...v5.1.10) (2026-01-19)

### Bug Fixes

- check for length before running bulkWrite ([32b18fc](https://github.com/kevinand11/equipped/commit/32b18fc8e8a29aa24f81ec151692ee199dbd3a33))

### [5.1.9](https://github.com/kevinand11/equipped/compare/v5.1.8...v5.1.9) (2026-01-18)

### Bug Fixes

- dont throw error inside process audit event session ([a35ebb0](https://github.com/kevinand11/equipped/commit/a35ebb04ddeeef0717c33e4031e2ac534db6697d))

### [5.1.8](https://github.com/kevinand11/equipped/compare/v5.1.7...v5.1.8) (2026-01-09)

### Features

- add firstRun to event context ([0f47b76](https://github.com/kevinand11/equipped/commit/0f47b762525aff5e51acfe1676e9b4e5b31a84eb))

### Bug Fixes

- update fastify options ([27524e2](https://github.com/kevinand11/equipped/commit/27524e231b4a5c306015986de25fa48f9a87a6a5))

### [5.1.7](https://github.com/kevinand11/equipped/compare/v5.1.6...v5.1.7) (2025-12-07)

### Bug Fixes

- mongo session not reversing on error and scope bull jobs names ([9a1b9cb](https://github.com/kevinand11/equipped/commit/9a1b9cb9fbaa9840c75b9f4324a8d96e964b8a7a))

### [5.1.6](https://github.com/kevinand11/equipped/compare/v5.1.5...v5.1.6) (2025-12-07)

### Bug Fixes

- custom id for bull jobs ([f56fb23](https://github.com/kevinand11/equipped/commit/f56fb23a12fc2bafe5d58ea062768a2f64bb83dc))

### [5.1.5](https://github.com/kevinand11/equipped/compare/v5.1.4...v5.1.5) (2025-12-07)

### Bug Fixes

- switch from bull to bullmq for jobs ([ba5fdfb](https://github.com/kevinand11/equipped/commit/ba5fdfb48ed8b95386f7a6950b4480e854134436))

### [5.1.4](https://github.com/kevinand11/equipped/compare/v5.1.3...v5.1.4) (2025-11-23)

### Bug Fixes

- confluent kafka version ([8d00144](https://github.com/kevinand11/equipped/commit/8d00144604877d20a1099f40299a5d474da58dd8))

### [5.1.3](https://github.com/kevinand11/equipped/compare/v5.1.2...v5.1.3) (2025-11-11)

### [5.1.2](https://github.com/kevinand11/equipped/compare/v5.1.1...v5.1.2) (2025-11-11)

### Bug Fixes

- type export ([4af5503](https://github.com/kevinand11/equipped/commit/4af55034020e44e66cb569873bf1fc841c7686fa))

### [5.1.1](https://github.com/kevinand11/equipped/compare/v5.1.0...v5.1.1) (2025-11-11)

### Features

- start audit queue in instance hooks ([1be0c79](https://github.com/kevinand11/equipped/commit/1be0c791a68a6c6482816ce434e560f19ff5373c))
- upgrade scalar version ([9b988a0](https://github.com/kevinand11/equipped/commit/9b988a0963d683bef5194243a3ba43ea5d5f60c0))

### Bug Fixes

- mongo session resuses same session for nested calls ([68a446f](https://github.com/kevinand11/equipped/commit/68a446fc9ffb69997c28a9fd5ecc6a68eb95fd61))
- starting db changes ([7de81c0](https://github.com/kevinand11/equipped/commit/7de81c021a15d2ed253843ae7d63f5452188500c))

## [5.1.0](https://github.com/kevinand11/equipped/compare/v5.0.35...v5.1.0) (2025-10-04)

### [5.0.35](https://github.com/kevinand11/equipped/compare/v5.0.34...v5.0.35) (2025-10-03)

### Bug Fixes

- audit userId->by ([0bd0afc](https://github.com/kevinand11/equipped/commit/0bd0afc85dbb24cd5cce0a83ecb10fc040c5a2fa))

### [5.0.34](https://github.com/kevinand11/equipped/compare/v5.0.33...v5.0.34) (2025-10-03)

### Features

- audit context with userId ([d5ecd16](https://github.com/kevinand11/equipped/commit/d5ecd167d7d794cef4c9f994f6c90bd950b9aba6))

### [5.0.33](https://github.com/kevinand11/equipped/compare/v5.0.32...v5.0.33) (2025-10-02)

### [5.0.32](https://github.com/kevinand11/equipped/compare/v5.0.31...v5.0.32) (2025-10-02)

### Bug Fixes

- extend defineHandler type ([4011003](https://github.com/kevinand11/equipped/commit/40110036366fb11fa69dd430ec346cf77c5defe2))

### [5.0.31](https://github.com/kevinand11/equipped/compare/v5.0.30...v5.0.31) (2025-10-02)

### Bug Fixes

- type errors ([c945f0b](https://github.com/kevinand11/equipped/commit/c945f0b0e2324c74748214eb9ad8262eb8d9e4e5))

### [5.0.30](https://github.com/kevinand11/equipped/compare/v5.0.29...v5.0.30) (2025-10-02)

### Features

- events auditing ([4f7eb59](https://github.com/kevinand11/equipped/commit/4f7eb59c75cd8b2809084c798d4ce3e0bc500ead))
- response cookies and cookies validations ([a500adb](https://github.com/kevinand11/equipped/commit/a500adbd937efa1bd4d320836ba3671414bbe0f3))

### [5.0.29](https://github.com/kevinand11/equipped/compare/v5.0.28...v5.0.29) (2025-08-28)

### Bug Fixes

- use snapshot mode of always ([cf3f132](https://github.com/kevinand11/equipped/commit/cf3f13204549661846fc440096f974f371269f84))

### [5.0.28](https://github.com/kevinand11/equipped/compare/v5.0.27...v5.0.28) (2025-08-18)

### Bug Fixes

- error when processing event ([12e867f](https://github.com/kevinand11/equipped/commit/12e867fbaf0bf5240d12227ffd394777f2996663))

### [5.0.27](https://github.com/kevinand11/equipped/compare/v5.0.26...v5.0.27) (2025-08-13)

### Bug Fixes

- compile request and response pipes before server starts ([79fbe2d](https://github.com/kevinand11/equipped/commit/79fbe2d8c6f0a1eb2bb07d4ce5447be02d8f90fc))
- recursive fn not defined when validating queryParams ([d7b4650](https://github.com/kevinand11/equipped/commit/d7b4650b7604f0097bf8d481febc6646aec697fc))

### [5.0.26](https://github.com/kevinand11/equipped/compare/v5.0.25...v5.0.26) (2025-08-11)

### Bug Fixes

- recursive fn not defined when validating queryParams ([c0c3f31](https://github.com/kevinand11/equipped/commit/c0c3f31b421414bf8d2e44999b0dee2e5fb97fba))

### [5.0.25](https://github.com/kevinand11/equipped/compare/v5.0.24...v5.0.25) (2025-08-09)

### Features

- instance ids ([376c91d](https://github.com/kevinand11/equipped/commit/376c91d4dadd9ac4324fac6e06404ce04a735afc))

### [5.0.24](https://github.com/kevinand11/equipped/compare/v5.0.23...v5.0.24) (2025-08-09)

### Bug Fixes

- query params pipe ([24abff2](https://github.com/kevinand11/equipped/commit/24abff243603f1dd66cd3b8d7c7e7849c55dfbfc))

### [5.0.23](https://github.com/kevinand11/equipped/compare/v5.0.22...v5.0.23) (2025-07-19)

### Bug Fixes

- undefined imports ([754d6e1](https://github.com/kevinand11/equipped/commit/754d6e1584bc81d2bfaabdfc60e3970f256a4261))

### [5.0.22](https://github.com/kevinand11/equipped/compare/v5.0.21...v5.0.22) (2025-07-19)

### Bug Fixes

- return type of createServer ([6622adc](https://github.com/kevinand11/equipped/commit/6622adc01e9391e22d98c6af6528f82933c384f2))

### [5.0.21](https://github.com/kevinand11/equipped/compare/v5.0.20...v5.0.21) (2025-07-13)

### Features

- events streams ([1cd6df1](https://github.com/kevinand11/equipped/commit/1cd6df19e6504d5ed1834401c230cf40fea9d9c5))
- events streams ([b0d9c5b](https://github.com/kevinand11/equipped/commit/b0d9c5bfddf692c64d8eb5e9c10dfd277cdce73d))

### [5.0.20](https://github.com/kevinand11/equipped/compare/v5.0.19...v5.0.20) (2025-07-13)

### Bug Fixes

- add ConditionalObjectKeys ([7103659](https://github.com/kevinand11/equipped/commit/7103659dd037ad00afb795a7cf08e56635b1031e))

### [5.0.19](https://github.com/kevinand11/equipped/compare/v5.0.18...v5.0.19) (2025-07-13)

### [5.0.18](https://github.com/kevinand11/equipped/compare/v5.0.17...v5.0.18) (2025-07-07)

### [5.0.17](https://github.com/kevinand11/equipped/compare/v5.0.16...v5.0.17) (2025-07-07)

### [5.0.16](https://github.com/kevinand11/equipped/compare/v5.0.15...v5.0.16) (2025-07-06)

### Bug Fixes

- withRequest and withResponse ([80c5a7f](https://github.com/kevinand11/equipped/commit/80c5a7fda7c4e4f221ef8ad427a55b12bfd6087d))

### [5.0.15](https://github.com/kevinand11/equipped/compare/v5.0.14...v5.0.15) (2025-07-06)

### Bug Fixes

- docs is hosted at ./index.html instead of ./ ([98e999c](https://github.com/kevinand11/equipped/commit/98e999c004b03697f87a908f04979a7c0e647e9f))
- updatedAt for upsert ([b956e7a](https://github.com/kevinand11/equipped/commit/b956e7ae6d37ded65e260376dc2527902a6b0373))

### [5.0.14](https://github.com/kevinand11/equipped/compare/v5.0.13...v5.0.14) (2025-07-06)

### Features

- make ttl in cache optional ([4e38b24](https://github.com/kevinand11/equipped/commit/4e38b241b7ecb36821e0c6418f8efc9e38db1fef))

### [5.0.13](https://github.com/kevinand11/equipped/compare/v5.0.12...v5.0.13) (2025-07-05)

### [5.0.12](https://github.com/kevinand11/equipped/compare/v5.0.11...v5.0.12) (2025-07-05)

### Features

- upgrade valleyed ([f5afa37](https://github.com/kevinand11/equipped/commit/f5afa373894fb16a405e1f82e191a2a294bb4497))

### [5.0.11](https://github.com/kevinand11/equipped/compare/v5.0.10...v5.0.11) (2025-06-28)

### Features

- add inmemory cache, make cache optional on instance and pass cache impl to CacheTokenImpl ([4338693](https://github.com/kevinand11/equipped/commit/43386931a1da6b1680d48e76a522d5398236c946))

### [5.0.10](https://github.com/kevinand11/equipped/compare/v5.0.9...v5.0.10) (2025-06-27)

### Features

- do not bundle ([7800947](https://github.com/kevinand11/equipped/commit/7800947e373315cfaaa6e56dd3d502524152157f))

### [5.0.9](https://github.com/kevinand11/equipped/compare/v5.0.8...v5.0.9) (2025-06-27)

### Bug Fixes

- sockets not importable in esm ([d28dc81](https://github.com/kevinand11/equipped/commit/d28dc811d48582bc194367c7ef8e6fdaae754168))

### [5.0.8](https://github.com/kevinand11/equipped/compare/v5.0.7...v5.0.8) (2025-06-27)

### [5.0.7](https://github.com/kevinand11/equipped/compare/v5.0.6...v5.0.7) (2025-06-27)

### [5.0.6](https://github.com/kevinand11/equipped/compare/v5.0.5...v5.0.6) (2025-06-27)

### Features

- support esm and cjs on build ([7f6d1cf](https://github.com/kevinand11/equipped/commit/7f6d1cf3d6adca5da5a0837d325191c5d1a112c5))

### [5.0.5](https://github.com/kevinand11/equipped/compare/v5.0.4...v5.0.5) (2025-06-26)

### Bug Fixes

- fix db typing ([ed307ad](https://github.com/kevinand11/equipped/commit/ed307ad244e4493e0817ea4233d8de8394c6cff1))

### [5.0.4](https://github.com/kevinand11/equipped/compare/v5.0.3...v5.0.4) (2025-06-25)

### Bug Fixes

- always read config from original object instead of destructuring ([777677b](https://github.com/kevinand11/equipped/commit/777677bcbd5bba4a0b788bf28a8590b85d02be0a))

### [5.0.3](https://github.com/kevinand11/equipped/compare/v5.0.2...v5.0.3) (2025-06-25)

### Features

- dbs add config on table ([3a0b248](https://github.com/kevinand11/equipped/commit/3a0b2485f98fd8c30268bf231b81f2a9ec513a95))

### [5.0.2](https://github.com/kevinand11/equipped/compare/v5.0.1...v5.0.2) (2025-06-24)

### Features

- valleyed 4.5.6 ([e61c65f](https://github.com/kevinand11/equipped/commit/e61c65f9c21d121e114f142bbe37f6f99ff39c2d))

### [5.0.1](https://github.com/kevinand11/equipped/compare/v5.0.0...v5.0.1) (2025-06-24)

## [5.0.0](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.40...v5.0.0) (2025-06-24)

### ⚠ BREAKING CHANGES

- **events:** change Events subscribe and publish api

### Features

- add Instance crash ([a385d4d](https://github.com/kevinand11/equipped/commit/a385d4df17bb2874b480caee98b8c6f8e6085ab2))
- can specify multiple dbs ([8f7f649](https://github.com/kevinand11/equipped/commit/8f7f649e1f4204ba256f7364c6b71a5825c7bf50))
- compile $refId schemas into openapi component schemas ([a43ecae](https://github.com/kevinand11/equipped/commit/a43ecae2be5ff097f86967eff4503484889038f5))
- complete route def for openapi ([eb7a064](https://github.com/kevinand11/equipped/commit/eb7a064d16217247164b6c6164477636ba59feaf))
- consume fromJson pipe ([cc33995](https://github.com/kevinand11/equipped/commit/cc33995e426cf0837bdcc1ebd2a92de0604363e3))
- context in schema ([30abe71](https://github.com/kevinand11/equipped/commit/30abe71ae4ee7c4796f8d8ad57cc3537953f1913))
- define common schemas used in code ([1b8f7bf](https://github.com/kevinand11/equipped/commit/1b8f7bf01cb3d2849172abd28bfc13aed9e9e731))
- **events:** change Events subscribe and publish api ([537d3a3](https://github.com/kevinand11/equipped/commit/537d3a3c9dc0d15a948ecef39be4ad95a8dea981))
- forward errors cause properly ([702272c](https://github.com/kevinand11/equipped/commit/702272c4186995b928c403d568788c536865bfa5))
- incoming file schema ([53f8780](https://github.com/kevinand11/equipped/commit/53f87807f596dfe3461c3c86c25ce82ea323c1b2))
- initialize Instance with envs ([6c27d4f](https://github.com/kevinand11/equipped/commit/6c27d4fddf1ba9106318a23db5d7ff931ff6ba6b))
- make db changes options optional ([60e1488](https://github.com/kevinand11/equipped/commit/60e14889c6239aac544e1d1396044743d160a632))
- make eventBus optional ([d623654](https://github.com/kevinand11/equipped/commit/d623654cd3ad27c11770fa3e1f9e8f0f8d913653))
- make jobs optional ([24d2f43](https://github.com/kevinand11/equipped/commit/24d2f437df92a66608b3d123e266e3a35be0f6ec))
- make server optional ([c640e35](https://github.com/kevinand11/equipped/commit/c640e35427b35c3b7c40da50ed649abf0df76371))
- merge Router and Route RouteDef ([b3dbfd5](https://github.com/kevinand11/equipped/commit/b3dbfd530fe8e511cd0ea5dc04b89f1a07ed2b53))
- migrate to pipe api for valleyed ([def6215](https://github.com/kevinand11/equipped/commit/def6215392ad507a56673ba28500db49ad0209e8))
- move validations to its own export ([ae7669f](https://github.com/kevinand11/equipped/commit/ae7669f570769ec7f00e493204ef457b3800c4aa))
- pass request and response in root pipe ([17e6ce1](https://github.com/kevinand11/equipped/commit/17e6ce142677dd0b08f0505f27ecafbaff1adb4c))
- refactor router to expect schema by pipes ([36aec73](https://github.com/kevinand11/equipped/commit/36aec73ab5ba4a5eb5fa4cd93a386ec2ed56e48e))
- restructure exports ([0b5c6fc](https://github.com/kevinand11/equipped/commit/0b5c6fcafdd30d1f00ad30cfc1b2a490ef5ed2bd))
- routes inherit config from routers ([440f0d1](https://github.com/kevinand11/equipped/commit/440f0d1d38b8e5581289f90aa31e2adf307d32ba))
- support for hooks on Instance ([c2eae60](https://github.com/kevinand11/equipped/commit/c2eae600f2efecb2d364fecd053a3a9cb529ae24))
- support specifying content type ([d57f3e6](https://github.com/kevinand11/equipped/commit/d57f3e63976a49c56ea6818083f17898b13167b6))
- use pipe to validate settings ([90ab69f](https://github.com/kevinand11/equipped/commit/90ab69f013261a8b8639d13ebb209f486c1e393b))
- validate if requests.schemaValidation ([efcd5ad](https://github.com/kevinand11/equipped/commit/efcd5ad013c28a83e1408529b10bcb2d9b05914f))
- validating reqs and res ([cc5e1fc](https://github.com/kevinand11/equipped/commit/cc5e1fc2f5725c07d5a933ea3a031938fdc0362b))
- withRequest and withResponse context ([91ea4a6](https://github.com/kevinand11/equipped/commit/91ea4a6d9769be3e90db960cce08f66964fbcb38))

### Bug Fixes

- change order of starting connections ([b1d33f0](https://github.com/kevinand11/equipped/commit/b1d33f02ce3a3735cf3e442d4d5cb8e7c3016f32))
- connect to redis before other services ([94a8d20](https://github.com/kevinand11/equipped/commit/94a8d20e6fae4aa15dd2fd51ee45dfa3131e5f3e))
- middlewares expect generic requests ([9535897](https://github.com/kevinand11/equipped/commit/9535897a7b0e53fbe83af5242f3725f6a5a06741))
- migrate to v.merge ([a9fdcc9](https://github.com/kevinand11/equipped/commit/a9fdcc94cf919a723b251a13d0beb27ae92978e3))
- parse json in request body and query ([b67e696](https://github.com/kevinand11/equipped/commit/b67e696c2e68811c96df85b4d1cfd255a2a8b99e))
- pipes ([9085cae](https://github.com/kevinand11/equipped/commit/9085cae1d7b98a28115a7ff3ff61d66ee5f197ed))
- remove need for DataClass __update ([fb8ea3c](https://github.com/kevinand11/equipped/commit/fb8ea3ca2f80e4649a993d81d20b90e774a1f6d9))
- remove v.objectTrim for v.merge ([c0d2e0e](https://github.com/kevinand11/equipped/commit/c0d2e0ee809524eb2caee7c0c51f0663ea306129))
- request body must be object ([7fce39c](https://github.com/kevinand11/equipped/commit/7fce39c7ad5db79330a69f9146a45324e941e339))
- typings for route request and response ([a69125b](https://github.com/kevinand11/equipped/commit/a69125bcd5f7650009f36d84b3196217b2746ecd))
- valleyed safeParse -> validate ([7a78ff6](https://github.com/kevinand11/equipped/commit/7a78ff626e971770aebeff77cf29098fa54ede35))
- wrap instanceSettingsPipe in function to prevent imported undefined ([c4d9911](https://github.com/kevinand11/equipped/commit/c4d9911de1720c05cd2e4547f01d582b61ea53fc))

## [5.0.0-rc.40](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.39...v5.0.0-rc.40) (2025-06-04)

### Features

- prettify types ([3764801](https://github.com/kevinand11/equipped/commit/37648011ed3b49b7db857480cc536ee21ddcf0e3))

## [5.0.0-rc.39](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.38...v5.0.0-rc.39) (2025-06-03)

### Features

- date schema ([b578c6b](https://github.com/kevinand11/equipped/commit/b578c6ba6f0820cf254c1a252d2e9e5f0941a3ca))
- remove need to wrap entities in EntityJSON ([a788990](https://github.com/kevinand11/equipped/commit/a7889909e96a78485bb98566f4c5e4016ff05391))
- reshape File in ApiDeb to FileSchema ([a46f188](https://github.com/kevinand11/equipped/commit/a46f1889384a4551059703d063a06dd3297dfda4))
- support passing VBase directly as body of ApiDef ([942344f](https://github.com/kevinand11/equipped/commit/942344f3602bc652c8def0fb87ddb05304bee2e9))

## [5.0.0-rc.38](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.37...v5.0.0-rc.38) (2025-06-01)

## [5.0.0-rc.37](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.36...v5.0.0-rc.37) (2025-06-01)

### Features

- new RequestError and EquippedError ([2900ad3](https://github.com/kevinand11/equipped/commit/2900ad3cddc1df07f752e6018e3053c8cb7b8a40))

## [5.0.0-rc.36](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.35...v5.0.0-rc.36) (2025-06-01)

### Bug Fixes

- allow errors to be forwarded to the user ([e09d88c](https://github.com/kevinand11/equipped/commit/e09d88cfa770e3c974c4a5de67c6bddfb3753f57))

## [5.0.0-rc.35](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.34...v5.0.0-rc.35) (2025-06-01)

### Bug Fixes

- return updated doc on updateOne mongo ([5034d67](https://github.com/kevinand11/equipped/commit/5034d6716d9117b3b7187aec1bec8c722410beab))

## [5.0.0-rc.34](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.33...v5.0.0-rc.34) (2025-05-25)

### Bug Fixes

- updateOne and deleteOne logic ([ec62374](https://github.com/kevinand11/equipped/commit/ec62374fb02d439526ea01631c534edef555d1e6))

## [5.0.0-rc.33](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.32...v5.0.0-rc.33) (2025-05-22)

### Bug Fixes

- merge scope when emitting ([d3f18b9](https://github.com/kevinand11/equipped/commit/d3f18b9ac79fd0c7ef30eaefcdb7d0d9a395cfee))

## [5.0.0-rc.32](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.31...v5.0.0-rc.32) (2025-05-22)

## [5.0.0-rc.31](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.30...v5.0.0-rc.31) (2025-05-21)

### Bug Fixes

- cache admin connection for kafka ([f14bfcf](https://github.com/kevinand11/equipped/commit/f14bfcf5796ebb69b4cf44dc79ac0cad19abf33b))

## [5.0.0-rc.30](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.29...v5.0.0-rc.30) (2025-05-21)

### Bug Fixes

- verify access token and scope redis key ([781fe51](https://github.com/kevinand11/equipped/commit/781fe518f4c8e05711e7a7522482384e49afb926))

## [5.0.0-rc.29](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.28...v5.0.0-rc.29) (2025-05-20)

## [5.0.0-rc.28](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.27...v5.0.0-rc.28) (2025-05-19)

## [5.0.0-rc.27](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.26...v5.0.0-rc.27) (2025-05-19)

## [5.0.0-rc.26](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.25...v5.0.0-rc.26) (2025-05-17)

### Bug Fixes

- upgrade valleyed ([ca70ba8](https://github.com/kevinand11/equipped/commit/ca70ba8bb87cae863bb39696a1a6cee30ee10426))

## [5.0.0-rc.25](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.24...v5.0.0-rc.25) (2025-05-17)

### Bug Fixes

- correct return type of validate fn ([90f9b40](https://github.com/kevinand11/equipped/commit/90f9b409db112171839d2fd2b1cc12228c695107))

## [5.0.0-rc.24](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.23...v5.0.0-rc.24) (2025-05-17)

### Features

- upgrade valleyed ([7f1da95](https://github.com/kevinand11/equipped/commit/7f1da952bebfaee840fe9ea7f1d65ae91dd16072))

## [5.0.0-rc.23](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.21...v5.0.0-rc.23) (2025-05-16)

## [5.0.0-rc.21](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.20...v5.0.0-rc.21) (2025-05-15)

### Features

- support api keys for auth ([f94857c](https://github.com/kevinand11/equipped/commit/f94857ce9dd598e3685b467aaee2180eb000eecf))

### Bug Fixes

- cors issue ([f91f952](https://github.com/kevinand11/equipped/commit/f91f952c15eece948bf490a33273b72b80ba0681))
- remove silly api docs path title ([8e5ea1e](https://github.com/kevinand11/equipped/commit/8e5ea1eaca5059731c74caeedbc67cae1e9ee1c7))
- specify default value for cors ([e25e16f](https://github.com/kevinand11/equipped/commit/e25e16f2c24378a44331be7d2c873f8c59bf475b))

## [5.0.0-rc.20](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.19...v5.0.0-rc.20) (2025-05-14)

## [5.0.0-rc.19](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.18...v5.0.0-rc.19) (2025-05-14)

## [5.0.0-rc.18](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.17...v5.0.0-rc.18) (2025-05-14)

## [5.0.0-rc.17](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.16...v5.0.0-rc.17) (2025-05-13)

## [5.0.0-rc.16](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.15...v5.0.0-rc.16) (2025-05-13)

### Features

- scope all external connections interactions under appId ([3dc767a](https://github.com/kevinand11/equipped/commit/3dc767a4c1d944b0bb8b5c2052f014b5e5b8d84f))

### Bug Fixes

- change debezium topic prefix ([3283930](https://github.com/kevinand11/equipped/commit/32839305bde345dd1962b6734fe4c1b02ae48dfe))
- check if debezium connected fine ([f24a2b1](https://github.com/kevinand11/equipped/commit/f24a2b1c7bc4ef89af019da359a5fb6f37993df1))
- upsert collection with proper settings ([e87867e](https://github.com/kevinand11/equipped/commit/e87867e125fee29333fe86e7ee95a33115319216))

## [5.0.0-rc.15](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.14...v5.0.0-rc.15) (2025-05-12)

## [5.0.0-rc.14](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.13...v5.0.0-rc.14) (2025-05-12)

### Bug Fixes

- connect mongodb to debezium ([644366e](https://github.com/kevinand11/equipped/commit/644366ece05d7263c530d433fec3987ab069440c))

## [5.0.0-rc.13](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.12...v5.0.0-rc.13) (2025-05-11)

### Bug Fixes

- connect mongodb to debezium ([21524cb](https://github.com/kevinand11/equipped/commit/21524cbae8b169683010fa47a3859cd33a4aceea))

## [5.0.0-rc.12](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.11...v5.0.0-rc.12) (2025-05-07)

## [5.0.0-rc.11](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.10...v5.0.0-rc.11) (2025-03-31)

### Bug Fixes

- hydrate issue ([dd4adde](https://github.com/kevinand11/equipped/commit/dd4added5cfaa667f775f3601897956b7c776981))
- type Paths defintion ([4a5a3f6](https://github.com/kevinand11/equipped/commit/4a5a3f6823c1bce8c7616b0428137b96d9fdd5ee))

## [5.0.0-rc.10](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.9...v5.0.0-rc.10) (2024-10-13)

### Bug Fixes

- remove stray console log ([3b7e789](https://github.com/kevinand11/equipped/commit/3b7e789252343c216bdb38033c26319ecb8bd885))

## [5.0.0-rc.9](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.8...v5.0.0-rc.9) (2024-10-13)

## [5.0.0-rc.8](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.7...v5.0.0-rc.8) (2024-09-25)

### Features

- allow passing headers and status into pipe ([0449538](https://github.com/kevinand11/equipped/commit/04495383fe264c808cebfa50a393b8bea964b0c0))

## [5.0.0-rc.7](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.6...v5.0.0-rc.7) (2024-09-25)

## [5.0.0-rc.6](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.5...v5.0.0-rc.6) (2024-09-19)

### Bug Fixes

- fix scalar and redoc version ([7b0aa4a](https://github.com/kevinand11/equipped/commit/7b0aa4a7dcb8494afebb35e2a4cdb375dcc9724c))

## [5.0.0-rc.5](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.4...v5.0.0-rc.5) (2024-09-17)

## [5.0.0-rc.4](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.3...v5.0.0-rc.4) (2024-09-17)

### Features

- req.res helper ([ceedbb4](https://github.com/kevinand11/equipped/commit/ceedbb43c33954c123265ca20640684c842f194e))

### Bug Fixes

- typings of Request ([fb3773a](https://github.com/kevinand11/equipped/commit/fb3773a37829fa89f45210c2501da881c058094c))

## [5.0.0-rc.3](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.2...v5.0.0-rc.3) (2024-09-16)

### Features

- flatten route definition to simplify ([466e51f](https://github.com/kevinand11/equipped/commit/466e51fcbbab24f6dc11e6de2aae8330b403a5df))
- json schema base path ([77fb309](https://github.com/kevinand11/equipped/commit/77fb309e635f8ab2ffc1883db14da04ec048a2fa))
- must return Response class if defaultStatusCode or responseHeaders is set ([7d4877e](https://github.com/kevinand11/equipped/commit/7d4877e2e85dac6844cafd0c63fca0048567c33e))

### Bug Fixes

- types back to interface ([fdf7457](https://github.com/kevinand11/equipped/commit/fdf7457d0383112728af4214dd4798f533022962))
- use scalar and redoc latest version ([7a6f937](https://github.com/kevinand11/equipped/commit/7a6f937876474230da47229d94c8f04aa19df9ba))

## [5.0.0-rc.2](https://github.com/kevinand11/equipped/compare/v5.0.0-rc.1...v5.0.0-rc.2) (2024-08-10)

### Features

- getOrSet in cache ([f21f132](https://github.com/kevinand11/equipped/commit/f21f1326221a5169c84de6b26483dc2cf6dd98c4))

## [5.0.0-rc.1](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.17...v5.0.0-rc.1) (2024-07-31)

## [5.0.0-alpha.17](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.16...v5.0.0-alpha.17) (2024-07-12)

### Bug Fixes

- validate schema ([c6977e9](https://github.com/kevinand11/equipped/commit/c6977e96eb159ee25df56dabb8fcae463cdb5f36))

## [5.0.0-alpha.16](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.15...v5.0.0-alpha.16) (2024-07-09)

### Bug Fixes

- to json on BaseEntity ([9196906](https://github.com/kevinand11/equipped/commit/919690689694823ccce6515e41df98fee3012666))

## [5.0.0-alpha.15](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.14...v5.0.0-alpha.15) (2024-07-09)

### Bug Fixes

- excludeIgnored by default ([983caac](https://github.com/kevinand11/equipped/commit/983caac977ccd2c5eeca17c144384bc057286440))

## [5.0.0-alpha.14](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.13...v5.0.0-alpha.14) (2024-07-07)

### Features

- add redocs doc ([f98347e](https://github.com/kevinand11/equipped/commit/f98347e5b815467a9c2a8bff97bdbfa166bc4c7d))
- redirect to scalar doc ([884f271](https://github.com/kevinand11/equipped/commit/884f271910d4bc2b1f2d50a6bbcf76f6889db85e))

## [5.0.0-alpha.13](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.12...v5.0.0-alpha.13) (2024-07-04)

## [5.0.0-alpha.12](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.11...v5.0.0-alpha.12) (2024-07-04)

## [5.0.0-alpha.11](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.10...v5.0.0-alpha.11) (2024-07-03)

## [5.0.0-alpha.10](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.9...v5.0.0-alpha.10) (2024-07-03)

## [5.0.0-alpha.9](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.8...v5.0.0-alpha.9) (2024-06-29)

### Bug Fixes

- ignoreTrailingSlash for fastify ([dc42565](https://github.com/kevinand11/equipped/commit/dc425659c472d1b8c8e3b899036077c4aa520e00))

## [5.0.0-alpha.8](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.7...v5.0.0-alpha.8) (2024-06-27)

### Bug Fixes

- apiDef key for api definition ([29608b9](https://github.com/kevinand11/equipped/commit/29608b98ff9c1e6eab1061fdc03deb95fed4b023))

## [5.0.0-alpha.7](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.6...v5.0.0-alpha.7) (2024-06-27)

### Bug Fixes

- typing of AuthRoles ([8c6ad91](https://github.com/kevinand11/equipped/commit/8c6ad911c8c0b668d53c0c3269414c3b6bdf30aa))

## [5.0.0-alpha.6](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.5...v5.0.0-alpha.6) (2024-06-26)

### Bug Fixes

- openapi.json relative to index html ([31658f9](https://github.com/kevinand11/equipped/commit/31658f924263ff88dfe2ac757e032e9412598665))

## [5.0.0-alpha.5](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.4...v5.0.0-alpha.5) (2024-06-26)

### Features

- route tag descriptions ([644ef9f](https://github.com/kevinand11/equipped/commit/644ef9f5f929b738aabc99f55d3c61af8a85266e))

## [5.0.0-alpha.4](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.3...v5.0.0-alpha.4) (2024-06-18)

## [5.0.0-alpha.3](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.2...v5.0.0-alpha.3) (2024-06-18)

## [5.0.0-alpha.2](https://github.com/kevinand11/equipped/compare/v5.0.0-alpha.1...v5.0.0-alpha.2) (2024-06-16)

### Features

- open api base url ([2a1becf](https://github.com/kevinand11/equipped/commit/2a1becf5f18f2b62ec5b2aada4c14db349e449bc))

## [5.0.0-alpha.1](https://github.com/kevinand11/equipped/compare/v5.0.0-beta.17...v5.0.0-alpha.1) (2024-06-09)

## [5.0.0-beta.17](https://github.com/kevinand11/equipped/compare/v5.0.0-beta.16...v5.0.0-beta.17) (2024-06-03)

### Bug Fixes

- clean path ([b669329](https://github.com/kevinand11/equipped/commit/b669329136c319d827f9c6b5440342ef2b05c8ca))

## [5.0.0-beta.16](https://github.com/kevinand11/equipped/compare/v5.0.0-beta.15...v5.0.0-beta.16) (2024-06-03)

### Features

- support headers in schema ([85a9319](https://github.com/kevinand11/equipped/commit/85a93195ffb9b97927dc22a61d5f118f49598926))

### Bug Fixes

- error when cloning objects in toJSON ([1f4cf25](https://github.com/kevinand11/equipped/commit/1f4cf252a6924f0b2c329c11b41f5ac71c68f87b))

## [5.0.0-beta.15](https://github.com/kevinand11/equipped/compare/v5.0.0-beta.14...v5.0.0-beta.15) (2024-06-02)

### Bug Fixes

- remove slowdown to avoid esm ([414b2ef](https://github.com/kevinand11/equipped/commit/414b2ef3c047a0c9843ae828b21a1aeaa10925b9))

## [5.0.0-beta.14](https://github.com/kevinand11/equipped/compare/v5.0.0-beta.13...v5.0.0-beta.14) (2024-06-02)

### Bug Fixes

- use maps for registered maps for speed ([1882a24](https://github.com/kevinand11/equipped/commit/1882a24d02d666e7779212dbeb67e1022761c823))

## [5.0.0-beta.13](https://github.com/kevinand11/equipped/compare/v5.0.0-beta.12...v5.0.0-beta.13) (2024-06-01)

### Features

- add description for each status code ([064a686](https://github.com/kevinand11/equipped/commit/064a68647ea91a5791aad75b1b95988accc38b32))

## [5.0.0-beta.12](https://github.com/kevinand11/equipped/compare/v5.0.0-beta.11...v5.0.0-beta.12) (2024-06-01)

### Bug Fixes

- function overloading for validate function ([e1209ab](https://github.com/kevinand11/equipped/commit/e1209ab10f435514d7ac84c3c0af1788d7f3699d))
- references to BaseEntity ([071a07a](https://github.com/kevinand11/equipped/commit/071a07a827e6c4f73b5cf43ae462541c4518df21))

## [5.0.0-beta.11](https://github.com/kevinand11/equipped/compare/v5.0.0-beta.10...v5.0.0-beta.11) (2024-06-01)

### Features

- unique paths and keys for routes ([36d1776](https://github.com/kevinand11/equipped/commit/36d17762b6d31497e9f15883cc05073ff29a886e))

## [5.0.0-beta.10](https://github.com/kevinand11/equipped/compare/v5.0.0-beta.9...v5.0.0-beta.10) (2024-05-31)

### Bug Fixes

- generateJSONSchema ([062360b](https://github.com/kevinand11/equipped/commit/062360bb92ccdaa1ae8fa3d167f9bbb71f156f7c))

## [5.0.0-beta.9](https://github.com/kevinand11/equipped/compare/v5.0.0-beta.8...v5.0.0-beta.9) (2024-05-31)

### Bug Fixes

- generateJSONSchema ([39031fd](https://github.com/kevinand11/equipped/commit/39031fd7c8d0f18a93c55b3fc542fd33042e4e44))

## [5.0.0-beta.8](https://github.com/kevinand11/equipped/compare/v5.0.0-beta.7...v5.0.0-beta.8) (2024-05-31)

### Features

- route descriptions ([26b7323](https://github.com/kevinand11/equipped/commit/26b7323b523f83aedacd55096ae01f285fff1398))

## [5.0.0-beta.7](https://github.com/kevinand11/equipped/compare/v5.0.0-beta-6...v5.0.0-beta.7) (2024-05-31)

### Features

- schema for files ([13e8b80](https://github.com/kevinand11/equipped/commit/13e8b80d7893392994331416f769f4c50bc9b975))

### Bug Fixes

- start server on 0.0.0.0 ([b654ee8](https://github.com/kevinand11/equipped/commit/b654ee88d1940fa5c89da8824240a62e727e99b8))

## [5.0.0-beta-6](https://github.com/kevinand11/equipped/compare/v5.0.0-beta-5...v5.0.0-beta-6) (2024-05-30)

### Bug Fixes

- res body defaults to any ([534b3a4](https://github.com/kevinand11/equipped/commit/534b3a4d20e832733a18b5f4735f9132d09669ad))

## [5.0.0-beta-5](https://github.com/kevinand11/equipped/compare/v5.0.0-beta-4...v5.0.0-beta-5) (2024-05-30)

### Bug Fixes

- more graceful defaults for Api ([a2d23f9](https://github.com/kevinand11/equipped/commit/a2d23f9ffcd0d4bcce73c7e3f8346afaea9baf55))

## [5.0.0-beta-4](https://github.com/kevinand11/equipped/compare/v5.0.0-beta-3...v5.0.0-beta-4) (2024-05-30)

## [5.0.0-beta-3](https://github.com/kevinand11/equipped/compare/v5.0.0-beta-2...v5.0.0-beta-3) (2024-05-30)

### Features

- allow custom validator in validate ([24a1d7a](https://github.com/kevinand11/equipped/commit/24a1d7a7cf69eabc73148dd9d36324d32ba95fc3))

## [5.0.0-beta-2](https://github.com/kevinand11/equipped/compare/v5.0.0-beta-1...v5.0.0-beta-2) (2024-05-30)

### Bug Fixes

- validate expects value of unknown not Record ([f3773f9](https://github.com/kevinand11/equipped/commit/f3773f905f6ccb5713fd30a0870d34fbd40c36fc))

## [5.0.0-beta-1](https://github.com/kevinand11/equipped/compare/v4.4.6...v5.0.0-beta-1) (2024-05-29)

### Features

- add request type details on Request class ([d6c3752](https://github.com/kevinand11/equipped/commit/d6c37529e7eeac5a3c2ac20e0a205de49cb0465e))
- error handler per route ([0eccc21](https://github.com/kevinand11/equipped/commit/0eccc2129c559353efc65ae7ddf6bd0368e4031e))
- express server swagger ([95c811b](https://github.com/kevinand11/equipped/commit/95c811ba7a1086116c4327c37e1723b08b85059d))
- fastify swagger and custom schema validation error ([17b8710](https://github.com/kevinand11/equipped/commit/17b8710324c5c515daa8928d7028ef0150a6c30d))
- hide routes from schema ([304df23](https://github.com/kevinand11/equipped/commit/304df23a413f13cbd77f2eeeae00032d57dcea2c))
- new JsonValue and Ignored types ([ba73af4](https://github.com/kevinand11/equipped/commit/ba73af440f54549d10a974fd530c35ac912ec4dd))
- regustere schemas in server and reference by key ([7298bb0](https://github.com/kevinand11/equipped/commit/7298bb0ae6a908325bbef3cd308e2a7787147387))
- route securities ([a7b91a1](https://github.com/kevinand11/equipped/commit/a7b91a17acf15cc9013fe971b0adf2b96cd129da))
- schema for fastify ([990529c](https://github.com/kevinand11/equipped/commit/990529ce777d5fcfb6f4c11d634ecdc31aa2ea81))
- script to generate schemas ([2736ffa](https://github.com/kevinand11/equipped/commit/2736ffa68da13fb0b3ef96809a06be74754257ba))
- settings to toggle whether to schema validate ([6f64313](https://github.com/kevinand11/equipped/commit/6f643133632963cc5418259d3f97a9cf172bcdaf))
- throw ValidationError for failed schema validation in express app ([be30a5e](https://github.com/kevinand11/equipped/commit/be30a5e1ff7fe7016bf6effa9566a3a48acafd0e))

### Bug Fixes

- catch errors in json schema ([02f4b0b](https://github.com/kevinand11/equipped/commit/02f4b0bb4c8eaa3fc0e1a25b14e2f531101d3d08))
- fix mongo createCollection command ([f0bfbfa](https://github.com/kevinand11/equipped/commit/f0bfbfa945d48741fbc56b6766483f12b35e0f7c))
- remove recursive type for QueryWhereBlock to prevent recursive errors in schema gen ([31e3af6](https://github.com/kevinand11/equipped/commit/31e3af64e6ead4b67e5a787df3c0b39671f8e39b))

### [4.4.6](https://github.com/kevinand11/equipped/compare/v4.4.5...v4.4.6) (2024-04-07)

### [4.4.5](https://github.com/kevinand11/equipped/compare/v4.4.4...v4.4.5) (2024-04-06)

### [4.4.4](https://github.com/kevinand11/equipped/compare/v4.4.3...v4.4.4) (2024-03-23)

### Bug Fixes

- debezium connector mongodb string ([125b199](https://github.com/kevinand11/equipped/commit/125b1992ac0caa9c9d40ae5de26706e8c5d01f43))

### [4.4.3](https://github.com/kevinand11/equipped/compare/v4.4.2...v4.4.3) (2024-03-01)

### Bug Fixes

- typing of QueryParams sort ([9c7e4a3](https://github.com/kevinand11/equipped/commit/9c7e4a37f3dbcfe06981419ade4e7678c128e2a4))

### [4.4.2](https://github.com/kevinand11/equipped/compare/v4.4.1...v4.4.2) (2024-03-01)

### Bug Fixes

- emit toJSONed base entity ([501c0c7](https://github.com/kevinand11/equipped/commit/501c0c76a8459c6bdbb78d510e6a16725b54c0bc))
- error message on start connections ([37aba2e](https://github.com/kevinand11/equipped/commit/37aba2e74d05e8afbab05f617667fc934f7a2b3c))

### [4.4.1](https://github.com/kevinand11/equipped/compare/v4.4.0...v4.4.1) (2024-02-24)

### Bug Fixes

- error handler routes ([421ca8a](https://github.com/kevinand11/equipped/commit/421ca8a6fa94af55570d1c0d549ae2238de07db2))

## [4.4.0](https://github.com/kevinand11/equipped/compare/v4.3.2...v4.4.0) (2024-02-23)

### [4.3.2](https://github.com/kevinand11/equipped/compare/v4.3.1...v4.3.2) (2024-02-21)

### [4.3.1](https://github.com/kevinand11/equipped/compare/v4.3.0...v4.3.1) (2024-02-17)

## [4.3.0](https://github.com/kevinand11/equipped/compare/v4.2.10...v4.3.0) (2024-02-12)

### Bug Fixes

- query types and add query in sockets ([881c397](https://github.com/kevinand11/equipped/commit/881c3972a209fd3d5832255b3628da99e4c0726a))

### [4.2.10](https://github.com/kevinand11/equipped/compare/v4.2.9...v4.2.10) (2024-02-09)

### [4.2.9](https://github.com/kevinand11/equipped/compare/v4.2.8...v4.2.9) (2024-02-09)

### [4.2.8](https://github.com/kevinand11/equipped/compare/v4.2.7...v4.2.8) (2023-12-19)

### [4.2.7](https://github.com/kevinand11/equipped/compare/v4.2.6...v4.2.7) (2023-12-12)

### Bug Fixes

- params.map ([fdc2ffc](https://github.com/kevinand11/equipped/commit/fdc2ffcfac6bfbda63fdd11c1585a98f85533e0c))

### [4.2.6](https://github.com/kevinand11/equipped/compare/v4.2.5...v4.2.6) (2023-11-27)

### Bug Fixes

- base entities need to include getters in toJSON ([1a3848d](https://github.com/kevinand11/equipped/commit/1a3848d6c7b64b255183f9ee12d19a080231c645))

### [4.2.5](https://github.com/kevinand11/equipped/compare/v4.2.4...v4.2.5) (2023-11-21)

### [4.2.4](https://github.com/kevinand11/equipped/compare/v4.2.3...v4.2.4) (2023-11-12)

### Bug Fixes

- pass hex string for id ([07b31bb](https://github.com/kevinand11/equipped/commit/07b31bbb78d845b97bbd18570b89f4fc08470444))

### [4.2.3](https://github.com/kevinand11/equipped/compare/v4.2.2...v4.2.3) (2023-11-12)

### [4.2.2](https://github.com/kevinand11/equipped/compare/v4.2.1...v4.2.2) (2023-11-07)

### Bug Fixes

- files all converted to buffer ([703bc2b](https://github.com/kevinand11/equipped/commit/703bc2bd7bf22eaddba57bda70733aedc5b58d1d))

### [4.2.1](https://github.com/kevinand11/equipped/compare/v4.2.0...v4.2.1) (2023-09-09)

## [4.2.0](https://github.com/kevinand11/equipped/compare/v4.1.23...v4.2.0) (2023-09-06)

### Features

- add type for base entity ([0f54bc8](https://github.com/kevinand11/equipped/commit/0f54bc8fe424d595f37003c27b668e64440b783f))

### [4.1.23](https://github.com/kevinand11/equipped/compare/v4.1.22...v4.1.23) (2023-08-25)

### Bug Fixes

- don't return db error from querying ([6eb6915](https://github.com/kevinand11/equipped/commit/6eb6915a77ff508d36c0c349d053dd012aed2020))

### [4.1.22](https://github.com/kevinand11/equipped/compare/v4.1.21...v4.1.22) (2023-08-25)

### Bug Fixes

- don't return db error from querying ([49642bd](https://github.com/kevinand11/equipped/commit/49642bdd9791753586bcee017c9bdea46c520907))
- remove space in logger ([12eddb8](https://github.com/kevinand11/equipped/commit/12eddb855f71bfe8ad335889bb5df2047e1cf6c8))

### [4.1.21](https://github.com/kevinand11/equipped/compare/v4.1.20...v4.1.21) (2023-08-16)

### Bug Fixes

- logger time ([14c1bd3](https://github.com/kevinand11/equipped/commit/14c1bd350739b5cba68d8f23183301861d6aa5ee))

### [4.1.20](https://github.com/kevinand11/equipped/compare/v4.1.19...v4.1.20) (2023-08-13)

### [4.1.19](https://github.com/kevinand11/equipped/compare/v4.1.18...v4.1.19) (2023-08-13)

### Bug Fixes

- use json res if null or undefined ([4b80d3e](https://github.com/kevinand11/equipped/commit/4b80d3ed1d68be7b9b65c2c9f2ae5b4238b05980))

### [4.1.18](https://github.com/kevinand11/equipped/compare/v4.1.17...v4.1.18) (2023-08-01)

### Bug Fixes

- make id ([e61c656](https://github.com/kevinand11/equipped/commit/e61c6569ac45d429a1cb9b7ee2c7fd80cc54d436))

### [4.1.17](https://github.com/kevinand11/equipped/compare/v4.1.16...v4.1.17) (2023-05-24)

### Bug Fixes

- only run update if there is an after ([1628b4e](https://github.com/kevinand11/equipped/commit/1628b4e04181714509e029abe5fc5d8f68f7c25b))

### [4.1.16](https://github.com/kevinand11/equipped/compare/v4.1.15...v4.1.16) (2023-05-15)

### Bug Fixes

- helmet allow cross origin ([c513b29](https://github.com/kevinand11/equipped/commit/c513b2995f2be329fee221b21ea7a04bfc6c92c1))

### [4.1.15](https://github.com/kevinand11/equipped/compare/v4.1.14...v4.1.15) (2023-05-05)

### Bug Fixes

- nullish checks when parsing json ([cb9d132](https://github.com/kevinand11/equipped/commit/cb9d132f02a8976ddc4407c300763ccf46b1bc97))

### [4.1.14](https://github.com/kevinand11/equipped/compare/v4.1.13...v4.1.14) (2023-05-03)

### Features

- add ability to pipe through response ([12bd81e](https://github.com/kevinand11/equipped/commit/12bd81e360059313feeb8a8114639750fce7a141))

### [4.1.13](https://github.com/kevinand11/equipped/compare/v4.1.12...v4.1.13) (2023-05-02)

### Features

- allow other content types ([312e66f](https://github.com/kevinand11/equipped/commit/312e66f441c6ca89f5b5c950879dca6a11de5561))

### [4.1.12](https://github.com/kevinand11/equipped/compare/v4.1.11...v4.1.12) (2023-04-10)

### [4.1.11](https://github.com/kevinand11/equipped/compare/v4.1.10...v4.1.11) (2023-04-09)

### Bug Fixes

- do not convert value in JSON.parse if it is not a string ([e7d735f](https://github.com/kevinand11/equipped/commit/e7d735f0bc3f82210102d5a9d667e2574eab3cea))

### [4.1.10](https://github.com/kevinand11/equipped/compare/v4.1.9...v4.1.10) (2023-04-07)

### Features

- add list to ignore when converting baseEntity to json ([624d134](https://github.com/kevinand11/equipped/commit/624d134f87b3acbec686cde1ad0c02d6b34dc73b))

### [4.1.9](https://github.com/kevinand11/equipped/compare/v4.1.8...v4.1.9) (2023-04-04)

### Bug Fixes

- export bull jobs interfaces to allow extending in user code ([a897617](https://github.com/kevinand11/equipped/commit/a897617eb7ee5bc6153568c7c4cbbc45d36e0f76))

### [4.1.8](https://github.com/kevinand11/equipped/compare/v4.0.2-alpha.4...v4.1.8) (2023-03-30)

### Bug Fixes

- update to latest version of valleyed ([7999007](https://github.com/kevinand11/equipped/commit/799900703519fdf8f56a57abd609d2575f14a173))

### [4.1.7](https://github.com/kevinand11/equipped/compare/v4.1.6...v4.1.7) (2023-03-22)

### Bug Fixes

- parse _id if string or ObjectId ([3aab101](https://github.com/kevinand11/equipped/commit/3aab101960a3a1fe88bea887a1b8e638ae2f3577))

### [4.1.6](https://github.com/kevinand11/equipped/compare/v4.1.5...v4.1.6) (2023-03-18)

### Features

- update to latest version of valleyed ([bdcd8e1](https://github.com/kevinand11/equipped/commit/bdcd8e16c3a05dadf7393558cae746c3ab007ddf))

### [4.1.5](https://github.com/kevinand11/equipped/compare/v4.1.4...v4.1.5) (2023-03-17)

### Features

- update to latest version of valleyed that fixes default problems ([77e4225](https://github.com/kevinand11/equipped/commit/77e4225e10600b7ab27a82970132d9ff7ca9062a))

### [4.1.4](https://github.com/kevinand11/equipped/compare/v4.1.3...v4.1.4) (2023-03-14)

### Features

- update to latest version of valleyed ([60c8c95](https://github.com/kevinand11/equipped/commit/60c8c95d0e0164d6f7934a6396da05b0543d7fbe))

### [4.1.3](https://github.com/kevinand11/equipped/compare/v4.1.2...v4.1.3) (2023-03-11)

### [4.1.2](https://github.com/kevinand11/equipped/compare/v4.1.1...v4.1.2) (2023-03-11)

### [4.1.1](https://github.com/kevinand11/equipped/compare/v4.1.0...v4.1.1) (2023-03-10)

## [4.1.0](https://github.com/kevinand11/equipped/compare/v4.0.2-alpha.3...v4.1.0) (2023-03-07)

### Features

- access db name from mongoose ([febdee0](https://github.com/kevinand11/equipped/commit/febdee0264fe0f7d2de02fcd08a380a8c93df68c))
- add fanout option for event subscribers ([4f0c060](https://github.com/kevinand11/equipped/commit/4f0c060aa2d99fd6128499d49e1f163d1e93a721))
- add helmet and supertest ([71ddcad](https://github.com/kevinand11/equipped/commit/71ddcad4e2b191913a890e7480619f1df527fde1))
- add Id to mongo db ([55a8728](https://github.com/kevinand11/equipped/commit/55a872827a427a65a9be25ce464468935a4c5674))
- add kafka eventbus ([22f79d4](https://github.com/kevinand11/equipped/commit/22f79d48e48cc7c5695a43089f6a724f479ed81c))
- automatically start subscribers in Instance.startConnections ([96a07c9](https://github.com/kevinand11/equipped/commit/96a07c923a90b9203920ab490c4554098dfab5e8))
- enable defaults, getters and virtuals on lean docs ([69f9d2b](https://github.com/kevinand11/equipped/commit/69f9d2b5f26072e91d411cc1dd5e676264a6a586))
- enable lean documents for query ([ce04a8a](https://github.com/kevinand11/equipped/commit/ce04a8a326025916a32ce017634328c37c09a7e0))
- enable pre images for all collections ([710457d](https://github.com/kevinand11/equipped/commit/710457d1132cd380a0890b191f98fece4473729f))
- hydrate cs docs with getters and virtuals ([c93809a](https://github.com/kevinand11/equipped/commit/c93809ab8f2f4597fb310c68dc8d95b9f901aedd))
- new changestream api ([923660b](https://github.com/kevinand11/equipped/commit/923660b11c1ab6f799c030b37dc6ce06c3b90ebb))
- server request ip ([371dac1](https://github.com/kevinand11/equipped/commit/371dac18ef729c88da0e8885e1e63e581e8b979b))
- socket emitters fanout ([65a36db](https://github.com/kevinand11/equipped/commit/65a36db9671205a30fe8aabd3b1763714e94f886))

### Bug Fixes

- hydrate _id from changes ([65e6539](https://github.com/kevinand11/equipped/commit/65e6539bfc9644421152af3ad5c0436a2b4ed3dc))
- loop over db connections ([eb3f548](https://github.com/kevinand11/equipped/commit/eb3f548f2e7a2f172cb4ead8ff655df0fc8f3b95))
- remove cache setInTransaction ([4f1b3c0](https://github.com/kevinand11/equipped/commit/4f1b3c0db37621162065c69fc24eab744675da27))
- setup debezium connection to mongo ([3d36283](https://github.com/kevinand11/equipped/commit/3d3628349910d8ba0633578b6578f09e682b8145))

### [4.1.7](https://github.com/kevinand11/equipped/compare/v4.1.6...v4.1.7) (2023-03-22)

### Bug Fixes

- parse _id if string or ObjectId ([3aab101](https://github.com/kevinand11/equipped/commit/3aab101960a3a1fe88bea887a1b8e638ae2f3577))

### [4.1.6](https://github.com/kevinand11/equipped/compare/v4.1.5...v4.1.6) (2023-03-18)

### Features

- update to latest version of valleyed ([bdcd8e1](https://github.com/kevinand11/equipped/commit/bdcd8e16c3a05dadf7393558cae746c3ab007ddf))

### [4.1.5](https://github.com/kevinand11/equipped/compare/v4.1.4...v4.1.5) (2023-03-17)

### Features

- update to latest version of valleyed that fixes default problems ([77e4225](https://github.com/kevinand11/equipped/commit/77e4225e10600b7ab27a82970132d9ff7ca9062a))

### [4.1.4](https://github.com/kevinand11/equipped/compare/v4.1.3...v4.1.4) (2023-03-14)

### Features

- update to latest version of valleyed ([60c8c95](https://github.com/kevinand11/equipped/commit/60c8c95d0e0164d6f7934a6396da05b0543d7fbe))

### [4.1.3](https://github.com/kevinand11/equipped/compare/v4.1.2...v4.1.3) (2023-03-11)

### [4.1.2](https://github.com/kevinand11/equipped/compare/v4.1.1...v4.1.2) (2023-03-11)

### [4.1.1](https://github.com/kevinand11/equipped/compare/v4.1.0...v4.1.1) (2023-03-10)

## [4.1.0](https://github.com/kevinand11/equipped/compare/v4.0.2-alpha.3...v4.1.0) (2023-03-07)

### Features

- access db name from mongoose ([febdee0](https://github.com/kevinand11/equipped/commit/febdee0264fe0f7d2de02fcd08a380a8c93df68c))
- add fanout option for event subscribers ([4f0c060](https://github.com/kevinand11/equipped/commit/4f0c060aa2d99fd6128499d49e1f163d1e93a721))
- add helmet and supertest ([71ddcad](https://github.com/kevinand11/equipped/commit/71ddcad4e2b191913a890e7480619f1df527fde1))
- add Id to mongo db ([55a8728](https://github.com/kevinand11/equipped/commit/55a872827a427a65a9be25ce464468935a4c5674))
- add kafka eventbus ([22f79d4](https://github.com/kevinand11/equipped/commit/22f79d48e48cc7c5695a43089f6a724f479ed81c))
- automatically start subscribers in Instance.startConnections ([96a07c9](https://github.com/kevinand11/equipped/commit/96a07c923a90b9203920ab490c4554098dfab5e8))
- enable defaults, getters and virtuals on lean docs ([69f9d2b](https://github.com/kevinand11/equipped/commit/69f9d2b5f26072e91d411cc1dd5e676264a6a586))
- enable lean documents for query ([ce04a8a](https://github.com/kevinand11/equipped/commit/ce04a8a326025916a32ce017634328c37c09a7e0))
- enable pre images for all collections ([710457d](https://github.com/kevinand11/equipped/commit/710457d1132cd380a0890b191f98fece4473729f))
- hydrate cs docs with getters and virtuals ([c93809a](https://github.com/kevinand11/equipped/commit/c93809ab8f2f4597fb310c68dc8d95b9f901aedd))
- new changestream api ([923660b](https://github.com/kevinand11/equipped/commit/923660b11c1ab6f799c030b37dc6ce06c3b90ebb))
- server request ip ([371dac1](https://github.com/kevinand11/equipped/commit/371dac18ef729c88da0e8885e1e63e581e8b979b))
- socket emitters fanout ([65a36db](https://github.com/kevinand11/equipped/commit/65a36db9671205a30fe8aabd3b1763714e94f886))

### Bug Fixes

- hydrate _id from changes ([65e6539](https://github.com/kevinand11/equipped/commit/65e6539bfc9644421152af3ad5c0436a2b4ed3dc))
- loop over db connections ([eb3f548](https://github.com/kevinand11/equipped/commit/eb3f548f2e7a2f172cb4ead8ff655df0fc8f3b95))
- remove cache setInTransaction ([4f1b3c0](https://github.com/kevinand11/equipped/commit/4f1b3c0db37621162065c69fc24eab744675da27))
- setup debezium connection to mongo ([3d36283](https://github.com/kevinand11/equipped/commit/3d3628349910d8ba0633578b6578f09e682b8145))

### [4.0.2-alpha.3](https://github.com/kevinand11/equipped/compare/v4.0.2-alpha.2...v4.0.2-alpha.3) (2023-02-19)

### [4.0.2-alpha.2](https://github.com/kevinand11/equipped/compare/v4.0.2-alpha.1...v4.0.2-alpha.2) (2023-02-19)

### [4.0.2-alpha.1](https://github.com/kevinand11/equipped/compare/v4.0.2...v4.0.2-alpha.1) (2023-02-19)

### Features

- make db change abstract ([e747c3f](https://github.com/kevinand11/equipped/commit/e747c3f2f74dc178521c3ee4d9a79efc8b160d32))

### [4.0.2](https://github.com/kevinand11/equipped/compare/v4.0.1...v4.0.2) (2023-02-16)

### [4.0.1](https://github.com/kevinand11/equipped/compare/v4.0.0-alpha-10...v4.0.1) (2023-02-16)

## [4.0.0-alpha-10](https://github.com/kevinand11/equipped/compare/v4.0.0-alpha.9...v4.0.0-alpha-10) (2023-02-16)

## [4.0.0-alpha.9](https://github.com/kevinand11/equipped/compare/v4.0.0-alpha.8...v4.0.0-alpha.9) (2023-02-15)

### Bug Fixes

- remove file type from validation ([5511b44](https://github.com/kevinand11/equipped/commit/5511b447a2d80af6cd65af7d222ea1b9126d3bc5))

## [4.0.0-alpha.8](https://github.com/kevinand11/equipped/compare/v4.0.0-alpha.7...v4.0.0-alpha.8) (2023-02-14)

### Features

- add isNotTruncated to file types ([4d013e1](https://github.com/kevinand11/equipped/commit/4d013e142301df7e98bbe96a8bf18d5fc3a10dc6))

## [4.0.0-alpha.7](https://github.com/kevinand11/equipped/compare/v4.0.0-alpha.6...v4.0.0-alpha.7) (2023-02-14)

### Bug Fixes

- update valleyed version ([638ea0a](https://github.com/kevinand11/equipped/commit/638ea0a2c91967ae897f83b8ea9da480dcd1a7bf))

## [4.0.0-alpha.6](https://github.com/kevinand11/equipped/compare/v4.0.0-alpha.5...v4.0.0-alpha.6) (2023-02-14)

## [4.0.0-alpha.5](https://github.com/kevinand11/equipped/compare/v4.0.0-alpha.4...v4.0.0-alpha.5) (2023-02-14)

### Bug Fixes

- controllers undefined ([f5b77aa](https://github.com/kevinand11/equipped/commit/f5b77aa7ca0d93eed57b474c2e9dd729b3faa7aa))

## [4.0.0-alpha.4](https://github.com/kevinand11/equipped/compare/v4.0.0-alpha.3...v4.0.0-alpha.4) (2023-02-14)

## [4.0.0-alpha.3](https://github.com/kevinand11/equipped/compare/v4.0.0-alpha.2...v4.0.0-alpha.3) (2023-02-14)

### Bug Fixes

- rules types ([2d332c8](https://github.com/kevinand11/equipped/commit/2d332c8ce33caf9962c80ba1984f9c04be8148cf))

## [4.0.0-alpha.2](https://github.com/kevinand11/equipped/compare/v4.0.0-alpha.1...v4.0.0-alpha.2) (2023-02-14)

### Bug Fixes

- add test command ([4782e3e](https://github.com/kevinand11/equipped/commit/4782e3ec5be379885724404a3146a7f060086431))

## 4.0.0-alpha.1 (2023-02-14)

### Features

- init repo ([6d1d857](https://github.com/kevinand11/equipped/commit/6d1d857947267830f7b2228864ca3032b7bc0a72))

### Bug Fixes

- change build command ([434b079](https://github.com/kevinand11/equipped/commit/434b0791d81077e2498d23455b10e89ee2f7d299))
- validation ([07c66b6](https://github.com/kevinand11/equipped/commit/07c66b63c39c337f18d152832bc886774e2071b6))
