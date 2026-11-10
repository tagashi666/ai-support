/**
 * Даты, длительности и склонения через Intl (план, 8.7 и 9):
 * «16:21», «вчера», «пн», «5 ноя», «5 ноя 2025»; «2 ч 40 мин».
 */
import { t, tn } from '@/i18n/ru';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const timeFmt = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat('ru', { weekday: 'short' });
const dayMonthFmt = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' });
const dayMonthYearFmt = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' });
const longDayFmt = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' });
const longDayYearFmt = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric' });
const fullDateFmt = new Intl.DateTimeFormat('ru', { weekday: 'long', day: 'numeric', month: 'long' });

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const trimDot = (text: string): string => text.replace(/\.$/, '').replace('.', '');

export function clock(ms: number): string {
  return timeFmt.format(ms);
}

/** Время в строке списка. */
export function listTime(ms: number, now: number): string {
  const today = startOfDay(now);
  if (ms >= today) return clock(ms);
  if (ms >= today - DAY) return t('time.yesterday');
  if (ms >= today - 6 * DAY) return trimDot(weekdayFmt.format(ms));
  if (new Date(ms).getFullYear() === new Date(now).getFullYear()) return trimDot(dayMonthFmt.format(ms));
  return trimDot(dayMonthYearFmt.format(ms)).replace(/\s*г$/, '');
}

/** Разделитель дней в ленте: «Сегодня», «Вчера», «5 ноября», «5 ноября 2025». */
export function dayDivider(ms: number, now: number): 'today' | 'yesterday' | string {
  const today = startOfDay(now);
  if (ms >= today) return 'today';
  if (ms >= today - DAY) return 'yesterday';
  if (new Date(ms).getFullYear() === new Date(now).getFullYear()) return longDayFmt.format(ms);
  return longDayYearFmt.format(ms).replace(/\s*г\.?$/, '');
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** Длительность словами: «5 мин», «2 ч», «2 ч 40 мин», «3 дня». */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MIN));
  if (total < 1) return t('time.lessMinute');
  if (total < 60) return `${total} ${tn('plural.minutes', total)}`;
  const days = Math.floor(total / (24 * 60));
  if (days >= 1) return `${days} ${tn('plural.days', days)}`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? t('time.hours', { h: hours }) : t('time.hoursMinutes', { h: hours, m: minutes });
}

/** Длительность без минут после часа: «1 ч», а не «1 ч 13 мин» (для строки списка). */
export function roughDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MIN));
  if (total >= 60 && total < 24 * 60) return t('time.hours', { h: Math.floor(total / 60) });
  return duration(ms);
}

export function fullDate(ms: number): string {
  return fullDateFmt.format(ms);
}

export function dayMonth(ms: number): string {
  return longDayFmt.format(ms);
}

/** «марта 2025» для «клиент с …». */
export function monthYear(ms: number): string {
  return longDayYearFmt.format(ms).replace(/^\d+\s/, '').replace(/\s*г\.?$/, '');
}

export function plural(n: number, key: Parameters<typeof tn>[0]): string {
  return `${n} ${tn(key, n)}`;
}
