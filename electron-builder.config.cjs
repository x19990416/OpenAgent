const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolvePackageJson(projectDir, fromDir, packageName) {
  let current = fromDir;
  const packagePathParts = packageName.split('/');

  while (true) {
    const candidate = path.join(current, 'node_modules', ...packagePathParts, 'package.json');
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const rootCandidate = path.join(projectDir, 'node_modules', ...packagePathParts, 'package.json');
  return fs.existsSync(rootCandidate) ? rootCandidate : null;
}

function copyRuntimePackage(projectDir, asarRoot, packageJsonPath, visited) {
  const packageDir = path.dirname(packageJsonPath);
  const relativePackageDir = path.relative(projectDir, packageDir);

  if (relativePackageDir.startsWith('..') || path.isAbsolute(relativePackageDir)) return;
  if (visited.has(relativePackageDir)) return;
  visited.add(relativePackageDir);

  const targetPackageDir = path.join(asarRoot, relativePackageDir);
  fs.rmSync(targetPackageDir, { recursive: true, force: true });
  fs.cpSync(packageDir, targetPackageDir, {
    recursive: true,
    dereference: false,
    filter: (source) => {
      const name = path.basename(source);
      return name !== '.cache' && name !== '.vite' && name !== '.vite-temp';
    },
  });

  const packageJson = readJson(packageJsonPath);
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.optionalDependencies ?? {}),
  };

  for (const dependencyName of Object.keys(dependencies)) {
    const dependencyPackageJson = resolvePackageJson(projectDir, packageDir, dependencyName);
    if (dependencyPackageJson) {
      copyRuntimePackage(projectDir, asarRoot, dependencyPackageJson, visited);
    }
  }
}

async function bundleRuntimeDependencyClosure(context) {
  const resourcesDir = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  if (!fs.existsSync(asarPath)) return;

  const projectDir = context.packager.projectDir;
  const appPackageJson = readJson(path.join(projectDir, 'package.json'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-asar-'));

  try {
    asar.extractAll(asarPath, tempRoot);

    const visited = new Set();
    for (const dependencyName of Object.keys(appPackageJson.dependencies ?? {})) {
      const dependencyPackageJson = resolvePackageJson(projectDir, projectDir, dependencyName);
      if (dependencyPackageJson) {
        copyRuntimePackage(projectDir, tempRoot, dependencyPackageJson, visited);
      }
    }

    fs.rmSync(asarPath, { force: true });
    fs.rmSync(`${asarPath}.unpacked`, { recursive: true, force: true });
    await asar.createPackageWithOptions(tempRoot, asarPath, {
      unpack: '**/*.node',
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.openagent.desktop',
  productName: 'OpenAgent',
  electronDist: 'node_modules/electron/dist',
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  afterPack: bundleRuntimeDependencyClosure,
  files: [
    'dist{,/**/*}',
    'skills{,/**/*}',
    'package.json',
    // Plugin packages should stay user/dev installed (for example under
    // ~/.openagent/plugins or a user-selected plugins root), not bundled into
    // desktop release artifacts. Keep dist/main/plugins: it is OpenAgent's
    // plugin runtime/framework code imported by main, not a packaged plugin.
    '!plugins{,/**/*}',
    '!openagent-plugins{,/**/*}',
    '!.agents/plugins{,/**/*}',
    '!dist/plugins{,/**/*}',
    '!dist/main/plugins/builtins{,/**/*}',
    // Electron is already bundled by electron-builder into the .app Frameworks.
    // Do not package the npm electron binary again under app.asar(.unpacked).
    '!node_modules/electron{,/**/*}',
    '!node_modules/.pnpm/electron@*/node_modules/electron{,/**/*}',
  ],
  extraMetadata: {
    main: 'dist/main/main.js',
  },
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    target: [
      {
        target: 'dmg',
        arch: ['arm64', 'x64'],
      },
      {
        target: 'zip',
        arch: ['arm64', 'x64'],
      },
    ],
  },
  win: {
    icon: 'build/icon.ico',
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
      {
        target: 'portable',
        arch: ['x64'],
      },
    ],
  },
  nsis: {
    artifactName: '${productName} Installer ${version}.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
};
