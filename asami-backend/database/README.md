# Asami database

The canonical schema snapshot is stored in 19 ordered base64 parts under this directory. The parts are the exact base64 representation of a deterministic gzip of the schema-only SQL dump.

Source schema: `Dump20260915 (2)(1).sql` from the project Library.

Integrity of the original uncompressed SQL:
- size: 150187 bytes
- tables: 81
- INSERT statements: 0
- SHA-256: `b702e7aea39ed8aa54fb75fa8db0949acbf7fb3370512c2f0e55ed06ae46747b`

Integrity of the deterministic gzip representation:
- SHA-256: `8ce8d37aa78c6a1fba38a2fa333ba7553e927366fb545d92a879585dbc351174`

The separate `Dump20260916 (3).sql` is a data-only dump and is intentionally not used for fresh-database initialization, because it contains runtime `INSERT` statements. The existing application bootstrap remains responsible for populating the fresh schema.

## Automatic creation

`src/db/database-init.js` connects to MySQL without selecting `DB_NAME`, acquires a MySQL advisory lock, and checks `INFORMATION_SCHEMA.SCHEMATA`.

When the configured database already exists, no schema SQL is executed. When it does not exist, Node reconstructs the canonical schema snapshot, verifies both hashes, adapts only the database identifier from `asami` to `DB_NAME`, and executes the schema.

After that, the normal startup continues and `bootstrapCoreDefinitions()` runs unchanged, so catalog and runtime population still happen through the existing bootstrap.
