import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const localRequire = createRequire(import.meta.url);

function resolveTranspiler() {
  // 1. Prefer project-local TypeScript compiler (`typescript` in workspace devDependencies)
  try {
    const ts = localRequire('typescript');
    return {
      kind: 'typescript',
      transpile(source, filename, isTsx, cjs = true) {
        const out = ts.transpileModule(source, {
          fileName: filename,
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: cjs ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
            jsx: isTsx ? ts.JsxEmit.ReactJSX : ts.JsxEmit.None,
            esModuleInterop: true,
          },
        });
        return out.outputText;
      },
      baseRequire: localRequire,
    };
  } catch {
    // Continue to project-local @babel/core
  }

  // 2. Next prefer project-local @babel/core (`@babel/core` in workspace devDependencies)
  try {
    const babel = localRequire('@babel/core');
    const presetTs = localRequire.resolve('@babel/preset-typescript');
    const pluginCjs = localRequire.resolve('@babel/plugin-transform-modules-commonjs');
    return {
      kind: 'babel-local',
      transpile(source, filename, isTsx, cjs = true) {
        const result = babel.transformSync(source, {
          filename,
          presets: [[presetTs, { isTSX: isTsx, allExtensions: true }]],
          plugins: cjs ? [pluginCjs] : [],
          configFile: false,
          babelrc: false,
        });
        return result && typeof result.code === 'string' ? result.code : '';
      },
      baseRequire: localRequire,
    };
  } catch {
    // Continue to offline sandbox system fallback if available
  }

  // 3. Fallback for offline sandbox container when node_modules is not installed
  const sysIndex = '/usr/share/nodejs/index.js';
  if (fs.existsSync(sysIndex)) {
    const sysRequire = createRequire(sysIndex);
    const babel = sysRequire('@babel/core');
    const presetTs = sysRequire.resolve('@babel/preset-typescript');
    const pluginCjs = sysRequire.resolve('@babel/plugin-transform-modules-commonjs');
    return {
      kind: 'babel-system-fallback',
      transpile(source, filename, isTsx, cjs = true) {
        const result = babel.transformSync(source, {
          filename,
          presets: [[presetTs, { isTSX: isTsx, allExtensions: true }]],
          plugins: cjs ? [pluginCjs] : [],
          configFile: false,
          babelrc: false,
        });
        return result && typeof result.code === 'string' ? result.code : '';
      },
      baseRequire: sysRequire,
    };
  }

  throw new Error(
    'Unable to resolve project-local TypeScript or @babel/core transpiler. Run `npm ci` first.',
  );
}

const activeTranspiler = resolveTranspiler();

export function getActiveTranspilerKind() {
  return activeTranspiler.kind;
}

export function transpileTypeScriptSource(source, filePath) {
  const isTsx = filePath.endsWith('.tsx');
  return activeTranspiler.transpile(source, filePath, isTsx, false);
}

export function loadTsModule(tsFilePath, customRequireMap = {}) {
  const rawSource = fs
    .readFileSync(tsFilePath, 'utf8')
    .replaceAll('import.meta.url', JSON.stringify(`file://${tsFilePath}`));

  const isTsx = tsFilePath.endsWith('.tsx');
  const compiledCode = activeTranspiler.transpile(rawSource, tsFilePath, isTsx, true);

  const customRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(customRequireMap, id)) {
      return customRequireMap[id];
    }
    return activeTranspiler.baseRequire(id);
  };

  const mod = { exports: {} };
  const fn = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    compiledCode,
  );
  fn(mod.exports, customRequire, mod, tsFilePath, path.dirname(tsFilePath));
  return mod.exports;
}
