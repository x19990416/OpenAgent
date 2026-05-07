import { useEffect, useRef } from 'react';
import type { MessageItem } from '@shared-types/events';
import { MessageList } from '@/components/chat/message-list';

interface ConversationPaneProps {
  messages: MessageItem[];
}

export function ConversationPane({ messages }: ConversationPaneProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const lastRenderKeyRef = useRef<string>('');
  const latestMessage = messages[messages.length - 1] ?? null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderKey = latestMessage ? `${latestMessage.id}:${latestMessage.content.length}` : 'empty';
    if (renderKey === lastRenderKeyRef.current) {
      return;
    }
    lastRenderKeyRef.current = renderKey;

    const shouldForceScroll = latestMessage?.role === 'user';
    if (!shouldStickToBottomRef.current && !shouldForceScroll) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: shouldForceScroll ? 'smooth' : 'auto'
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [latestMessage]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldStickToBottomRef.current = distanceToBottom <= 48;
  };

  return (
    <section ref={containerRef} className="conversation-pane scroll-y" onScroll={handleScroll}>
      <MessageList messages={messages} />
    </section>
  );
}
