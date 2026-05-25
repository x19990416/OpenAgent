import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getOpenAgentPath } from './openagent-home.js';

export interface ModelTokenUsageRecord {
  schemaVersion: 'openagent.model-usage.v1';
  id: string;
  createdAt: string;
  source: string;
  providerId: string;
  model: string;
  runId?: string;
  threadId?: string;
  requestId?: string;
  status?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface ModelUsageStatsRow {
  providerId: string;
  model: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  firstUsedAt: string;
  lastUsedAt: string;
}

export interface ModelUsageStatsResult {
  ok: boolean;
  periodDays: number;
  startedAt: string;
  endedAt: string;
  ledgerPath: string;
  total: Omit<ModelUsageStatsRow, 'providerId' | 'model' | 'firstUsedAt' | 'lastUsedAt'>;
  rows: ModelUsageStatsRow[];
  error?: string;
}

export interface RecordModelUsageInput {
  source: string;
  providerId?: string;
  model?: string;
  runId?: string;
  threadId?: string;
  requestId?: string;
  status?: number;
  usage: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
  };
}

export function getModelUsageLedgerPath() {
  return getOpenAgentPath('state', 'model-usage.jsonl');
}

export function recordModelUsage(input: RecordModelUsageInput) {
  const usage = normalizeDirectTokenUsage(input.usage);
  if (!usage) return null;

  const record: ModelTokenUsageRecord = {
    schemaVersion: 'openagent.model-usage.v1',
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: input.source,
    providerId: normalizeStatKey(input.providerId, 'unknown-provider'),
    model: normalizeStatKey(usage.model || input.model, 'unknown-model'),
    runId: input.runId,
    threadId: input.threadId,
    requestId: input.requestId,
    status: input.status,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cachedInputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens
  };

  appendModelUsageRecord(record);
  return record;
}

export function recordModelUsageFromResponse(input: {
  source: string;
  responseBody: string;
  providerId?: string;
  model?: string;
  runId?: string;
  threadId?: string;
  requestId?: string;
  status?: number;
}) {
  const usage = extractTokenUsage(input.responseBody);
  if (!usage) return null;

  return recordModelUsage({
    source: input.source,
    providerId: input.providerId,
    model: usage.model || input.model,
    runId: input.runId,
    threadId: input.threadId,
    requestId: input.requestId,
    status: input.status,
    usage
  });
}


export function resetModelUsageStats() {
  const ledgerPath = getModelUsageLedgerPath();
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, '', 'utf8');
  return { ok: true, ledgerPath, resetAt: new Date().toISOString() };
}

