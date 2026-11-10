import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t, type Key } from '@/i18n/ru';
import { showToast } from '@/lib/actions/toasts';
import { isMod } from '@/lib/keys';
import { Button } from '@/ui/Button';
import { closeModal, openModal } from '@/ui/layer';
import s from './media.module.css';

export type Tool = 'draw' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'pixel' | 'crop';

/** Инструменты и клавиши — как в классике (composer.js): D L A R E T B C; привязка по event.code. */
export const TOOLS: ReadonlyArray<{ tool: Tool; label: Key; code: string }> = [
  { tool: 'draw', label: 'editor.draw', code: 'KeyD' },
  { tool: 'line', label: 'editor.line', code: 'KeyL' },
  { tool: 'arrow', label: 'editor.arrow', code: 'KeyA' },
  { tool: 'rect', label: 'editor.rect', code: 'KeyR' },
  { tool: 'ellipse', label: 'editor.ellipse', code: 'KeyE' },
  { tool: 'text', label: 'editor.text', code: 'KeyT' },
  { tool: 'pixel', label: 'editor.pixel', code: 'KeyB' },
  { tool: 'crop', label: 'editor.crop', code: 'KeyC' },
];

const MAX_PIXELS = 40_000_000;
interface Point { x: number; y: number }

/**
 * Редактор картинки (6.3.3, прил. А.E): карандаш, линия, стрелка, рамка,
 * эллипс, надпись, размытие (пикселизация), обрезка, размер, отмена и
 * повтор. Сохраняет PNG-копию; исходный файл не меняется.
 */
