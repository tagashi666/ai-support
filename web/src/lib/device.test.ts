/** «Это устройство» (6.12): клавиша отправки. */
import { describe, expect, it } from 'vitest';
import { isSendKey } from './device';

const key = (over: Partial<KeyboardEvent> = {}) => ({ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...over });

describe('Enter отправляет', () => {
  it('⌘/Ctrl+Enter отправляет всегда', () => {
    expect(isSendKey(key({ metaKey: true }), false)).toBe(true);
    expect(isSendKey(key({ ctrlKey: true }), false)).toBe(true);
  });
  it('просто Enter — только если включено; Shift+Enter — новая строка', () => {
    expect(isSendKey(key(), false)).toBe(false);
    expect(isSendKey(key(), true)).toBe(true);
    expect(isSendKey(key({ shiftKey: true }), true)).toBe(false);
  });
  it('набор через IME не отправляет', () => {
    expect(isSendKey(key({ isComposing: true }), true)).toBe(false);
    expect(isSendKey(key({ key: 'a' }), true)).toBe(false);
  });
});