export function getModelUsageStats(input: { periodDays?: number } = {}): ModelUsageStatsResult {
  const periodDays = normalizePeriodDays(input.periodDays);
  const endedAtDate = new Date();
  const startedAtDate = new Date(endedAtDate.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const ledgerPath = getModelUsageLedgerPath();
  const total = createEmptyTotal();
  const rowsByKey = new Map<string, ModelUsageStatsRow>();

  for (const record of readModelUsageRecords()) {
    const createdAtMs = Date.parse(record.createdAt);
    if (!Number.isFinite(createdAtMs) || createdAtMs < startedAtDate.getTime() || createdAtMs > endedAtDate.getTime()) continue;

    const providerId = normalizeStatKey(record.providerId, 'unknown-provider');
    const model = normalizeStatKey(record.model, 'unknown-model');
    const key = `${providerId}\u0000${model}`;
    const row = rowsByKey.get(key) ?? {
      providerId,
      model,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      firstUsedAt: record.createdAt,
      lastUsedAt: record.createdAt
    };

    applyUsage(row, record);
    applyUsage(total, record);
    row.firstUsedAt = earlierIso(row.firstUsedAt, record.createdAt);
    row.lastUsedAt = laterIso(row.lastUsedAt, record.createdAt);
    rowsByKey.set(key, row);
  }

  return {
    ok: true,
    periodDays,
    startedAt: startedAtDate.toISOString(),
    endedAt: endedAtDate.toISOString(),
    ledgerPath,
    total,
    rows: [...rowsByKey.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.providerId.localeCompare(b.providerId) || a.model.localeCompare(b.model))
  };
}

function appendModelUsageRecord(record: ModelTokenUsageRecord) {
  const ledgerPath = getModelUsageLedgerPath();
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function readModelUsageRecords() {
  const ledgerPath = getModelUsageLedgerPath();
  if (!existsSync(ledgerPath)) return [];
  const content = readFileSync(ledgerPath, 'utf8');
  const records: ModelTokenUsageRecord[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<ModelTokenUsageRecord>;
      if (parsed.schemaVersion === 'openagent.model-usage.v1' && typeof parsed.createdAt === 'string') {
        records.push({
          schemaVersion: 'openagent.model-usage.v1',
          id: typeof parsed.id === 'string' ? parsed.id : randomUUID(),
          createdAt: parsed.createdAt,
          source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
          providerId: normalizeStatKey(parsed.providerId, 'unknown-provider'),
          model: normalizeStatKey(parsed.model, 'unknown-model'),
          runId: parsed.runId,
          threadId: parsed.threadId,
          requestId: parsed.requestId,
          status: parsed.status,
          inputTokens: normalizeTokenCount(parsed.inputTokens),
          outputTokens: normalizeTokenCount(parsed.outputTokens),
          totalTokens: normalizeTokenCount(parsed.totalTokens),
          cachedInputTokens: normalizeTokenCount(parsed.cachedInputTokens),
          reasoningOutputTokens: normalizeTokenCount(parsed.reasoningOutputTokens)
        });
      }
    } catch {
      // Ignore broken JSONL rows; the ledger is append-only and should keep loading valid rows.
    }
  }
  return records;
}

function extractTokenUsage(responseBody: string) {
  for (const candidate of parseResponseCandidates(responseBody)) {
    if (!isRecord(candidate)) continue;
    const usage = candidate.usage;
    if (!isRecord(usage)) continue;
    const inputTokens = firstNumber(usage.input_tokens, usage.prompt_tokens);
    const outputTokens = firstNumber(usage.output_tokens, usage.completion_tokens);
    const totalTokens = firstNumber(usage.total_tokens, inputTokens + outputTokens);
    if (totalTokens <= 0 && inputTokens <= 0 && outputTokens <= 0) continue;

    const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
    const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : null;

    return {
      model: typeof candidate.model === 'string' ? candidate.model : undefined,
      inputTokens,
      outputTokens,
      totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
      cachedInputTokens: inputDetails ? firstNumber(inputDetails.cached_tokens, inputDetails.cache_read_input_tokens) : 0,
      reasoningOutputTokens: outputDetails ? firstNumber(outputDetails.reasoning_tokens) : 0
    };
  }
  return null;
}

function normalizeDirectTokenUsage(usage: RecordModelUsageInput['usage']) {
  const rawInputTokens = firstNumber(usage.inputTokens, usage.input);
  const cachedInputTokens = firstNumber(usage.cachedInputTokens, usage.cacheRead, usage.cacheWrite);
  const inputTokens = typeof usage.inputTokens === 'number' ? rawInputTokens : rawInputTokens + cachedInputTokens;
  const outputTokens = firstNumber(usage.outputTokens, usage.output);
  const totalTokens = firstNumber(usage.totalTokens, inputTokens + outputTokens);
  if (totalTokens <= 0 && inputTokens <= 0 && outputTokens <= 0) return null;

  return {
    model: usage.model,
    inputTokens,
    outputTokens,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
    cachedInputTokens,
    reasoningOutputTokens: firstNumber(usage.reasoningOutputTokens, usage.reasoning)
  };
}

function parseResponseCandidates(responseBody: string): unknown[] {
  const candidates: unknown[] = [];
  const trimmed = responseBody.trim();
  if (!trimmed) return candidates;

  try {
    candidates.push(JSON.parse(trimmed));
  } catch {
    // Streaming/SSE responses are parsed below.
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const data = line.trim().replace(/^data:\s*/, '');
    if (!data || data === '[DONE]' || !data.startsWith('{')) continue;
    try {
      candidates.push(JSON.parse(data));
    } catch {
      // Ignore non-JSON stream fragments.
    }
  }

  return candidates;
}

function createEmptyTotal() {
  return {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0
  };
}

function applyUsage(target: ReturnType<typeof createEmptyTotal>, record: ModelTokenUsageRecord) {
  target.requestCount += 1;
  target.inputTokens += normalizeTokenCount(record.inputTokens);
  target.outputTokens += normalizeTokenCount(record.outputTokens);
  target.totalTokens += normalizeTokenCount(record.totalTokens);
  target.cachedInputTokens += normalizeTokenCount(record.cachedInputTokens);
  target.reasoningOutputTokens += normalizeTokenCount(record.reasoningOutputTokens);
}

function normalizePeriodDays(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 45;
  return Math.max(1, Math.min(365, Math.floor(value)));
}

function normalizeTokenCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  }
  return 0;
}

function normalizeStatKey(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function earlierIso(a: string, b: string) {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function laterIso(a: string, b: string) {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}
