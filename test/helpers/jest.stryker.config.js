// Stryker's Jest config: legacy + unit + integration together (R1). STRYKER_EXCLUDE is a comma-separated
// list of test paths (ROOT-relative) to leave out, so a gate "after" run differs from "before" by
// exactly the replaced tests (R3).
const path = require('path');
const base = require('../../jest.config.js');
const root = path.resolve(__dirname, '../..');
const exclude = (process.env.STRYKER_EXCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean)
  .map((p) => path.resolve(root, p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
// STRYKER_ONLY is a comma-separated list of test paths (ROOT-relative) to run and nothing else. The
// jest runner passes --testFiles to the dry run only; every mutant run then loads every test file of
// every project and filters by test name, which costs minutes per mutant once the repo has hundreds
// of suites. Ignoring everything but the listed files keeps a mutant run to the batch's own tests.
const only = (process.env.STRYKER_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
  .map((p) => path.resolve(root, p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const notOnly = only.length ? [`^(?!(?:${only.join('|')})$)`] : [];
module.exports = {
  ...base,
  rootDir: root,
  projects: base.projects
    .filter((p) => ['legacy', 'unit', 'integration'].includes(p.displayName))
    .map((p) => ({ ...p, rootDir: root, testPathIgnorePatterns: [...(p.testPathIgnorePatterns || ['/node_modules/']), ...exclude, ...notOnly] })),
};