export function ImageEditor({ file, onSave, onClose, saveLabel }: {
  file: File; onSave: (edited: File) => void; onClose: () => void; saveLabel: string;
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>('draw');
  const [color, setColor] = useState('#ff3b5c');
  const [width, setWidth] = useState(5);
  const [text, setText] = useState('');
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [ready, setReady] = useState(false);
  const history = useRef<{ undo: HTMLCanvasElement[]; redo: HTMLCanvasElement[] }>({ undo: [], redo: [] });
  const drag = useRef<{ start: Point; before: ImageData } | null>(null);

  const ctx = (): CanvasRenderingContext2D => canvas.current!.getContext('2d', { willReadFrequently: true })!;
  const snapshot = (): HTMLCanvasElement => {
    const copy = document.createElement('canvas');
    copy.width = canvas.current!.width; copy.height = canvas.current!.height;
    copy.getContext('2d')!.drawImage(canvas.current!, 0, 0);
    return copy;
  };
  const restore = (snap: HTMLCanvasElement): void => {
    const el = canvas.current!;
    el.width = snap.width; el.height = snap.height;
    ctx().drawImage(snap, 0, 0);
    setSize({ w: snap.width, h: snap.height });
  };
  const checkpoint = (): void => {
    history.current.undo.push(snapshot());
    if (history.current.undo.length > 30) history.current.undo.shift();
    history.current.redo = [];
  };
  const undo = (): void => { const prev = history.current.undo.pop(); if (prev) { history.current.redo.push(snapshot()); restore(prev); } };
  const redo = (): void => { const next = history.current.redo.pop(); if (next) { history.current.undo.push(snapshot()); restore(next); } };

  useEffect(() => {
    const box = dialog.current;
    if (box) openModal(box);
    let alive = true;
    void createImageBitmap(file).then((bitmap) => {
      if (!alive || !canvas.current) return;
      canvas.current.width = bitmap.width; canvas.current.height = bitmap.height;
      ctx().drawImage(bitmap, 0, 0);
      bitmap.close();
      setSize({ w: canvas.current.width, h: canvas.current.height });
      setReady(true);
    }).catch(() => { showToast({ text: t('editor.badFormat'), kind: 'error', ttl: null }); onClose(); });
    return () => { alive = false; if (box) closeModal(box); };
  }, [file]);

  const style = (c: CanvasRenderingContext2D): void => {
    c.strokeStyle = color; c.fillStyle = color; c.lineWidth = width; c.lineCap = 'round'; c.lineJoin = 'round';
  };
  const point = (event: PointerEvent): Point => {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvas.current!.width / rect.width, y: (event.clientY - rect.top) * canvas.current!.height / rect.height };
  };
  const arrow = (c: CanvasRenderingContext2D, a: Point, b: Point): void => {
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = Math.max(12, width * 3);
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    c.beginPath(); c.moveTo(b.x, b.y);
    c.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
    c.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
    c.closePath(); c.fill();
  };
  const shape = (c: CanvasRenderingContext2D, a: Point, b: Point): void => {
    style(c);
    if (tool === 'line') { c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); }
    else if (tool === 'arrow') arrow(c, a, b);
    else if (tool === 'rect') c.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    else if (tool === 'ellipse') { c.beginPath(); c.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2); c.stroke(); }
    else if (tool === 'pixel' || tool === 'crop') { c.save(); c.setLineDash([6, 4]); c.lineWidth = 2; c.strokeStyle = '#ffffff'; c.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); c.restore(); }
  };

  const onDown = (event: PointerEvent): void => {
    if (!ready) return;
    const c = ctx();
    const p = point(event);
    if (tool === 'text') {
      if (!text.trim()) { showToast({ text: t('editor.textFirst'), kind: 'error', ttl: null }); return; }
      checkpoint(); style(c);
      c.font = `${Math.max(18, width * 5)}px system-ui, sans-serif`;
      c.fillText(text.trim(), p.x, p.y);
      return;
    }
    checkpoint();
    drag.current = { start: p, before: c.getImageData(0, 0, canvas.current!.width, canvas.current!.height) };
    canvas.current!.setPointerCapture(event.pointerId);
    if (tool === 'draw') { style(c); c.beginPath(); c.moveTo(p.x, p.y); }
  };
  const onMove = (event: PointerEvent): void => {
    const d = drag.current;
    if (!d) return;
    const c = ctx();
    const p = point(event);
    if (tool === 'draw') { c.lineTo(p.x, p.y); c.stroke(); return; }
    c.putImageData(d.before, 0, 0);
    shape(c, d.start, p);
  };
  const onUp = (event: PointerEvent): void => {
    const d = drag.current;
    drag.current = null;
    if (!d || tool === 'draw') return;
    const c = ctx();
    const end = point(event);
    c.putImageData(d.before, 0, 0);
    const x = Math.floor(Math.min(d.start.x, end.x)); const y = Math.floor(Math.min(d.start.y, end.y));
    const w = Math.floor(Math.abs(end.x - d.start.x)); const h = Math.floor(Math.abs(end.y - d.start.y));
    if (tool === 'pixel') {
      if (!w || !h) return;
      const data = c.getImageData(x, y, w, h);
      const block = Math.max(8, Math.round(Math.min(w, h) / 18));
      for (let yy = 0; yy < h; yy += block) {
        for (let xx = 0; xx < w; xx += block) {
          const i = (yy * w + xx) * 4;
          c.fillStyle = `rgb(${data.data[i]},${data.data[i + 1]},${data.data[i + 2]})`;
          c.fillRect(x + xx, y + yy, block, block);
        }
      }
    } else if (tool === 'crop') {
      if (w <= 2 || h <= 2) return;
      const data = c.getImageData(x, y, w, h);
      canvas.current!.width = w; canvas.current!.height = h;
      ctx().putImageData(data, 0, 0);
      setSize({ w, h });
    } else shape(c, d.start, end);
  };

  const resize = (): void => {
    const { w, h } = size;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > MAX_PIXELS) { showToast({ text: t('editor.badSize'), kind: 'error', ttl: null }); return; }
    checkpoint();
    const old = snapshot();
    canvas.current!.width = w; canvas.current!.height = h;
    ctx().drawImage(old, 0, 0, w, h);
  };

  const save = (): void => {
    canvas.current?.toBlob((blob) => {
      if (!blob) { showToast({ text: t('editor.saveFailed'), kind: 'error', ttl: null }); return; }
      const base = file.name.replace(/\.[^.]+$/, '') || 'image';
      onSave(new File([blob], `${base}-edited.png`, { type: 'image/png' }));
    }, 'image/png');
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const field = (event.target as HTMLElement).closest('input');
    if (isMod(event) && event.code === 'KeyZ') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (isMod(event) && event.code === 'KeyY') { event.preventDefault(); redo(); return; }
    if (field || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code === 'Enter') { event.preventDefault(); save(); return; }
    const found = TOOLS.find((entry) => entry.code === event.code);
    if (found) { event.preventDefault(); setTool(found.tool); }
  };

  return (
    <dialog ref={dialog} class={s.editor} aria-label={t('editor.title', { name: file.name })} onClose={onClose} onKeyDown={onKeyDown}>
      <div class={s.editorTools} role="toolbar" aria-label={t('editor.tools')}>
        {TOOLS.map((entry) => (
          <button key={entry.tool} type="button" class={s.tool} aria-pressed={tool === entry.tool} title={`${t(entry.label)} (${entry.code.slice(3)})`}
            onClick={() => setTool(entry.tool)}>{t(entry.label)}</button>
        ))}
        {tool === 'text' && (
          <input class={s.textInput} type="text" maxLength={120} value={text} placeholder={t('editor.textPlaceholder')} aria-label={t('editor.textPlaceholder')}
            onInput={(event) => setText((event.target as HTMLInputElement).value)} />
        )}
        <label class={s.inline}><span class="visually-hidden">{t('editor.color')}</span>
          <input type="color" value={color} onInput={(event) => setColor((event.target as HTMLInputElement).value)} /></label>
        <label class={s.inline}><span class="visually-hidden">{t('editor.width')}</span>
          <input type="range" min={2} max={24} value={width} onInput={(event) => setWidth(Number((event.target as HTMLInputElement).value))} /></label>
        <button type="button" class={s.tool} onClick={undo} aria-label={t('editor.undo')} title={t('editor.undo')}>↶</button>
        <button type="button" class={s.tool} onClick={redo} aria-label={t('editor.redo')} title={t('editor.redo')}>↷</button>
        <span class={s.size}>
          <input type="number" min={1} max={10000} value={size.w} aria-label={t('editor.widthPx')} onInput={(event) => setSize({ ...size, w: Number((event.target as HTMLInputElement).value) })} />
          <span aria-hidden="true">×</span>
          <input type="number" min={1} max={10000} value={size.h} aria-label={t('editor.heightPx')} onInput={(event) => setSize({ ...size, h: Number((event.target as HTMLInputElement).value) })} />
          <button type="button" class={s.tool} onClick={resize}>{t('editor.resize')}</button>
        </span>
      </div>
      <div class={s.stage}>
        <canvas ref={canvas} class={s.canvas} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          aria-label={t('editor.canvas')} />
      </div>
      <div class={s.editorFoot}>
        <span class={s.hint}>{t('editor.hint', { enter: 'Enter', esc: 'Esc' })}</span>
        <Button variant="secondary" onClick={onClose}>{t('sheet.cancel')}</Button>
        <Button variant="primary" icon="send" disabled={!ready} onClick={save}>{saveLabel}</Button>
      </div>
    </dialog>
  );
}
