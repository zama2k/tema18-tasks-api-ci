/**
 * `npm run build`: this project ships plain JavaScript, so there is nothing to transpile.
 * The build step instead proves the deployable tree is complete and loadable:
 * every module compiles, the app can be created, and the runtime assets exist.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REQUIRED_PATHS = ['src/server.js', 'src/app.js', 'src/db/migrations', 'public/index.html', 'package-lock.json'];

function listJsFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJsFiles(fullPath);
    return entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

/** Returns a list of human readable problems; empty means the tree is deployable. */
function checkBuild(root) {
  const problems = [];

  for (const required of REQUIRED_PATHS) {
    if (!fs.existsSync(path.join(root, required))) problems.push(`missing ${required}`);
  }

  const migrationsDir = path.join(root, 'src/db/migrations');
  if (fs.existsSync(migrationsDir) && !fs.readdirSync(migrationsDir).some((f) => f.endsWith('.sql'))) {
    problems.push('src/db/migrations has no .sql files');
  }

  const srcDir = path.join(root, 'src');
  if (fs.existsSync(srcDir)) {
    for (const file of listJsFiles(srcDir)) {
      try {
        // Compiles without executing (server.js and db/cli.js would start side effects).
        new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
      } catch (error) {
        problems.push(`${path.relative(root, file)}: ${error.message}`);
      }
    }
  }

  return problems;
}

function main() {
  const root = path.join(__dirname, '..');
  const problems = checkBuild(root);

  if (problems.length > 0) {
    process.stderr.write(`build check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }

  const { createApp } = require(path.join(root, 'src/app'));
  const { createMemoryRepository } = require(path.join(root, 'src/models/task.model'));
  createApp({ repository: createMemoryRepository() });
  process.stdout.write('build check passed: sources compile, app can be created, assets present\n');
}

if (require.main === module) main();

module.exports = { checkBuild };
