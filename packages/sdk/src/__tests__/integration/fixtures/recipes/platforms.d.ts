/**
 * Minimal stand-ins for the platform types the README's serverless recipes
 * use (#171), so `tsc` checks the recipes (`./*.ts`, compared with the README
 * by `readme-recipes.test.ts`) without the platforms' packages installed:
 * `@vercel/functions`, `next/server`, `@netlify/functions`,
 * `@cloudflare/workers-types` and the AWS Lambda Node.js runtime's
 * `awslambda` global. Each declares only what the recipes call, with the
 * real signature or a narrower one.
 */

declare module "@vercel/functions" {
  export function waitUntil(promise: Promise<unknown>): void;
}

declare module "next/server" {
  export function after<T>(task: Promise<T> | (() => T | Promise<T>)): void;
}

declare module "@netlify/functions" {
  export interface Context {
    waitUntil(promise: Promise<unknown>): void;
  }
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

declare namespace awslambda {
  type ResponseStream = import("node:stream").Writable;
  function streamifyResponse<E>(
    handler: (event: E, responseStream: ResponseStream, context: unknown) => Promise<void>,
  ): (event: E, context: unknown) => Promise<void>;
  namespace HttpResponseStream {
    function from(
      responseStream: ResponseStream,
      prelude: { statusCode?: number; headers?: Record<string, string> },
    ): ResponseStream;
  }
}
