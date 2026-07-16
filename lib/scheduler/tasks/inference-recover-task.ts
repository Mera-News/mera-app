import { recoverCycle } from '@/lib/services/cycle-state-machine';
import { AppScheduler } from '../AppScheduler';

AppScheduler.register({
  name: 'inference-recover',
  displayName: 'Inference Recovery',
  frequency: 0,
  triggers: ['app-foreground'],
  conditions: [{ type: 'authenticated' }, { type: 'db-ready' }],
  timeout: 120_000,
  maxAttempts: 1,
  exclusive: true,
  handler: async (_input, ctx) => {
    ctx.log('recovering cycle');
    await recoverCycle();
  },
});
