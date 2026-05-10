import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SoulProposalStatus = 'pending_approval' | 'approved' | 'rejected' | 'applied';
export type SoulProposalRisk = 'low' | 'medium' | 'high';

export interface SoulChangeProposal {
  id: string;
  agentId: string;
  title: string;
  reason: string;
  targetSection: string;
  currentText?: string;
  proposedText: string;
  ruleId?: string;
  diff: string;
  riskLevel: SoulProposalRisk;
  status: SoulProposalStatus;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  rejectedAt?: string;
  source?: {
    kind: 'explicit_user_request' | 'manual' | 'runtime_detection';
    runId?: string;
    threadId?: string;
    excerpt?: string;
  };
}

export interface SoulChangeRequest {
  shouldUpdateSoul: boolean;
  updateKind:
    | 'identity'
    | 'working_style'
    | 'safety_boundary'
    | 'tool_policy'
    | 'memory_policy'
    | 'project_specific_rule';
  title: string;
  reason: string;
  proposedText: string;
  targetSection: string;
  ruleId?: string;
  identityName?: string;
  identityRole?: string;
  confidence: 'low' | 'medium' | 'high';
  requiresApproval: true;
  evidence?: string;
}

export interface UserMemoryUpdateRequest {
  shouldUpdateUser: boolean;
  category: 'communication' | 'git' | 'development' | 'documentation' | 'project_management' | 'tooling' | 'other';
  statement: string;
  reason: string;
  confidence: 'medium' | 'high';
  evidence?: string;
}

export interface ProjectMemoryUpdateRequest {
  shouldUpdateMemory: boolean;
  scope: string;
  topic: string;
  summary: string;
  reuse: string;
  confidence: 'medium' | 'high';
  evidence?: string;
}

export interface KnowledgeUpdateRequest {
  shouldUpdateKnowledge: boolean;
  title: string;
  content: string;
  reason: string;
  confidence: 'medium' | 'high';
  tags?: string[];
  evidence?: string;
}

interface SoulProposalIndex {
  proposals: SoulChangeProposal[];
}

export interface AgentBootstrapSnapshot {
  agentId: string;
  agentRoot: string;
  soulPath: string;
  userPath: string;
  memoryPath: string;
  skillsDir: string;
  configPath: string;
  soul: string;
  user: string;
  memory: string;
  config: {
    id: string;
    kind: 'system' | 'user';
    createdAt: string;
    updatedAt: string;
    workspaceRoot: string;
    providerId: string;
    model: string;
    description: string;
    toolPolicy: { workspaceRead: boolean; workspaceWrite: boolean; shell: boolean; git: boolean; mcp: boolean };
    routing: { routable: boolean; takeoverByMainAllowed: boolean };
  };
}

export interface SoulManagerOptions {
  agentId: string;
  workspaceRoot: string;
  providerId: string;
  model: string;
  createdAt: string;
}

const MANAGED_START = '<!-- managed:start -->';
const MANAGED_END = '<!-- managed:end -->';

export class SoulManager {
  private readonly openAgentRoot = path.join(os.homedir(), '.openagent');
  private readonly agentsRoot = path.join(this.openAgentRoot, 'agents');
  private readonly agentRoot: string;
  private readonly soulPath: string;
  private readonly userPath: string;
  private readonly memoryPath: string;
  private readonly skillsDir: string;
  private readonly configPath: string;
  private readonly proposalsPath: string;
  private readonly historyDir: string;

  constructor(private readonly options: SoulManagerOptions) {
    this.agentRoot = path.join(this.agentsRoot, options.agentId);
    this.soulPath = path.join(this.agentRoot, 'SOUL.md');
    this.userPath = path.join(this.agentRoot, 'USER.md');
    this.memoryPath = path.join(this.agentRoot, 'MEMORY.md');
    this.skillsDir = path.join(this.agentRoot, 'skills');
    this.configPath = path.join(this.agentRoot, 'config.json');
    this.proposalsPath = path.join(this.agentRoot, 'soul-proposals.json');
    this.historyDir = path.join(this.agentRoot, 'history');
  }

