// Stryker's jest runner does not understand multi-project configs, and mutation testing
// only needs the fast, hermetic unit suite (no database).
// Relative glob (no <rootDir>): Stryker runs from a sandbox inside a dot-directory.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/unit/**/*.test.js'],
};
