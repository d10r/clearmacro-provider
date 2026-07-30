type SafeHttpError = Error & { statusCode?: number };

export class SafeApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
    readonly code: string,
  ) {
    super(message);
    this.name = "SafeApiError";
  }
}

export class SafeMessageUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeMessageUnsupportedError";
  }
}

export function classifySafeApiError(error: unknown): SafeApiError {
  if (error instanceof SafeApiError) {
    return error;
  }
  if (error instanceof SafeMessageUnsupportedError) {
    throw error;
  }
  const status =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof (error as SafeHttpError).statusCode === "number"
      ? (error as SafeHttpError).statusCode!
      : 0;
  const message = error instanceof Error ? error.message : "Safe API request failed";
  if (status === 404) {
    return new SafeApiError("Safe message not found.", 404, true, "SAFE_MESSAGE_NOT_FOUND");
  }
  if (status === 401 || status === 403) {
    return new SafeApiError("Safe API authentication failed.", status, false, "SAFE_API_UNAUTHORIZED");
  }
  if (status === 429) {
    return new SafeApiError("Safe API rate limited.", 429, true, "SAFE_API_RATE_LIMITED");
  }
  if (status >= 500) {
    return new SafeApiError("Safe API unavailable.", status, true, "SAFE_API_UNAVAILABLE");
  }
  if (message.toLowerCase().includes("fetch failed") || message.toLowerCase().includes("timeout")) {
    return new SafeApiError(message, 502, true, "SAFE_API_ERROR");
  }
  return new SafeApiError(message, status || 502, status === 0, "SAFE_API_ERROR");
}
