# 0004 — Opaque SQLite Documents

Documents, bounded Transaction history, per-Document Configuration and view state, and singleton Surface state live atomically in one private SQLite database. MCP exposes only opaque generated IDs and semantic metadata: it has no path input, path output, import operation, or compatibility path for the retired file-backed CLI.
