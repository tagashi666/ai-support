import type { JSX } from 'preact';
import { usePresence } from '@/ui/motion';
import { useRef, useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { clock, dayMonth, sameDay } from '@/lib/format/format';
import type { PausePreset } from '@/lib/assistant/model';
import { canPause, offline, pause, pauseFor, resumeAssistant } from '@/lib/assistant/store';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Option, Sheet } from '@/ui/Sheet';
import a from './assistant.module.css';

const PRESETS: ReadonlyArray<{ value: PausePreset; label: 'pause.hour' | 'pause.morning' | 'pause.forever' }> = [
  { value: 'hour', label: 'pause.hour' }, { value: 'morning', label: 'pause.morning' }, { value: 'forever', label: 'pause.forever' },
];

/** «до 15:00», «до 10 ноября, 09:00», «пока не включите». */
export function pauseText(until: number | null, now = Date.now()): string {
  if (until === null) return t('pause.untilOn');
  return sameDay(until, now) ? t('pause.until', { time: clock(until) }) : t('pause.until', { time: `${dayMonth(until)}, ${clock(until)}` });
}

/**
 * Пауза помощника везде (6.7, 10.4 п.1): кнопки «на 1 час / до утра / пока
 * не включу»; на паузе — когда кончится и «Возобновить». menu — одна кнопка
 * «Пауза ▾» с листом (карточка «Сегодня»).
 */
export function PauseControls({ menu = false }: { menu?: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const current = pause.value;
  const allowed = canPause.value && !offline.value;
  if (current) {
    return (
      <div class={a.pauseRow}>
        <span class={a.pauseState}><Icon name="pause" size={18} />{t('pause.state', { until: pauseText(current.until) })}</span>
        {allowed && <Button variant="primary" size="sm" onClick={() => void resumeAssistant()}>{t('pause.resume')}</Button>}
      </div>
    );
  }
  if (!allowed) return null;
  if (menu) {
    return (
      <>
        <Button variant="secondary" size="sm" icon="pause" aria-haspopup="dialog" onClick={() => setOpen(true)}>{t('pause.menu')}</Button>
        <Sheet open={open} onClose={() => setOpen(false)} title={t('pause.title')}>
          <p class={a.muted}>{t('pause.means')}</p>
          <div role="menu" aria-label={t('pause.title')}>
            {PRESETS.map((preset) => (
              <Option key={preset.value} label={t(preset.label)} onSelect={() => { setOpen(false); void pauseFor(preset.value); }} />
            ))}
          </div>
        </Sheet>
      </>
    );
  }
  return (
    <div class={a.pauseRow} role="group" aria-label={t('pause.title')}>
      <span class={a.pauseLabel}>{t('pause.title')}:</span>
      {PRESETS.map((preset) => (
        <Button key={preset.value} variant="secondary" size="sm" onClick={() => void pauseFor(preset.value)}>{t(preset.label)}</Button>
      ))}
    </div>
  );
}

/** Строка состояния всех экранов во время паузы: «Помощник на паузе до 15:00 · Возобновить» (6.7). */
export function PauseStrip({ hidden = [], onHide }: { hidden?: readonly string[]; onHide?: (key: string) => void } = {}): JSX.Element | null {
  const live = pause.value;
  const liveKey = live ? `p:${live.until}` : '';
  const shown = Boolean(live) && !hidden.includes(liveKey);
  // Уходит так же, как пришла (R2 C): пока гаснет — с прежним временем.
  const { mounted, closing } = usePresence(shown);
  const last = useRef(live);
  if (shown) last.current = live;
  const current = last.current;
  const key = current ? `p:${current.until}` : '';
  if (!mounted || !current) return null;
  return (
    <div class={a.strip} role="status" data-state={closing ? 'closing' : undefined} inert={closing || undefined}>
      <Icon name="pause" size={16} />
      <span class={a.stripText}>{t('pause.strip', { until: pauseText(current.until) })}</span>
      {canPause.value && !offline.value && (
        <Button variant="link" size="sm" onClick={() => void resumeAssistant()}>{t('pause.resume')}</Button>
      )}
      {onHide && <Button variant="quiet" size="sm" icon="close" label={t('shell.hideStrip')} class={a.stripClose} onClick={() => onHide(key)} />}
    </div>
  );
}
