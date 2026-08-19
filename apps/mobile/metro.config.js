// Metro does not follow npm workspace symlinks by default, so the monorepo roots and the
// node_modules search path both have to be declared or `@caliper/core` resolves to nothing.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Left at Metro's default (false). Setting it true confines resolution to `nodeModulesPaths`,
// and in a hoisted npm workspace several Expo packages live nested under `node_modules/expo/`,
// where Metro then cannot see them — `expo-modules-core` is the first to fail.
config.resolver.disableHierarchicalLookup = false;
// The shared packages ship TypeScript sources rather than a build step.
config.resolver.sourceExts = [...config.resolver.sourceExts, 'ts', 'tsx'];

/**
 * Map TypeScript's ESM ".js" specifiers onto the ".ts" files they actually refer to.
 *
 * `packages/core` is written as standards-compliant TypeScript ESM, where `./schemas.js` is the
 * correct way to import `./schemas.ts`. Node resolves that via tsx and Vite resolves it natively;
 * Metro does neither, and reports the source file as missing.
 *
 * Scoped to the workspace's own packages so third-party resolution is untouched, and it falls
 * through to the default resolver whenever the rewrite does not hit a real file.
 */
const workspaceSources = path.join(workspaceRoot, 'packages');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromWorkspacePackage = (context.originModulePath ?? '').startsWith(workspaceSources);
  if (fromWorkspacePackage && moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    for (const ext of ['.ts', '.tsx']) {
      try {
        return context.resolveRequest(context, moduleName.replace(/\.js$/, ext), platform);
      } catch {
        // try the next extension, then fall through to the untouched specifier
      }
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
