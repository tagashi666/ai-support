import type { JSX } from 'preact';
import { Collapse } from '@/ui/Collapse';
import { Segmented } from '@/ui/Segmented';
import { useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import {
  browserNotify, density, enterSends, setBrowserNotify, gestures, letterKeys, navKeys, playWaitSound, setDensity, setEnterSends, setGestures, setLetterKeys, setNavKeys,
  setStartScreen, setTextSize, setUndo, setWaitSound, startScreen, textSize, undoScope, undoSeconds, waitSound,
  type Density, type TextSize, type UndoScope, type UndoSeconds,
} from '@/lib/device';
import { isMac } from '@/lib/keys';
import { clearToken } from '@/lib/live/api';
import { bootstrap, mode } from '@/lib/live/store';
import { setTheme, theme, type Theme } from '@/lib/store/state';
import { meRole } from '@/lib/workspace/labels';
import { setsUp, showChecklistAgain, showHintsAgain } from '@/lib/onboarding';
import { Button } from '@/ui/Button';
import { Sheet, sheetStyles } from '@/ui/Sheet';
import s from './device.module.css';

/** Сегменты с одним выбором (radiogroup): стрелки и Tab как у обычных радио. */
function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return (
    <label class={s.toggle}>
      <span class={s.toggleText}>{label}{hint && <span class={s.hint}>{hint}</span>}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange((event.target as HTMLInputElement).checked)} />
    </label>
  );
}

/**
 * «Это устройство» (6.12): тема, размер текста, окно отмены отправки,
 * клавиши и жесты. Меняется сразу и только в этом браузере.
 */
