import { buildPiProviderCatalog } from '../pi/pi-model-registry.js';

export interface LlmPlanStepDraft {
  title: string;
  description?: string;
  allowedTools?: string[];
  riskLevel?: 'low' | 'medium' | 'high';
  requiresApproval?: boolean;
}

export interface LlmPlanDraft {
  steps: LlmPlanStepDraft[];
  summary?: string;
  approvalReason?: string;
}

export interface LlmPlanningIntentDecision {
  shouldPlan: boolean;
  approvalRequired?: boolean;
  riskLevel?: 'low' | 'medium' | 'high';
  reason?: string;
}

const ALLOWED_TOOL_HINTS = [
  'read-only',
  'write_file',
  'file-write',
  'shell_exec',
  'shell-exec',
  'shell_agent',
  'knowledge_agent',
  'knowledge',
  'knowledge-write',
  'tool-executor',
  'message',
  'runtime'
];

export class PlanLlmGenerator {
  async classifyIntent(input: { prompt: string; fallbackRiskLevel: 'low' | 'medium' | 'high' }): Promise<LlmPlanningIntentDecision | null> {
    const schema = '{"shouldPlan":true,"approvalRequired":true,"riskLevel":"low|medium|high","reason":"string"}';
    const text = await generateText([
      'Decide whether this OpenAgent user request needs Agent Plan Mode.',
      'Return strict JSON only. No Markdown. No code fence.',
      'Agent Plan Mode is useful for multi-step tasks, file writes, multi-file output, code changes, data deletion, risky operations, git operations, long-running work, or tasks that need a visible structured execution plan.',
      'Simple Q&A, explanation, translation, or read-only answers usually do not need Agent Plan Mode.',
      'approvalRequired means OpenAgent should pause for explicit user confirmation before executing the generated plan.',
      'Set approvalRequired true for destructive actions, git push/commit, external impact, database cleanup, or ambiguous high-risk writes.',
      'If the user clearly asks the agent to complete the task autonomously and the risk is only low/medium workspace-local work, approvalRequired can be false; tool-level approvals still apply later.',
      `Schema: ${schema}`,
      `Fallback risk: ${input.fallbackRiskLevel}`,
      '<user_request>',
      input.prompt.slice(0, 4000),
      '</user_request>'
    ].join('\n'));
    if (!text) return null;
    const parsed = parseJson(text) as Record<string, unknown> | null;
    if (!parsed) return null;
    return {
      shouldPlan: asBoolean(parsed.shouldPlan),
      approvalRequired: typeof parsed.approvalRequired === 'boolean' ? parsed.approvalRequired : undefined,
      riskLevel: asRisk(parsed.riskLevel, input.fallbackRiskLevel),
      reason: asString(parsed.reason).slice(0, 240)
    };
  }

  async generate(input: { prompt: string; riskLevel: 'low' | 'medium' | 'high' }): Promise<LlmPlanDraft | null> {
    const schema = '{"summary":"string","approvalReason":"string","steps":[{"title":"string","description":"string","allowedTools":["read-only"],"riskLevel":"low|medium|high","requiresApproval":false}]}';
    const text = await generateText([
      'You create concise execution plans for OpenAgent Plan Mode.',
      'Return strict JSON only. No Markdown. No code fence.',
      'The plan should contain 2-6 business execution steps for the user goal, not generic runtime plumbing.',
      'Each step must be actionable, observable, and short.',
      'approvalReason must be one short natural sentence explaining why user confirmation is needed before execution.',
      `Use only these allowedTools hints: ${ALLOWED_TOOL_HINTS.join(', ')}`,
      'For simple text file creation or text file writing, prefer write_file or file-write on the relevant step.',
      'For tasks that require writing and running a program or script to compute, transform data, generate files, or call local CLIs, include shell_exec or shell-exec on the relevant step.',
      'For broader code implementation or mixed tool work, include tool-executor on the relevant step.',
      'For external data fetching, live market/news/API data, or HTTP request tasks, include shell_exec or tool-executor because the agent may need to run a small script or CLI after user/tool approval.',
      'For read-only investigation, use read-only.',
      'For knowledge-base work, use knowledge or knowledge-write.',
      'Risk must be low, medium, or high. requiresApproval should be true for shell execution, dependency installation, external writes, overwrites, git, destructive, or external-impact steps; simple workspace-local new file writes do not require extra approval by themselves.',
      `Schema: ${schema}`,
      `Overall risk: ${input.riskLevel}`,
      '<user_goal>',
      input.prompt.slice(0, 4000),
      '</user_goal>'
    ].join('\n'));
    if (!text) return null;
    const parsed = parseJson(text) as { summary?: unknown; approvalReason?: unknown; steps?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.steps)) return null;
    const steps = parsed.steps.flatMap((item): LlmPlanStepDraft[] => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Record<string, unknown>;
      const title = asString(value.title).trim();
      if (!title) return [];
      return [{
        title: title.slice(0, 120),
        description: asString(value.description).slice(0, 500),
        allowedTools: sanitizeAllowedTools(value.allowedTools),
        riskLevel: asRisk(value.riskLevel, input.riskLevel),
        requiresApproval: Boolean(value.requiresApproval)
      }];
    }).slice(0, 6);
    return steps.length > 0
      ? {
          summary: asString(parsed.summary).slice(0, 500),
          approvalReason: asString(parsed.approvalReason).slice(0, 240),
          steps
        }
      : null;
  }
}

async function generateText(prompt: string): Promise<string | null> {
  const endpoint = await resolveChatEndpoint();
  if (!endpoint) return null;
  const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${endpoint.apiKey}`,
      ...(endpoint.extraHeaders ?? {})
    },
    body: JSON.stringify({
      model: endpoint.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'You are the OpenAgent structured planning module. Return JSON only.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() || null;
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

function sanitizeAllowedTools(value: unknown) {
  if (!Array.isArray(value)) return ['tool-executor'];
  const allowed = new Set(ALLOWED_TOOL_HINTS);
  const tools = value.map(String).map((item) => item.trim()).filter((item) => allowed.has(item)).slice(0, 6);
  return tools.length ? tools : ['tool-executor'];
}

function asRisk(value: unknown, fallback: 'low' | 'medium' | 'high') {
  return value === 'low' || value === 'medium' || value === 'high' ? value : fallback;
}

function asBoolean(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function defaultBaseUrl(providerId: string) {
  const defaults: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    deepseek: 'https://api.deepseek.com/v1'
  };
  return defaults[providerId] ?? '';
}

function asString(value: unknown) { return typeof value === 'string' ? value : ''; }
