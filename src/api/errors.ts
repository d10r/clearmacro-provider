export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function toErrorBody(error: ApiError, requestId?: string) {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId: requestId ?? null,
      details: error.details ?? {},
    },
  };
}

