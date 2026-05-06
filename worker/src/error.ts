export interface ErrorBody {
  error: string;
  errorKey?: string;
  errorParams?: Record<string, unknown>;
}

export const createErrorBody = (
  error: string,
  options?: {
    errorKey?: string;
    errorParams?: Record<string, unknown>;
  },
): ErrorBody => ({
  error,
  ...(options?.errorKey ? { errorKey: options.errorKey } : {}),
  ...(options?.errorParams ? { errorParams: options.errorParams } : {}),
});
