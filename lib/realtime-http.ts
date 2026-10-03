import {
  realtimeEventSchema,
  type RealtimeEvent,
} from "./realtime-contract.ts";

export class RealtimeError extends Error {
  readonly terminal: boolean;
  constructor(message: string, terminal = false) {
    super(message);
    this.terminal = terminal;
  }
}

// Fetch permits the same account precondition as sync HTTP, and explicit abort
// and backoff. Frames are SSE data messages; chunk boundaries are arbitrary.
export async function consumeWorkspaceEvents(
  workspaceId: string,
  afterVersion: number,
  accountId: string,
  signal: AbortSignal,
  receive: (event: RealtimeEvent) => void,
) {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/events?afterVersion=${afterVersion}`,
    {
      headers: { Accept: "text/event-stream", "x-relay-account-id": accountId },
      credentials: "same-origin",
      cache: "no-store",
      signal,
    },
  );
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get("content-type")?.startsWith("text/event-stream")
  )
    throw new RealtimeError(
      "Realtime connection unavailable.",
      [401, 403, 404].includes(response.status),
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // Normalize only complete CRLF pairs, even when split across chunks.
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.length > 128 * 1024)
          throw new RealtimeError("Realtime event is too large.");
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        const event = realtimeEventSchema.parse(JSON.parse(data));
        if (event.workspaceId !== workspaceId)
          throw new RealtimeError("Realtime workspace mismatch.");
        receive(event);
      }
      if (buffer.length > 128 * 1024)
        throw new RealtimeError("Realtime event is too large.");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
