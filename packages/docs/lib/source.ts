import { docs, meta } from "@/.source/server";
import { loader } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";
import { openapiPlugin } from "fumadocs-openapi/server";

export const source = loader({
  baseUrl: "/docs",
  source: toFumadocsSource(docs, meta),
  plugins: [openapiPlugin()],
});
