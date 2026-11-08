// Панель: настройки.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './diag.js';
import { state } from './state.js';
import { $, esc } from './dom.js';
import { api, json, mutate } from './api.js';
import { canPermission } from './access.js';
import { requestedSettingsSection, scrollToSettingsCategory } from './theme.js';
import { toast, sheet, closeSheet } from './nav.js';
import { fmtTime, safeColor, sourceKind, renderInboxTabs, renderList } from './inbox-list.js';
import { confirmAction, renderAiNote } from './inspector.js';

/* ═══ настройки ═══ */
/**
 * Настройки с пояснениями. Без описания половина параметров выглядит
 * шумом: оператор менял значение, ничего не происходило, и настройка
 * считалась сломанной — хотя просто не действовала в текущем режиме.
 *
 * active(runtime) отвечает, работает ли параметр сейчас. Неактивные не
 * прячем — показываем с пометкой, иначе непонятно, куда они делись.
 */
const CONFIDENCE_LEVELS = [
  [0.40, 'Очень низкий — отвечает почти всегда'],
  [0.55, 'Низкий — отвечает, если ответ похож на верный'],
  [0.70, 'Средний — нужна заметная опора на базу'],
  [0.80, 'Высокий — ответ должен прямо следовать из статьи'],
  [0.90, 'Очень высокий — только дословно из базы'],
];

const FIELDS = [
  { key:'aiMode', label:'Режим AI по умолчанию', kind:'select',
    options:[['off','Выключен везде'],['shadow','Тень: анализирует, но не пишет'],['suggest','Предлагает'],['auto','Отвечает сам']],
    hint:'«Тень» запускает тот же анализ и сохраняет причины решения, но ничего не отправляет клиенту. Это безопасный режим для проверки новой базы знаний и промпта.' },

  { key:'requireKb', label:'Отвечать только по базе знаний', kind:'select',
    options:[['true','Да, иначе зовём человека'],['false','Разрешить отвечать без опоры']],
    hint:'Главная защита от выдумок. Если поиск по базе знаний не нашёл ничего, ответ клиенту сам не уйдёт ни при какой уверенности — диалог передаётся человеку.' },

  { key:'autoLearn', label:'Учиться на закрытых диалогах', kind:'select',
    options:[['false','Выключено'],['true','Создавать черновики статей']],
    hint:'После закрытия диалога AI выделяет повторно полезные решения и кладёт их в черновики базы знаний. Самостоятельной публикации нет: оператор проверяет и публикует статью вручную.' },

  { key:'bedolagaInterfaceKb', label:'Включить базу знаний интерфейса Бедолаги', kind:'select',
    options:[['false','Выключено'],['true','Включено']],
    hint:'Разрешает AI использовать только проверенные инструкции и локальные скриншоты интерфейса. До загрузки проверенного комплекта оставьте выключенным.' },

  { key:'bedolagaInterfaceMode', label:'Вид кабинета Бедолаги', kind:'select',
    options:[['auto','Авто — как у магазина'],['full','Полный вид'],['lite','Простой вид']],
    hint:'У кабинета два вида: полный и «Простой вид». Инструкции для них отличаются — кнопки и пункты меню называются по-разному. В авто-режиме панель раз в 10 минут спрашивает кабинет, какой вид включён у магазина; пока ответа нет, используется полный вид. Выберите вид вручную, если автоопределение не подходит.' },

  { key:'minConfidence', label:'Порог уверенности', kind:'level',
    options: CONFIDENCE_LEVELS.map(([v, t]) => [String(v), t]),
    hint:'Модель сама оценивает от 0 до 1, насколько её ответ подтверждается выдержками из базы знаний, и возвращает эту оценку вместе с ответом. Ниже порога — ответ становится предложкой оператору. Оценка приблизительная, поэтому порог стоит поднимать, если видите неточные автоответы.',
    active:(r) => r.aiMode === 'auto' },

  { key:'autoPerHour', label:'Предел автоответов в диалоге за час', kind:'number',
    attrs:{min:0,max:100,step:1},
    hint:'Предохранитель от зацикливания в одном диалоге, а не общий лимит запросов. Если сработал, следующий ответ уходит оператору предложкой, а клиент получает «передал специалисту» — молча его не игнорируют. 0 — без предела.',
    active:(r) => r.aiMode === 'auto' },

  { key:'humanHoldMinutes', label:'Молчать после ответа оператора, мин', kind:'number',
    attrs:{min:0,max:1440,step:5},
    hint:'После того как в диалоге ответил живой человек, AI не вмешивается указанное время: разговор уже ведёт оператор. 0 — выключено. Действует только когда AI отвечает сам.',
    active:(r) => r.aiMode === 'auto' },

  { key:'maxAgeMinutes', label:'Не отвечать на сообщения старше, мин', kind:'number',
    attrs:{min:1,max:10080,step:10},
    hint:'Защита при перезапуске и разборе завала: если сообщение пролежало дольше этого срока, AI на него не отвечает. Иначе после простоя модель начинает отвечать на вчерашние вопросы, на которые уже ответили или которые потеряли смысл.' },

  { key:'slaFirstResponseMinutes', label:'Срок первого ответа, мин', kind:'number',
    attrs:{min:1,max:10080,step:5},
    hint:'Через сколько минут ожидания прислать уведомление, что клиенту до сих пор никто не ответил. На сам ответ не влияет — это только напоминание вам. Тот же срок применяется к диалогам, переданным человеку.' },

  { key:'handoffRepeatMinutes', label:'Повторять «ожидайте» не чаще, мин', kind:'number',
    attrs:{min:0,max:10080,step:10},
    hint:'Когда диалог передан человеку, а клиент продолжает писать, AI повторяет «вопрос у специалиста» не чаще этого срока. Срабатывает на новое сообщение клиента, а не по таймеру. 0 — не повторять вовсе.' },

  { key:'notifyLevel', label:'Подробность уведомлений', kind:'select',
    options:[['all','Каждое сообщение и действие AI'],['important','Только требующее вмешательства'],['minimal','Только передачи и просрочки']],
    hint:'Что присылать в Telegram. Передача человеку приходит на любом уровне: клиенту в этот момент обещан специалист.' },

  { key:'model', label:'Модель', kind:'text',
    hint:'Имя модели у провайдера. Кнопка «Выбрать» подтянет список от него самого.' },

  { key:'fallbackModel', label:'Запасная модель', kind:'text',
    hint:'Запрос без фото уходит сюда при лимите, временном сбое или снятии основной модели. Фото никогда не передаётся модели без vision: при недоступности основной диалог безопасно останется оператору.' },

  { key:'brand', label:'Название сервиса для AI', kind:'text',
    hint:'Как модель называет ваш сервис в ответах клиентам.' },
];

