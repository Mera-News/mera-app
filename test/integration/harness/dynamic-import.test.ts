// Guard: import() works under the integration project (test/helpers/babel-dynamic-import.js). Without
// the transform every dynamic import rejects with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG, and app
// code that catches it skips whole branches while its seam tests stay green.
import database from '@/lib/database';
import { toastManager } from '@/lib/toast-manager';

it('a dynamic import resolves to the module, named exports and default', async () => {
  const named = await import('@/lib/algorithms/mask-email');
  expect(Object.keys(named).length).toBeGreaterThan(0);
  const cjs = await import('node:path');
  expect(typeof cjs.default.join).toBe('function');
});

it("toastManager.showNotifiedToast persists its inbox row through its dynamic import", async () => {
  await toastManager.showNotifiedToast({ type: 'fact_check_done', title: 'factCheck.notify.title', body: 'b', source: 'harness:dynamic-import' } as never);
  const rows = await database.get('notifications').query().fetch();
  expect(rows.map((r) => (r as unknown as { source: string }).source)).toContain('harness:dynamic-import');
});
