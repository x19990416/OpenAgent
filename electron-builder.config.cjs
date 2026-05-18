/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.openagent.desktop',
  productName: 'OpenAgent',
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  files: [
    'dist/**/*',
    'skills/**/*',
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
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
};