export function DeviceScreen(): JSX.Element {
  const [logout, setLogout] = useState(false);
  const [learn, setLearn] = useState(false);
  const me = bootstrap.value?.me;
  const notifySupported = typeof Notification !== 'undefined';
  const [permission, setPermission] = useState(notifySupported ? Notification.permission : 'denied');
  // Включить можно только с разрешения браузера; запрет — подсказка, переключатель не включается.
  const toggleNotify = (on: boolean): void => {
    if (!on || !notifySupported) { setBrowserNotify(false); return; }
    void Notification.requestPermission().then((answer) => { setPermission(answer); setBrowserNotify(answer === 'granted'); });
  };
  return (
    <div class={s.screen}>
      <h1 class={s.title}>{t('nav.device')}</h1>
      <section class={s.group} aria-labelledby="dev-look">
        <h2 class={s.head} id="dev-look">{t('device.look')}</h2>
        <div class={s.row}>
          <span class={s.rowLabel}>{t('device.theme')}</span>
          <Segmented<Theme> label={t('device.theme')} value={theme.value} onChange={setTheme}
            items={[{ value: 'auto', label: t('device.themeAuto') }, { value: 'light', label: t('device.themeLight') }, { value: 'dark', label: t('device.themeDark') }]} />
        </div>
        <div class={s.row}>
          <span class={s.rowLabel}>{t('device.textSize')}</span>
          <Segmented<TextSize> label={t('device.textSize')} value={textSize.value} onChange={setTextSize}
            items={[{ value: 100, label: '100%' }, { value: 112, label: '112%' }, { value: 125, label: '125%' }]} />
        </div>
        <div class={s.row}>
          <span class={s.rowLabel}>{t('device.density')}</span>
          <Segmented<Density> label={t('device.density')} value={density.value} onChange={setDensity}
            items={[{ value: 'comfortable', label: t('device.densityComfortable') }, { value: 'compact', label: t('device.densityCompact') }]} />
        </div>
        <p class={s.hint}>{t('device.densityHint')}</p>
      </section>
      <section class={s.group} aria-labelledby="dev-work">
        <h2 class={s.head} id="dev-work">{t('device.work')}</h2>
        <div class={s.row}>
          <span class={s.rowLabel}>{t('device.start')}</span>
          <Segmented<'auto' | 'today' | 'chats'> label={t('device.start')} value={startScreen.value ?? 'auto'}
            onChange={(value) => setStartScreen(value === 'auto' ? null : value)}
            items={[{ value: 'auto', label: t('device.startAuto') }, { value: 'today', label: t('device.startToday') }, { value: 'chats', label: t('device.startChats') }]} />
        </div>
        <p class={s.hint}>{t('device.startHint')}</p>
        <div class={s.row}>
          <span class={s.rowLabel}>{t('device.undo')}</span>
          <Segmented<UndoSeconds> label={t('device.undo')} value={undoSeconds.value} onChange={(value) => setUndo(value)}
            items={[{ value: 0, label: t('device.undoNone') }, { value: 5, label: t('device.seconds', { n: 5 }) }, { value: 10, label: t('device.seconds', { n: 10 }) }]} />
        </div>
        <Collapse open={undoSeconds.value > 0}>
          <div class={s.row}>
            <span class={s.rowLabel}>{t('device.undoFor')}</span>
            <Segmented<UndoScope> label={t('device.undoFor')} value={undoScope.value} onChange={(value) => setUndo(undoSeconds.peek(), value)}
              items={[{ value: 'drafts', label: t('device.undoDrafts') }, { value: 'all', label: t('device.undoAll') }]} />
          </div>
        </Collapse>
        <Toggle label={t('device.enterSends', { enter: 'Enter' })} hint={t('device.enterSendsHint', { enter: 'Enter', shift: 'Shift', mod: isMac ? '⌘' : 'Ctrl' })}
          checked={enterSends.value} onChange={setEnterSends} />
        <Toggle label={t('device.sound')} hint={t('device.soundHint')} checked={waitSound.value} onChange={(on) => { setWaitSound(on); if (on) playWaitSound(); }} />
        {waitSound.value && <Button variant="quiet" size="sm" onClick={playWaitSound}>{t('device.soundTry')}</Button>}
        <Toggle label={t('device.notify')} hint={t('device.notifyHint')} checked={browserNotify.value && permission === 'granted'} onChange={toggleNotify} />
        {!notifySupported ? <p class={s.hint}>{t('device.notifyNone')}</p> : permission === 'denied' && <p class={s.hint} role="status">{t('device.notifyDenied')}</p>}
      </section>
      {mode.value === 'live' && (
        <section class={s.group} aria-labelledby="dev-learn">
          <h2 class={s.head} id="dev-learn">{t('device.learn')}</h2>
          <div class={s.actions}>
            {setsUp(me)
              ? <Button variant="secondary" size="sm" onClick={() => { showChecklistAgain(); setLearn(true); }}>{t('device.checklistAgain')}</Button>
              : <Button variant="secondary" size="sm" onClick={() => { showHintsAgain(); setLearn(true); }}>{t('device.hintsAgain')}</Button>}
          </div>
          {learn && <p class={s.hint} role="status">{t('device.learnDone')}</p>}
        </section>
      )}
      <section class={s.group} aria-labelledby="dev-keys">
        <h2 class={s.head} id="dev-keys">{t('device.keys')}</h2>
        <Toggle label={t('device.navKeys')} hint={t('device.navKeysHint', { enter: 'Enter', g: 'G' })} checked={navKeys.value} onChange={setNavKeys} />
        <Toggle label={t('device.letterKeys')} hint={t('device.letterKeysHint')} checked={letterKeys.value} onChange={setLetterKeys} />
        <Toggle label={t('device.gestures')} hint={t('device.gesturesHint')} checked={gestures.value} onChange={setGestures} />
      </section>
      <section class={s.group}>
        <a class={s.link} href="/?ui=classic">{t('nav.classic')}</a>
        {mode.value === 'live' && <Button variant="secondary" onClick={() => setLogout(true)}>{t('device.logout')}</Button>}
        {me && <p class={s.hint}>{meRole(me) === me.name ? t('device.youName', { name: me.name }) : t('device.you', { name: me.name, role: meRole(me) })}</p>}
      </section>
      <Sheet open={logout} onClose={() => setLogout(false)} title={t('device.logoutTitle')}>
        <p class={sheetStyles.text}>{t('device.logoutText')}</p>
        <div class={sheetStyles.actions}>
          <Button variant="secondary" onClick={() => setLogout(false)} autoFocus>{t('sheet.cancel')}</Button>
          <Button variant="danger" onClick={() => { clearToken(); location.assign('/next/'); }}>{t('device.logoutYes')}</Button>
        </div>
      </Sheet>
    </div>
  );
}
