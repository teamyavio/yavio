import cors from "@fastify/cors";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const corsSetup: FastifyPluginAsync = async (app) => {
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
};

export const corsPlugin = fp(corsSetup, { name: "cors" });
