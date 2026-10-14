/**
 * Next.js calls register() once when a server instance starts: `next start`,
 * `next dev` and the standalone server.js in the Docker image.
 *
 * Node-only work lives in lib/startup-check.ts and is imported only for the
 * nodejs runtime, so the edge bundle never contains process.exit.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runStartupChecks } = await import("./lib/startup-check");
    await runStartupChecks();
  }
}