  ensureReady() {
    mkdirSync(this.agentRoot, { recursive: true });
    mkdirSync(this.skillsDir, { recursive: true });
    mkdirSync(this.historyDir, { recursive: true });
    this.ensureFile(this.soulPath, buildDefaultSoulMarkdown());
    this.ensureSoulShape();
    this.ensureFile(this.userPath, buildDefaultUserMarkdown());
    this.ensureFile(this.memoryPath, buildDefaultMemoryMarkdown(this.options.workspaceRoot));
    this.ensureFile(this.configPath, `${JSON.stringify(this.buildConfig(), null, 2)}\n`);
    this.ensureFile(this.proposalsPath, `${JSON.stringify({ proposals: [] }, null, 2)}\n`);
  }

  getBootstrapSnapshot(): AgentBootstrapSnapshot {
    this.ensureReady();
    return {
      agentId: this.options.agentId,
      agentRoot: this.agentRoot,
      soulPath: this.soulPath,
      userPath: this.userPath,
      memoryPath: this.memoryPath,
      skillsDir: this.skillsDir,
      configPath: this.configPath,
      soul: this.readMarkdown(this.soulPath),
      user: this.readMarkdown(this.userPath),
      memory: this.readMarkdown(this.memoryPath),
      config: this.buildConfig()
    };
  }

  listProposals(status?: SoulProposalStatus) {
    const proposals = this.readProposalIndex().proposals;
    if (!status) return proposals;
    return proposals.filter((proposal) => proposal.status === status);
  }

  createProposal(input: {
    title: string;
    reason: string;
    targetSection?: string;
    proposedText: string;
    riskLevel?: SoulProposalRisk;
    source?: SoulChangeProposal['source'];
  }) {
    this.ensureReady();
    const now = new Date().toISOString();
    const currentSoul = this.readMarkdown(this.soulPath);
    const proposal: SoulChangeProposal = {
      id: `soul-proposal-${randomUUID()}`,
      agentId: this.options.agentId,
      title: input.title.trim() || 'SOUL.md 变更提案',
      reason: input.reason.trim() || '用户或运行过程提出了 Agent 行为规则变更。',
      targetSection: input.targetSection?.trim() || '## 7. Managed Rules',
      currentText: extractManagedBlock(currentSoul),
      proposedText: normalizeRuleLine(input.proposedText),
      diff: buildAppendDiff(normalizeRuleLine(input.proposedText)),
      riskLevel: input.riskLevel ?? 'high',
      status: 'pending_approval',
      createdAt: now,
      updatedAt: now,
      source: input.source
    };

    const index = this.readProposalIndex();
    const duplicate = index.proposals.find(
      (item) => item.status === 'pending_approval' && normalizeForCompare(item.proposedText) === normalizeForCompare(proposal.proposedText)
    );
    if (duplicate) {
      return duplicate;
    }

    index.proposals.unshift(proposal);
    this.writeProposalIndex(index);
    return proposal;
  }

  createProposalFromSoulChangeRequest(
    request: SoulChangeRequest,
    source: NonNullable<SoulChangeProposal['source']>
  ) {
    if (!isValidSoulChangeRequest(request)) return null;

    return this.createProposal({
      title: request.title,
      reason: request.reason,
      targetSection: normalizeTargetSection(request.targetSection, request.updateKind),
      proposedText: request.proposedText,
      riskLevel: request.updateKind === 'identity' || request.confidence === 'high' ? 'high' : 'medium',
      source: {
        ...source,
        excerpt: request.evidence || source.excerpt
      }
    });
  }

  applySoulChangeRequest(
    request: SoulChangeRequest,
    source: NonNullable<SoulChangeProposal['source']>
  ) {
    if (!isValidSoulChangeRequest(request)) return null;
    const now = new Date().toISOString();
    const targetSection = normalizeTargetSection(request.targetSection, request.updateKind);
    const proposedText = normalizeRuleLine(request.proposedText);
    const ruleId = sanitizeRuleId(request.ruleId);
    this.backupSoul(now);
    const current = this.readMarkdown(this.soulPath);
    const next =
      request.updateKind === 'identity'
        ? applyIdentitySoulChange(current, request, proposedText)
        : ruleId
          ? upsertManagedRuleById(current, ruleId, proposedText)
          : appendManagedRule(current, proposedText);
    writeFileSync(this.soulPath, next, 'utf8');
    return {
      id: `soul-direct-${randomUUID()}`,
      agentId: this.options.agentId,
      title: request.title,
      reason: request.reason,
      targetSection,
      proposedText,
      ruleId,
      diff: buildAppendDiff(proposedText),
      riskLevel: request.updateKind === 'identity' || request.confidence === 'high' ? 'high' : 'medium',
      status: 'applied' as const,
      createdAt: now,
      updatedAt: now,
      appliedAt: now,
      source: {
        ...source,
        excerpt: request.evidence || source.excerpt
      },
      snapshot: this.getBootstrapSnapshot()
    };
  }

