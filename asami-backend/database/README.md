# Asami database

This directory contains the canonical schema used when a fresh Asami database must be created.

## Canonical schema snapshot

- File: `schema.sql.gz`
- Source: `Dump20260915 (2)(1).sql`
- Original SQL size: 150187 bytes
- Tables: 81
- INSERT statements: 0
- SHA-256 of the uncompressed SQL: `b702e7aea39ed8aa54fb75fa8db0949acbf7fb3370512c2f0e55ed06ae46747b`

The compressed snapshot is only a transport/storage representation. Node verifies the SHA-256 of the uncompressed SQL before executing it.

## Automatic creation

At startup, `src/db/database-init.js` connects to MySQL without selecting `DB_NAME` and acquires a MySQL advisory lock.

- When `DB_NAME` already exists, no schema statement is executed.
- When `DB_NAME` does not exist, Node executes the canonical schema snapshot after adapting only the database identifier from `asami` to the configured `DB_NAME`.
- After the database exists, the existing `bootstrapCoreDefinitions()` runs normally and remains responsible for automatic catalog/runtime population.

The application does not import the data-only dump `Dump20260916 (3).sql` for initialization. That file contains runtime data and would incorrectly bypass the intended bootstrap population flow.
