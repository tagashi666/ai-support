/**
 * Клавиши всей панели (7.3) по event.code — в русской раскладке тоже.
 * ⌘K/Ctrl+K — палитра (и из поля ввода); остальное — только вне поля ввода и
 * без открытого листа. Переходы (G …, [ ], ?) выключаются одним
 * переключателем, одиночные буквы — другим и по умолчанию выключены.
 */
import { useEffect } from 'preact/hooks';
import { letterKeys, navKeys } from '@/lib/device';
import { inField, isMod, layerOpen, plain } from '@/lib/keys';
import { keysHelpOpen, LETTERS, openThreadId, paletteOpen, runCommand, step } from '@/lib/palette/run';
import { navigate } from '@/lib/router';
import { mode } from '@/lib/live/store';

const G_MS = 1200;

export function useGlobalKeys(): void {
  useEffect(() => {
    let gAt = 0;
    const onKey = (event: KeyboardEvent): void => {
      if (event.code === 'KeyK' && isMod(event) && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        paletteOpen.value = !paletteOpen.peek();
        return;
      }
      if (event.defaultPrevented || inField(event.target) || layerOpen() || event.isComposing) return;
      const live = mode.peek() === 'live';
      if (navKeys.peek()) {
        if (event.code === 'Slash' && plain(event, true)) { event.preventDefault(); keysHelpOpen.value = true; return; }
        if (event.code === 'KeyG' && plain(event)) { gAt = Date.now(); return; }
        if (gAt && Date.now() - gAt < G_MS && plain(event)) {
          gAt = 0;
          const target = { KeyS: 'today', KeyD: 'chats', KeyK: 'knowledge', KeyA: 'assistant' }[event.code];
          if (target === 'today') navigate({ name: 'today' });
          else if (target === 'chats') navigate({ name: 'chats', id: null });
          else if (target === 'knowledge') navigate({ name: 'section', key: 'knowledge' });
          else if (target === 'assistant') navigate({ name: 'section', key: 'assistant' });
          if (target) { event.preventDefault(); return; }
        }
        if ((event.code === 'BracketLeft' || event.code === 'BracketRight') && plain(event) && live && openThreadId() !== null) {
          if (step(event.code === 'BracketLeft' ? -1 : 1)) event.preventDefault();
          return;
        }
      }
      if (!letterKeys.peek() || !plain(event) || !live) return;
      const thread = openThreadId();
      const command = LETTERS[event.code];
      if (command && (thread !== null || command === 'list.select')) { event.preventDefault(); runCommand(command); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
}
