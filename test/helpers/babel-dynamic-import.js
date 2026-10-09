// Babel plugin, integration Jest project only: `import(x)` becomes a require() inside a resolved
// promise. Jest runs CommonJS without --experimental-vm-modules, so a real dynamic import throws
// ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG and any code path behind one (toastManager's inbox
// row write) could not be tested. A CommonJS module without __esModule gets the ESM-style default.
module.exports = function dynamicImportToRequire({ template }) {
  const build = template.expression(
    'Promise.resolve().then(() => { const m = require(SOURCE); return m && m.__esModule ? m : Object.assign({ default: m }, m); })',
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
