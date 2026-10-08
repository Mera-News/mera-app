import { IDLE, shareFlow } from '../share-flow';

const cards = ['publications', 'languages', 'now'] as const;

describe('shareFlow', () => {
    it('Share enters select mode with every card picked', () => {
        expect(shareFlow(IDLE, { type: 'start', cards })).toEqual({
            selecting: true,
            picked: [...cards],
            previewOpen: false,
        });
    });

    it('closing the preview by any route leaves select mode', () => {
        const open = shareFlow(shareFlow(IDLE, { type: 'start', cards }), { type: 'preview' });
        expect(open.previewOpen).toBe(true);
        expect(shareFlow(open, { type: 'closePreview' })).toEqual(IDLE);
    });

    it('Cancel leaves select mode without previewing', () => {
        const selecting = shareFlow(IDLE, { type: 'start', cards });
        expect(shareFlow(selecting, { type: 'cancel' })).toEqual(IDLE);
    });

    it('Preview does nothing with nothing picked', () => {
        let s = shareFlow(IDLE, { type: 'start', cards: ['now'] });
        s = shareFlow(s, { type: 'toggle', id: 'now' });
        expect(s.picked).toEqual([]);
        expect(shareFlow(s, { type: 'preview' }).previewOpen).toBe(false);
    });
});
