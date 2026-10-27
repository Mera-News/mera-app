/**
 * The app is built with the React Compiler and jest is not, so a component the compiler skips
 * (a ref read or written during render, for one) passes every render test and ships unmemoised.
 * This compiles the toast and notification surfaces as the app build does and fails on any
 * CompileError. Files that skip on purpose (an eslint-disabled exhaustive-deps) are not listed.
 */
import { transformSync } from '@babel/core';
import { readFileSync } from 'fs';
import { join } from 'path';

const FILES = [
    'components/custom/notifications/NotificationSheet.tsx',
    'components/custom/notifications/NotificationSheetHost.tsx',
    'components/custom/notifications/NotificationRow.tsx',
    'components/custom/toast/MeraToast.tsx',
    'components/ui/bottom-sheet/index.tsx',
];

function compileErrors(file: string): string[] {
    const errors: string[] = [];
    const path = join(__dirname, '../../../..', file);
    transformSync(readFileSync(path, 'utf8'), {
        filename: path,
        babelrc: false,
        configFile: false,
        presets: [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]],
        plugins: [
            [
                'babel-plugin-react-compiler',
                {
                    logger: {
                        logEvent: (_f: string, event: { kind: string; detail?: { reason?: string } }) => {
                            if (event.kind === 'CompileError') errors.push(event.detail?.reason ?? 'unknown');
                        },
                    },
                },
            ],
        ],
    });
    return errors;
}

it.each(FILES)('%s compiles under the React Compiler with no bail-out', (file) => {
    expect(compileErrors(file)).toEqual([]);
});
