import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '../../../../components/custom/floating-chat/ChatThread.tsx'), 'utf8');

// Mera's replies start on the thread's left edge, like the steps box, cards
// and input. A reserved avatar gutter indented them ~34pt (28 + 6 gap).
describe('assistant rows share the thread edge', () => {
  it('draws no avatar gutter or spacer', () => {
    expect(src).not.toMatch(/MeraStreamAvatar|AVATAR_GUTTER|avatarSpacer|gutterRow|mera-avatar-spacer/);
  });

  it('the plain, streaming and wait replies are bare bubbles', () => {
    // Nothing but comments and the empty-reply guard sits between Message and
    // the bubble: no sibling that could reserve a left gutter. The bubble may
    // take props (the first-words handover fades its surface in).
    expect(src).toMatch(
      /<Message role="assistant">[\s\S]{0,1400}?<View style={styles\.replyRow}>\s*<MessageContent role="assistant"[^>]*>/,
    );
    expect(src).toMatch(/<Message role="assistant">\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<WaitBubble[\s>]/);
  });
});

// The reply bubble keeps ONE tree from its first token to the end of the
// stream. When the container type, or the entering wrapper, followed
// `streaming` / `handover`, the end of the stream remounted the bubble: the
// surface vanished, the text dimmed for a frame and re-landed lower.
describe('a finished reply keeps the streaming bubble', () => {
  it('the assistant bubble is always StreamingBubble', () => {
    expect(src).toMatch(/<MessageContent role="assistant" as=\{StreamingBubble\}>/);
  });

  it('the entering wrapper does not come or go with the handover', () => {
    expect(src).not.toMatch(/startsWith\('live-'\)\s*&&\s*!item\.handover/);
    expect(src).toMatch(/entering=\{item\.handover \? undefined : MESSAGE_ENTERING\}/);
  });
});
