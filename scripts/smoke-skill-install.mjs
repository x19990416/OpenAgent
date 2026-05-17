import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(tmpdir(), 'openagent-install-test-'));
const source = path.join(root, 'source-skill');
const workspace = path.join(root, 'workspace');
const home = path.join(root, '.openagent');
mkdirSync(source, { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(path.join(source, 'SKILL.md'), '---\nname: local-install-test\ndescription: Test install skill.\nrisk: read\n---\n\n# Local Install Test\n', 'utf8');
process.env.OPENAGENT_HOME = home;

const { SkillService } = await import('../dist/main/runtime/skills/skill-service.js');
const service = new SkillService({ agentId: 'main', workspaceRoot: workspace, appRoot: repoRoot, openAgentRoot: home });
const result = service.installLocal({ sourceDir: source, target: 'agent' });
if (!result.ok) throw new Error(result.error);
if (!existsSync(path.join(home, 'agents/main/skills/local-install-test/SKILL.md'))) throw new Error('installed SKILL.md missing');
if (!result.skills.some((skill) => skill.name === 'local-install-test' && skill.source === 'agent')) throw new Error('installed skill not in catalog');
const duplicate = service.installLocal({ sourceDir: source, target: 'agent' });
if (duplicate.ok) throw new Error('duplicate install without overwrite should fail');
const overwrite = service.installLocal({ sourceDir: source, target: 'agent', overwrite: true });
if (!overwrite.ok) throw new Error(`overwrite install should succeed: ${overwrite.error}`);
console.log(JSON.stringify({ ok: true, destinationDir: result.destinationDir, count: result.skills.length }, null, 2));
