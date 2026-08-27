# 0001 — Revisioned single writer

A Session serializes human and agent Transactions, while unattached CLI commands acquire the same per-Document lock. Every mutation requires a content-derived Revision; disjoint live changes may rebase, but stale or overlapping changes are refused instead of overwriting work.