/** Ближайший уровень: в базе может лежать значение, набранное руками. */
function nearestLevel(value) {
  let best = CONFIDENCE_LEVELS[0][0];
  for (const [level] of CONFIDENCE_LEVELS) {
    if (Math.abs(level - Number(value)) < Math.abs(best - Number(value))) best = level;
  }
  return String(best);
}

const SETTINGS_GROUPS = [
  { id:'safety', title:'Режим и безопасность', note:'Когда AI может отвечать и на что он должен опираться',
    fields:['aiMode','requireKb','autoLearn','bedolagaInterfaceKb','bedolagaInterfaceMode','minConfidence','maxAgeMinutes'] },
  { id:'limits', title:'Лимиты и внимание оператора', note:'Паузы, SLA и защита от зацикливания',
    fields:['autoPerHour','humanHoldMinutes','handoffRepeatMinutes','notifyLevel'] },
  { id:'models', title:'Модели и сервис', note:'Основная, запасная модель и имя бренда',
    fields:['model','fallbackModel','brand'] },
];
let settingsSaveTimer = null;
function showSettingsSaveState(state, text) {
  const wrap = $('setHint').closest('.save-state');
  wrap.dataset.state = state;
  $('setHint').textContent = text;
  clearTimeout(settingsSaveTimer);
  if (state === 'saved') settingsSaveTimer = setTimeout(() => { wrap.dataset.state = 'idle'; $('setHint').textContent = ''; }, 1800);
}

let updatePoll = null;
const UPDATE_STATUS = {
  queued:'В очереди', backing_up:'Резервная копия', installing:'Установка', checking:'Проверка',
  completed:'Установлено', rolled_back:'Откат выполнен', failed:'Ошибка',
};

function paintUpdate(state) {
  const panel = $('updatePanel');
  if (!panel || !state) return;
  const published = state.publishedAt ? ` · ${fmtTime(new Date(state.publishedAt).getTime())}` : '';
  const progress = state.progress;
  const history = state.history ?? [];
  const historyHtml = history.length ? `<details><summary>История операций · ${history.length}</summary><div class="group">${history.slice(0,20).map((row) => `<div class="item">
    <span><b>${row.action === 'rollback' ? 'Откат' : 'Обновление'}${row.version ? ` · ${esc(row.version)}` : ''}</b><span class="hint">${fmtTime(Number(row.created_at))} · ${esc(row.actor_key)}</span></span>
    <span class="badge ${row.status === 'failed' ? 'danger' : row.status === 'completed' || row.status === 'rolled_back' ? 'ok' : ''}">${esc(UPDATE_STATUS[row.status] ?? row.status)}</span></div>`).join('')}</div></details>` : '';
  const progressHtml = progress ? `<div class="ops-card"><header><b>${esc(UPDATE_STATUS[progress.status] ?? progress.status)}</b><span class="badge ${progress.status === 'failed' ? 'danger' : progress.status === 'completed' || progress.status === 'rolled_back' ? 'ok' : ''}">${Number(progress.percent ?? 0)}%</span></header>
    <div class="progress"><i style="width:${Math.max(0,Math.min(100,Number(progress.percent ?? 0)))}%"></i></div>
    <div class="meta"><span>${esc(progress.stage || progress.detail || 'Ожидает ограниченный host-updater')}</span>${progress.backupPath ? '<span>Резервная копия подтверждена</span>' : ''}</div></div>` : '';
  const safety = `<div class="update-safety"><span>Кнопка запускает полную установку.</span><span>Изолированный host-updater скачивает и проверяет релиз.</span><span>Перед заменой создаётся резервная копия; затем выполняются health-check и автоматический откат при ошибке.</span></div>`;
  const changelog = state.changelog ? `<details><summary>Что изменилось в ${esc(state.tag ?? state.latest ?? '')}</summary><pre class="log" style="white-space:pre-wrap;max-height:260px">${esc(state.changelog)}</pre></details>` : '';
  const rollback = state.compatibility?.rollbackAvailable ? '<button class="btn danger" id="updateRollback">Откатить</button>' : '';

  if (!state.enabled) {
    panel.innerHTML = `<div><b>Обновления отключены</b><span class="hint">Включаются через UPDATE_ENABLED на сервере. Текущая версия v${esc(state.current)}.</span></div>${progressHtml}${historyHtml}`;
    return;
  }
  const title = progress && ['queued','backing_up','installing','checking'].includes(progress.status)
    ? `Обновление выполняется: ${UPDATE_STATUS[progress.status]}`
    : state.available ? `Доступна версия ${esc(state.latest)}`
    : `Установлена актуальная версия v${esc(state.current)}`;
  const error = state.error ? `<div class="badge danger">Проверка релиза: ${esc(state.error)}</div>` : '';
  const install = state.tag && !state.queued && state.available
    ? `<button class="btn primary" id="updateApply">Установить v${esc(state.latest)}</button>` : '';
  const reinstall = state.tag && !state.queued && !state.available && state.reinstallable
    ? `<details><summary>Восстановление</summary><button class="btn" id="updateReinstall">Переустановить v${esc(state.current)}</button></details>` : '';
  panel.innerHTML = `<div class="ops-head"><div><b>${title}</b><span class="hint">Канал: ${state.prerelease ? 'предрелизы' : 'стабильные релизы'}${published}</span></div>
    <div class="ops-actions">${install}${rollback}<button class="btn" id="updateRetry">Проверить</button></div></div>
    ${error}${safety}${progressHtml}${reinstall}${changelog}${historyHtml}`;
  $('updateRetry').onclick = () => loadUpdateState(true);
  if ($('updateApply')) $('updateApply').onclick = () => confirmAction('Установить обновление?',
    'Система скачает подписанный релиз, проверит контрольную сумму, создаст резервную копию, установит его и автоматически откатится при неуспешной проверке.', () => requestUpdate('update'));
  if ($('updateReinstall')) $('updateReinstall').onclick = () => confirmAction('Переустановить текущую версию?',
    'Это аварийное восстановление: текущий подписанный релиз будет скачан и установлен заново с резервной копией и автоматическим откатом.', () => requestUpdate('update', true));
  if ($('updateRollback')) $('updateRollback').onclick = () => confirmAction('Откатить обновление?',
    'Будет использована только резервная копия, которую ранее подтвердил host-updater.', () => requestUpdate('rollback'));
  clearInterval(updatePoll);
  if (state.queued || progress && ['queued','backing_up','installing','checking'].includes(progress.status)) {
    updatePoll = setInterval(loadUpdateState, 2000);
  }
}

