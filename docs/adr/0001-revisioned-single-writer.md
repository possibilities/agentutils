# 0001 — Revisioned singleton writer

The Surface serializes human and MCP Transactions and commits assistant mutations to SQLite before reporting success. Every mutation requires a content-derived Revision; disjoint live changes may rebase, but stale, overlapping, and Active-region changes are refused instead of overwriting work.
