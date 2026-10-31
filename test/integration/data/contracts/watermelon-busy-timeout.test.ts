// plugins/withWatermelonBusyTimeout.js swaps busy_timeout ahead of WAL in
// WatermelonDB's shared Database.cpp at prebuild (MERA-APP-8P). The last case
// reads the INSTALLED file, so a WatermelonDB bump that moves the pragmas fails
// here rather than in an EAS build.
import fs from 'fs';

const plugin = require('../../../../plugins/withWatermelonBusyTimeout');
const { patchDatabaseCpp, databaseCppPath } = plugin;

const WAL = '    initSql += "pragma journal_mode = WAL;";\n';
const TIMEOUT =
  '    // set timeout before SQLITE_BUSY error is returned\n' +
  '    initSql += "pragma busy_timeout = 5000;";\n';
const wrap = (body: string) => `    std::string initSql = "";\n\n${body}\n    executeMultiple(initSql);\n`;

const order = (src: string) => [src.indexOf('busy_timeout'), src.indexOf('journal_mode')];

describe('withWatermelonBusyTimeout', () => {
  it('puts busy_timeout before journal_mode = WAL', () => {
    const [timeout, wal] = order(patchDatabaseCpp(wrap(`${WAL}\n${TIMEOUT}`)));
    expect(timeout).toBeGreaterThan(-1);
    expect(timeout).toBeLessThan(wal);
  });

  it('leaves an already patched file unchanged', () => {
    const once = patchDatabaseCpp(wrap(`${WAL}\n${TIMEOUT}`));
    expect(patchDatabaseCpp(once)).toBe(once);
  });

  it('throws when the anchor moved', () => {
    expect(() => patchDatabaseCpp(wrap('    initSql += "pragma journal_mode = DELETE;";\n'))).toThrow(
      /pragmas moved/,
    );
  });

  it('matches the installed WatermelonDB source', () => {
    const src = fs.readFileSync(databaseCppPath(process.cwd()), 'utf8');
    expect(() => patchDatabaseCpp(src)).not.toThrow();
    const [timeout, wal] = order(patchDatabaseCpp(src));
    expect(timeout).toBeLessThan(wal);
  });
});