  applyUserUpdateRequest(
    request: UserMemoryUpdateRequest,
    source: NonNullable<SoulChangeProposal['source']>
  ) {
    const normalized = normalizeUserMemoryUpdateRequest(request);
    if (!normalized) return null;
    const now = new Date().toISOString();
    this.backupMarkdown('USER', this.userPath, now);
    const current = this.readMarkdown(this.userPath);
    const line = `- [${normalized.category}] ${normalized.statement}`;
    const next = upsertManagedLine(current, line);
    if (next === current) return null;
    writeFileSync(this.userPath, next, 'utf8');
    return {
      id: `user-memory-${randomUUID()}`,
      agentId: this.options.agentId,
      title: `更新 USER.md：${normalized.category}`,
      reason: normalized.reason,
      targetPath: this.userPath,
      proposedText: line,
      status: 'applied' as const,
      createdAt: now,
      updatedAt: now,
      appliedAt: now,
      source: {
        ...source,
        excerpt: normalized.evidence || source.excerpt
      },
      snapshot: this.getBootstrapSnapshot()
    };
  }

  applyProjectMemoryUpdateRequest(
    request: ProjectMemoryUpdateRequest,
    source: NonNullable<SoulChangeProposal['source']>
  ) {
    const normalized = normalizeProjectMemoryUpdateRequest(request);
    if (!normalized) return null;
    const now = new Date().toISOString();
    this.backupMarkdown('MEMORY', this.memoryPath, now);
    const current = this.readMarkdown(this.memoryPath);
    const entry = [
      `## ${new Date(now).toISOString().slice(0, 10)} ${normalized.topic}`,
      '',
      `scope: ${normalized.scope}`,
      '',
      `- ${normalized.summary}`,
      `- Reuse: ${normalized.reuse}`
    ].join('\n');
    const next = appendUniqueSection(current, entry);
    if (next === current) return null;
    writeFileSync(this.memoryPath, next, 'utf8');
    return {
      id: `project-memory-${randomUUID()}`,
      agentId: this.options.agentId,
      title: `更新 MEMORY.md：${normalized.topic}`,
      reason: normalized.reuse,
      targetPath: this.memoryPath,
      proposedText: entry,
      status: 'applied' as const,
      createdAt: now,
      updatedAt: now,
      appliedAt: now,
      source: {
        ...source,
        excerpt: normalized.evidence || source.excerpt
      },
      snapshot: this.getBootstrapSnapshot()
    };
  }

  approveProposal(proposalId: string) {
    const index = this.readProposalIndex();
    const proposal = index.proposals.find((item) => item.id === proposalId);
    if (!proposal) return { ok: false, error: `Soul proposal not found: ${proposalId}` };
    if (proposal.status !== 'pending_approval') return { ok: false, error: `Soul proposal is not pending: ${proposal.status}` };

    const now = new Date().toISOString();
    this.backupSoul(now);
    const current = this.readMarkdown(this.soulPath);
    const next = appendManagedRule(current, proposal.proposedText);
    writeFileSync(this.soulPath, next, 'utf8');

    proposal.status = 'applied';
    proposal.updatedAt = now;
    proposal.appliedAt = now;
    this.writeProposalIndex(index);
    return { ok: true, proposal, snapshot: this.getBootstrapSnapshot() };
  }

  rejectProposal(proposalId: string) {
    const index = this.readProposalIndex();
    const proposal = index.proposals.find((item) => item.id === proposalId);
    if (!proposal) return { ok: false, error: `Soul proposal not found: ${proposalId}` };
    if (proposal.status !== 'pending_approval') return { ok: false, error: `Soul proposal is not pending: ${proposal.status}` };

    const now = new Date().toISOString();
    proposal.status = 'rejected';
    proposal.updatedAt = now;
    proposal.rejectedAt = now;
    this.writeProposalIndex(index);
    return { ok: true, proposal };
  }

