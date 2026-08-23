# Firestore cutover record — 2026-08-23

The former production `db.json` was retired after the following checks:

- Source SHA-256: `b5c8261fa8e3ec1688c87a5cf9b66202a5c22d219ce4b34c427b91a40b12a835`
- Source size: 283,324 bytes
- Snapshot document: `_migration_snapshots/dbjson_b5c8261fa8e3ec1688c87a5cf9b66202a5c22d219ce4b34c427b91a40b12a835`
- Snapshot encoding: gzip/base64 with verified round-trip checksum
- Snapshot contents: 16 users, 137 sessions, 10 groups, and 10 history records
- Operational comparison: 168 exact documents, three newer Firestore user documents retained, and no safe active document missing
- One settled session and its explicitly deleted group were not resurrected; their settled record remains in history and their original bytes remain in the snapshot

Firestore is the only application datastore. JSON storage remains available only
to tests that explicitly set `BILLSPLIT_DB_PATH` to a temporary fixture.
