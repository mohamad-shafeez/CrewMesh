import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRootPackageJson = path.resolve(__dirname, '../package.json');
const projectRequire = createRequire(repoRootPackageJson);

function resolveDeclaredTranspiler() {
  // 1. Prefer the declared TypeScript compiler (`typescript` in workspace devDependencies)
  try {
    const ts = projectRequire('typescript');
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
      baseRequire: projectRequire,
    };
  } catch {
    // Continue to declared @babel/core
  }

  // 2. Otherwise use the declared @babel/core + @babel/preset-typescript packages from root devDependencies
  try {
    const babel = projectRequire('@babel/core');
    const presetTs = projectRequire.resolve('@babel/preset-typescript');
    const pluginCjs = projectRequire.resolve('@babel/plugin-transform-modules-commonjs');
    return {
      kind: 'babel',
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
      baseRequire: projectRequire,
    };
  } catch {
    throw new Error(
      'Missing declared TypeScript transpiler dependencies ("typescript" or "@babel/core"). Run "npm ci" from the repository root before executing tests.',
    );
  }
}

const activeTranspiler = resolveDeclaredTranspiler();

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
