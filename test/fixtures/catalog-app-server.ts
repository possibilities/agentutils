import { createInterface } from "node:readline"

const lines = createInterface({ input: process.stdin })

for await (const line of lines) {
  const message = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> }
  if (message.method === "initialize") {
    respond(message.id, { protocolVersion: "test" })
    continue
  }
  if (message.method === "initialized") continue
  if (message.method !== "model/list") continue

  if (message.id === 1) {
    respond(message.id, {
      data: [
        {
          id: "gpt-primary",
          hidden: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
          ],
        },
        {
          id: "hidden-model",
          hidden: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        },
      ],
      nextCursor: "page-two",
    })
    continue
  }

  if (message.params?.cursor !== "page-two") process.exit(2)
  respond(message.id, {
    data: [
      {
        id: "gpt-fast",
        hidden: false,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      },
    ],
    nextCursor: null,
  })
}

function respond(id: number | undefined, result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`)
}
