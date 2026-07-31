/**
 * RFC 6749 §5.2 error responses. Thrown by OAuth lib functions and converted
 * to JSON at the route boundary.
 */
export class OAuthError extends Error {
  constructor(
    public readonly error: string,
    public readonly description: string,
    public readonly status: number = 400,
  ) {
    super(`${error}: ${description}`);
    this.name = "OAuthError";
  }

  toResponse(): Response {
    return Response.json(
      { error: this.error, error_description: this.description },
      {
        status: this.status,
        headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
      },
    );
  }
}