async function requestUpdate(action, force = false) {
  const result = await mutate('/api/update/request', { method:'POST', body:JSON.stringify({ action, force }) });
  if (result?.update) { paintUpdate(result.update); toast(action === 'rollback' ? 'Откат поставлен в очередь' : 'Обновление поставлено в очередь'); }
}

async function loadUpdateState(force = false) {
  const panel = $('updatePanel');
  if (!canPermission('settings:update')) {
    panel.innerHTML = '<div><b>Центр обновлений</b><span class="hint">У вашей роли нет права управлять обновлениями.</span></div>';
    return;
  }
  if (panel && !panel.querySelector('.ops-head, .ops-card')) panel.innerHTML = '<span class="hint">Проверяю обновления…</span>';
  const retry = $('updateRetry');
  if (retry) retry.disabled = true;
  try {
    const response = await api(`/api/update${force === true ? '?force=1' : ''}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    const state = await response.json();
    paintUpdate(state);
    if (force === true) toast(state.error ? `Проверка завершилась с ошибкой: ${state.error}` : 'Проверка обновлений завершена');
  } catch (err) {
    panel.innerHTML = `<div><b>Центр обновлений недоступен</b><span class="hint">${esc(err instanceof Error ? err.message : String(err))}</span></div><button class="btn" id="updateRetry">Повторить проверку</button>`;
    $('updateRetry').onclick = () => loadUpdateState(true);
  } finally {
    const currentRetry = $('updateRetry');
    if (currentRetry) currentRetry.disabled = false;
  }
}

const SOURCE_APPLY_STATUS = {
  queued:'Ожидает безопасного исполнителя', backing_up:'Создаётся резервная копия',
  applying:'Применяется конфигурация', checking:'Проверяется здоровье приложения',
  completed:'Источник подключён', rolled_back:'Изменения отменены', failed:'Подключить не удалось',
};
let sourceApplyPoll = null;

function sourceProgressMarkup(progressState = state.settings?.sourceManagement) {
  const progress = progressState?.progress;
  if (!progressState?.queued && !progress) return '';
  const status = progress?.status ?? 'queued';
  const tone = status === 'completed' ? 'ok' : ['failed','rolled_back'].includes(status) ? 'danger' : 'warn';
  return `<div class="source-progress ${tone}"><div><b>${esc(SOURCE_APPLY_STATUS[status] ?? 'Добавление источника')}</b>
    <span>${esc(progress?.name || progress?.id || 'Запрос принят')}${progress?.stage ? ` · ${esc(progress.stage)}` : ''}</span></div>
    ${progress?.detail ? `<p>${esc(progress.detail)}</p>` : ''}</div>`;
}

function watchSourceApply() {
  clearInterval(sourceApplyPoll);
  const active = state.settings?.sourceManagement?.queued
    || ['queued','backing_up','applying','checking'].includes(state.settings?.sourceManagement?.progress?.status);
  if (!active) return;
  sourceApplyPoll = setInterval(async () => {
    let response;
    try { response = await api('/api/sources/status'); } catch { return; }
    if (!response.ok) return;
    const sourceState = await response.json();
    if (!state.settings) return;
    state.settings.sourceManagement = sourceState;
    renderSourceFoldersPanel();
    const finished = ['completed','failed','rolled_back'].includes(sourceState?.progress?.status);
    if (finished) {
      clearInterval(sourceApplyPoll);
      sourceApplyPoll = null;
      toast(sourceState.progress.status === 'completed' ? 'Источник подключён' : (sourceState.progress.detail || 'Источник не подключён'));
      if (sourceState.progress.status === 'completed') setTimeout(loadSettings, 1200);
    }
  }, 2200);
}

function openSourceWizard() {
  if (!canPermission('settings:sources')) return;
  const botSources = state.inboxSources.filter((source) => source.kind === 'telegram_bot');
  sheet('Добавить источник',
    `<div class="source-wizard-intro"><b>Новый канал в едином инбоксе</b><span>Секреты передаются только ограниченному host-исполнителю и не возвращаются в браузер.</span></div>
     <div class="frow"><label for="sourceType">Что подключаем</label><select id="sourceType">
       <option value="telegram_bot">Telegram-бот</option><option value="telegram_business">Telegram Business-аккаунт</option><option value="remnawave">Панель Remnawave</option><option value="minishop">MiniShop</option>
     </select></div><div id="sourceWizardFields"></div>`,
    '<button class="btn" id="sourceCancel">Отмена</button><button class="btn primary" id="sourceContinue">Подключить</button>');
  $('sourceCancel').onclick = closeSheet;

  const renderFields = () => {
    const kind = $('sourceType').value;
    const box = $('sourceWizardFields');
    if (kind === 'telegram_bot') {
      box.innerHTML = `<div class="frow"><label for="sourceName">Название бота</label><input id="sourceName" maxlength="120" placeholder="Например, VPN Support"></div>
        <div class="frow"><label for="sourceToken">Токен из @BotFather</label><input id="sourceToken" type="password" autocomplete="new-password" placeholder="123456789:AA…"><span class="hint">После применения токен исчезнет из запроса и не будет показан снова.</span></div>
        <div class="frow"><label for="sourceId">Технический ID · необязательно</label><input id="sourceId" maxlength="80" placeholder="support-bot-eu"><span class="hint">Если оставить пустым, будет создан безопасный уникальный ID.</span></div>`;
      $('sourceContinue').textContent = 'Подключить бота';
    } else if (kind === 'remnawave') {
      box.innerHTML = `<div class="frow"><label for="sourceName">Название панели</label><input id="sourceName" maxlength="120" placeholder="Например, Remnawave Europe"></div>
        <div class="frow"><label for="sourceUrl">URL панели</label><input id="sourceUrl" type="url" maxlength="1000" placeholder="https://panel.example.com"></div>
        <div class="frow"><label for="sourceToken">API-токен</label><input id="sourceToken" type="password" autocomplete="new-password" placeholder="Токен Remnawave"></div>
        <div class="frow"><label for="sourceId">Технический ID · необязательно</label><input id="sourceId" maxlength="80" placeholder="remnawave-eu"></div>
        <label class="source-readonly"><input id="sourceReadOnly" type="checkbox" checked><span><b>Только чтение</b><small>Не разрешать сброс устройств и перевыпуск подписок из этой панели.</small></span></label>`;
      $('sourceContinue').textContent = 'Подключить панель';
    } else if (kind === 'minishop') {
      box.innerHTML = `<div class="frow"><label for="sourceName">Название магазина</label><input id="sourceName" maxlength="120" value="MiniShop"></div>
        <div class="frow"><label for="sourceUrl">URL MiniShop</label><input id="sourceUrl" type="url" maxlength="1000" placeholder="https://shop.example.com"></div>
        <div class="frow"><label for="sourceToken">Service token</label><input id="sourceToken" type="password" autocomplete="new-password" placeholder="MINISHOP_AI_SUPPORT_TOKEN"><span class="hint">Рекомендуется постоянный токен плагина ai-support.</span></div>
        <div class="frow"><label for="sourceMode">Режим API</label><select id="sourceMode"><option value="plugin">Плагин ai-support</option><option value="admin">Временный AdminBearer</option></select></div>`;
      $('sourceContinue').textContent = 'Подключить MiniShop';
    } else {
      const choices = botSources.length
        ? botSources.map((source) => `<li><b>${esc(source.name)}</b><span>${esc(source.id)}</span></li>`).join('')
        : '<li><b>Сначала добавьте Telegram-бота</b><span>Именно ему Telegram передаёт события Business.</span></li>';
      box.innerHTML = `<div class="business-guide"><b>Подключение выполняется в самом Telegram</b>
        <ol><li>Откройте нужный аккаунт Telegram: Настройки → Telegram Business → Чат-боты.</li>
        <li>Выберите одного из ботов ниже и выдайте права читать сообщения и отвечать.</li>
        <li>Вернитесь сюда: аккаунт появится отдельным источником автоматически. Повторите для остальных аккаунтов.</li></ol>
        <ul>${choices}</ul><p>Один бот может обслуживать несколько Business-аккаунтов; папки и профиль сервиса настраиваются отдельно после подключения.</p></div>`;
      $('sourceContinue').textContent = botSources.length ? 'Понятно' : 'Добавить бота';
    }
  };
  $('sourceType').onchange = renderFields;
  renderFields();
  $('sourceContinue').onclick = async () => {
    const kind = $('sourceType').value;
    if (kind === 'telegram_business') {
      if (!botSources.length) { $('sourceType').value = 'telegram_bot'; renderFields(); $('sourceName').focus(); }
      else closeSheet();
      return;
    }
    const payload = { kind, name:$('sourceName').value.trim(), token:$('sourceToken').value.trim(), id:$('sourceId')?.value.trim() ?? '' };
    if (kind === 'remnawave') Object.assign(payload, { url:$('sourceUrl').value.trim(), readOnly:$('sourceReadOnly').checked });
    if (kind === 'minishop') Object.assign(payload, { url:$('sourceUrl').value.trim(), mode:$('sourceMode').value });
    if (!payload.name || !payload.token || (['remnawave','minishop'].includes(kind) && !payload.url)) return toast('Заполните обязательные поля');
    $('sourceContinue').disabled = true;
    const result = await mutate('/api/sources/request', { method:'POST', body:JSON.stringify(payload) });
    if (!result) { $('sourceContinue').disabled = false; return; }
    // Секрет сразу убираем из DOM ещё до закрытия окна.
    $('sourceToken').value = '';
    state.settings.sourceManagement = result.sourceManagement;
    closeSheet();
    renderSourceFoldersPanel();
    watchSourceApply();
    toast('Источник поставлен в очередь');
  };
}

function renderSourceFoldersPanel() {
  const box = $('sourceFolders');
  if (!box) return;
  const sourceWritable = canPermission('settings:sources');
  const serviceWritable = canPermission('settings:services');
  const profiles = state.settings?.serviceProfiles ?? {};
  const sourceRows = state.inboxSources.length ? state.inboxSources.map((source) => `<div class="source-row">
    <span class="source-kind">${esc(sourceKind(source.kind).slice(0, 3).toUpperCase())}</span>
    <div><b>${esc(profiles[source.id]?.serviceName || source.name)}</b><span>${esc(sourceKind(source.kind))} · ${esc(source.name)} · ${esc(source.id)}</span></div>
    <div class="source-actions"><span class="badge ok">${profiles[source.id] ? 'свой профиль' : 'общий профиль'}</span>
      ${serviceWritable ? `<button class="btn" data-edit-service="${esc(source.id)}">Настроить</button>` : ''}</div>
  </div>`).join('') : '<div class="source-row"><div><b>Входящие источники не подключены</b><span>Панель продолжает работать в голом режиме.</span></div></div>';
  const folderRows = state.inboxFolders.length ? state.inboxFolders.map((folder) => {
    const names = folder.source_ids.map((id) => state.inboxSources.find((source) => source.id === id)?.name ?? id);
    return `<div class="folder-row">
      <span class="folder-dot" style="--folder-color:${safeColor(folder.color)}"></span>
      <div><b>${esc(folder.name)}</b><span>${esc(names.join(' · ') || 'Источники пока не выбраны')}</span></div>
      ${sourceWritable ? `<button class="btn" data-edit-folder="${folder.id}">Изменить</button>` : ''}
    </div>`;
  }).join('') : '<div class="folder-row"><div><b>Своих папок пока нет</b><span>Один источник можно включить в несколько папок.</span></div></div>';
  box.innerHTML = `${sourceProgressMarkup()}<div class="source-folders-head"><div><b>Подключённые источники</b><span>${state.inboxSources.length} активных подключений</span></div>${sourceWritable ? '<button class="btn primary" id="newSource">Добавить источник</button>' : ''}</div>
    <div class="source-list">${sourceRows}</div>
    <div class="source-folders-head"><div><b>Папки инбокса</b><span>Состав может пересекаться</span></div>${sourceWritable ? '<button class="btn primary" id="newInboxFolder">Новая папка</button>' : ''}</div>
    <div class="folder-list">${folderRows}</div>`;
  if (sourceWritable) {
    $('newSource').onclick = openSourceWizard;
    $('newInboxFolder').onclick = () => openFolderEditor();
  }
  for (const button of box.querySelectorAll('[data-edit-service]')) {
    button.onclick = () => openServiceEditor(state.inboxSources.find((source) => source.id === button.dataset.editService));
  }
  for (const button of box.querySelectorAll('[data-edit-folder]')) {
    button.onclick = () => openFolderEditor(state.inboxFolders.find((folder) => folder.id === Number(button.dataset.editFolder)) ?? null);
  }
}

function openServiceEditor(source) {
  if (!canPermission('settings:services') || !source) return;
  const profile = state.settings?.serviceProfiles?.[source.id] ?? {};
  const serviceName = profile.serviceName || (source.kind === 'remnawave' ? source.name : state.settings.runtime.brand);
  const greetingMessage = profile.greetingMessage || '';
  const handoffMessage = profile.handoffMessage || state.settings.runtime.handoffMessage || '';
  sheet('Профиль сервиса',
    `<div class="service-profile-copy"><b>${esc(source.name)}</b><span>${esc(sourceKind(source.kind))} · ${esc(source.id)}</span></div>
     <div class="frow"><label for="serviceName">Название для клиента и AI</label><input id="serviceName" type="text" maxlength="80" value="${esc(serviceName)}" placeholder="Название сервиса"></div>
     <div class="frow"><label for="serviceGreeting">Приветствие первого ответа</label><textarea id="serviceGreeting" rows="3" maxlength="600" placeholder="Можно оставить пустым">${esc(greetingMessage)}</textarea><span class="hint">Добавляется один раз — перед первым содержательным ответом.</span></div>
     <div class="frow"><label for="serviceHandoff">Фраза передачи человеку</label><textarea id="serviceHandoff" rows="3" maxlength="600">${esc(handoffMessage)}</textarea><span class="hint">Используется и для напоминания, пока диалог ждёт оператора.</span></div>
     <p class="hint">Связанная панель Remnawave имеет приоритет над общим ботом или Telegram Business. Управление остаётся в одном инбоксе.</p>`,
    '<button class="btn" id="cancel">Отмена</button><button class="btn primary" id="saveService">Сохранить профиль</button>');
  $('cancel').onclick = closeSheet;
  $('saveService').onclick = async () => {
    const payload = {
      serviceName: $('serviceName').value.trim(),
      greetingMessage: $('serviceGreeting').value.trim(),
      handoffMessage: $('serviceHandoff').value.trim(),
    };
    if (!payload.serviceName) return toast('Введите название сервиса');
    $('saveService').disabled = true;
    const result = await mutate(`/api/settings/services/${encodeURIComponent(source.id)}`, {
      method:'POST', body:JSON.stringify(payload),
    }, 'Профиль сервиса сохранён');
    if (!result) { $('saveService').disabled = false; return; }
    state.settings.serviceProfiles = result.serviceProfiles ?? state.settings.serviceProfiles;
    closeSheet();
    renderSourceFoldersPanel();
  };
}

function openFolderEditor(folder = null) {
  if (!canPermission('settings:sources')) return;
  const selected = new Set(folder?.source_ids ?? []);
  const checks = state.inboxSources.length ? state.inboxSources.map((source) => `<label class="folder-check">
    <input type="checkbox" value="${esc(source.id)}"${selected.has(source.id) ? ' checked' : ''}>
    <span><b>${esc(source.name)}</b><small>${esc(sourceKind(source.kind))}</small></span>
  </label>`).join('') : '<span class="hint">Сначала подключите источник на сервере. Пустую папку всё равно можно создать.</span>';
  sheet(folder ? 'Изменить папку' : 'Новая папка',
    `<div class="frow"><label for="folderName">Название</label><input id="folderName" type="text" maxlength="80" value="${esc(folder?.name ?? '')}" placeholder="Например, VPN техподдержка"></div>
     <div class="frow"><label for="folderColor">Цвет метки</label><input id="folderColor" type="color" value="${safeColor(folder?.color)}"></div>
     <div class="frow"><label>Источники · можно повторять в других папках</label><div class="folder-checks">${checks}</div></div>`,
    `${folder ? '<button class="btn danger" id="deleteFolder">Удалить</button>' : ''}<button class="btn" id="cancel">Отмена</button><button class="btn primary" id="saveFolder">Сохранить</button>`);
  $('cancel').onclick = closeSheet;
  $('saveFolder').onclick = async () => {
    const name = $('folderName').value.trim();
    if (!name) return toast('Введите название папки');
    const sourceIds = [...$('sheet').querySelectorAll('.folder-check input:checked')].map((input) => input.value);
    $('saveFolder').disabled = true;
    const result = await mutate('/api/inbox/folders', { method:'POST', body:JSON.stringify({ id:folder?.id, name, color:$('folderColor').value, sourceIds }) }, 'Папка сохранена');
    if (!result) { $('saveFolder').disabled = false; return; }
    state.inboxFolders = result.folders ?? state.inboxFolders;
    closeSheet(); renderInboxTabs(); renderSourceFoldersPanel(); renderList(true);
  };
  if ($('deleteFolder')) $('deleteFolder').onclick = () => confirmAction('Удалить папку?',
    'Диалоги и источники останутся на месте — исчезнет только эта группировка.', async () => {
      const result = await mutate(`/api/inbox/folders/${folder.id}`, { method:'DELETE' }, 'Папка удалена');
      if (!result) return;
      state.inboxFolders = result.folders ?? state.inboxFolders;
      if (state.filter === `folder:${folder.id}`) state.filter = 'all';
      closeSheet(); renderInboxTabs(); renderSourceFoldersPanel(); renderList(true);
    });
}

$('manageFolders').onclick = () => openFolderEditor();

export async function loadSettings() {
  state.settings = await json('/api/settings'); if (!state.settings) return;
  state.inboxSources = state.settings.sources ?? state.inboxSources;
  state.inboxFolders = state.settings.folders ?? state.inboxFolders;
  renderInboxTabs();
  renderSourceFoldersPanel();
  watchSourceApply();
  $('ver').textContent = 'v' + state.settings.version;
  const settingRows = new Map(FIELDS.map((f) => {
    const value = state.settings.runtime[f.key];
    const inactive = f.active && !f.active(state.settings.runtime);
    const fieldWritable = canPermission(`setting:${f.key}`);
    // Сравниваем строками: в runtime булево true, в option — строка 'true',
    // и строгое равенство ничего не подсвечивало.
    const selected = f.kind === 'level' ? nearestLevel(value) : String(value);
    const control = (f.kind === 'select' || f.kind === 'level')
      ? `<select class="ctl" id="setting-${f.key}" data-key="${f.key}" aria-describedby="setting-hint-${f.key}" ${fieldWritable ? '' : 'disabled'}>${f.options.map(([v,t]) =>
          `<option value="${v}"${String(v)===selected?' selected':''}>${esc(t)}</option>`).join('')}</select>`
      : `<input class="ctl" id="setting-${f.key}" type="${f.kind}" data-key="${f.key}" value="${esc(value)}" aria-describedby="setting-hint-${f.key}"${f.attrs
          ? ` min="${f.attrs.min}" max="${f.attrs.max}" step="${f.attrs.step}"` : ''} ${fieldWritable ? '' : 'disabled'}>`;
    return [f.key, `<div class="setting-row${inactive ? ' is-inactive' : ''}" data-setting="${f.key}">
      <div class="setting-main"><label class="setting-label" for="setting-${f.key}">${esc(f.label)}</label><span class="setting-control">${control}</span></div>
      <div class="setting-meta"><button class="why" data-why="${f.key}" aria-expanded="false">Зачем это?</button>${inactive ? '<span class="setting-badge">Только в авто</span>' : ''}</div>
      <span class="hint why-text" id="setting-hint-${f.key}" data-whytext="${f.key}">${esc(f.hint)}${
        inactive ? '<br><b>Сейчас не действует: включается в режиме «отвечает сам».</b>' : ''}</span>
    </div>`];
  }));
  $('aiSettings').innerHTML = SETTINGS_GROUPS.map((group) => `<section class="settings-cluster" data-cluster="${group.id}">
    <header class="settings-cluster-head"><span class="cluster-mark" aria-hidden="true"></span><div><h3>${esc(group.title)}</h3><p>${esc(group.note)}</p></div></header>
    <div class="settings-panel">${group.fields.map((field) => settingRows.get(field)).join('')}</div>
  </section>`).join('').replace(/&lt;b&gt;/g,'<b>').replace(/&lt;\/b&gt;/g,'</b>').replace(/&lt;br&gt;/g,'<br>') + `
    <section class="settings-cluster" data-cluster="voice">
      <header class="settings-cluster-head"><span class="cluster-mark" aria-hidden="true"></span><div><h3>Тон и передача</h3><p>Как звучит помощник и что видит клиент при передаче оператору</p></div></header>
      <div class="settings-panel copy-settings">
        <div class="copy-setting">
          <div class="copy-setting-head"><label for="styleBox">Манера ответа</label><span>до 1200 символов</span></div>
          <textarea id="styleBox" rows="4" maxlength="1200" placeholder="Как AI должен формулировать ответы">${esc(state.settings.runtime.replyStyle ?? '')}</textarea>
          <span class="hint">Например: «пиши коротко», «обращайся на ты», «не используй нумерованные списки».</span>
          <button class="btn" id="styleSave">Сохранить манеру</button>
        </div>
        <div class="copy-setting">
          <div class="copy-setting-head"><label for="handoffBox">Сообщение при передаче человеку</label><span>до 600 символов</span></div>
          <textarea id="handoffBox" rows="3" minlength="5" maxlength="600">${esc(state.settings.runtime.handoffMessage ?? '')}</textarea>
          <span class="hint">После этого AI молчит по существу, пока оператор не ответит.</span>
          <button class="btn" id="handoffSave">Сохранить текст</button>
        </div>
      </div>
    </section>`;
  if (!FIELDS.some((field) => canPermission(`setting:${field.key}`))) {
    $('aiSettings').insertAdjacentHTML('afterbegin', '<div class="ops-note"><b>Режим просмотра</b><span class="hint">У роли нет прав на изменение этих параметров.</span></div>');
  }
  for (const el of $('aiSettings').querySelectorAll('[data-key]')) {
    if (!canPermission(`setting:${el.dataset.key}`)) {
      el.title = 'Это поле запрещено настройками роли';
      continue;
    }
    el.onchange = async () => {
      const row = el.closest('.setting-row');
      row.classList.add('is-saving'); el.disabled = true; showSettingsSaveState('saving', 'Сохраняю…');
      const saved = await mutate('/api/settings', { method:'POST', body: JSON.stringify({ [el.dataset.key]: el.value }) });
      row.classList.remove('is-saving'); el.disabled = false;
      if (saved?.runtime) {
        state.settings.runtime = saved.runtime;
        // Подпись режима в открытом диалоге зависит от глобального режима.
        renderAiNote();
        for (const f of FIELDS) {
          const target = $('aiSettings').querySelector(`[data-setting="${f.key}"]`); if (!target) continue;
          const inactive = f.active && !f.active(state.settings.runtime);
          target.classList.toggle('is-inactive', Boolean(inactive));
          let badge = target.querySelector('.setting-badge');
          if (inactive && !badge) { badge = Object.assign(document.createElement('span'), { className:'setting-badge', textContent:'Только в авто' }); target.querySelector('.setting-meta').append(badge); }
          if (!inactive) badge?.remove();
          const hint = target.querySelector('.why-text');
          hint.innerHTML = `${esc(f.hint)}${inactive ? '<br><b>Сейчас не действует: включается в режиме «отвечает сам».</b>' : ''}`;
        }
        showSettingsSaveState('saved', 'Сохранено');
      } else showSettingsSaveState('error', 'Не сохранено');
    };
  }
  for (const b of $('aiSettings').querySelectorAll('.why')) {
    b.onclick = () => {
      const text = $('aiSettings').querySelector(`[data-whytext="${b.dataset.why}"]`);
      const open = text.classList.toggle('open');
      b.setAttribute('aria-expanded', String(open));
      b.textContent = open ? 'Скрыть описание' : 'Зачем это?';
    };
  }

  // Список моделей провайдера: набирать вручную — верный способ опечататься.
  // Выбор модели и ключа — для основной и запасной одинаково. Ключ важен:
  // у провайдеров лимит бывает и на модель, и на аккаунт, и если запасная
  // ходит тем же ключом, при аккаунтном лимите она не спасает.
  for (const [field, keyField, title] of [
    ['model', 'modelKey', 'Основная модель'],
    ['fallbackModel', 'fallbackKey', 'Запасная модель'],
  ]) {
    const input = $('aiSettings').querySelector(`[data-key="${field}"]`);
    if (!input || !canPermission(`setting:${field}`) || !canPermission(`setting:${keyField}`) || !canPermission('settings:ai_tools')) continue;
    const pick = document.createElement('button');
    pick.className = 'btn model-pick';
    pick.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M4 10h8M4 14h10"/></svg><span>Выбрать</span>';
    pick.onclick = async () => {
      pick.disabled = true;
      const [models, keys] = await Promise.all([json('/api/ai/models'), json('/api/ai/keys')]);
      pick.disabled = false;
      if (!models) return toast('Провайдер не отдал список моделей');
      const current = state.settings.runtime[field];
      const boundKey = state.settings.runtime[keyField] ?? -1;
      sheet(title,
        `<div class="frow"><label>Модель · найдено ${models.models.length}</label>
           <select id="modelPick" size="10" style="height:auto">${
             (field === 'fallbackModel' ? ['', ...models.models] : models.models).map((m) =>
               `<option value="${esc(m)}"${m === current ? ' selected' : ''}>${m ? esc(m) : '— без запасной —'}</option>`).join('')}</select></div>
         <div class="frow"><label>Каким ключом ходит</label>
           <select id="keyPick">
             <option value="-1"${boundKey === -1 ? ' selected' : ''}>Любой доступный</option>
             ${(keys?.keys ?? []).map((k, i) =>
               `<option value="${i}"${boundKey === i ? ' selected' : ''}>Ключ #${i + 1} · ${esc(k)}</option>`).join('')}
           </select>
           <span class="hint">Если у провайдера лимит считается на аккаунт, запасной модели нужен свой ключ — иначе она упрётся в тот же потолок.</span>
         </div>`,
        `<button class="btn" id="cancel">Отмена</button><button class="btn primary" id="useModel">Применить</button>`);
      $('cancel').onclick = closeSheet;
      $('useModel').onclick = async () => {
        const patch = { [field]: $('modelPick').value, [keyField]: Number($('keyPick').value) };
        if (await mutate('/api/settings', { method:'POST', body: JSON.stringify(patch) }, 'Сохранено')) {
          closeSheet(); loadSettings();
        }
      };
    };
    input.after(pick);
  }

  if (canPermission('setting:replyStyle')) {
    $('styleSave').onclick = async () => {
      showSettingsSaveState('saving', 'Сохраняю…'); $('styleSave').disabled = true;
      const saved = await mutate('/api/settings', { method:'POST', body: JSON.stringify({ replyStyle: $('styleBox').value }) }, 'Манера сохранена');
      $('styleSave').disabled = false; showSettingsSaveState(saved ? 'saved' : 'error', saved ? 'Сохранено' : 'Не сохранено');
    };
  } else { $('styleBox').disabled = true; $('styleSave').disabled = true; }
  if (canPermission('setting:handoffMessage')) {
    $('handoffSave').onclick = async () => {
      showSettingsSaveState('saving', 'Сохраняю…'); $('handoffSave').disabled = true;
      const saved = await mutate('/api/settings', { method:'POST', body: JSON.stringify({ handoffMessage: $('handoffBox').value }) }, 'Текст сохранён');
      $('handoffSave').disabled = false; showSettingsSaveState(saved ? 'saved' : 'error', saved ? 'Сохранено' : 'Не сохранено');
    };
  } else { $('handoffBox').disabled = true; $('handoffSave').disabled = true; }

  const caps = state.settings.remnawave;
  const business = state.settings.businessConnectionLive;
  const healthCards = [
    { label:'Telegram Business', value:state.settings.channels.tg_dm ? 'Подключён' : 'Не подключён', tone:state.settings.channels.tg_dm ? 'ok' : 'off' },
    { label:'Telegram-бот', value:state.settings.channels.tg_bot ? 'Принимает личные сообщения' : 'Не подключён', tone:state.settings.channels.tg_bot ? 'ok' : 'off' },
    { label:'Bedolaga', value:state.settings.channels.bedolaga ? 'Тикеты подключены' : 'Не подключена', tone:state.settings.channels.bedolaga ? 'ok' : 'off' },
    { label:'MiniShop', value:state.settings.channels.minishop ? 'Тикеты подключены' : 'Не подключён', tone:state.settings.channels.minishop ? 'ok' : 'off' },
    { label:'Business Connection', value:business?.enabled ? (business.canReply ? 'Можно отвечать' : 'Нет права отвечать') : business ? 'Отключено в аккаунте' : 'Нет подключения', tone:business?.enabled && business.canReply ? 'ok' : business ? 'warn' : 'off' },
    { label:'Remnawave', value:caps ? (caps.index?.size ? `${caps.index.size} клиентов в индексе` : 'Подключён') : 'Не подключён', tone:caps ? 'ok' : 'off' },
    { label:'Уведомления', value:state.settings.alerts?.configured ? (state.settings.alerts.lastError ? `Ошибка: ${state.settings.alerts.lastError}` : `Работают · отправлено ${state.settings.alerts.sent}`) : 'ALERT_CHAT_ID не задан', tone:state.settings.alerts?.lastError ? 'error' : state.settings.alerts?.configured ? 'ok' : 'off' },
    { label:'AI-модели', value:state.settings.ai ? `${state.settings.ai.model}${state.settings.ai.fallback ? ` → ${state.settings.ai.fallback}` : ''} · ключей ${state.settings.ai.keys}` : 'Не настроены', tone:state.settings.ai?.keys ? 'accent' : 'warn' },
    { label:'Мониторинг узлов', value:state.settings.nodes ? `${state.settings.nodes.known} узлов${state.settings.nodes.at ? ` · ${fmtTime(state.settings.nodes.at)}` : ''}` : 'Выключен', tone:state.settings.nodes ? 'ok' : 'off' },
    { label:'База знаний', value:`${state.settings.kb} статей`, tone:state.settings.kb ? 'accent' : 'warn' },
    { label:'Доступ Remnawave', value:state.settings.readOnly ? 'Только чтение' : 'Действия разрешены', tone:state.settings.readOnly ? 'neutral' : 'warn' },
    { label:'Последний опрос Bedolaga', value:state.settings.lastBedolagaPoll ? fmtTime(Number(state.settings.lastBedolagaPoll)) : 'Данных нет', tone:state.settings.lastBedolagaPoll ? 'ok' : 'off' },
    { label:'Последний опрос MiniShop', value:state.settings.lastMinishopPoll ? fmtTime(Number(state.settings.lastMinishopPoll)) : 'Данных нет', tone:state.settings.lastMinishopPoll ? 'ok' : 'off' },
  ];
  $('health').innerHTML = healthCards.map((card) => `<article class="health-card ${card.tone}"><span class="health-status"><i></i></span><div><b>${esc(card.label)}</b><span>${esc(card.value)}</span></div></article>`).join('')
    + `<div class="health-action"><div><b>Проверка уведомлений</b><span>Отправим тестовое сообщение в служебный чат.</span></div><button class="btn" id="testAlert">Отправить тест</button></div>`;
  if (canPermission('settings:alerts')) {
    $('testAlert').onclick = async () => {
      $('testAlert').disabled = true;
      await mutate('/api/settings/test-alert', { method:'POST' }, 'Отправлено — проверьте чат');
      $('testAlert').disabled = false;
      loadSettings();
    };
  } else {
    $('testAlert').disabled = true;
    $('testAlert').title = 'Проверка запрещена настройками роли';
  }
  requestAnimationFrame(() => scrollToSettingsCategory(requestedSettingsSection, false));
  void loadUpdateState();
}
