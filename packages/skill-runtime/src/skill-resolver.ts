import path from 'node:path';
import type { RuntimeAttachment } from '@openagent/runtime';
import type { SkillCatalogItem } from './skill-types.js';
import { SOURCE_PRIORITY } from './skill-types.js';
import { tokenize } from './skill-utils.js';

export function resolveRelevantSkills(input: { skills: SkillCatalogItem[]; prompt: string; attachments: RuntimeAttachment[]; selectedSkillId: string }) {
  return input.skills
    .map((skill) => ({ skill, score: scoreSkill(skill, input.prompt, input.attachments, input.selectedSkillId) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || SOURCE_PRIORITY[b.skill.source] - SOURCE_PRIORITY[a.skill.source])
    .slice(0, 8)
    .map((item) => item.skill);
}

export function inferImplicitSelectedSkill(input: { skills: SkillCatalogItem[]; prompt: string; attachments: RuntimeAttachment[] }) {
  if (!hasSkillAuthoringIntent(input.prompt, input.attachments)) return null;
  return input.skills
    .filter((skill) => skill.enabled && skill.name === 'skill-creator')
    .sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source])[0] ?? null;
}

function scoreSkill(skill: SkillCatalogItem, prompt: string, attachments: RuntimeAttachment[], selectedSkillId: string) {
  if (selectedSkillId && (selectedSkillId === skill.id || selectedSkillId === skill.name)) return 100;
  const haystack = `${prompt} ${attachments.map((attachment) => `${attachment.name} ${attachment.path} ${attachment.mimeType}`).join(' ')}`.toLowerCase();
  let score = 0;
  if (skill.name === 'skill-creator' && hasSkillAuthoringIntent(prompt, attachments)) score += 80;
  for (const token of tokenize(skill.name)) if (haystack.includes(token)) score += 12;
  for (const tag of skill.tags) if (haystack.includes(tag.toLowerCase())) score += 10;
  const descTokens = tokenize(skill.description).filter((token) => token.length >= 4).slice(0, 24);
  for (const token of descTokens) if (haystack.includes(token)) score += 2;
  for (const attachment of attachments) {
    const ext = path.extname(attachment.name || attachment.path || '').replace(/^\./, '').toLowerCase();
    if (ext && skill.tags.map((tag) => tag.toLowerCase()).includes(ext)) score += 20;
    if (ext && skill.description.toLowerCase().includes(ext)) score += 12;
  }
  return score;
}

function hasSkillAuthoringIntent(prompt: string, attachments: RuntimeAttachment[]) {
  const haystack = `${prompt} ${attachments.map((attachment) => `${attachment.name} ${attachment.path} ${attachment.mimeType}`).join(' ')}`.toLowerCase();
  const mentionsSkill = /(?:skill|skills|技能|能力包|工具包)/i.test(haystack);
  if (!mentionsSkill) return false;

  const authoringPatterns = [
    /创建(?:一个|一[个套]?|新的?)?.{0,24}(?:skill|技能|能力包|工具包)/i,
    /新建(?:一个|一[个套]?|新的?)?.{0,24}(?:skill|技能|能力包|工具包)/i,
    /新增(?:一个|一[个套]?|新的?)?.{0,24}(?:skill|技能|能力包|工具包)/i,
    /生成(?:一个|一[个套]?|新的?)?.{0,24}(?:skill|技能|能力包|工具包)/i,
    /搭建(?:一个|一[个套]?|新的?)?.{0,24}(?:skill|技能|能力包|工具包)/i,
    /做(?:一个|个|一套)?.{0,24}(?:skill|技能|能力包|工具包)/i,
    /封装(?:成|为)?.{0,24}(?:skill|技能|能力包|工具包)/i,
    /把.{0,40}(?:做成|转成|改成|封装成).{0,24}(?:skill|技能|能力包|工具包)/i,
    /\b(?:create|scaffold|generate|build|make|author|migrate|update)\b.{0,40}\b(?:skill|skills)\b/i,
    /\b(?:skill|skills)\b.{0,40}\b(?:create|scaffold|generate|build|make|author|migrate|update)\b/i
  ];
  return authoringPatterns.some((pattern) => pattern.test(haystack));
}
