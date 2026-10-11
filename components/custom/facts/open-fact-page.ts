import { router, type Href } from 'expo-router';

/** Opens the fact page inside the You stack (Profile, Facts). The Feed opens
 *  it through its own stack route, `feed/interest`. */
export function openFactPage(fact: { readonly id: string; readonly statement: string }): void {
    router.push({
        pathname: '/logged-in/app_container/you/fact',
        params: { factId: fact.id, statement: fact.statement },
    } as Href);
}
