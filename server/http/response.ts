import "server-only";
import { ApiError } from "./errors";

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function apiResponse(action: () => Promise<Response>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: { code: error.code, message: error.message } }, error.status);
    }
    // Neither SQL, auth tokens, nor connection strings belong in HTTP responses/logs.
    console.error("Relay server request failed", { type: error instanceof Error ? error.name : "UnknownError" });
    return json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed. Please try again." } }, 500);
  }
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" ||
    (origin && origin !== new URL(request.url).origin)) {
    throw new ApiError(403, "FORBIDDEN", "Cross-origin mutations are not allowed.");
  }
}

export async function readJson(request: Request, maxBytes = 4096): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send an application/json request.");
  }
  // Bound the stream too: Content-Length alone is client controlled.
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_INPUT", "A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_INPUT", "The request body must be valid JSON.");
  }
}