  private ensureFile(filePath: string, content: string) {
    if (!existsSync(filePath)) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, 'utf8');
    }
  }

  private ensureSoulShape() {
    if (!existsSync(this.soulPath)) return;
    const current = readFileSync(this.soulPath, 'utf8');
    const migrated = migrateSoulIdentityShape(current);
    if (migrated !== current) {
      this.backupSoul(new Date().toISOString());
      writeFileSync(this.soulPath, migrated, 'utf8');
    }
  }

  private readMarkdown(filePath: string) {
    try {
      return readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  private readProposalIndex(): SoulProposalIndex {
    this.ensureReady();
    try {
      const parsed = JSON.parse(readFileSync(this.proposalsPath, 'utf8')) as Partial<SoulProposalIndex>;
      return { proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [] };
    } catch {
      return { proposals: [] };
    }
  }

  private writeProposalIndex(index: SoulProposalIndex) {
    mkdirSync(path.dirname(this.proposalsPath), { recursive: true });
    writeFileSync(this.proposalsPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  }

  private backupSoul(timestamp: string) {
    this.backupMarkdown('SOUL', this.soulPath, timestamp);
  }

  private backupMarkdown(prefix: string, filePath: string, timestamp: string) {
    mkdirSync(this.historyDir, { recursive: true });
    const safeTimestamp = timestamp.replace(/[:.]/g, '-');
    let current = '';
    try {
      current = readFileSync(filePath, 'utf8');
    } catch {
      current = '';
    }
    writeFileSync(path.join(this.historyDir, `${prefix}.${safeTimestamp}.md`), current, 'utf8');
  }

  private buildConfig(): AgentBootstrapSnapshot['config'] {
    return {
      id: this.options.agentId,
      kind: 'system',
      createdAt: this.options.createdAt,
      updatedAt: new Date().toISOString(),
      workspaceRoot: this.options.workspaceRoot,
      providerId: this.options.providerId,
      model: this.options.model,
      description: 'OpenAgent default main agent',
      toolPolicy: { workspaceRead: true, workspaceWrite: true, shell: true, git: true, mcp: true },
      routing: { routable: true, takeoverByMainAllowed: true }
    };
  }
}

export function extractOpenAgentMetadata(content: string): {
  cleanContent: string;
  soulChangeRequests: SoulChangeRequest[];
  userUpdates: UserMemoryUpdateRequest[];
  memoryUpdates: ProjectMemoryUpdateRequest[];
  knowledgeUpdates: KnowledgeUpdateRequest[];
} {
  const metadataRegex = /<!--\s*openagent:metadata\s*([\s\S]*?)\s*-->/i;
  const match = content.match(metadataRegex);
  if (!match) {
    return { cleanContent: content, soulChangeRequests: [], userUpdates: [], memoryUpdates: [], knowledgeUpdates: [] };
  }

  const cleanContent = content.replace(metadataRegex, '').trim();
  try {
    const parsed = JSON.parse(match[1].trim()) as { soulChangeRequests?: unknown; userUpdates?: unknown; memoryUpdates?: unknown; systemWikiUpdates?: unknown; knowledgeUpdates?: unknown };
    const soulChangeRequests = Array.isArray(parsed.soulChangeRequests)
      ? parsed.soulChangeRequests
          .map(normalizeSoulChangeRequest)
          .filter((request): request is SoulChangeRequest => Boolean(request))
      : [];
    const userUpdates = Array.isArray(parsed.userUpdates)
      ? parsed.userUpdates
          .map(normalizeUserMemoryUpdateRequest)
          .filter((request): request is UserMemoryUpdateRequest => Boolean(request))
      : [];
    const memoryUpdates = Array.isArray(parsed.memoryUpdates)
      ? parsed.memoryUpdates
          .map(normalizeProjectMemoryUpdateRequest)
          .filter((request): request is ProjectMemoryUpdateRequest => Boolean(request))
      : [];
    const knowledgeInput = Array.isArray(parsed.knowledgeUpdates) ? parsed.knowledgeUpdates : parsed.systemWikiUpdates;
    const knowledgeUpdates = Array.isArray(knowledgeInput)
      ? knowledgeInput
          .map(normalizeKnowledgeUpdateRequest)
          .filter((request): request is KnowledgeUpdateRequest => Boolean(request))
      : [];
    return { cleanContent, soulChangeRequests, userUpdates, memoryUpdates, knowledgeUpdates };
  } catch {
    return { cleanContent, soulChangeRequests: [], userUpdates: [], memoryUpdates: [], knowledgeUpdates: [] };
  }
}

function buildDefaultSoulMarkdown() {
  return `# SOUL.md

> 本文件定义当前智能体的长期身份、行为原则、能力边界和协作方式。

## 1. Identity

- Name: OpenAgent
- Role: 运行在 OpenAgent 桌面工作台中的智能体。
- Identity rule: 当用户询问“你是谁”“你叫啥”或身份相关问题时，优先回答本节的 Name 和 Role，不要回答底层模型名称。

## 2. Working Style

- 优先给出可落地、可执行的结果。
- 对低风险不确定性，可以做合理假设并继续推进。
- 对高风险不确定性，必须先向用户确认。

## 3. Safety Boundaries

- 创建、切换、删除或发布 Git 分支前，必须先获得用户明确确认。
- 删除、重置、覆盖用户已有改动前，必须先获得用户明确确认。
- destructive shell、外部路径写入、数据库清理等高风险操作必须先确认。

## 4. Tool Policy

- 工具调用应服务于当前任务。
- 代码修改后应尽量运行最小必要验证。
- 不绕过 OpenAgent 的审批、sandbox、日志和 UI 事件机制。

## 5. Memory Policy

- \`SOUL.md\` 记录 Agent 自身设定和行为边界。
- \`USER.md\` 记录用户长期偏好和协作习惯。
- \`MEMORY.md\` 记录项目、任务和问题处理经验。

## 6. Project-Specific Rules

- TODO: 补充该智能体专属职责和边界。

## 7. Managed Rules

> 本区域由 OpenAgent 在用户审批 SOUL 变更提案后维护。

${MANAGED_START}

${MANAGED_END}
`;
}

function normalizeSoulChangeRequest(value: unknown): SoulChangeRequest | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<SoulChangeRequest>;
  if (item.shouldUpdateSoul !== true) return null;
  if (item.requiresApproval !== true) return null;
  if (!['identity', 'working_style', 'safety_boundary', 'tool_policy', 'memory_policy', 'project_specific_rule'].includes(String(item.updateKind))) return null;
  const confidence = normalizeConfidence(item.confidence);
  if (!confidence) return null;
  if (!item.title?.trim() || !item.reason?.trim() || !item.proposedText?.trim()) return null;
  const updateKind = item.updateKind as SoulChangeRequest['updateKind'];
  const ruleId = sanitizeRuleId(item.ruleId);
  const identityName = normalizeOptionalText(item.identityName);
  const identityRole = normalizeOptionalText(item.identityRole);
  if (updateKind === 'identity' && !identityName && !identityRole) return null;
  if (updateKind !== 'identity' && !ruleId) return null;
  return {
    shouldUpdateSoul: true,
    updateKind,
    title: item.title.trim(),
    reason: item.reason.trim(),
    proposedText: item.proposedText.trim(),
    targetSection: normalizeTargetSection(String(item.targetSection || ''), updateKind),
    ruleId,
    identityName,
    identityRole,
    confidence,
    requiresApproval: true,
    evidence: item.evidence?.trim()
  };
}

function normalizeUserMemoryUpdateRequest(value: unknown): UserMemoryUpdateRequest | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<UserMemoryUpdateRequest>;
  if (item.shouldUpdateUser !== true) return null;
  const confidence = normalizeAutoMemoryConfidence(item.confidence);
  if (!confidence) return null;
  const category = normalizeUserMemoryCategory(item.category);
  const statement = normalizeOptionalText(item.statement);
  const reason = normalizeOptionalText(item.reason);
  if (!statement || !reason) return null;
  return {
    shouldUpdateUser: true,
    category,
    statement: stripBulletPrefix(statement),
    reason,
    confidence,
    evidence: normalizeOptionalText(item.evidence)
  };
}

