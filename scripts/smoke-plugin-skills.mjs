import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(path.join(tmpdir(), 'openagent-plugin-skills-'));
const openAgentHome = path.join(root, '.openagent');
const workspaceRoot = path.join(root, 'workspace');
const pluginsRoot = path.join(root, 'plugins');
mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(pluginsRoot, { recursive: true });
process.env.OPENAGENT_HOME = openAgentHome;

function writePlugin(id, files) {
  const pluginRoot = path.join(pluginsRoot, id);
  mkdirSync(pluginRoot, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(pluginRoot, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
  return pluginRoot;
}

const manifestPluginRoot = writePlugin('manifest-skill-plugin', {
  '.openagent-plugin/plugin.json': JSON.stringify({
    schemaVersion: 'openagent.plugin.v1',
    id: 'manifest-skill-plugin',
    name: 'Manifest Skill Plugin',
    version: '0.1.0',
    main: 'index.mjs',
    capabilities: ['skills'],
    skills: [
      { name: 'plugin-path-skill', description: 'Plugin skill from path.', path: 'skills/path-skill/SKILL.md' },
      { name: 'plugin-content-skill', description: 'Plugin skill from inline content.', content: '---\nname: plugin-content-skill\ndescription: Plugin skill from inline content.\nrisk: read\n---\n\n# Plugin Content Skill\n' }
    ]
  }, null, 2),
  '.openagent-plugin/index.mjs': 'export default { id: "manifest-skill-plugin", name: "Manifest Skill Plugin", register() {} };\n',
  '.openagent-plugin/skills/path-skill/SKILL.md': '---\nname: plugin-path-skill\ndescription: Plugin skill from path.\nrisk: read\n---\n\n# Plugin Path Skill\n',
  '.openagent-plugin/skills/path-skill/templates/example.md': '# Template\n'
});

const registeredPluginRoot = writePlugin('registered-skill-plugin', {
  '.openagent-plugin/plugin.json': JSON.stringify({
    schemaVersion: 'openagent.plugin.v1',
    id: 'registered-skill-plugin',
    name: 'Registered Skill Plugin',
    version: '0.1.0',
    main: 'index.mjs',
    capabilities: ['skills']
  }, null, 2),
  '.openagent-plugin/index.mjs': `import path from 'node:path';
export default {
  id: 'registered-skill-plugin',
  name: 'Registered Skill Plugin',
  register(ctx) {
    const rootDir = path.join(import.meta.dirname, 'registered-skill');
    ctx.registerSkill({ name: 'plugin-rootdir-skill', description: 'Plugin skill from registered rootDir.', rootDir });
  }
};
`,
  '.openagent-plugin/registered-skill/SKILL.md': '---\nname: plugin-rootdir-skill\ndescription: Plugin skill from registered rootDir.\nrisk: read\n---\n\n# Plugin RootDir Skill\n',
  '.openagent-plugin/registered-skill/references/ref.md': '# Ref\n'
});

const { PluginService } = await import('../dist/main/plugins/plugin-service.js');
const { SkillService } = await import('../dist/main/runtime/skills/skill-service.js');

const pluginService = new PluginService();
await pluginService.initialize();
await pluginService.installLocal(manifestPluginRoot);
await pluginService.installLocal(registeredPluginRoot);
await pluginService.setEnabled({ pluginId: 'manifest-skill-plugin', enabled: true });
await pluginService.setEnabled({ pluginId: 'registered-skill-plugin', enabled: true });
await pluginService.load({ pluginIds: ['manifest-skill-plugin', 'registered-skill-plugin'] });

let packages = pluginService.getSkillPackages();
if (process.env.DEBUG_PLUGIN_SKILLS) {
  console.log(JSON.stringify({ registry: pluginService.getRegistry(), packages }, null, 2));
}
assert(packages.some((skill) => skill.name === 'plugin-path-skill' && skill.skillFile?.endsWith('skills/path-skill/SKILL.md')), 'manifest path skill package missing or skillFile not resolved');
assert(packages.some((skill) => skill.name === 'plugin-content-skill' && skill.content?.includes('Plugin Content Skill')), 'manifest content skill package missing');
assert(packages.some((skill) => skill.name === 'plugin-rootdir-skill' && skill.rootDir?.endsWith('registered-skill')), 'registered rootDir skill package missing');

const skillService = new SkillService({ agentId: 'main', workspaceRoot, appRoot: process.cwd(), openAgentRoot: openAgentHome });
skillService.setPluginSkills(packages);
let catalog = skillService.refreshSkills();
const names = catalog.filter((skill) => skill.source === 'plugin').map((skill) => skill.name).sort();
assert(names.includes('plugin-path-skill'), 'plugin path skill not in SkillService catalog');
assert(names.includes('plugin-content-skill'), 'plugin content skill not in SkillService catalog');
assert(names.includes('plugin-rootdir-skill'), 'plugin rootDir skill not in SkillService catalog');
assert(catalog.find((skill) => skill.name === 'plugin-path-skill')?.resources.some((resource) => resource.path === 'templates/example.md'), 'plugin path skill resource missing');
assert(catalog.find((skill) => skill.name === 'plugin-rootdir-skill')?.resources.some((resource) => resource.path === 'references/ref.md'), 'plugin rootDir skill resource missing');
assert(existsSync(path.join(openAgentHome, 'state/plugin-skills/manifest-skill-plugin/plugin-content-skill/SKILL.md')), 'content skill was not materialized');

await pluginService.setEnabled({ pluginId: 'manifest-skill-plugin', enabled: false });
packages = pluginService.getSkillPackages();
skillService.setPluginSkills(packages);
catalog = skillService.refreshSkills();
assert(!catalog.some((skill) => skill.name === 'plugin-path-skill'), 'disabled plugin path skill should disappear');
assert(!catalog.some((skill) => skill.name === 'plugin-content-skill'), 'disabled plugin content skill should disappear');
assert(catalog.some((skill) => skill.name === 'plugin-rootdir-skill'), 'other enabled plugin skill should remain');

await pluginService.setCapability({ pluginId: 'registered-skill-plugin', capability: 'skills', enabled: false });
await pluginService.load({ pluginIds: ['registered-skill-plugin'] });
packages = pluginService.getSkillPackages();
skillService.setPluginSkills(packages);
catalog = skillService.refreshSkills();
assert(!catalog.some((skill) => skill.name === 'plugin-rootdir-skill'), 'plugin skill should disappear when skills capability is disabled');

console.log(JSON.stringify({ ok: true, pluginSkillNames: names, openAgentHome }, null, 2));
