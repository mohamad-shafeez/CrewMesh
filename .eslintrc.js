const Module = require('module');

let resolvedParser = null;
let parserOptions = {
  ecmaVersion: 2022,
  sourceType: 'module',
};

try {
  resolvedParser = require.resolve('@typescript-eslint/parser', { paths: [__dirname] });
  parserOptions = {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  };
} catch {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@nicolo-ribaudo/eslint-scope-5-internals') {
      try {
        return origLoad.call(this, request, parent, isMain);
      } catch {
        return origLoad.call(this, 'eslint-scope', parent, isMain);
      }
    }
    return origLoad.call(this, request, parent, isMain);
  };
  resolvedParser = require.resolve('@babel/eslint-parser');
  parserOptions = {
    requireConfigFile: false,
    ecmaVersion: 2022,
    sourceType: 'module',
    babelOptions: {
      presets: [
        [require.resolve('@babel/preset-typescript'), { isTSX: true, allExtensions: true }],
      ],
    },
  };
}

module.exports = {
  root: true,
  parser: resolvedParser,
  parserOptions,
  env: {
    node: true,
    es6: true,
    browser: true,
  },
  rules: {
    'no-console': ['warn', { allow: ['info', 'warn', 'error'] }],
    'no-eval': 'error',
    'no-var': 'error',
    'prefer-const': 'error',
    eqeqeq: ['error', 'always'],
  },
};
