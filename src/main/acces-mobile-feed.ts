// Accès mobile feed (#337) — the binding: the real history loader (account-aware sdkHistory) and the platform broadcast tap.
// All the logic is in acces-mobile-feed-core.ts (tested under node --test).

import { onBroadcast } from './platform';
import { sdkHistory } from './agent-sdk';
import { scoped } from './logger';
import { createMobileFeed } from './acces-mobile-feed-core';

const log = scoped('acces-mobile');

const feed = createMobileFeed({ loadHistory: sdkHistory, onBroadcast, warn: (m, e) => log.warn(m, e) });

export const getMobileConversation = feed.getMobileConversation;
export const subscribeMobileFeed = feed.subscribeMobileFeed;
export const mobileFeedState = feed.mobileFeedState;
