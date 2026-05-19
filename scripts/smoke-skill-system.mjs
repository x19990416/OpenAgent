import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = mkdtempSync(path.join(tmpdir(), 'openagent-skill-smoke-'));
const openAgentRoot = path.join(tempRoot, '.openagent');
const workspaceRoot = path.join(openAgentRoot, 'agents', 'smoke-agent', 'workspace');
mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(openAgentRoot, { recursive: true });
process.env.OPENAGENT_HOME = openAgentRoot;

const { SkillService } = await import('../dist/main/runtime/skills/skill-service.js');
const { ToolPolicy } = await import('../dist/main/runtime/tool-policy.js');

const service = new SkillService({
  agentId: 'smoke-agent',
  workspaceRoot,
  appRoot: repoRoot,
  openAgentRoot
});

const skills = service.refreshSkills();
const skill = skills.find((item) => item.name === 'markdown-report' && item.source === 'system');
assert(skill, 'system skill markdown-report should be discovered');
assert(skill.enabled, 'system skill markdown-report should be enabled by default');
assert(skill.scripts.some((script) => script.path === 'scripts/word_count.mjs' && script.risk === 'read'), 'declared read-only script should be indexed');
assert(skill.resources.some((resource) => resource.path === 'templates/report.md' && resource.kind === 'template'), 'template resource should be indexed');

const inferredSkillCreator = service.inferSelectedSkill({
  prompt: '帮我创建一个叫做 email 的技能，用 POP3/SMTP 收发邮件'
});
assert(inferredSkillCreator?.name === 'skill-creator', 'skill authoring intent should implicitly select skill-creator');

const nonAuthoringSkill = service.inferSelectedSkill({
  prompt: '帮我使用 email 技能发送一封邮件'
});
assert(!nonAuthoringSkill, 'normal skill usage should not implicitly select skill-creator');

const tools = service.createTools();
const resourceTool = tools.find((tool) => tool.name === 'skill_resource');
const scriptTool = tools.find((tool) => tool.name === 'skill_script');
assert(resourceTool, 'skill_resource tool should be registered');
assert(scriptTool, 'skill_script tool should be registered');

const controller = new AbortController();
const resourceResult = await resourceTool.execute({
  toolCallId: 'smoke-resource',
  input: { skillName: 'markdown-report', path: 'templates/report.md' },
  signal: controller.signal
});
assert(resourceResult.ok, `skill_resource should succeed: ${resourceResult.content}`);
assert(resourceResult.content.includes('# {{title}}'), 'template content should be returned');

const policy = new ToolPolicy(workspaceRoot);
const selectedSkillWriteDecision = policy.decide(
  { name: 'write_file', label: 'Write File', description: 'write file', parameters: {}, execute: async () => ({ ok: true, content: '' }) },
  { path: path.join(openAgentRoot, 'agents', 'smoke-agent', 'skills', 'email', 'SKILL.md'), content: 'test' },
  {
    planId: 'selected-skill:skill-creator',
    stepId: 'selected-skill-routing',
    mode: 'executing',
    allowedTools: ['read-only'],
    selectedSkillName: 'skill-creator',
    selectedSkillHasScripts: true
  }
);
assert(selectedSkillWriteDecision.kind !== 'deny', 'skill-creator selected flow should allow write_file through plan allowlist');

const badSkillRootWriteDecision = policy.decide(
  { name: 'write_file', label: 'Write File', description: 'write file', parameters: {}, execute: async () => ({ ok: true, content: '' }) },
  { path: 'skills/email/SKILL.md', content: 'test' },
  {
    planId: 'selected-skill:skill-creator',
    stepId: 'selected-skill-routing',
    mode: 'executing',
    allowedTools: ['read-only'],
    selectedSkillName: 'skill-creator',
    selectedSkillHasScripts: true
  }
);
assert(badSkillRootWriteDecision.kind === 'deny', 'skill-creator selected flow should deny writes directly under workspace root');

const policyDecision = policy.decide(scriptTool, { skillName: 'markdown-report', scriptPath: 'scripts/word_count.mjs', args: ['hello world'] });
assert(policyDecision.kind === 'requires_approval', 'skill_script should require approval');
assert(policyDecision.approval.risk === 'low', `read-only skill script should be low risk, got ${policyDecision.approval.risk}`);
assert(policyDecision.approval.actionType === 'skill.script', `read-only actionType should be skill.script, got ${policyDecision.approval.actionType}`);
assert(policyDecision.approval.description.includes('network：no'), 'approval description should include network metadata');
assert(policyDecision.approval.description.includes('writes：no'), 'approval description should include writes metadata');

const events = [];
const scriptResult = await scriptTool.execute({
  toolCallId: 'smoke-script',
  input: { skillName: 'markdown-report', scriptPath: 'scripts/word_count.mjs', args: ['hello world'] },
  signal: controller.signal,
  context: {
    runId: 'smoke-run',
    threadId: 'smoke-thread',
    workspaceRoot,
    emitUiEvent: (type, payload) => events.push({ type, payload }),
    onLog: () => {}
  }
});
assert(scriptResult.ok, `skill_script should succeed: ${scriptResult.content}`);
assert(scriptResult.content.includes('"words": 2'), 'word_count output should include words=2');
assert(events.some((event) => event.type === 'skill.script.started'), 'skill.script.started event should be emitted');
assert(events.some((event) => event.type === 'skill.script.completed'), 'skill.script.completed event should be emitted');
assert(events.some((event) => event.payload?.scriptRisk === 'read' && event.payload?.network === false && event.payload?.writes === false), 'script events should include script metadata');

const auditLogPath = path.join(openAgentRoot, 'logs', 'skill-execution.jsonl');
assert(existsSync(auditLogPath), 'skill audit log should be written under OPENAGENT_HOME');
const auditLog = readFileSync(auditLogPath, 'utf8');
assert(auditLog.includes('"skillName":"markdown-report"'), 'audit log should include skill name');
assert(auditLog.includes('"scriptRisk":"read"'), 'audit log should include script risk');

console.log(JSON.stringify({
  ok: true,
  skill: skill.name,
  source: skill.source,
  policy: policyDecision.approval.actionType,
  risk: policyDecision.approval.risk,
  auditLogPath
}, null, 2));
