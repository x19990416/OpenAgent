import { buildPiProviderCatalog } from '@openagent/pi-adapter';
import { appendKnowledgeLlmResponseLog } from './knowledge-logger.js';

export interface KnowledgeContextDecision {
  needsKnowledge: boolean;
  reason?: string;
  query?: string;
  limit?: number;
}

export class KnowledgeContextRouter {
  async classify(input: { prompt: string; abortSignal?: AbortSignal }): Promise<KnowledgeContextDecision | null> {
    const schema = '{"needsKnowledge":true,"reason":"string","query":"string","limit":3}';
    const text = await generateText('classify-knowledge-context', [
      'Decide whether OpenAgent should run a KnowledgeService.search before the main answer.',
      'Return strict JSON only. No Markdown. No code fence.',
      'Set needsKnowledge true only when the user request likely needs OpenAgent system knowledge, durable project decisions, stored docs, architecture notes, historical context, or knowledge-base content.',
      'Set needsKnowledge false for ordinary conversation, generic coding help, translation, formatting, simple explanations, or tasks answerable from the current prompt and attached runtime context.',
      'This decision is semantic. Do not rely on keyword matching. If uncertain, prefer false because the main agent can still call knowledge tools later if needed.',
      'When needsKnowledge is true, provide a concise query optimized for knowledge retrieval. Use limit 1-5, default 3.',
      `Schema: ${schema}`,
      '<user_request>',
      input.prompt.slice(0, 4000),
      '</user_request>'
    ].join('\n'), input.abortSignal);
    if (!text) return null;
    const parsed = parseJson(text) as Record<string, unknown> | null;
    if (!parsed) return null;
    return {
      needsKnowledge: asBoolean(parsed.needsKnowledge),
      reason: asString(parsed.reason).slice(0, 240),
      query: asString(parsed.query).slice(0, 1000),
      limit: normalizeLimit(parsed.limit, 3, 5)
    };
  }
}

async function generateText(operation: 'classify-knowledge-context', prompt: string, abortSignal?: AbortSignal): Promise<string | null> {
  const endpoint = await resolveChatEndpoint();
  if (!endpoint) return null;
  const requestBody = {
    model: endpoint.model,
    temperature: 0.1,
    messages: [
      { role: 'system', content: 'You are the OpenAgent knowledge context router. Return JSON only.' },
      { role: 'user', content: prompt }
    ]
  };
  appendKnowledgeLlmResponseLog({
    scope: 'knowledge-router',
    message: `Knowledge router LLM request body (${operation})`,
    data: {
      operation,
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      promptLength: prompt.length,
      requestBody
    }
  });
  const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${endpoint.apiKey}`,
      ...(endpoint.extraHeaders ?? {})
    },
    body: JSON.stringify(requestBody),
    signal: abortSignal
  });
  const rawText = await response.text().catch(() => '');
  appendKnowledgeLlmResponseLog({
    scope: 'knowledge-router',
    message: `Knowledge router LLM raw response body (${operation})`,
    data: {
      operation,
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      rawText
    }
  });
  if (!response.ok) return null;
  const data = parseJsonFromResponse(rawText) as { choices?: Array<{ message?: { content?: string } }> } | null;
  return data?.choices?.[0]?.message?.content?.trim() || null;
}

async function resolveChatEndpoint(): Promise<{ baseUrl: string; model: string; apiKey: string; extraHeaders?: Record<string, string> } | null> {
  const catalog = await buildPiProviderCatalog();
  const provider = catalog.providers.find((item) => item.id === catalog.activeProviderId) ?? catalog.providers.find((item) => item.enabled);
  if (!provider || !provider.auth.secret) return null;
  const baseUrl = provider.baseUrl || defaultBaseUrl(provider.id);
  if (!baseUrl) return null;
  return {
    baseUrl,
    model: provider.defaultModel,
    apiKey: provider.auth.secret,
    extraHeaders: provider.id === 'openrouter' ? { 'HTTP-Referer': 'https://openagent.local', 'X-Title': 'OpenAgent' } : undefined
  };
}

function defaultBaseUrl(providerId: string) {
  switch (providerId) {
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'dashscope':
      return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    default:
      return '';
  }
}

function parseJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const source = fenced || text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function parseJsonFromResponse(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asBoolean(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeLimit(value: unknown, fallback: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}
