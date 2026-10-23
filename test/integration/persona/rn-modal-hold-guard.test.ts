// An RN Modal is a native window that outlives a JS reload, so every file that imports `Modal` from
// 'react-native' must take a restart hold. Reads source by path (invisible to tsc).
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const ALLOWED = [
    'components/ui/bottom-sheet/index.tsx',
    'components/ui/help-modal/index.tsx',
    'components/custom/FeedbackWidgetModal.tsx',
    'components/custom/share-stats/StatsShareModal.tsx',
    'components/custom/config-mera/SecuritySettingsSection.tsx',
    'components/custom/auth/MoveToPhoneHost.tsx',
    'components/custom/VideoPlayerModal.tsx',
    'components/custom/nav/InlineChoiceChip.tsx',
];

function walk(dir: string): string[] {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) return walk(rel);
        return /\.tsx?$/.test(e.name) ? [rel] : [];
    });
}

/** True when `Modal` is among the names imported from 'react-native' (single or multi-line import). */
function importsRnModal(src: string): boolean {
    const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'react-native'/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
        if (m[1].split(',').some((n) => n.trim() === 'Modal')) return true;
    }
    return false;
}

describe('RN Modal importers hold a restart', () => {
    const importers = ['components', 'app'].flatMap(walk).filter((f) => importsRnModal(fs.readFileSync(path.join(ROOT, f), 'utf8')));

    it('only allowlisted files import RN Modal', () => {
        expect(importers.filter((f) => !ALLOWED.includes(f))).toEqual([]);
    });

    it.each(ALLOWED)('%s takes useRestartHold', (f) => {
        expect(fs.readFileSync(path.join(ROOT, f), 'utf8')).toContain('useRestartHold(');
    });
});
