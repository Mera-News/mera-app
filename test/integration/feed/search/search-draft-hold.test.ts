import { act, renderHook } from '@testing-library/react-native';

import { useSearchDraftHold } from '@/components/custom/world/use-search-draft-hold';
import { activeHolds } from '@/lib/app-restart';

describe('Search draft hold', () => {
  it('holds a restart while text is typed and releases when emptied or unmounted', () => {
    const { rerender, unmount } = renderHook(({ q }: { q: string }) => useSearchDraftHold(q), {
      initialProps: { q: '' },
    });
    expect(activeHolds('update')).not.toContain('draft:search');

    rerender({ q: 'budget' });
    expect(activeHolds('update')).toContain('draft:search');

    rerender({ q: '   ' });
    expect(activeHolds('update')).not.toContain('draft:search');

    rerender({ q: 'x' });
    expect(activeHolds('update')).toContain('draft:search');
    act(() => unmount());
    expect(activeHolds('update')).not.toContain('draft:search');
  });
});
