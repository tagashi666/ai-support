/** Палитра и клавиши совпадают с реестром действий (план, 7.4, третий автотест). */
import { describe, expect, it } from 'vitest';
import { codeLabel } from '@/lib/keys';
import { ACTIONS } from '@/lib/workspace/registry';
import { COMMANDS, commandsOnly, LETTERS, matchCommand, NEXT_VIEW, searchable } from './commands';

describe('палитра', () => {
  it('команды ссылаются на существующие действия реестра', () => {
    for (const def of COMMANDS) if (def.action) expect(ACTIONS[def.action], def.id).toBeDefined();
  });

  it('клавиша в подсказке палитры = клавиша реестра = обработчик клавиш', () => {
    for (const def of COMMANDS) {
      const registryKey = def.action ? ACTIONS[def.action].key : undefined;
      if (registryKey?.startsWith('Key') && def.keys) expect(def.keys, def.id).toBe(codeLabel(registryKey));
    }
    for (const [code, id] of Object.entries(LETTERS)) {
      const def = COMMANDS.find((entry) => entry.id === id);
      if (def) expect(def.keys, id).toBe(codeLabel(code));
    }
  });

  it('у команд настроек есть раздел новой панели (этап 6: в классику не ведут)', () => {
    for (const def of COMMANDS.filter((entry) => entry.group === 'settings')) expect(NEXT_VIEW[def.id], def.id).toBeTruthy();
  });

  it('находит по старым словам классики', () => {
    const find = (q: string): string[] => COMMANDS.filter((def) => matchCommand(def, def.id, q)).map((def) => def.id);
    expect(find('нода')).toContain('set.nodes');
    expect(find('предложка')).toContain('set.assistant');
    expect(find('SLA')).toContain('set.sla');
    expect(find('ai-студия')).toContain('set.lab');
    expect(find('тёмн')).toContain('theme.dark');
    expect(find('пауза')).toEqual(expect.arrayContaining(['assistant.pauseHour', 'assistant.resume']));
  });

  it('«>» — только команды; поиск от двух символов', () => {
    expect(commandsOnly('> тема')).toBe(true);
    expect(searchable('> тема')).toBe(false);
    expect(searchable('а')).toBe(false);
    expect(searchable('ан')).toBe(true);
  });

  it('клавиши по физической клавише: подписи латиницей', () => {
    expect(codeLabel('KeyE')).toBe('E');
    expect(codeLabel('BracketRight')).toBe(']');
  });
});
