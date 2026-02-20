import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkHealth, fetchJson } from "../util/http.js";

describe("http utilities", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = createServer((req, res) => {
          if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
          } else if (req.url === "/error") {
            res.writeHead(500);
            res.end("Internal Server Error");
          } else if (req.url === "/slow") {
            setTimeout(() => {
              res.writeHead(200);
              res.end("ok");
            }, 5000);
          } else {
            res.writeHead(404);
            res.end("Not Found");
          }
        });
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  describe("checkHealth", () => {
    it("returns ok:true for healthy endpoint", async () => {
      const result = await checkHealth(`${baseUrl}/health`);
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it("returns ok:false for error endpoint", async () => {
      const result = await checkHealth(`${baseUrl}/error`);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(500);
    });

    it("returns ok:false for unreachable endpoint", async () => {
      const result = await checkHealth("http://127.0.0.1:1", 500);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(0);
    });

    it("returns ok:false on timeout", async () => {
      const result = await checkHealth(`${baseUrl}/slow`, 100);
      expect(result.ok).toBe(false);
    });
  });

  describe("fetchJson", () => {
    it("fetches and parses JSON", async () => {
      const result = await fetchJson<{ status: string }>(`${baseUrl}/health`);
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ status: "ok" });
      expect(result.status).toBe(200);
    });

    it("returns ok:false for error responses", async () => {
      const result = await fetchJson(`${baseUrl}/error`);
      expect(result.ok).toBe(false);
      expect(result.data).toBeNull();
      expect(result.status).toBe(500);
    });

    it("returns ok:false for unreachable endpoint", async () => {
      const result = await fetchJson("http://127.0.0.1:1", { timeout: 500 });
      expect(result.ok).toBe(false);
      expect(result.data).toBeNull();
    });
  });
});
