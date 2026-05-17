import path from 'node:path';
import type { RuntimeAttachment } from '../runtime-types.js';
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

function scoreSkill(skill: SkillCatalogItem, prompt: string, attachments: RuntimeAttachment[], selectedSkillId: string) {
  if (selectedSkillId && (selectedSkillId === skill.id || selectedSkillId === skill.name)) return 100;
  const haystack = `${prompt} ${attachments.map((attachment) => `${attachment.name} ${attachment.path} ${attachment.mimeType}`).join(' ')}`.toLowerCase();
  let score = 0;
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
