// D6: a server persona's processingMode reaches the local store only through
// localModeFor (OnDevice only when On this phone can run), or a read on a phone
// that cannot run undoes the local Private cloud fallback. MeraChatSession did
// exactly that on chat open, and no seam test mounts it (no component renders),
// so this reads the source as text.
//
// The Mera Protocol screen gates the same copy by hand on its own runnable read,
// and settings-mera-protocol.test.ts covers it behaviourally.

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const HAND_GATED = new Set(['components/custom/config-mera/useMeraProtocolSettings.tsx']);

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) return sourceFiles(rel);
        return /\.tsx?$/.test(e.name) ? [rel] : [];
    });
}

/** `setProcessingMode(` calls whose argument reads a persona's mode without going through localModeFor. */
function rawCopies(source: string): string[] {
    const calls = source.match(/setProcessingMode\(\s*[^;]*?\)\s*;/g) ?? [];
    return calls.filter((c) => /[pP]ersona\??\.processingMode/.test(c) && !c.includes('localModeFor('));
}

describe('a server persona mode reaches the local store only through localModeFor', () => {
    it('the chat open path goes through it', () => {
        const chat = fs.readFileSync(path.join(ROOT, 'components/custom/floating-chat/MeraChatSession.tsx'), 'utf8');
        expect(rawCopies(chat)).toEqual([]);
        expect(chat).toContain('setProcessingMode(await localModeFor(persona.processingMode))');
    });

    it('no other app file copies it raw', () => {
        const offenders = ['app', 'components', 'lib']
            .flatMap(sourceFiles)
            .filter((f) => !HAND_GATED.has(f))
            .filter((f) => rawCopies(fs.readFileSync(path.join(ROOT, f), 'utf8')).length > 0);
        expect(offenders).toEqual([]);
    });
});
