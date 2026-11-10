import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { ClientPanel } from '@/features/client/ClientPanel';
import { Thread } from '@/features/thread/Thread';
import { Today } from '@/features/today/Today';
import { markRead } from '@/lib/actions/chat';
import { isWide } from '@/lib/media';
import { byId, clientPinned } from '@/lib/store/state';
import { ChatList } from './ChatList';
import s from './chats.module.css';

/**
 * «Диалоги»: список и диалог. <768 — стек экранов; ≥768 — рядом;
 * ≥1440 — «Клиент» колонкой по кнопке; ≥1800 — закреплён по умолчанию (6.0).
 */
export function ChatsScreen({ id }: { id: string | null }): JSX.Element {
  const chat = id ? byId.value.get(id) ?? null : null;
  useEffect(() => { if (id) markRead(id); }, [id]);
  const pinned = clientPinned.value ?? true;
  const showClient = Boolean(chat) && isWide.value && pinned;
  return (
    <div class={s.screen} data-open={chat ? 'true' : 'false'} data-client={showClient ? 'true' : 'false'}>
      <section class={s.listCol}>
        <ChatList openId={id} />
      </section>
      <section class={s.threadCol}>
        {chat ? <Thread key={chat.id} chat={chat} /> : <div class={s.summary}><Today compact /></div>}
      </section>
      {showClient && chat && (
        <aside class={s.clientCol}>
          <ClientPanel chat={chat} onClose={() => { clientPinned.value = false; }} />
        </aside>
      )}
    </div>
  );
}
