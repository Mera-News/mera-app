// Stryker's Jest config: legacy + integration together (R1). STRYKER_EXCLUDE is a comma-separated
// list of test paths (ROOT-relative) to leave out, so a gate "after" run differs from "before" by
// exactly the replaced tests (R3).
const path = require('path');
const base = require('../../jest.config.js');
const root = path.resolve(__dirname, '../..');
const exclude = (process.env.STRYKER_EXCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean)
  .map((p) => path.resolve(root, p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
module.exports = {
  ...base,
  rootDir: root,
  projects: base.projects
    .filter((p) => p.displayName === 'legacy' || p.displayName === 'integration')
    .map((p) => ({ ...p, rootDir: root, testPathIgnorePatterns: [...(p.testPathIgnorePatterns || ['/node_modules/']), ...exclude] })),
};
