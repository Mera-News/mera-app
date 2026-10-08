import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '..', 'ChatThread.tsx'), 'utf8');

// Mera's replies start on the thread's left edge, like the steps box, cards
// and input. A reserved avatar gutter indented them ~34pt (28 + 6 gap).
describe('assistant rows share the thread edge', () => {
  it('draws no avatar gutter or spacer', () => {
    expect(src).not.toMatch(/MeraStreamAvatar|AVATAR_GUTTER|avatarSpacer|gutterRow|mera-avatar-spacer/);
  });

  it('the plain, streaming and wait replies are bare bubbles', () => {
    // Nothing but comments and the empty-reply guard sits between Message and
    // the bubble: no sibling that could reserve a left gutter.
    expect(src).toMatch(
      /<Message role="assistant">[\s\S]{0,1400}?<View style={styles\.replyRow}>\s*<MessageContent role="assistant">/,
    );
    expect(src).toMatch(/<Message role="assistant">\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<WaitBubble>/);
  });
});
