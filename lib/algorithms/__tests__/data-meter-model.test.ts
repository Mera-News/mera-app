import { meterFigures } from '@/components/custom/config-mera/data-meter-model';

const sizes = (o: Partial<Parameters<typeof meterFigures>[0]> = {}) => ({
  databaseBytes: 100_000_000,
  modelBytes: null,
  backupBytes: 0,
  freeBytes: 900_000_000,
  ...o,
});

describe('meterFigures', () => {
  it('sums the database alone without a model', () => {
    const f = meterFigures(sizes(), 'en');
    expect(f.used).toBe('100 MB');
    expect(f.rows.map((r) => r.key)).toEqual(['database']);
  });

  it('adds the model row and switches to GB at 1 GB', () => {
    const f = meterFigures(sizes({ modelBytes: 2_000_000_000 }), 'en');
    expect(f.used).toBe('2.1 GB');
    expect(f.rows.map((r) => r.key)).toEqual(['database', 'model']);
  });

  it('shows a backup row only when there is a backup', () => {
    expect(meterFigures(sizes({ backupBytes: 50_000_000 }), 'en').rows.map((r) => r.key)).toEqual(['database', 'backup']);
  });

  it('the shown total is the sum of the rounded rows, in MB', () => {
    const f = meterFigures(sizes({ databaseBytes: 100_400_000, backupBytes: 100_400_000 }), 'en');
    expect(f.rows.map((r) => r.value)).toEqual(['100 MB', '100 MB']);
    expect(f.used).toBe('200 MB');
  });

  it('the shown total is the sum of the rounded rows, in GB', () => {
    const f = meterFigures(sizes({ databaseBytes: 340_000_000, modelBytes: 1_340_000_000, backupBytes: 0 }), 'en');
    expect(f.rows.map((r) => r.value)).toEqual(['0.3 GB', '1.3 GB']);
    expect(f.used).toBe('1.6 GB');
  });

  it('formats numbers for the locale', () => {
    expect(meterFigures(sizes({ modelBytes: 2_000_000_000 }), 'de').used).toBe('2,1 GB');
  });

  it('fraction is used over used plus free, null free gives no fraction', () => {
    expect(meterFigures(sizes(), 'en').fraction).toBeCloseTo(0.1);
    expect(meterFigures(sizes({ freeBytes: null }), 'en').fraction).toBeNull();
    expect(meterFigures(sizes({ freeBytes: null }), 'en').free).toBeNull();
  });
});
