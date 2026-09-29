// monorepo 配置:需监听仓库根并显式声明依赖查找路径。
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// 注意:pnpm 把依赖放在各 workspace 包自己的 node_modules 下,
// 不能开 disableHierarchicalLookup,否则深层包(如 packages/client)的依赖解析失败。
// @zcode/* 通过 package.json exports 暴露 TS 源码。
config.resolver.unstable_enablePackageExports = true;

// 仓库内 TS 源码用 NodeNext 风格的 `./foo.js` 导入(以及 services 的 `#src/*` 包内别名);
// Metro 默认不会把 .js 回退到 .ts/.tsx,这里统一兜底。
const originalResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = originalResolve ?? context.resolveRequest;
  const isRelative = moduleName.startsWith("./") || moduleName.startsWith("../");
  const isPackageImport = moduleName.startsWith("#");
  if ((isRelative || isPackageImport) && moduleName.endsWith(".js")) {
    const stem = moduleName.slice(0, -3);
    for (const ext of [".ts", ".tsx"]) {
      try {
        return resolve(context, stem + ext, platform);
      } catch {
        // 继续尝试下一个扩展。
      }
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
