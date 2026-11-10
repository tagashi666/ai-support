import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { tr } from '@/i18n/sections/system';
import { clock } from '@/lib/format/format';
import {
  aliasName, bytesWords, countryName, nodeState, nodeStateWords, serversWords, sortNodes, type NodeRow, type NodesSnapshot,
} from '@/lib/system/model';
import { loadNodes, nodes, refreshNodes, rights, saveAlias } from '@/lib/system/store';
import { Button } from '@/ui/Button';
import { InlineField } from '@/ui/InlineField';
import s from './system.module.css';

function State({ node }: { node: NodeRow }): JSX.Element {
  const state = nodeState(node);
  return <span class={s.state}><span class={s.dot} data-tone={state === 'online' ? 'ok' : state === 'offline' ? 'error' : 'off'} aria-hidden="true" />{nodeStateWords(node)}</span>;
}

function Alias({ node }: { node: NodeRow }): JSX.Element {
  if (!rights.value.editNodes) return <span>{node.alias ?? tr('system.servers.noAlias')}</span>;
  return (
    <InlineField label={tr('system.servers.aliasLabel', { name: node.name })} hideLabel value={node.alias ?? ''} maxLength={40}
      placeholder={tr('system.servers.aliasPlaceholder')} onSave={(next) => saveAlias(aliasName(node), next)} />
  );
}

/** Таблица — от 768 px, ниже карточки; рисуем что-то одно, чтобы поля не дублировались. */
function useWide(): boolean {
  const query = '(min-width: 768px)';
  const [wide, setWide] = useState(() => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(query);
    const on = (): void => setWide(media.matches);
    media.addEventListener('change', on);
    on();
    return () => media.removeEventListener('change', on);
  }, []);
  return wide;
}

const source = (node: NodeRow): string => node.sourceName ?? tr('system.servers.noSource');
const users = (node: NodeRow): string => (node.disabled || !node.online ? tr('system.dash') : String(node.usersOnline ?? 0));
const traffic = (node: NodeRow): string => (node.trafficUsedBytes === undefined ? tr('system.dash') : bytesWords(node.trafficUsedBytes));

function Table({ list }: { list: NodeRow[] }): JSX.Element {
  return (
    <table class={s.table}>
      <thead>
        <tr>
          <th scope="col">{tr('system.servers.col.name')}</th>
          <th scope="col">{tr('system.servers.col.country')}</th>
          <th scope="col">{tr('system.servers.col.state')}</th>
          <th scope="col" class={s.num}>{tr('system.servers.col.users')}</th>
          <th scope="col" class={s.num}>{tr('system.servers.col.traffic')}</th>
          <th scope="col">{tr('system.servers.col.source')}</th>
          <th scope="col">{tr('system.servers.col.alias')}</th>
        </tr>
      </thead>
      <tbody>
        {list.map((node) => (
          <tr key={aliasName(node)}>
            <th scope="row" class={s.nodeName}>{node.name}</th>
            <td>{countryName(node.country) || tr('system.dash')}</td>
            <td><State node={node} /></td>
            <td class={s.num}>{users(node)}</td>
            <td class={s.num}>{traffic(node)}</td>
            <td>{source(node)}</td>
            <td><Alias node={node} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Cards({ list }: { list: NodeRow[] }): JSX.Element {
  return (
    <ul class={s.cards}>
      {list.map((node) => (
        <li key={aliasName(node)} class={s.nodeCard}>
          <div class={s.nodeHead}><span class={s.nodeName}>{node.name}</span><State node={node} /></div>
          <div class={s.nodeFacts}>
            {node.country && <span>{countryName(node.country)}</span>}
            <span>{tr('system.servers.usersLine', { n: users(node) })}</span>
            <span>{tr('system.servers.trafficLine', { size: traffic(node) })}</span>
            <span>{source(node)}</span>
          </div>
          <Alias node={node} />
        </li>
      ))}
    </ul>
  );
}

function Loaded({ snapshot }: { snapshot: NodesSnapshot }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const wide = useWide();
  const list = sortNodes(snapshot.nodes);
  const refresh = async (): Promise<void> => { setBusy(true); await refreshNodes(); setBusy(false); };
  return (
    <div class={s.panel}>
      <div class={s.serverBar}>
        <span class={s.muted}>{tr('system.servers.dataAt', { time: clock(snapshot.at) })}</span>
        {rights.value.editNodes && <Button variant="secondary" size="sm" icon="undo" disabled={busy} onClick={() => void refresh()}>{tr('system.servers.refresh')}</Button>}
      </div>
      {snapshot.error && <p class={s.error} role="alert">{tr('system.servers.partial', { reason: snapshot.error })}</p>}
      {list.length === 0 ? (
        <div class={s.block}><p class={s.subhead}>{tr('system.servers.emptyTitle')}</p><p class={s.muted}>{tr('system.servers.emptyText')}</p></div>
      ) : (
        <>
          <p class={s.subhead} role="status">{serversWords(list)}</p>
          {wide ? <Table list={list} /> : <Cards list={list} />}
          <p class={s.hint}>{tr('system.servers.aliasHelp', { save: 'Enter', cancel: 'Esc' })}</p>
        </>
      )}
    </div>
  );
}

/** «Серверы» (бывшая «Инфраструктура», 6.9): таблица на компьютере, карточки на телефоне; три разных текста: выключено, ошибка, пусто. */
export function ServersPanel(): JSX.Element {
  useEffect(() => { void loadNodes(); }, []);
  const state = nodes.value;
  if (state === undefined) return <div class={s.panel} aria-busy="true"><div class={s.skeleton} aria-hidden="true" /></div>;
  if (state === null || state.kind === 'error') {
    return (
      <div class={s.panel}>
        <p class={s.error} role="alert">{tr('system.servers.error', { reason: state?.kind === 'error' ? state.message : tr('system.unknown') })}</p>
        <div class={s.actions}><Button variant="secondary" onClick={() => void loadNodes()}>{tr('system.retry')}</Button></div>
      </div>
    );
  }
  if (state.kind === 'off') {
    return <div class={s.block}><p class={s.subhead}>{tr('system.servers.offTitle')}</p><p class={s.muted}>{tr('system.servers.offText')}</p></div>;
  }
  return <Loaded snapshot={state.snapshot} />;
}