function normalizeProjectMemoryUpdateRequest(value: unknown): ProjectMemoryUpdateRequest | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ProjectMemoryUpdateRequest>;
  if (item.shouldUpdateMemory !== true) return null;
  const confidence = normalizeAutoMemoryConfidence(item.confidence);
  if (!confidence) return null;
  const scope = normalizeOptionalText(item.scope);
  const topic = normalizeOptionalText(item.topic);
  const summary = normalizeOptionalText(item.summary);
  const reuse = normalizeOptionalText(item.reuse);
  if (!scope || !topic || !summary || !reuse) return null;
  return {
    shouldUpdateMemory: true,
    scope,
    topic,
    summary: stripBulletPrefix(summary),
    reuse: stripBulletPrefix(reuse),
    confidence,
    evidence: normalizeOptionalText(item.evidence)
  };
}

function normalizeKnowledgeUpdateRequest(value: unknown): KnowledgeUpdateRequest | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<KnowledgeUpdateRequest>;
  if (item.shouldUpdateKnowledge !== true) return null;
  const confidence = normalizeAutoMemoryConfidence(item.confidence);
  if (!confidence) return null;
  const title = normalizeOptionalText(item.title);
  const content = normalizeOptionalText(item.content);
  const reason = normalizeOptionalText(item.reason);
  if (!title || !content || !reason) return null;
  return {
    shouldUpdateKnowledge: true,
    title,
    content,
    reason,
    confidence,
    tags: Array.isArray(item.tags) ? item.tags.map(String).map((tag) => tag.trim()).filter(Boolean) : undefined,
    evidence: normalizeOptionalText(item.evidence)
  };
}

