// Babel plugin, integration Jest project only: `import(x)` becomes a require() inside a resolved
// promise. Jest runs CommonJS without --experimental-vm-modules, so a real dynamic import throws
// ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG and any code path behind one (toastManager's inbox
// row write) could not be tested. A CommonJS module without __esModule gets the ESM-style default.
// The require runs at once, as Expo's native async require does for a module in the bundle: a missing
// module then throws synchronously, never as a rejection a `.catch` could take.
module.exports = function dynamicImportToRequire({ template }) {
  const build = template.expression(
    '(() => { const m = require(SOURCE); return Promise.resolve(m && m.__esModule ? m : Object.assign({ default: m }, m)); })()',
  );
  return {
    name: 'mera-dynamic-import-to-require',
    visitor: {
      CallExpression(path) {
        if (path.node.callee.type !== 'Import') return;
        path.replaceWith(build({ SOURCE: path.node.arguments[0] }));
      },
    },
  };
};
