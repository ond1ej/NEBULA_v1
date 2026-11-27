// Lazy screens that other screens preload (pointer down on a chat row, hover on a link): one shared handle each.
import { lazyNamed } from '../lib/lazy';

export const ConversationScreen = lazyNamed(() => import('./screens/ConversationScreen'), 'ConversationScreen');
