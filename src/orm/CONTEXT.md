# ORM Migration Mapping

This focused glossary records the agreed direction for the migration-mapping redesign discussed in issue #149, not the currently shipped behavior. The existing ORM reference remains `docs/orm/CONTEXT.md`; its migration naming rules need reconciliation when this change is implemented.

## Language

**Migration target**:
A historical logical schema-name string identifying the subject of a declarative migration change for resolution through the Repo.
_Avoid_: Current Schema reference, pre-resolved table name

**Logical schema name**:
The name string shared by query and migration resolution before adapter-specific physical mapping.
_Avoid_: Physical table name, Schema object

**Physical target**:
The database location represented by the adapter-specific schema config produced by the Repo's resolution pipeline.
_Avoid_: Schema name, logical name

**Migration payload**:
The explicit historical change specification carried by a migration independently of current Schema definitions.
_Avoid_: Current-schema snapshot, inferred historical shape

**Managed target set**:
The explicit set of Schemas supplied to migration codegen for comparison with their resolved physical targets, not a complete inventory of the database namespace.
_Avoid_: Whole-database desired state, namespace inventory

**Migration ledger**:
The adapter-owned record of applied migration IDs within one history store.
_Avoid_: Resolver scope, application table mapping

**Target namespace**:
The database container of a physical migration target, such as a PostgreSQL schema or MongoDB database, as selected by resolved adapter config.
_Avoid_: Migration ledger scope, logical schema name

**Physical target identity**:
The adapter-defined canonical identity of a resolved table or collection, including its namespace where applicable.
_Avoid_: Bare table name, logical schema name

## Relationships

- A declarative migration change carries a **Migration target** as a string, not a reference to a current Schema object.
- The **Migration target** passes through the Repo's mapping to a **Physical target** before adapter dispatch.
- Both the base resolver and scoped config transforms receive a **Logical schema name** string instead of a Schema object; queries supply `schema.name`, while migrations supply their stored historical names.
- Queries and migrations share the base-resolver, scoped-transform, and schema-config validation pipeline rather than maintaining separate mapping functions.
- A **Migration target** determines where a change applies; its **Migration payload** determines what changes, without deriving old migration contents from current Schema definitions.
- Migration codegen resolves each member of its **Managed target set** before comparing physical database state, then emits explicit migration payloads with historical logical-name strings rather than Schema references or pre-resolved table names.
- Codegen leaves tables outside the **Managed target set** untouched; removing a table from that set does not generate a drop-table change, while field removal within a managed target can still generate a drop-field change.
- Removing an entire table requires an explicit migration using its historical **Logical schema name**.
- Resolver-consistent application targets do not partition the **Migration ledger**: pending selection still uses the applied migration IDs in the adapter's history store.
- Every table endpoint of a migration, including both rename endpoints and both foreign-key targets, resolves independently from its logical name under the active execution scope.
- Adapters receive the explicit migration payload together with resolved config for each target; no physical table name is fed back through the resolver.
- Column names and explicit index or constraint names are literal identifiers, not **Logical schema names**; automatically derived object names use the **Physical target**, and a drop-index payload includes its owning logical table.
- Codegen compares only explicitly managed targets through adapter-owned targeted introspection; broad discovery remains a diagnostic operation rather than a declaration of ownership.
- Targeted introspection accepts validated resolved adapter config and returns one `DiscoveredSchema` or `null`; it does not construct a declarative Schema. Each adapter also canonicalizes that config as a physical target identity, including PostgreSQL schema and MongoDB database namespaces. Broad `introspect()` remains available for diagnostic inventory.
- Distinct codegen targets sharing one **Physical target identity** are rejected rather than producing conflicting changes.
- Supported operations honor PostgreSQL schema and MongoDB database **Target namespaces**; namespace provisioning and cross-namespace table renames remain outside this change, with cross-namespace rename attempts rejected.

## Example dialogue

> **Dev:** "The Schema is named users, but the Repo resolves it to app_users. Which table does its migration target?"
> **Domain expert:** "app_users: the migration carries the historical logical name users, which must go through the same mapping as a query."

> **Dev:** "Today's users Schema has an email field. Does that add email when replaying the original id-only create migration?"
> **Domain expert:** "No. The original migration's explicit payload still creates only id; a later migration adds email."

> **Dev:** "I supplied only the users Schema, but introspection also found app_orders and reporting_exports. Should codegen remove them?"
> **Domain expert:** "No. The target list selects tables to manage; it does not declare every other table obsolete."

> **Dev:** "After migration 001 runs for Acme, can I run it for Globex using a different resolver scope but the same migration history store?"
> **Domain expert:** "Not independently: that store already records 001 as applied. Per-scope migration history is separate, deferred work."

> **Dev:** "Does an index named users_email_idx get passed through the users table resolver?"
> **Domain expert:** "No. Its owning logical table is resolved; the explicitly supplied index name remains literal within that target's namespace."

## Flagged ambiguities

- Existing migration documentation alternates between logical and literal database names; migration target strings are logical names that require resolution, not already-physical names.
- Passing Schema objects to migrations was reconsidered and rejected because subsequent edits to application Schema definitions must not change historical migration specifications.
- Schema field definitions are not the source of historical migration contents; field and primary-key specifications remain explicit in each migration payload.
- The current Repo resolver accepts a full Schema object; the accepted redesign replaces that input with a logical-name string for both base resolution and scoped transforms, intentionally breaking Schema-object-based callbacks.
- Historical strings preserve identifiers and payloads, but cannot by themselves freeze the effects of future edits to resolver logic.
- Independent per-tenant migration ledgers and associated locking are explicitly deferred to [issue #150](https://github.com/andthexi/equipped/issues/150), separate from resolver consistency in issue #149.