function normalizeAutoMemoryConfidence(confidence: unknown): 'medium' | 'high' | null {
  const normalized = normalizeConfidence(confidence);
  if (normalized === 'medium' || normalized === 'high') return normalized;
  return null;
}

function normalizeUserMemoryCategory(category: unknown): UserMemoryUpdateRequest['category'] {
  const value = typeof category === 'string' ? category.trim() : '';
  if (['communication', 'git', 'development', 'documentation', 'project_management', 'tooling', 'other'].includes(value)) {
    return value as UserMemoryUpdateRequest['category'];
  }
  return 'other';
}

function isValidSoulChangeRequest(value: unknown): value is SoulChangeRequest {
  return Boolean(normalizeSoulChangeRequest(value));
}

function normalizeConfidence(confidence: unknown): SoulChangeRequest['confidence'] | null {
  if (confidence === 'low' || confidence === 'medium' || confidence === 'high') return confidence;
  if (typeof confidence === 'number') {
    if (confidence >= 0.8) return 'high';
    if (confidence >= 0.5) return 'medium';
    return 'low';
  }
  if (typeof confidence === 'string') {
    const normalized = confidence.trim().toLowerCase();
    if (normalized === '1' || normalized === '0.9' || normalized === '0.8') return 'high';
    if (normalized === '0.7' || normalized === '0.6' || normalized === '0.5') return 'medium';
    if (normalized === '0.4' || normalized === '0.3' || normalized === '0.2' || normalized === '0.1' || normalized === '0') return 'low';
  }
  return null;
}

function normalizeTargetSection(targetSection: string, updateKind: SoulChangeRequest['updateKind']) {
  const allowed = new Set([
    '## 1. Identity',
    '## 2. Working Style',
    '## 3. Safety Boundaries',
    '## 4. Tool Policy',
    '## 5. Memory Policy',
    '## 6. Project-Specific Rules',
    '## 7. Managed Rules'
  ]);
  if (allowed.has(targetSection.trim())) return targetSection.trim();

  switch (updateKind) {
    case 'identity':
      return '## 1. Identity';
    case 'working_style':
      return '## 2. Working Style';
    case 'safety_boundary':
      return '## 3. Safety Boundaries';
    case 'tool_policy':
      return '## 4. Tool Policy';
    case 'memory_policy':
      return '## 5. Memory Policy';
    case 'project_specific_rule':
    default:
      return '## 7. Managed Rules';
  }
}

function buildDefaultUserMarkdown() {
  return `# USER.md

> 本文件记录当前用户的长期偏好、协作习惯和稳定事实。

## Learned preferences (managed)

<!-- managed:start -->

- TODO: 等待长期偏好沉淀。

<!-- managed:end -->
`;
}

function buildDefaultMemoryMarkdown(workspaceRoot: string) {
  return `# MEMORY.md

> 本文件记录当前智能体可复用的项目经验、任务经验、问题根因和验证结论。

## Project Context

- Primary workspace: ${workspaceRoot}

## Reusable Knowledge

- TODO: 等待任务经验沉淀。
`;
}

