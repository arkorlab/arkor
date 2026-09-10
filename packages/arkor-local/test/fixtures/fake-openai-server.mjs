/**
 * Stand-in for `mlx_lm server` in inference tests: a loopback HTTP server
 * that answers POST /v1/chat/completions with either OpenAI-style SSE delta
 * frames or a plain JSON completion, depending on the request's `stream`.
 *
 * Argv: --port <n> [--startup-delay-ms <n>] [--never-listen]
 */
import { createServer } from "node:http";

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

const port = Number(argValue("--port"));
const startupDelayMs = Number(argValue("--startup-delay-ms") ?? "0");

if (process.argv.includes("--never-listen")) {
  // Simulates a child that hangs before binding (model download stall).
  setInterval(() => {
    // keep the event loop alive without ever binding the port
  }, 1000);
} else {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (parsed.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "hello from fake" } },
            ],
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const delta of ["hello", " from", " fake"]) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  setTimeout(() => {
    server.listen(port, "127.0.0.1");
  }, startupDelayMs);
}
