# Database

`schema.sql.gz` is the canonical compressed copy of the MySQL dump supplied for Asami on 2026-09-15. The dump is stored byte-for-byte after decompression and is used by the Node.js startup initializer.

## Automatic creation

On startup, Asami first checks `INFORMATION_SCHEMA.SCHEMATA` using the configured `DB_NAME`.

- If the database already exists, the initializer does not execute the schema dump and does not alter the existing database.
- If the database does not exist, Node executes the canonical schema dump, then the normal startup continues.
- After the database is available, the existing `bootstrapCoreDefinitions()` population bootstrap still runs exactly as before.

The initializer adapts only the dump's database identifier (`asami`) to `DB_NAME`; table definitions and constraints are not edited.

## Snapshot integrity

SHA-256 of the original uploaded SQL dump:

`b702e7aea39ed8aa54fb75fa8db0949acbf7fb3370512c2f0e55ed06ae46747b`

To inspect the snapshot locally:

```bash
gunzip -c schema.sql.gz > schema.sql
sha256sum schema.sql
```
