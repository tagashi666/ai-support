import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '@/i18n/ru';
import { getJson, readToken } from '@/lib/live/api';
import s from './media.module.css';

interface Animation { play(): void; pause(): void; destroy(): void }
interface LottiePlayer {
  loadAnimation(options: { container: Element; renderer: 'svg'; loop: boolean; autoplay: boolean; animationData: unknown; rendererSettings?: Record<string, unknown> }): Animation;
}

let player: Promise<LottiePlayer> | null = null;

/**
 * Плеер Lottie — тот же файл, что у классики (`/vendor/lottie.min.js`, лёгкая
 * сборка lottie-web без eval): CSP `script-src 'self'` его пропускает, внешних
 * CDN нет. Грузится один раз и только когда стикер появился на экране.
 */
function loadPlayer(): Promise<LottiePlayer> {
  const existing = (window as unknown as { lottie?: LottiePlayer }).lottie;
  if (existing) return Promise.resolve(existing);
  player ??= new Promise<LottiePlayer>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/lottie.min.js';
    script.async = true;
    script.onload = () => {
      const loaded = (window as unknown as { lottie?: LottiePlayer }).lottie;
      if (loaded) resolve(loaded); else reject(new Error('lottie'));
    };
    script.onerror = () => reject(new Error('lottie'));
    document.head.append(script);
  }).catch((err: unknown) => { player = null; throw err; });
  return player;
}

/** Анимация TGS: 202 — файл ещё готовится, повторяем с паузой (как классика). */
async function animationData(id: number, alive: () => boolean): Promise<unknown> {
  for (let attempt = 0; attempt < 12 && alive(); attempt += 1) {
    const response = await fetch(`/api/attachments/${id}/lottie`, { credentials: 'same-origin' });
    if (response.status === 200) return await response.json();
    // 401 — медиа-билет в cookie ещё не выдан или истёк: взять новый и повторить (как классика).
    if (response.status === 401) { await getJson('/api/ticket', readToken() ?? '').catch(() => undefined); continue; }
    if (response.status !== 202) throw new Error(`HTTP ${response.status}`);
    const retry = Number(response.headers.get('retry-after')) || 0;
    await new Promise((resolve) => setTimeout(resolve, retry ? Math.min(60_000, retry * 1000) : Math.min(5000, 750 * (attempt + 1))));
  }
  throw new Error('pending');
}

/** Анимированный стикер TGS: играет, только пока виден на экране (6.3.2). */
export function TgsSticker({ id }: { id: number }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'idle' | 'ready' | 'failed'>('idle');
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver !== 'function') return undefined;
    let alive = true;
    let anim: Animation | null = null;
    let started = false;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (anim) { if (visible) anim.play(); else anim.pause(); return; }
      if (!visible || started) return;
      started = true;
      void Promise.all([animationData(id, () => alive), loadPlayer()]).then(([data, lottie]) => {
        if (!alive || !box.current) return;
        anim = lottie.loadAnimation({ container: box.current, renderer: 'svg', loop: true, autoplay: true, animationData: data,
          rendererSettings: { progressiveLoad: true, preserveAspectRatio: 'xMidYMid meet' } });
        setState('ready');
      }).catch(() => { if (alive) setState('failed'); });
    });
    observer.observe(el);
    return () => { alive = false; observer.disconnect(); anim?.destroy(); };
  }, [id]);
  return (
    <div class={s.tgs} role="img" aria-label={t('file.sticker')} data-state={state}>
      <div ref={box} class={s.tgsBox} />
      {state === 'failed' && <span class={s.tgsFailed}>{t('file.stickerFailed')}</span>}
    </div>
  );
}