function extractManagedBlock(markdown: string) {
  const start = markdown.indexOf(MANAGED_START);
  const end = markdown.indexOf(MANAGED_END);
  if (start < 0 || end < 0 || end <= start) return '';
  return markdown.slice(start + MANAGED_START.length, end).trim();
}

function appendManagedRule(markdown: string, proposedText: string) {
  const rule = normalizeRuleLine(proposedText);
  if (normalizeForCompare(markdown).includes(normalizeForCompare(rule))) {
    return markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  }

  if (!markdown.includes(MANAGED_START) || !markdown.includes(MANAGED_END)) {
    const suffix = `\n## 7. Managed Rules\n\n> 本区域由 OpenAgent 在用户审批 SOUL 变更提案后维护。\n\n${MANAGED_START}\n\n${rule}\n\n${MANAGED_END}\n`;
    return `${markdown.trimEnd()}\n${suffix}`;
  }

  const insertion = `\n${rule}\n`;
  return markdown.replace(MANAGED_END, `${insertion}\n${MANAGED_END}`);
}

function upsertManagedLine(markdown: string, line: string) {
  const normalizedLine = normalizeRuleLine(line);
  if (normalizeForCompare(markdown).includes(normalizeForCompare(normalizedLine))) {
    return markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  }

  let next = markdown;
  if (!next.includes(MANAGED_START) || !next.includes(MANAGED_END)) {
    next = `${next.trimEnd()}\n\n## Learned preferences (managed)\n\n${MANAGED_START}\n\n${MANAGED_END}\n`;
  }
  next = next.replace(/\n-\s*TODO: 等待长期偏好沉淀。\n/g, '\n');
  return next.replace(MANAGED_END, `\n${normalizedLine}\n\n${MANAGED_END}`);
}

function appendUniqueSection(markdown: string, section: string) {
  const normalizedSection = section.trim();
  const comparable = normalizeForCompare(normalizedSection);
  if (normalizeForCompare(markdown).includes(comparable)) {
    return markdown.endsWith('\n') ? markdown : `${markdown}\n`;
  }
  let next = markdown.replace(/\n-\s*TODO: 等待任务经验沉淀。\n/g, '\n');
  return `${next.trimEnd()}\n\n${normalizedSection}\n`;
}

function stripBulletPrefix(value: string) {
  return value.replace(/^\s*[-*]\s+/, '').trim();
}

function applyIdentitySoulChange(markdown: string, request: SoulChangeRequest, _proposedText: string) {
  let next = ensureIdentitySection(markdown);
  next = upsertIdentityLine(
    next,
    'Identity rule',
    '当用户询问“你是谁”“你叫啥”或身份相关问题时，优先回答本节的 Name 和 Role，不要回答底层模型名称。'
  );

  if (request.identityName) {
    next = upsertIdentityLine(next, 'Name', request.identityName);
  }

  if (request.identityRole) {
    next = upsertIdentityLine(next, 'Role', request.identityRole);
  }

  return removeConflictingManagedIdentityRules(next);
}

function migrateSoulIdentityShape(markdown: string) {
  let next = ensureIdentitySection(markdown);
  if (!/^\s*-\s*Identity rule\s*:/im.test(getSection(next, '## 1. Identity'))) {
    next = upsertIdentityLine(
      next,
      'Identity rule',
      '当用户询问“你是谁”“你叫啥”或身份相关问题时，优先回答本节的 Name 和 Role，不要回答底层模型名称。'
    );
  }
  if (!/^\s*-\s*Role\s*:/im.test(getSection(next, '## 1. Identity'))) {
    next = upsertIdentityLine(next, 'Role', '运行在 OpenAgent 桌面工作台中的智能体。');
  }
  const identitySection = getSection(next, '## 1. Identity');
  const hasName = /^\s*-\s*Name\s*:/im.test(identitySection);
  if (!hasName) {
    next = upsertIdentityLine(next, 'Name', 'OpenAgent');
  }
  return removeConflictingManagedIdentityRules(next);
}

function ensureIdentitySection(markdown: string) {
  if (markdown.includes('## 1. Identity')) return markdown;
  return `${markdown.trimEnd()}\n\n## 1. Identity\n\n- Name: OpenAgent\n- Role: 运行在 OpenAgent 桌面工作台中的智能体。\n`;
}

