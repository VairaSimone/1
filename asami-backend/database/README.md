# Database

The canonical MySQL schema supplied for Asami on 2026-09-15 is stored in this directory as seven ordered Base64 text parts of the gzip-compressed dump. Concatenating the seven parts and decoding them reconstructs the original dump without changing its SQL contents.

## Automatic creation

At startup Node checks `INFORMATION_SCHEMA.SCHEMATA` for the configured `DB_NAME` before opening the normal application pool.

- If the database already exists, the schema is not executed and the existing database is left untouched.
- If the database does not exist, Node reconstructs the canonical dump and executes it once.
- After the database is available, the existing `bootstrapCoreDefinitions()` population bootstrap runs as before.

The initializer adapts only the dump's database identifier (`asami`) to the configured `DB_NAME`. Table definitions, constraints, indexes and checks are not rewritten.

## Reconstruct the dump locally

```bash
cat schema.sql.gz.b64.001 schema.sql.gz.b64.002a schema.sql.gz.b64.002b schema.sql.gz.b64.003a schema.sql.gz.b64.003b schema.sql.gz.b64.004 schema.sql.gz.b64.005 | base64 -d | gunzip > schema.sql
sha256sum schema.sql
```

Expected SHA-256:

`b702e7aea39ed8aa54fb75fa8db0949acbf7fb3370512c2f0e55ed06ae46747b`
