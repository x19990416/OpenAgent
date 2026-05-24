import { ModelInvocationError } from '@openagent/runtime';

export function normalizePiError(error: unknown) {
  if (error instanceof Error) {
    return new ModelInvocationError(error.message, error);
  }
  return new ModelInvocationError(String(error));
}
