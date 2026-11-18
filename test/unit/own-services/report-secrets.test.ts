import fs from 'fs';
import path from 'path';
import { reportSecrets, setReportSecrets } from '@/lib/own-services/report-secrets';

afterEach(() => {
  setReportSecrets('ownAi', null);
  setReportSecrets('ownNews', null);
  setReportSecrets('pod', null);
});

describe('report secrets', () => {
  it('unions and deduplicates across kinds, lower-casing hosts', () => {
    setReportSecrets('ownAi', { hosts: ['AI.Own.Test'], secrets: ['secret-value-1'] });
    setReportSecrets('ownNews', { hosts: ['ai.own.test', 'news.own.test'], secrets: ['secret-value-1'] });
    const r = reportSecrets();
    expect([...r.hosts].sort()).toEqual(['ai.own.test', 'news.own.test']);
    expect(r.secrets).toEqual(['secret-value-1']);
  });

  it('clears a kind with null', () => {
    setReportSecrets('pod', { hosts: ['pod.test'], secrets: ['secret-value-2'] });
    setReportSecrets('pod', null);
    expect(reportSecrets()).toEqual({ hosts: [], secrets: [] });
  });

  it('drops secrets shorter than 8 characters', () => {
    setReportSecrets('ownAi', { hosts: [], secrets: ['1234567', '12345678'] });
    expect(reportSecrets().secrets).toEqual(['12345678']);
  });

  it('has no import or require', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../lib/own-services/report-secrets.ts'), 'utf8');
    expect(src).not.toMatch(/\bimport\b|\brequire\b/);
  });
});
