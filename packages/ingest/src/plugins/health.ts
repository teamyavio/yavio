import { sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

interface HealthResponse {
  status: "ok" | "degraded";
  postgres: "up" | "down";
  clickhouse: "up" | "down";
}

const healthRoute: FastifyPluginAsync = async (app) => {
  app.get("/health", async (_request, reply) => {
    const checks = await Promise.allSettled([app.db.execute(sql`SELECT 1`), app.clickhouse.ping()]);

    const pgUp = checks[0].status === "fulfilled";
    const chUp = checks[1].status === "fulfilled" && checks[1].value.success;

    const response: HealthResponse = {
      status: pgUp && chUp ? "ok" : "degraded",
      postgres: pgUp ? "up" : "down",
      clickhouse: chUp ? "up" : "down",
    };

    return reply.status(200).send(response);
  });
};

export const healthPlugin = fp(healthRoute, { name: "health" });
