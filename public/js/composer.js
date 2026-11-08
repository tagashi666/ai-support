// Панель: инбокс: отправка, вложения, редактор картинок.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './conversation.js';
import { state } from './state.js';
import { $ } from './dom.js';
import { api, mutate } from './api.js';
import { canPermission, canWrite } from './access.js';
import { toast } from './nav.js';
import { renderWindow } from './inbox-list.js';
import { clearQuote, renderSuggestion } from './thread.js';
import { heartbeatCurrent, engageCurrent, open, clearDraft } from './conversation.js';

/**
 * Диалог и цитата фиксируются в момент нажатия «Отправить». Пока запрос
 * летит, оператор может открыть другой диалог: раньше после ответа очищались
 * поле, цитата и предложка уже нового диалога, а он сам переоткрывался.
 */
export async function sendText(text, extra = {}, target = { id: state.current?.id, quoting: state.quoting }) {
  if (!canWrite() || !text.trim() || !target.id) return;
  $('send').disabled = true;
  const payload = { text, ...extra };
  if (target.quoting) { payload.replyTo = target.quoting.id; payload.replyExcerpt = target.quoting.excerpt; }
  let res;
  try {
    res = await api(`/api/conversations/${target.id}/reply`, { method:'POST', body: JSON.stringify(payload) });
  } catch (err) {
    if (state.current?.id === target.id) $('err').textContent = `Нет связи с сервером: ${err.message}`;
    else toast(`Ответ не отправлен: ${err.message}`);
    renderWindow(); return false;
  }
  const stillOpen = state.current?.id === target.id;
  if (res.ok) {
    clearDraft(target.id);
    if (stillOpen) {
      $('input').value = ''; $('input').style.height = 'auto'; $('err').textContent = '';
      state.suggestion = null; renderSuggestion(); clearQuote();
      void open(target.id);
    }
  } else {
    const error = (await res.json().catch(() => ({}))).error ?? `Отправить не удалось (${res.status})`;
    if (state.current?.id === target.id) $('err').textContent = error; else toast(error);
  }
  renderWindow();
  return res.ok;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes))) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

const dangerousFile = (file) => /\.(exe|msi|com|scr|bat|cmd|ps1|vbs|js|jar|apk|appimage)$/i.test(file.name);
const editableImage = (file) => (file.type.startsWith('image/') && file.type !== 'image/svg+xml')
  || /\.(png|jpe?g|webp|gif)$/i.test(file.name);

function addFiles(files) {
  if (!canPermission('conversation:attachments') || !state.current) return;
  const incoming = [...files].filter((file) => file instanceof File);
  if (!incoming.length) return;
  if (state.pendingFiles.length + incoming.length > 10) return toast('За один раз можно отправить не больше 10 файлов');
  const tooLarge = incoming.find((file) => file.size > 45 * 1024 * 1024);
  if (tooLarge) return toast(`${tooLarge.name}: максимальный размер — 45 МБ`);
  for (const file of incoming) state.pendingFiles.push({ id:crypto.randomUUID(), file, originalFile:file, progress:0 });
  renderPendingFiles(); engageCurrent();
}

function removePending(id) {
  const item = state.pendingFiles.find((entry) => entry.id === id);
  if (item?.preview) URL.revokeObjectURL(item.preview);
  state.pendingFiles = state.pendingFiles.filter((entry) => entry.id !== id);
  renderPendingFiles();
}

