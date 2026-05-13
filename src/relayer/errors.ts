/** Non-2xx OpenZeppelin Relayer HTTP response (excluding rate limit; see {@link OzRelayerRateLimitError}). */
export class OzRelayerHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "OzRelayerHttpError";
  }
}

/** Relayer returned HTTP 429. When `retryAfterMs` is set, it is always in milliseconds (from `Retry-After` / `x-ratelimit-after`, or from OZ JSON `after` expressed in whole seconds). */
export class OzRelayerRateLimitError extends OzRelayerHttpError {
  constructor(
    message: string,
    status: number,
    path: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message, status, path);
    this.name = "OzRelayerRateLimitError";
  }
}
