import { appendLlmResponseLog } from '../runtime-info-logger.js';
import { recordModelUsageFromResponse } from '../model-usage-store.js';

export interface PiHttpLoggerInput {
  runId?: string;
  threadId?: string;
  providerId?: string;
  model?: string;
}

export function installPiHttpLogger(input: PiHttpLoggerInput) {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== 'function') {
    return () => undefined;
  }

  let requestIndex = 0;
  const loggingFetch = (async (...args: Parameters<typeof fetch>) => {
    const requestId = `${input.runId ?? 'run'}-${Date.now()}-${++requestIndex}`;
    const startedAt = new Date().toISOString();
    const requestSnapshot = await buildFetchRequestSnapshot(args);

    appendLlmResponseLog({
      scope: 'llm-http',
      message: 'Provider HTTP request',
      data: {
        ...input,
        requestId,
        startedAt,
        ...requestSnapshot
      }
    });

    try {
      const response = await originalFetch(...args);
      logFetchResponse(input, requestId, startedAt, response);
      return response;
    } catch (error) {
      appendLlmResponseLog({
        scope: 'llm-http',
        message: 'Provider HTTP request failed',
        data: {
          ...input,
          requestId,
          startedAt,
          completedAt: new Date().toISOString(),
          error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
        }
      });
      throw error;
    }
  }) as typeof fetch;
  globalThis.fetch = loggingFetch;

  return () => {
    if (globalThis.fetch === loggingFetch) {
      globalThis.fetch = originalFetch;
    }
  };
}

async function buildFetchRequestSnapshot(args: Parameters<typeof fetch>) {
  const [resource, init] = args;
  const request = resource instanceof Request ? resource : null;
  const url = request?.url ?? String(resource);
  const method = init?.method ?? request?.method ?? 'GET';
  const headers = mergeHeaders(request?.headers, init?.headers);
  const body = await readRequestBody(resource, init);

  return {
    url,
    method,
    headers: redactHeaders(headers),
    body,
    bodyLength: typeof body === 'string' ? body.length : undefined
  };
}

function logFetchResponse(input: PiHttpLoggerInput, requestId: string, startedAt: string, response: Response) {
  const completedAt = () => new Date().toISOString();
  const responseHeaders = redactHeaders(headersToObject(response.headers));
  const cloned = response.clone();

  void cloned.text().then(
    (body) => {
      const completedAtIso = completedAt();
      appendLlmResponseLog({
        scope: 'llm-http',
        message: 'Provider HTTP response',
        data: {
          ...input,
          requestId,
          startedAt,
          completedAt: completedAtIso,
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          headers: responseHeaders,
          body,
          bodyLength: body.length
        }
      });
      const usageRecord = recordModelUsageFromResponse({
        source: 'pi-provider-http',
        responseBody: body,
        providerId: input.providerId,
        model: input.model,
        runId: input.runId,
        threadId: input.threadId,
        requestId,
        status: response.status
      });
      if (usageRecord) {
        appendLlmResponseLog({
          scope: 'llm-http',
          message: 'Provider HTTP token usage recorded',
          data: {
            ...input,
            requestId,
            createdAt: usageRecord.createdAt,
            providerId: usageRecord.providerId,
            model: usageRecord.model,
            inputTokens: usageRecord.inputTokens,
            outputTokens: usageRecord.outputTokens,
            totalTokens: usageRecord.totalTokens
          }
        });
      }
    },
    (error) => {
      appendLlmResponseLog({
        scope: 'llm-http',
        message: 'Provider HTTP response body read failed',
        data: {
          ...input,
          requestId,
          startedAt,
          completedAt: completedAt(),
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          headers: responseHeaders,
          error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
        }
      });
    }
  );
}

async function readRequestBody(resource: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) {
  if (typeof init?.body === 'string') return init.body;
  if (init?.body instanceof URLSearchParams) return init.body.toString();
  if (init?.body instanceof FormData) return '[FormData body omitted]';
  if (init?.body instanceof Blob) return await init.body.text();
  if (init?.body) return `[${Object.prototype.toString.call(init.body)} body omitted]`;

  if (resource instanceof Request) {
    try {
      return await resource.clone().text();
    } catch (error) {
      return `<<request body unavailable: ${error instanceof Error ? error.message : String(error)}>>`;
    }
  }

  return undefined;
}

function mergeHeaders(base?: HeadersInit, override?: HeadersInit) {
  return {
    ...headersToObject(base),
    ...headersToObject(override)
  };
}

function headersToObject(headers?: HeadersInit) {
  const result: Record<string, string> = {};
  if (!headers) return result;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) result[key] = value;
    return result;
  }

  return { ...headers };
}

function redactHeaders(headers: Record<string, string>) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = isSensitiveHeader(key) ? redactHeaderValue(value) : value;
  }
  return result;
}

function isSensitiveHeader(key: string) {
  return /authorization|api[-_]?key|x[-_].*key|cookie|token/i.test(key);
}

function redactHeaderValue(value: string) {
  if (!value) return value;
  if (value.length <= 12) return '<redacted>';
  return `${value.slice(0, 8)}…<redacted:${value.length}>`;
}
