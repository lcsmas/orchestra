import React from 'react';
import type { RenderMessage } from '../../../shared/types';
import { MessageBubble } from './MessageBubble';
import { ToolCard } from './ToolCard';

interface Props {
  message: RenderMessage;
}

/**
 * The single entry point A2's `StructuredView` renders per {@link RenderMessage}:
 * routes a message to the right presentational component by role. `tool` messages
 * become a {@link ToolCard}; every other role (`assistant`/`user`/`system`/
 * `error`) becomes a {@link MessageBubble}. Both leaves are individually
 * memoized, so this router adds no re-render cost of its own.
 *
 * Usage in StructuredView:
 *   {session.messages.map((m) => <AgentMessage key={m.id} message={m} />)}
 */
function AgentMessageImpl({ message }: Props) {
  if (message.role === 'tool') {
    return <ToolCard message={message} />;
  }
  return <MessageBubble message={message} />;
}

export const AgentMessage = React.memo(AgentMessageImpl);
