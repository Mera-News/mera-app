// Per-flow route for the on-device chat flows (D43): 'kev' (Kev decides, the
// built-in model writes) or 'single' (one built-in model call, as before).
// Article chat and follow-story go back to 'single' if the harness shows 'kev'
// below AFM alone on that flow's test metrics; persona chat stays on 'kev'.

export type OnDeviceChatRoute = 'kev' | 'single';
export type OnDeviceChatFlow = 'persona' | 'article' | 'follow';

export const ON_DEVICE_CHAT_ROUTE: Record<OnDeviceChatFlow, OnDeviceChatRoute> = {
  persona: 'kev',
  article: 'kev',
  follow: 'kev',
};
