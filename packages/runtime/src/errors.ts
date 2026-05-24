export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'RuntimeError';
  }
}

export class PromptValidationError extends RuntimeError {
  constructor(message: string) {
    super(message, 'prompt_validation_error');
    this.name = 'PromptValidationError';
  }
}

export class ModelInvocationError extends RuntimeError {
  constructor(message: string, details?: unknown) {
    super(message, 'model_invocation_error', details);
    this.name = 'ModelInvocationError';
  }
}

export class ToolExecutionError extends RuntimeError {
  constructor(message: string, details?: unknown) {
    super(message, 'tool_execution_error', details);
    this.name = 'ToolExecutionError';
  }
}

export class ApprovalRequiredError extends RuntimeError {
  constructor(message: string, details?: unknown) {
    super(message, 'approval_required', details);
    this.name = 'ApprovalRequiredError';
  }
}

export class CancelledError extends RuntimeError {
  constructor(message = 'Run cancelled') {
    super(message, 'cancelled');
    this.name = 'CancelledError';
  }
}

export class ContextOverflowError extends RuntimeError {
  constructor(message: string) {
    super(message, 'context_overflow');
    this.name = 'ContextOverflowError';
  }
}

export function isCancelledError(error: unknown) {
  return error instanceof CancelledError || (error instanceof Error && error.name === 'AbortError');
}

export function errorToMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
