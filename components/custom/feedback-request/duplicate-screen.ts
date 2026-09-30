// Is this feedback-request screen a second copy pushed directly on top of the
// same question? Pure, over the containing stack's navigation state, so the
// route screen can close a duplicate before it renders or stamps anything.

interface StackRouteLike {
    key: string;
    name: string;
    params?: object;
}

export interface StackStateLike {
    routes: readonly StackRouteLike[];
}

export const FEEDBACK_REQUEST_ROUTE_NAME = 'feedback-request';

export function isDuplicateFeedbackRequestScreen(
    state: StackStateLike | null | undefined,
    ownKey: string,
    id: unknown,
): boolean {
    if (!state || typeof id !== 'string') return false;
    const index = state.routes.findIndex((r) => r.key === ownKey);
    if (index <= 0) return false;
    const below = state.routes[index - 1];
    return (
        below.name === FEEDBACK_REQUEST_ROUTE_NAME &&
        (below.params as { id?: unknown } | undefined)?.id === id
    );
}
