// Renders a message that marks emphasis with **double asterisks**: `rich('devices.remove.body1')`.
import type { ReactNode } from 'react';
import { t, type Args, type MessageKey } from './index';

export function rich<K extends MessageKey>(key: K, ...args: Args<K>): ReactNode[] {
  return t(key, ...args)
    .split('**')
    .map((part, i) => (i % 2 === 1 ? <strong key={i} className="text-text">{part}</strong> : part));
}
