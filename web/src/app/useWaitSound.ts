import { useEffect, useRef } from 'preact/hooks';
import { playWaitSound, waitSound } from '@/lib/device';
import { liveMine, mode } from '@/lib/live/store';

/** Звук «ждут вас» (6.12): только когда число выросло, а не при загрузке и не при уменьшении. */
export function useWaitSound(): void {
  const on = waitSound.value && mode.value === 'live';
  const mine = liveMine.value;
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (on && last.current !== null && mine > last.current) playWaitSound();
    last.current = mine;
  }, [mine, on]);
}
