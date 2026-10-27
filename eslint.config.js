const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'reports/**',
      'playwright-report/**',
      'blob-report/**',
      'test-results/**',
      '.stryker-tmp/**',
      'evidencias/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      curly: ['error', 'multi-line'],
    },
  },
  {
    files: ['src/**/*.js'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['tests/unit/**/*.js', 'tests/integration/**/*.js'],
    languageOptions: { globals: { ...globals.jest } },
  },
  {
    // page.evaluate() callbacks run in the browser
    files: ['tests/e2e/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
];
