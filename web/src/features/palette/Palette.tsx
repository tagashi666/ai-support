import { Fragment, type JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { listTime } from '@/lib/format/format';
import { getJson, readToken } from '@/lib/live/api';
import { liveName } from '@/lib/live/labels';
import { connection, inbox } from '@/lib/live/store';
import { letterKeys } from '@/lib/device';
import { modLabel } from '@/lib/keys';
import { navigate } from '@/lib/router';
import { now } from '@/lib/store/state';
import { CLASSIC_VIEW, COMMANDS, commandsOnly, matchCommand, readRecent, searchable, type Group } from '@/lib/palette/commands';
import { commandAllowed, openThreadId, paletteOpen, runCommand } from '@/lib/palette/run';
import { permissions } from '@/lib/workspace/actions';
import s from './palette.module.css';

interface SearchResponse {
  conversations: Array<{ id: number; display_name: string | null; username: string | null; subject: string | null; last_message_at: number; hidden?: number }>;
  messages: Array<{ id: number; conversation_id: number; text: string | null; created_at: number }>;
  customers: Array<{ id: number; display_name: string | null; username: string | null; conversation_id: number | null }>;
  knowledge: Array<{ id: number; title: string; excerpt?: string; source?: string; ext_id?: string | null }>;
}

interface Option { key: string; group: Group; label: string; hint?: string; keys?: string; run: () => void }

const SEARCH_MS = 180;
const LIMIT = 8;
const GROUP_KEY: Record<Group, Parameters<typeof t>[0]> = {
  recent: 'palette.recent', actions: 'palette.actions', chats: 'palette.chats', messages: 'palette.messages',
  clients: 'palette.clients', articles: 'palette.articles', settings: 'palette.settings',
};

/** Одиночные буквы в подсказках — только если включены в «Этом устройстве». */
const shownKeys = (keys: string | undefined): string | undefined => {
  if (!keys) return undefined;
  if (/^[A-Z]$/.test(keys) && !letterKeys.value) return undefined;
  return keys;
};

const nameOf = (row: { display_name: string | null; username: string | null }, id: number): string =>
  row.display_name || (row.username ? `@${row.username}` : `#${id}`);

/**
 * Палитра ⌘K / Ctrl+K (6.5): действия (с клавишей справа — так палитра учит
 * клавишам), диалоги, сообщения, клиенты, статьи, настройки. ↑↓ и Enter, Tab
 * между группами, Esc закрывает только палитру; результаты — listbox с
 * aria-activedescendant. Ответы поиска не обгоняют друг друга.
 */
export function Palette(): JSX.Element {
  const open = paletteOpen.value;
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<{ q: string; data: SearchResponse } | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const seq = useRef(0);
  const inThread = openThreadId() !== null;
  const perms = permissions.value;
  const offline = connection.value === 'offline';

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) { dialog.showModal(); setQuery(''); setResult(null); setActive(0); requestAnimationFrame(() => input.current?.focus()); }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Поиск на сервере: от 2 символов, задержка 180 мс, защита от гонки ответов.
  useEffect(() => {
    if (!open || !searchable(query) || offline) { setState('idle'); return undefined; }
    const q = query.trim();
    const my = ++seq.current;
    setState('loading');
    const timer = setTimeout(() => {
      getJson<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`, readToken() ?? '')
        .then((data) => { if (my === seq.current) { setResult({ q, data }); setState('idle'); } })
        .catch(() => { if (my === seq.current) setState('error'); });
    }, SEARCH_MS);
    return () => clearTimeout(timer);
  }, [query, open, offline]);

  const close = (): void => { paletteOpen.value = false; };
  const go = (option: Option): void => { close(); option.run(); };

  const options = useMemo<Option[]>(() => {
    const list: Option[] = [];
    const q = query.trim();
    if (!q) {
      const entries = inbox.peek().entries;
      for (const id of readRecent()) {
        const item = entries.get(id)?.item;
        if (item) list.push({ key: `r${id}`, group: 'recent', label: liveName(item), hint: listTime(item.activity_at, now.peek()), run: () => navigate({ name: 'chats', id: String(id) }) });
      }
    }
    const commands = COMMANDS.filter((def) => commandAllowed(def, inThread))
      .filter((def) => matchCommand(def, t(def.label), q))
      .sort((a, b) => Number(Boolean(b.inThread)) - Number(Boolean(a.inThread)));
    for (const def of commands.filter((entry) => entry.group === 'actions').slice(0, q ? LIMIT : 5)) {
      list.push({ key: def.id, group: 'actions', label: t(def.label), keys: shownKeys(def.keys), run: () => runCommand(def.id) });
    }
    if (!commandsOnly(query) && result && result.q === q) {
      for (const row of result.data.conversations.slice(0, LIMIT)) {
        list.push({ key: `c${row.id}`, group: 'chats', label: nameOf(row, row.id), hint: row.hidden ? t('palette.hiddenMark') : row.subject || listTime(row.last_message_at, now.peek()),
          run: () => navigate({ name: 'chats', id: String(row.id) }) });
      }
      for (const row of result.data.messages.slice(0, LIMIT)) {
        list.push({ key: `m${row.id}`, group: 'messages', label: `«${(row.text ?? '').slice(0, 80)}»`, hint: listTime(row.created_at, now.peek()),
          run: () => navigate({ name: 'chats', id: String(row.conversation_id) }) });
      }
      for (const row of result.data.customers.slice(0, LIMIT)) {
        const target = row.conversation_id;
        list.push({ key: `p${row.id}`, group: 'clients', label: nameOf(row, row.id), hint: target ? t('palette.openClient') : t('palette.noConversation'),
          run: () => { if (target) navigate({ name: 'chats', id: String(target), client: true }); } });
      }
      for (const row of result.data.knowledge.slice(0, LIMIT)) {
        // Статья из файлов открывается сама (этап 5); FAQ из Bedolaga правится там — открываем «Знания».
        const file = row.source === 'files' && row.ext_id ? row.ext_id : null;
        list.push({ key: `k${row.id}`, group: 'articles', label: row.title, hint: file ? t('palette.openArticle') : t('palette.bedolagaFaq'),
          run: () => navigate(file ? { name: 'section', key: 'knowledge', sub: 'articles', item: file } : { name: 'section', key: 'knowledge' }) });
      }
    }
    for (const def of commands.filter((entry) => entry.group === 'settings').slice(0, q ? LIMIT : 0)) {
      list.push({ key: def.id, group: 'settings', label: t(def.label), ...(CLASSIC_VIEW[def.id] ? { hint: t('palette.inClassic') } : {}), run: () => runCommand(def.id) });
    }
    return list;
  }, [query, result, inThread, perms, letterKeys.value]);

  const current = Math.min(active, Math.max(0, options.length - 1));
  const activeId = options[current] ? `pal-${options[current]!.key}` : undefined;

  useEffect(() => {
    if (activeId) ref.current?.querySelector(`#${CSS.escape(activeId)}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((current + 1) % Math.max(1, options.length)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((current - 1 + options.length) % Math.max(1, options.length)); }
    else if (event.key === 'Enter') { event.preventDefault(); const option = options[current]; if (option) go(option); }
    else if (event.key === 'Tab') {
      // Tab — к следующей группе.
      event.preventDefault();
      const group = options[current]?.group;
      const delta = event.shiftKey ? -1 : 1;
      for (let i = 1; i <= options.length; i += 1) {
        const index = (current + delta * i + options.length) % options.length;
        if (options[index]?.group !== group && (index === 0 || options[index - 1]?.group !== options[index]?.group)) { setActive(index); break; }
      }
    }
  };

  const q = query.trim();
  let lastGroup: Group | null = null;
  return (
    <dialog ref={ref} class={s.palette} aria-label={t('palette.title')} onClose={close}
      onClick={(event) => { if (event.target === ref.current) close(); }}>
      {open && (
        <>
          <div class={s.field} data-loading={state === 'loading' ? 'true' : 'false'}>
            <input ref={input} type="search" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
              aria-activedescendant={activeId} aria-label={t('palette.placeholder')} placeholder={t('palette.placeholder')}
              value={query} onInput={(event) => { setQuery((event.target as HTMLInputElement).value); setActive(0); }} onKeyDown={onKeyDown} />
            <button type="button" class={s.cancel} onClick={close}>{t('palette.cancel')}</button>
          </div>
          <div class={s.list} id="palette-list" role="listbox" aria-label={t('palette.results')}>
            {options.map((option, index) => {
              const head = option.group !== lastGroup ? <div class={s.group} role="presentation">{t(GROUP_KEY[option.group])}</div> : null;
              lastGroup = option.group;
              return (
                <Fragment key={option.key}>
                  {head}
                  <div id={`pal-${option.key}`} role="option" aria-selected={index === current} class={s.option}
                    onMouseMove={() => { if (index !== current) setActive(index); }} onClick={() => go(option)}>
                    <span class={s.label}>{option.label}</span>
                    {option.hint && <span class={s.hint}>{option.hint}</span>}
                    {option.keys && <kbd class={s.kbd}>{option.keys}</kbd>}
                  </div>
                </Fragment>
              );
            })}
          </div>
          <div class={s.status} role="status">
            {q.length === 1 && !commandsOnly(query) && t('palette.short')}
            {state === 'error' && <>{t('palette.error')} <button type="button" class={s.retry} onClick={() => setQuery(`${query} `)}>{t('live.retry')}</button></>}
            {offline && searchable(query) && t('palette.offline')}
            {searchable(query) && state === 'idle' && result?.q === q && options.every((option) => option.group === 'actions' || option.group === 'settings')
              && t('palette.nothing', { q })}
          </div>
          <p class={s.foot}>{t('palette.foot', { mod: modLabel(), k: 'K', enter: 'Enter', tab: 'Tab', esc: 'Esc' })}</p>
        </>
      )}
    </dialog>
  );
}
