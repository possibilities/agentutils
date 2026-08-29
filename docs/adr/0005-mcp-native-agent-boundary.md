# 0005 — MCP-native agent boundary

The live Surface owns a guarded loopback Streamable HTTP server built with the official MCP TypeScript SDK; the former custom Unix socket and JSON CLI protocol do not survive. Configuration is deliberately inert: an external manager reads one atomic Surface snapshot and chooses how to launch or submit through tools outside agenteditor.