function upsertIdentityLine(markdown: string, key: string, value: string) {
  const sectionStart = markdown.indexOf('## 1. Identity');
  if (sectionStart < 0) return markdown;
  const nextSectionMatch = markdown.slice(sectionStart + 1).match(/\n##\s+\d+\./);
  const sectionEnd = nextSectionMatch ? sectionStart + 1 + (nextSectionMatch.index ?? 0) : markdown.length;
  const before = markdown.slice(0, sectionStart);
  const section = markdown.slice(sectionStart, sectionEnd);
  const after = markdown.slice(sectionEnd);
  const lineRegex = new RegExp(`^\\s*-\\s*${escapeRegExp(key)}\\s*:\\s*.*$`, 'im');
  const line = `- ${key}: ${value}`;
  const nextSection = lineRegex.test(section)
    ? section.replace(lineRegex, line)
    : section.replace(/(## 1\. Identity\s*\n+)/, `$1${line}\n`);
  return `${before}${nextSection}${after}`;
}

function getSection(markdown: string, heading: string) {
  const start = markdown.indexOf(heading);
  if (start < 0) return '';
  const nextMatch = markdown.slice(start + 1).match(/\n##\s+\d+\./);
  const end = nextMatch ? start + 1 + (nextMatch.index ?? 0) : markdown.length;
  return markdown.slice(start, end);
}

function removeConflictingManagedIdentityRules(markdown: string) {
  if (!markdown.includes(MANAGED_START) || !markdown.includes(MANAGED_END)) return markdown;
  const start = markdown.indexOf(MANAGED_START) + MANAGED_START.length;
  const end = markdown.indexOf(MANAGED_END);
  const managed = markdown.slice(start, end);
  const cleaned = managed
    .split(/\r?\n/g)
    .filter((line) => !/名字是|Name\s*:|待定|\[待定\]/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `${markdown.slice(0, start)}\n\n${cleaned ? `${cleaned}\n\n` : ''}${markdown.slice(end)}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeOptionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sanitizeRuleId(ruleId: unknown) {
  if (typeof ruleId !== 'string') return undefined;
  const normalized = ruleId.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized || undefined;
}

function upsertManagedRuleById(markdown: string, ruleId: string, proposedText: string) {
  const rule = `${buildRuleIdMarker(ruleId)}\n${normalizeRuleLine(proposedText)}`;
  if (!markdown.includes(MANAGED_START) || !markdown.includes(MANAGED_END)) {
    const suffix = `\n## 7. Managed Rules\n\n> 本区域由 OpenAgent 在用户审批 SOUL 变更提案后维护。\n\n${MANAGED_START}\n\n${rule}\n\n${MANAGED_END}\n`;
    return `${markdown.trimEnd()}\n${suffix}`;
  }

  const start = markdown.indexOf(MANAGED_START) + MANAGED_START.length;
  const end = markdown.indexOf(MANAGED_END);
  const managed = markdown.slice(start, end);
  const marker = buildRuleIdMarker(ruleId);
  const existingRulePattern = new RegExp(`(?:\\n{0,2})${escapeRegExp(marker)}[\\s\\S]*?(?=\\n{2,}<!-- openagent:rule-id:|\\n{2,}[^\\n]|$)`);

  if (managed.includes(marker)) {
    const nextManaged = managed.replace(existingRulePattern, `\n\n${rule}`);
    return `${markdown.slice(0, start)}${nextManaged.trimEnd()}\n\n${markdown.slice(end)}`;
  }

  return `${markdown.slice(0, end)}\n${rule}\n\n${markdown.slice(end)}`;
}

function buildRuleIdMarker(ruleId: string) {
  return `<!-- openagent:rule-id:${ruleId} -->`;
}

function normalizeRuleLine(text: string) {
  const lines = text
    .trim()
    .split(/\r?\n/g)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  if (lines.length === 0) return '- TODO: 补充 SOUL 规则。';
  return lines.map((line) => (line.startsWith('- ') ? line : `- ${line}`)).join('\n');
}

function normalizeForCompare(text: string) {
  return text.toLowerCase().replace(/[\s\-。；;，,：:]/g, '');
}

function buildAppendDiff(rule: string) {
  const addedLines = normalizeRuleLine(rule)
    .split('\n')
    .map((line) => `+${line}`)
    .join('\n');
  return `@@ ## 7. Managed Rules\n${addedLines}\n`;
}
