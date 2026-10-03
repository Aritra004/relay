import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeWorkspaceEvents } from "./realtime-http.ts";

test("SSE decoder handles split UTF-8, CRLF boundaries and several events in one chunk", async (t) => {
  const workspaceId = crypto.randomUUID(),
    account = crypto.randomUUID();
  const events = [0, 1].map((serverVersion) => ({
    type: "stream.checkpoint",
    workspaceId,
    serverVersion,
  }));
  const bytes = new TextEncoder().encode(
    `: heartbeat café\r\n\r\n${events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")}`,
  );
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers["x-relay-account-id"], account);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const received = [];
  await consumeWorkspaceEvents(
    workspaceId,
    0,
    account,
    new AbortController().signal,
    (event) => received.push(event),
  );
  assert.deepEqual(received, events);
});

test("SSE rejects events for other workspaces and malformed operation contracts", async (t) => {
  const workspaceId = crypto.randomUUID();
  for (const event of [
    {
      type: "stream.ready",
      workspaceId: crypto.randomUUID(),
      serverVersion: 0,
    },
    { type: "operation.accepted", workspaceId, serverVersion: 1 },
  ]) {
    const mock = t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(`data: ${JSON.stringify(event)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    await assert.rejects(
      consumeWorkspaceEvents(
        workspaceId,
        0,
        crypto.randomUUID(),
        new AbortController().signal,
        () => assert.fail("Invalid event delivered"),
      ),
    );
    mock.mock.restore();
  }
});