export function renderPendingFiles() {
  const box = $('pendingFiles'); box.innerHTML = ''; box.hidden = !state.pendingFiles.length;
  for (const item of state.pendingFiles) {
    const card = document.createElement('div'); card.className = 'pending-file'; card.dataset.pending = item.id;
    if (editableImage(item.file)) {
      item.preview ||= URL.createObjectURL(item.file);
      const image = document.createElement('img'); image.src = item.preview; image.alt = '';
      card.append(image);
    }
    const copy = document.createElement('div'); copy.className = 'pending-file-copy';
    const name = document.createElement('b'); name.textContent = item.file.name;
    const size = document.createElement('span'); size.textContent = formatBytes(item.file.size);
    const actions = document.createElement('span'); actions.className = 'pending-file-actions';
    if (editableImage(item.file)) {
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '✎'; edit.title = 'Редактировать';
      edit.onclick = () => openImageEditor(item.file, (edited) => {
        if (item.preview) URL.revokeObjectURL(item.preview);
        item.file = edited; item.preview = ''; renderPendingFiles();
      });
      actions.append(edit);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = 'Убрать';
    remove.onclick = () => removePending(item.id); actions.append(remove);
    copy.append(name, size, actions); card.append(copy);
    const meter = document.createElement('span'); meter.className = 'upload-meter';
    meter.innerHTML = `<i style="--upload:${Math.round(item.progress)}%"></i>`; card.append(meter); box.append(card);
  }
}

function uploadOne(item, batchId, batchSize, index, caption, dangerConfirmed, target) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/conversations/${target.id}/attachments`);
    xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
    xhr.setRequestHeader('Content-Type', 'application/vnd.ai-support.attachment');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.file.name));
    xhr.setRequestHeader('X-File-Type', encodeURIComponent(item.file.type || 'application/octet-stream'));
    xhr.setRequestHeader('X-Upload-Batch', batchId);
    xhr.setRequestHeader('X-Upload-Batch-Size', String(batchSize));
    xhr.setRequestHeader('X-Upload-Index', String(index));
    if (caption) xhr.setRequestHeader('X-Caption', encodeURIComponent(caption));
    if (target.quoting?.id) xhr.setRequestHeader('X-Reply-To', encodeURIComponent(target.quoting.id));
    if (dangerConfirmed) xhr.setRequestHeader('X-Dangerous-Confirmed', 'yes');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) { item.progress = event.loaded / event.total * 100; renderPendingFiles(); }
    };
    xhr.onerror = () => reject(new Error('Нет связи с сервером'));
    xhr.onload = () => {
      let body = {}; try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `HTTP ${xhr.status}`));
    };
    xhr.send(item.file);
  });
}

async function sendPending() {
  if (state.uploadRunning || !state.pendingFiles.length || !state.current) return;
  if (!state.current.channel?.startsWith('tg_')) return toast('Bedolaga принимает только текстовые ответы');
  const risky = state.pendingFiles.filter((entry) => dangerousFile(entry.file));
  if (risky.length && !confirm(`Отправить потенциально исполняемые файлы (${risky.map(x => x.file.name).join(', ')})? Получатель должен доверять источнику.`)) return;
  state.uploadRunning = true; $('send').disabled = true; $('err').textContent = '';
  const batch = crypto.randomUUID().replaceAll('-', '_');
  const initial = [...state.pendingFiles];
  const text = $('input').value.trim();
  // Файлы пачки идут в диалог, где нажали «Отправить», даже если оператор
  // за время загрузки открыл другой: раньше остаток пачки уходил другому клиенту.
  const target = { id: state.current.id, quoting: state.quoting };
  try {
    for (let index = 0; index < initial.length; index += 1) {
      const item = initial[index];
      await uploadOne(item, batch, initial.length, index, index === 0 && text.length <= 1024 ? text : '', dangerousFile(item.file), target);
      removePending(item.id);
    }
    if (text.length > 1024 && !await sendText(text, {}, target)) throw new Error($('err').textContent || 'Текст не отправлен');
    clearDraft(target.id);
    if (state.current?.id === target.id) {
      $('input').value = ''; $('input').style.height = 'auto'; clearQuote();
      state.suggestion = null; renderSuggestion(); void open(target.id);
    }
  } catch (err) {
    $('err').textContent = err.message || String(err);
  } finally {
    state.uploadRunning = false; renderWindow();
  }
}

export function openImageEditorFromUrl(url, name) {
  fetch(url).then((response) => {
    if (!response.ok) throw new Error('Изображение недоступно');
    return response.blob();
  }).then((blob) => openImageEditor(new File([blob], name, { type:blob.type }), (edited) => addFiles([edited])))
    .catch((error) => toast(error.message));
}

async function openImageEditor(file, onSave) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return toast('Этот формат изображения нельзя отредактировать в браузере');
  if (bitmap.width * bitmap.height > 40_000_000) { bitmap.close(); return toast('Изображение слишком велико для редактора'); }
  const modal = document.createElement('div'); modal.className = 'image-editor'; modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true');
  modal.innerHTML = `<div class="editor-tools"><b class="editor-title"></b>
    <button class="btn" data-tool="draw" title="Карандаш (D)">Карандаш</button><button class="btn" data-tool="line" title="Линия (L)">Линия</button>
    <button class="btn" data-tool="arrow" title="Стрелка (A)">Стрелка</button><button class="btn" data-tool="rect" title="Прямоугольник (R)">Рамка</button>
    <button class="btn" data-tool="ellipse" title="Эллипс (E)">Эллипс</button><button class="btn" data-tool="text" title="Текст (T)">Текст</button>
    <button class="btn" data-tool="pixel" title="Размытие / пикселизация (B)">Размытие</button><button class="btn" data-tool="crop" title="Обрезка (C)">Обрезать</button>
    <input class="editor-text-input" type="text" maxlength="120" placeholder="Текст для надписи" aria-label="Текст надписи">
    <input type="color" value="#ff3b5c" aria-label="Цвет"><input type="range" min="2" max="24" value="5" aria-label="Толщина">
    <button class="btn" data-action="undo" title="Ctrl+Z">↶</button><button class="btn" data-action="redo" title="Ctrl+Y">↷</button>
    <span class="editor-size"><input type="number" data-size="width" min="1" max="10000" aria-label="Ширина"><span>×</span><input type="number" data-size="height" min="1" max="10000" aria-label="Высота"><button class="btn" data-action="resize">Размер</button></span></div>
    <div class="editor-stage"><canvas></canvas></div><div class="editor-foot"><span class="hint">PNG-копия · Enter сохранить · Esc отменить</span><button class="btn" data-action="cancel">Отмена</button><button class="btn primary" data-action="save">Добавить к ответу</button></div>`;
  modal.querySelector('.editor-title').textContent = file.name;
  document.body.append(modal);
  const canvas = modal.querySelector('canvas'), ctx = canvas.getContext('2d', { willReadFrequently:true });
  canvas.width = bitmap.width; canvas.height = bitmap.height; ctx.drawImage(bitmap,0,0); bitmap.close();
  modal.querySelector('[data-size=width]').value=canvas.width; modal.querySelector('[data-size=height]').value=canvas.height;
  let tool = 'draw', drawing = false, start = null, before = null, undo = [], redo = [];
  const snapshot = () => { const c=document.createElement('canvas'); c.width=canvas.width;c.height=canvas.height;c.getContext('2d').drawImage(canvas,0,0);return c; };
  const restore = (snap) => { canvas.width=snap.width;canvas.height=snap.height;ctx.drawImage(snap,0,0); };
  const checkpoint = () => { undo.push(snapshot()); if (undo.length > 15) undo.shift(); redo=[]; };
  const point = (event) => { const r=canvas.getBoundingClientRect();return {x:(event.clientX-r.left)*canvas.width/r.width,y:(event.clientY-r.top)*canvas.height/r.height}; };
  const style = () => { ctx.strokeStyle=modal.querySelector('input[type=color]').value;ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=Number(modal.querySelector('input[type=range]').value);ctx.lineCap='round';ctx.lineJoin='round'; };
  const arrow = (a,b) => { ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();const angle=Math.atan2(b.y-a.y,b.x-a.x),size=Math.max(12,ctx.lineWidth*4);ctx.beginPath();ctx.moveTo(b.x,b.y);ctx.lineTo(b.x-size*Math.cos(angle-.45),b.y-size*Math.sin(angle-.45));ctx.moveTo(b.x,b.y);ctx.lineTo(b.x-size*Math.cos(angle+.45),b.y-size*Math.sin(angle+.45));ctx.stroke(); };
  const shape = (end) => { style(); if(tool==='line'){ctx.beginPath();ctx.moveTo(start.x,start.y);ctx.lineTo(end.x,end.y);ctx.stroke();} else if(tool==='arrow')arrow(start,end); else if(tool==='rect')ctx.strokeRect(start.x,start.y,end.x-start.x,end.y-start.y); else if(tool==='ellipse'){ctx.beginPath();ctx.ellipse((start.x+end.x)/2,(start.y+end.y)/2,Math.abs(end.x-start.x)/2,Math.abs(end.y-start.y)/2,0,0,Math.PI*2);ctx.stroke();} };
  canvas.onpointerdown = (event) => {
    const p=point(event); if(tool==='text'){const value=modal.querySelector('.editor-text-input').value.trim();if(!value)return toast('Введите текст в панели редактора');checkpoint();style();ctx.font=`${Math.max(18,ctx.lineWidth*5)}px sans-serif`;ctx.fillText(value,p.x,p.y);return; }
    drawing=true;start=p;checkpoint();before=ctx.getImageData(0,0,canvas.width,canvas.height);canvas.setPointerCapture(event.pointerId);if(tool==='draw'){style();ctx.beginPath();ctx.moveTo(p.x,p.y);}
  };
  canvas.onpointermove = (event) => { if(!drawing)return;const p=point(event);if(tool==='draw'){ctx.lineTo(p.x,p.y);ctx.stroke();start=p;}else if(['line','arrow','rect','ellipse'].includes(tool)){ctx.putImageData(before,0,0);shape(p);} };
  canvas.onpointerup = (event) => {
    if(!drawing)return;drawing=false;const end=point(event);
    if(tool==='pixel'){ctx.putImageData(before,0,0);const x=Math.floor(Math.min(start.x,end.x)),y=Math.floor(Math.min(start.y,end.y)),w=Math.floor(Math.abs(end.x-start.x)),h=Math.floor(Math.abs(end.y-start.y));if(w&&h){const data=ctx.getImageData(x,y,w,h),block=Math.max(8,Math.round(Math.min(w,h)/18));for(let yy=0;yy<h;yy+=block)for(let xx=0;xx<w;xx+=block){const i=(yy*w+xx)*4;ctx.fillStyle=`rgb(${data.data[i]},${data.data[i+1]},${data.data[i+2]})`;ctx.fillRect(x+xx,y+yy,block,block);}}}
    if(tool==='crop'){ctx.putImageData(before,0,0);const x=Math.floor(Math.min(start.x,end.x)),y=Math.floor(Math.min(start.y,end.y)),w=Math.floor(Math.abs(end.x-start.x)),h=Math.floor(Math.abs(end.y-start.y));if(w>2&&h>2){const data=ctx.getImageData(x,y,w,h);canvas.width=w;canvas.height=h;ctx.putImageData(data,0,0);modal.querySelector('[data-size=width]').value=w;modal.querySelector('[data-size=height]').value=h;}}
  };
  const selectTool = (next) => { tool=next;for(const button of modal.querySelectorAll('[data-tool]'))button.setAttribute('aria-pressed',String(button.dataset.tool===tool)); };
  for(const button of modal.querySelectorAll('[data-tool]')) button.onclick=()=>selectTool(button.dataset.tool); selectTool(tool);
  const close=()=>{document.removeEventListener('keydown',keys);modal.remove();};
  modal.querySelector('[data-action=cancel]').onclick=close;
  modal.querySelector('[data-action=undo]').onclick=()=>{if(!undo.length)return;redo.push(snapshot());restore(undo.pop());};
  modal.querySelector('[data-action=redo]').onclick=()=>{if(!redo.length)return;undo.push(snapshot());restore(redo.pop());};
  modal.querySelector('[data-action=resize]').onclick=()=>{const w=Number(modal.querySelector('[data-size=width]').value),h=Number(modal.querySelector('[data-size=height]').value);if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w*h>40000000)return toast('Недопустимый размер');checkpoint();const old=snapshot();canvas.width=w;canvas.height=h;ctx.drawImage(old,0,0,w,h);};
  const save=()=>canvas.toBlob((blob)=>{if(!blob)return toast('Не удалось создать PNG');const base=file.name.replace(/\.[^.]+$/,'')||'image';onSave(new File([blob],`${base}-edited.png`,{type:'image/png'}));close();},'image/png');
  modal.querySelector('[data-action=save]').onclick=save;
  const shortcuts={d:'draw',l:'line',a:'arrow',r:'rect',e:'ellipse',t:'text',b:'pixel',c:'crop'};
  const keys=(event)=>{if(event.key==='Escape')return close();if(event.target instanceof HTMLInputElement&&!event.ctrlKey&&!event.metaKey)return;else if(event.key==='Enter'&&!event.ctrlKey&&!event.metaKey)save();else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();modal.querySelector(`[data-action=${event.shiftKey?'redo':'undo'}]`).click();}else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();modal.querySelector('[data-action=redo]').click();}else if(shortcuts[event.key.toLowerCase()])selectTool(shortcuts[event.key.toLowerCase()]);};
  document.addEventListener('keydown',keys);
}

async function captureScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Браузер не поддерживает снимок экрана');
  try {
    const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false}),video=document.createElement('video');video.srcObject=stream;await video.play();
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);stream.getTracks().forEach(track=>track.stop());
    canvas.toBlob((blob)=>blob&&openImageEditor(new File([blob],`screenshot-${Date.now()}.png`,{type:'image/png'}),(edited)=>addFiles([edited])),'image/png');
  } catch (error) { if(error.name!=='NotAllowedError')toast('Снимок экрана не создан'); }
}

$('send').onclick = () => {
  if (state.pendingFiles.length) return sendPending();
  const text = $('input').value;
  const edited = state.suggestion && text.trim() && text.trim() !== state.suggestion.text.trim();
  sendText(text, edited ? { suggestionId: state.suggestion.id, edited: true } : {});
};
$('attachBtn').onclick = () => $('filePicker').click();
$('filePicker').onchange = (event) => { addFiles(event.target.files); event.target.value = ''; };
$('captureBtn').onclick = captureScreen;
for (const eventName of ['dragenter','dragover']) $('composer').addEventListener(eventName, (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return; event.preventDefault(); $('composer').classList.add('dragging');
});
for (const eventName of ['dragleave','drop']) $('composer').addEventListener(eventName, (event) => {
  $('composer').classList.remove('dragging'); if(eventName==='drop'&&event.dataTransfer?.files?.length){event.preventDefault();addFiles(event.dataTransfer.files);}
});
$('input').addEventListener('paste', (event) => {
  const files=[...(event.clipboardData?.items ?? [])].filter((item)=>item.kind==='file').map((item)=>item.getAsFile()).filter(Boolean);
  if(files.length){event.preventDefault();addFiles(files);}
});
document.addEventListener('keydown', (event) => {
  if(document.querySelector('.image-editor'))return;
  if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='u'){event.preventDefault();$('filePicker').click();}
  if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='s'){event.preventDefault();captureScreen();}
});
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('send').click(); });
$('input').addEventListener('focus', heartbeatCurrent);
$('input').addEventListener('input', (e) => {
  if (e.target.value.trim()) engageCurrent(); else heartbeatCurrent();
  e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 148) + 'px';
});
$('noteBtn').onclick = async () => {
  if (!canPermission('conversation:notes')) return;
  const text = $('input').value.trim(); if (!text || !state.current) return;
  const id = state.current.id;
  if (await mutate(`/api/conversations/${id}/note`,
    { method:'POST', body: JSON.stringify({ text }) }, 'Заметка добавлена')) {
    clearDraft(id);
    if (state.current?.id === id) { $('input').value = ''; open(id); }
  }
};
