import { createServer } from "node:net";

/**
 * Reserve an ephemeral port by binding a throwaway listener on `0`,
 * recording the kernel-assigned port, and closing immediately. The
 * port may race with another listener between `close()` and the
 * spawned child's `listen()`, but in practice this window is small and
 * matches the pattern used by `e2e/cli/src/arkor-whoami.test.ts`.
 *
 * Hardcoding port 4000 (the `arkor dev` default) would collide with
 * parallel test workers, other dev sessions, or sibling matrix entries
 * on the same CI runner.
 */
export function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    // Close on error too — leaving the server open here would keep
    // the underlying TCP handle alive and (without `unref` honoured
    // for half-open sockets) could pin the event loop until the
    // process exits. Idempotent close is safe whether the error
    // happened before or after `listen()` returned.
    srv.on("error", (err) => {
      srv.close();
      reject(err);
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Could not allocate ephemeral port"));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
