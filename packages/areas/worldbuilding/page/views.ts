import { createMemo } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { Client } from '@st/page/client';

// A view the page holds once an action has opened it; reading it never opens it on its own.
export const shownView = <T>(client: Client, key: string): Accessor<T | undefined> =>
    createMemo(() => (client.version(key) > 0 ? client.view<T>(key)() : undefined));

// The view, opened if this tab doesn't hold it yet.
export const openedView = <T>(client: Client, key: string): Accessor<T | undefined> => client.view<T>(key);
