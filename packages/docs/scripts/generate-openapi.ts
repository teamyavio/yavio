import { generateFiles } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

const openapi = createOpenAPI({
  input: ["./openapi/ingest.yaml"],
});

await generateFiles({
  input: openapi,
  output: "./content/docs/06-api-reference",
  per: "operation",
  groupBy: "tag",
});
