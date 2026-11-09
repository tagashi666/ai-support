/** Код причины с сервера → подпись словаря: на экран не попадают сырые коды. */
import { describe, expect, it } from 'vitest';
import type { InboxItem } from '@shared/api-types';
import type { ReasonCode } from '@shared/attention';
import { isUrgentCode, liveName, livePreview, liveReasonView } from './labels';

const CODES: ReasonCode[] = ['handoff', 'sla_overdue', 'ai_silent', 'draft_unsure', 'draft_ready', 'important', 'urgent',
  'sla_soon', 'waiting', 'check', 'ai_replying', 'ai_replied', 'waiting_client', 'window_closed', 'resolved'];
const NOW = Date.UTC(2026, 0, 15, 12, 0);

const item = (patch: Partial<InboxItem>): InboxItem => ({
  id: 7, section: 'mine', reason: { code: 'waiting', since: NOW - 3_600_000 }, waiting_since: NOW - 3_600_000,
  owner: null, last: null, customer: { name: null, username: null, avatar_version: null }, ...patch,
} as InboxItem);

describe('живой список: подписи', () => {
  it('у каждого кода причины есть текст без сырых значений', () => {
    for (const code of CODES) {
      const view = liveReasonView(item({ reason: { code, since: NOW - 600_000 } }), NOW);
      expect(view.text, code).not.toBe('');
      expect(view.text, code).not.toMatch(/[a-z]+_[a-z]+|\{\w+\}/);
    }
  });

  it('у коллег вместо причины — «Ведёт Мария»', () => {
    const view = liveReasonView(item({ section: 'colleagues', owner: { id: 'op:2', name: 'Мария', until: NOW } }), NOW);
    expect(view.text).toBe('Ведёт Мария');
  });

  it('срочные причины — янтарные, черновик — фиолетовый', () => {
    expect(isUrgentCode('handoff') && isUrgentCode('ai_silent') && !isUrgentCode('waiting')).toBe(true);
    expect(liveReasonView(item({ reason: { code: 'ai_silent', since: NOW } }), NOW).tone).toBe('attention');
    expect(liveReasonView(item({ reason: { code: 'draft_ready', since: NOW } }), NOW).tone).toBe('ai');
  });

  it('имя: имя клиента, затем @ник, затем номер', () => {
    expect(liveName(item({ customer: { name: 'Анна', username: 'anna', avatar_version: null } }))).toBe('Анна');
    expect(liveName(item({ customer: { name: null, username: 'anna', avatar_version: null } }))).toBe('@anna');
    expect(liveName(item({}))).toContain('7');
  });

  it('превью: автор и вложение словом', () => {
    expect(livePreview(item({ last: { author: 'assistant', kind: 'text', text: 'Готово', at: NOW } }))).toEqual({ who: 'Помощник:', text: 'Готово' });
    expect(livePreview(item({ last: { author: 'client', kind: 'photo', text: '', at: NOW } })).text).toBe('Вложение');
  });
});
