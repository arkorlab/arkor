/**
 * Shared `Response` builders for studio-app tests. Mirrors the local
 * helpers in `lib/api.test.ts` so component tests can mock `fetch` with
 * the same shape the SPA's own helpers consume.
 */

export function jsonResponse(
  data: unknown,
  init?: { status?: number; statusText?: string },
): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: { "content-type": "application/json" },
  });
}

export function textStreamResponse(
  chunks: string[],
  init?: { contentType?: string },
): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": init?.contentType ?? "text/plain" },
    },
  );
}

export function sseResponse(frames: string[]): Response {
  return textStreamResponse(frames, { contentType: "text/event-stream" });
}

/**
 * Build a single OpenAI-style SSE frame
 * (`data: {choices:[{delta:{content}}]}\n\n`) matching the envelope
 * `streamInferenceContent` parses.
 */
export function sseDeltaFrame(content: string, event = "token"): string {
  const data = JSON.stringify({ choices: [{ delta: { content } }] });
  return `event: ${event}\ndata: ${data}\n\n`;
}
