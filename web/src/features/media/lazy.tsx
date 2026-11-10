import { lazyScreen } from '@/app/lazy';
import s from './media.module.css';

/**
 * Редактор картинки и стикер .tgs — свои чанки (бюджет начального JS, 11.4):
 * нужны только по нажатию «Править» или когда в ленте есть стикер. Место
 * под стикер держит заглушка того же размера — лента не прыгает.
 */
export const ImageEditor = lazyScreen(() => import('./ImageEditor').then((module) => module.ImageEditor), () => <span />);
export const TgsSticker = lazyScreen(() => import('./TgsSticker').then((module) => module.TgsSticker), () => <div class={s.tgs} aria-busy="true" />);
