export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly category: "user" | "provider" | "chain" | "relayer" | "auth" | "validation" | "unknown",
    public readonly retryable: boolean,
    public readonly executionId: string | null = null,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function toErrorBody(error: ApiError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      category: error.category,
      retryable: error.retryable,
      executionId: error.executionId,
      details: error.details ?? {},
    },
  };
}

