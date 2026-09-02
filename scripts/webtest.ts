import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.BOT_TOKEN = '123:FAKE';
process.env.PANEL_TOKEN = 'test-token-0123456789abcdef';
process.env.AI_MODE = 'off';
process.env.PANEL_PORT = '8099';
process.env.LOG_LEVEL = 'error';
const dir = mkdtempSync(join(tmpdir(), 'web-'));
process.env.DB_PATH = join(dir, 'w.db');
const sourceRequestPath = join(dir, 'source-request.json');
process.env.SOURCE_REQUEST_FILE = sourceRequestPath;
process.env.SOURCE_STATUS_FILE = join(dir, 'source-status.json');

const { Store } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');
const { Outbox } = await import('../src/core/outbox.js');
const { startWeb } = await import('../src/panel/server.js');

const db = openDatabase(); const store = new Store(db);
const outbox = new Outbox(store);
const bedolagaCalls: Array<{ id: number; status: string }> = [];
let failBedolagaStatus = false;
const bedolaga = {
  setStatus: async (id: number, status: string) => {
    if (failBedolagaStatus) throw new Error('remote rejected');
    bedolagaCalls.push({ id, status });
  },
};
outbox.register('tg_dm', { send: async () => ({ externalMsgId: '1' }) });
const firstInbound = store.recordInbound({ channel:'tg_dm', externalId:'555', tgUserId:555, businessConnectionId:'b1',
  username:'client', displayName:'Клиент', text:'привет, не работает', externalMsgId:'1', sentAt: Date.now() });
store.setConversationAvatar(firstInbound!.conversation.id, 'avatar-file');
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).startsWith('https://api.telegram.org/file/bot')) {
    // Telegram реально отвечает для фото application/octet-stream. Маркер
    // JPEG нужен, чтобы endpoint доказал корректный тип при nosniff.
    return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]), {
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  return nativeFetch(input, init);
}) as typeof fetch;
const fakeBot = { api: { getFile: async () => ({ file_path: 'photos/avatar.bin' }) } };
const app = await startWeb({ store, outbox, bot: fakeBot as any, bedolaga: bedolaga as any });
const B = 'http://127.0.0.1:8099'; const T = process.env.PANEL_TOKEN!;
const h = { authorization: `Bearer ${T}` };
let fails = 0;
const ok = (l:string,c:boolean,d?:unknown)=>{ c?console.log('  ok   '+l):(fails++,console.error('  FAIL '+l,d??'')); };

ok('без токена 401', (await fetch(`${B}/api/conversations`)).status === 401);
ok('неверный токен 401', (await fetch(`${B}/api/conversations`,{headers:{authorization:'Bearer nope'}})).status === 401);
ok('основной токен запрещён в URL',
  (await fetch(`${B}/api/settings?token=${encodeURIComponent(T)}`)).status === 401);
const list = await (await fetch(`${B}/api/conversations`,{headers:h})).json() as any;
ok('список отдаётся', list.conversations.length === 1, list);
ok('окно посчитано в API', list.conversations[0].window.open === true && list.conversations[0].window.applies === true);
const id = list.conversations[0].id;
const avatarResponse = await fetch(`${B}/api/conversations/${id}/avatar`, { headers:h });
ok('аватар с octet-stream отдаётся браузеру как JPEG', avatarResponse.status === 200
  && avatarResponse.headers.get('content-type')?.startsWith('image/jpeg') === true
  && (await avatarResponse.arrayBuffer()).byteLength === 8);
const sourceId = list.conversations[0].source_ids?.[0];
const inboxMeta = await (await fetch(`${B}/api/inbox/meta`, { headers:h })).json() as any;
ok('метаданные инбокса содержат источник', Boolean(sourceId)
  && inboxMeta.sources.some((source: any) => source.id === sourceId), inboxMeta);
const serviceProfileResponse = await fetch(`${B}/api/settings/services/${encodeURIComponent(sourceId)}`, {
  method:'POST', headers:{...h,'content-type':'application/json'},
  body:JSON.stringify({
    serviceName:'Личная поддержка',
    greetingMessage:'Здравствуйте!',
    handoffMessage:'Передаю вопрос человеку.',
  }),
});
const serviceProfileBody = await serviceProfileResponse.json() as any;
ok('администратор сохраняет отдельный профиль источника', serviceProfileResponse.status === 200
  && serviceProfileBody.profile.serviceName === 'Личная поддержка'
  && serviceProfileBody.serviceProfiles[sourceId].handoffMessage === 'Передаю вопрос человеку.');
const metaWithProfile = await (await fetch(`${B}/api/inbox/meta`, { headers:h })).json() as any;
ok('профиль сервиса возвращается центру управления',
  metaWithProfile.serviceProfiles[sourceId]?.greetingMessage === 'Здравствуйте!');
ok('профиль неизвестного источника не создаётся', (await fetch(`${B}/api/settings/services/missing-source`, {
  method:'POST', headers:{...h,'content-type':'application/json'},
  body:JSON.stringify({ serviceName:'Чужой', handoffMessage:'Передаю человеку.' }),
})).status === 400);
const saveFolder = async (name: string, sourceIds: string[]) => {
  const response = await fetch(`${B}/api/inbox/folders`, {
    method:'POST', headers:{...h,'content-type':'application/json'},
    body:JSON.stringify({ name, color:'#7788aa', sourceIds }),
  });
  return { status: response.status, body: await response.json() as any };
};
const folderOne = await saveFolder('Личная линия', [sourceId]);
const folderTwo = await saveFolder('VIP', [sourceId]);
ok('один источник входит в несколько папок', folderOne.status === 200 && folderTwo.status === 200
  && folderOne.body.folder.source_ids.includes(sourceId)
  && folderTwo.body.folder.source_ids.includes(sourceId));
const deleteFolder = await fetch(`${B}/api/inbox/folders/${folderOne.body.folder.id}`, { method:'DELETE', headers:h });
const foldersAfterDelete = (await (await fetch(`${B}/api/inbox/meta`, { headers:h })).json() as any).folders;
ok('удаление одной папки не ломает пересекающуюся', deleteFolder.status === 200
  && foldersAfterDelete.some((folder: any) => folder.id === folderTwo.body.folder.id && folder.source_ids.includes(sourceId)));
const one = await (await fetch(`${B}/api/conversations/${id}`,{headers:h})).json() as any;
ok('тред отдаётся', one.messages.length === 1 && one.messages[0].text === 'привет, не работает');
ok('панель отдаётся статикой', (await (await fetch(`${B}/`)).text()).includes('ai-support'));
ok('404 на несуществующий диалог', (await fetch(`${B}/api/conversations/9999`,{headers:h})).status === 404);
ok('пустой текст отклонён', (await fetch(`${B}/api/conversations/${id}/reply`,{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({text:'  '})})).status === 400);
const presence = await fetch(`${B}/api/conversations/${id}/presence`, {
  method: 'POST', headers: { ...h, 'content-type':'application/json' }, body: JSON.stringify({ state:'viewing' }),
});
ok('простой просмотр диалога не глушит AI', presence.status === 200 && !store.operatorIsActive(id));
const engaged = await fetch(`${B}/api/conversations/${id}/engage`, { method: 'POST', headers: h });
ok('явно взятый оператором диалог ставит AI на паузу', engaged.status === 200 && store.operatorIsActive(id));

const WS = (await import('ws')).default;
const ticket = await (await fetch(`${B}/api/ticket`,{headers:h})).json() as { ticket:string };
const ws = new WS(`ws://127.0.0.1:8099/ws?token=${encodeURIComponent(ticket.ticket)}`);
const frame = await new Promise<any>((res, rej) => {
  ws.on('open', async () => {
    await fetch(`${B}/api/conversations/${id}/reply`,{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({text:'сейчас посмотрю'})});
  });
  ws.on('message', (d:any) => res(JSON.parse(d.toString())));
  setTimeout(()=>rej(new Error('таймаут WS')), 4000);
}).catch(e=>({error:e.message}));
ok('WS присылает исходящее в реальном времени', frame?.type==='message' && frame?.message?.text==='сейчас посмотрю', frame);
const conversationFrame = new Promise<any>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('таймаут карточки WS')), 4000);
  const receive = (data: any) => {
    const next = JSON.parse(data.toString());
    if (next.type !== 'conversation') return;
    clearTimeout(timeout); ws.off('message', receive); resolve(next);
  };
  ws.on('message', receive);
});
store.setTelegramProfile(id, { tgUserId:555, displayName:'Клиент обновлён', avatarFileId:'avatar-file' });
const liveConversation = await conversationFrame.catch((error) => ({ error:error.message }));
ok('WS присылает изменение имени и аватара', liveConversation.type === 'conversation'
  && liveConversation.conversation.display_name === 'Клиент обновлён', liveConversation);

const newChatFrame = new Promise<any>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('таймаут нового чата WS')), 4000);
  const receive = (data: any) => {
    const next = JSON.parse(data.toString());
    if (next.type !== 'message' || next.conversation.remote_external_id !== '777') return;
    clearTimeout(timeout); ws.off('message', receive); resolve(next);
  };
  ws.on('message', receive);
});
store.recordInbound({ channel:'tg_dm', externalId:'777', tgUserId:777, businessConnectionId:'b1',
  displayName:'Новый клиент', text:'новый чат', externalMsgId:'new-1', sentAt:Date.now() });
const liveNewChat = await newChatFrame.catch((error) => ({ error:error.message }));
ok('WS немедленно присылает новый диалог', liveNewChat.type === 'message'
  && liveNewChat.conversation.display_name === 'Новый клиент', liveNewChat);
const badWs = new WS(`ws://127.0.0.1:8099/ws?token=bad`);
ok('WS без токена не апгрейдится', await new Promise(r=>{badWs.on('error',()=>r(true));badWs.on('open',()=>r(false));}));

// Токен той же длины, но другой — проверяем, что сравнение не подменено длиной.
const sameLen = 'X'.repeat(T.length);
ok('токен той же длины отвергается', (await fetch(`${B}/api/conversations`,{headers:{authorization:`Bearer ${sameLen}`}})).status === 401);
ok('здоровье отдаётся', (await (await fetch(`${B}/api/health`,{headers:h})).json() as any).ok === true);
ok('шаблоны отдаются', Array.isArray((await (await fetch(`${B}/api/templates`,{headers:h})).json() as any).templates));
ok('статистика отдаётся', typeof (await (await fetch(`${B}/api/stats`,{headers:h})).json() as any).days === 'number');
const st = await fetch(`${B}/api/conversations/${id}/state`,{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({aiMode:'off',status:'pending'})});
ok('состояние диалога меняется', st.status === 200 && (await st.json() as any).conversation.ai_mode === 'off');

store.recordInbound({ channel:'bedolaga', externalId:'77', displayName:'Тикет Bedolaga',
  text:'внешний тикет', externalMsgId:'bed-1', sentAt: Date.now() });
const bedolagaConversation = store.findConversation('bedolaga', '77', 'bedolaga-default')!;
const closeBedolaga = await fetch(`${B}/api/conversations/${bedolagaConversation.id}/state`, {
  method:'POST', headers:{...h,'content-type':'application/json'}, body:JSON.stringify({ status:'resolved' }),
});
ok('решение в панели сначала закрывает тикет Bedolaga', closeBedolaga.status === 200
  && bedolagaCalls.some((call) => call.id === 77 && call.status === 'closed')
  && store.getConversation(bedolagaConversation.id)?.status === 'resolved');
failBedolagaStatus = true;
const failedBedolagaOpen = await fetch(`${B}/api/conversations/${bedolagaConversation.id}/state`, {
  method:'POST', headers:{...h,'content-type':'application/json'}, body:JSON.stringify({ status:'open' }),
});
ok('ошибка Bedolaga не рассинхронизирует локальный статус', failedBedolagaOpen.status === 502
  && store.getConversation(bedolagaConversation.id)?.status === 'resolved');
failBedolagaStatus = false;
const invalidState = await fetch(`${B}/api/conversations/${id}/state`,{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({status:'broken',handoff:true})});
const stateAfterReject = await (await fetch(`${B}/api/conversations/${id}`,{headers:h})).json() as any;
ok('невалидное состояние отклоняется целиком', invalidState.status === 400
  && stateAfterReject.conversation.status === 'pending' && stateAfterReject.conversation.handoff_at === null);
ok('заметка добавляется', (await fetch(`${B}/api/conversations/${id}/note`,{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({text:'внутренняя'})})).status === 200);
ok('вложение без файла даёт 404', (await fetch(`${B}/api/attachments/999`,{headers:h})).status === 404);

// Новые маршруты панели
ok('настройки отдаются', typeof (await (await fetch(`${B}/api/settings`,{headers:h})).json() as any).runtime.aiMode === 'string');
const badSet = await fetch(`${B}/api/settings`,{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({minConfidence: 5})});
ok('невалидная настройка отклонена', badSet.status === 400);
const goodSet = await fetch(`${B}/api/settings`,{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({minConfidence: 0.9})});
ok('валидная настройка принята', goodSet.status === 200);
const secret = await fetch(`${B}/api/settings`,{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({minConfidence:0.42,botToken:'hack'})});
const settingsAfterReject = await (await fetch(`${B}/api/settings`,{headers:h})).json() as any;
ok('пакет настроек отклоняется целиком', secret.status === 400 && settingsAfterReject.runtime.minConfidence === 0.9);

const invalidSource = await fetch(`${B}/api/sources/request`, {
  method:'POST', headers:{...h,'content-type':'application/json'},
  body:JSON.stringify({ kind:'telegram_bot', name:'Второй бот', token:'не-токен' }),
});
ok('некорректный источник отклонён до записи', invalidSource.status === 409);
const sourceToken = '123456789:' + 'A'.repeat(35);
const sourceRequest = await fetch(`${B}/api/sources/request`, {
  method:'POST', headers:{...h,'content-type':'application/json'},
  body:JSON.stringify({ kind:'telegram_bot', name:'Второй бот', id:'support-bot-two', token:sourceToken }),
});
const sourceResponseText = await sourceRequest.text();
const sourcePayload = JSON.parse(readFileSync(sourceRequestPath, 'utf8')) as any;
ok('источник ставится в безопасную очередь', sourceRequest.status === 200
  && sourcePayload.source.id === 'support-bot-two');
ok('секрет источника не возвращается в браузер', !sourceResponseText.includes(sourceToken));
ok('файл запроса источника root-only', (statSync(sourceRequestPath).mode & 0o777) === 0o600);
const sourceStatusText = await (await fetch(`${B}/api/sources/status`, { headers:h })).text();
ok('статус источника не раскрывает токен', !sourceStatusText.includes(sourceToken)
  && JSON.parse(sourceStatusText).queued === true);
const kb = await (await fetch(`${B}/api/kb`,{headers:h})).json() as any;
ok('список базы знаний отдаётся', Array.isArray(kb.kb) && Array.isArray(kb.drafts));
const traverse = await fetch(`${B}/api/kb/kb/${encodeURIComponent('../../../etc/passwd')}`,{headers:h});
ok('выход за каталог не проходит', traverse.status === 404);
const notMd = await fetch(`${B}/api/kb/kb/evil.sh`,{method:'PUT',headers:{...h,'content-type':'application/json'},body:JSON.stringify({text:'x'})});
ok('не-markdown записать нельзя', notMd.status === 400);

// Регрессия: Fastify отбивает POST с content-type: application/json и пустым
// телом (FST_ERR_CTP_EMPTY_JSON_BODY) ещё до обработчика. Так молча ломалась
// публикация черновиков — сервер отвечал «Bad Request», а панель это глотала.
const emptyBody = await fetch(`${B}/api/conversations/${id}/read`, {
  method: 'POST', headers: { ...h, 'content-type': 'application/json' },
});
ok('пустое тело при json-заголовке принимается', emptyBody.status === 200, emptyBody.status);

const brokenJson = await fetch(`${B}/api/kb`, {
  method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{сломано',
});
ok('битый JSON по-прежнему отклоняется', brokenJson.status === 400, brokenJson.status);

const withBody = await fetch(`${B}/api/conversations/${id}/state`, {
  method: 'POST', headers: { ...h, 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'open' }),
});
ok('нормальное тело принимается', withBody.status === 200, withBody.status);

// Роли проверяем через настоящий HTTP-слой: одной проверки Operations.can()
// недостаточно, потому что порядок правил маршрутов уже однажды открывал
// административные GET-ответы viewer-у.
const createOperator = async (name: string, role: string) => {
  const response = await fetch(`${B}/api/operators`, {
    method: 'POST', headers: { ...h, 'content-type': 'application/json' },
    body: JSON.stringify({ name, role }),
  });
  return { status: response.status, body: await response.json() as any };
};
const viewer = await createOperator('Наблюдатель', 'viewer');
const agent = await createOperator('Оператор', 'agent');
const lead = await createOperator('Старший', 'lead');
ok('администратор создаёт все рабочие роли', [viewer, agent, lead].every((item) => item.status === 200 && item.body.token));
const roleHeaders = (operatorToken: string) => ({ authorization: `Bearer ${operatorToken}` });
const viewerH = roleHeaders(viewer.body.token);
const agentH = roleHeaders(agent.body.token);
const leadH = roleHeaders(lead.body.token);
ok('viewer читает диалоги', (await fetch(`${B}/api/conversations`, { headers: viewerH })).status === 200);
const viewerSettings = await (await fetch(`${B}/api/settings`, { headers: viewerH })).json() as any;
const viewerHealth = await (await fetch(`${B}/api/health`, { headers: viewerH })).json() as any;
ok('viewer не получает внутренний id Telegram Business',
  viewerSettings.businessConnection === true
  && viewerHealth.businessConnection === true
  && viewerSettings.businessConnectionLive?.id === undefined
  && !JSON.stringify({ viewerSettings, viewerHealth }).includes('"b1"'));
ok('viewer не получает credential подписки', (await fetch(`${B}/api/conversations/${id}/subscription`, { headers: viewerH })).status === 403);
ok('viewer не меняет диалог', (await fetch(`${B}/api/conversations/${id}/note`, {
  method: 'POST', headers: { ...viewerH, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'нет' }),
})).status === 403);
ok('viewer не видит обновления, операторов, аудит и обучение', (await Promise.all([
  fetch(`${B}/api/update`, { headers: viewerH }),
  fetch(`${B}/api/operators`, { headers: viewerH }),
  fetch(`${B}/api/audit`, { headers: viewerH }),
  fetch(`${B}/api/learning/candidates`, { headers: viewerH }),
])).every((response) => response.status === 403));
ok('viewer не видит диагностику и параметры AI', (await Promise.all([
  fetch(`${B}/api/diagnostics`, { headers: viewerH }),
  fetch(`${B}/api/ai/keys`, { headers: viewerH }),
  fetch(`${B}/api/ai/models`, { headers: viewerH }),
])).every((response) => response.status === 403));

// В тело специально кладём поле с чувствительным именем. Оно не является
// настоящим секретом, но позволяет доказать, что аудит не сохранит значение.
const filterResponse = await fetch(`${B}/api/filters`, {
  method: 'POST', headers: { ...agentH, 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Мои VIP',
    query: {
      tag: 'vip',
      password: 'audit-redaction-probe',
      authorization: 'Bearer audit-authorization-probe',
      cookie: 'audit-cookie-probe',
    },
  }),
});
ok('agent ведёт диалоги и свои фильтры', filterResponse.status === 200);
ok('agent не меняет SLA и не читает аудит', (await Promise.all([
  fetch(`${B}/api/sla/normal`, { method: 'PUT', headers: { ...agentH, 'content-type': 'application/json' }, body: JSON.stringify({ firstResponseMinutes: 15, resolutionMinutes: 120 }) }),
  fetch(`${B}/api/audit`, { headers: agentH }),
])).every((response) => response.status === 403));
const leadSla = await fetch(`${B}/api/sla/normal`, {
  method: 'PUT', headers: { ...leadH, 'content-type': 'application/json' },
  body: JSON.stringify({ firstResponseMinutes: 15, resolutionMinutes: 120 }),
});
ok('lead меняет SLA', leadSla.status === 200);
ok('lead читает диагностику, но не видит ключи AI',
  (await fetch(`${B}/api/diagnostics`, { headers: leadH })).status === 200
  && (await fetch(`${B}/api/ai/keys`, { headers: leadH })).status === 403);
ok('lead не меняет системные настройки и не запускает обновление', (await Promise.all([
  fetch(`${B}/api/settings`, { method: 'POST', headers: { ...leadH, 'content-type': 'application/json' }, body: JSON.stringify({ minConfidence: 0.8 }) }),
  fetch(`${B}/api/settings/services/${encodeURIComponent(sourceId)}`, { method: 'POST', headers: { ...leadH, 'content-type': 'application/json' }, body: JSON.stringify({ serviceName: 'Нет доступа' }) }),
  fetch(`${B}/api/sources/status`, { headers: leadH }),
  fetch(`${B}/api/sources/request`, { method: 'POST', headers: { ...leadH, 'content-type': 'application/json' }, body: JSON.stringify({ kind:'telegram_bot', name:'Нет доступа', token:sourceToken }) }),
  fetch(`${B}/api/update/request`, { method: 'POST', headers: { ...leadH, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'update' }) }),
])).every((response) => response.status === 403));
unlinkSync(sourceRequestPath);
const audit = await (await fetch(`${B}/api/audit`, { headers: leadH })).json() as any;
const auditPayload = JSON.stringify(audit.events);
ok('lead читает аудит, секретоподобные поля вычищены', Array.isArray(audit.events)
  && auditPayload.includes('[redacted]')
  && !auditPayload.includes('audit-redaction-probe')
  && !auditPayload.includes('audit-authorization-probe')
  && !auditPayload.includes('audit-cookie-probe'));

// Подбор токена: без ограничения частоты панель защищена одним секретом,
// который можно перебирать тысячами попыток в секунду.
let lastStatus = 0;
for (let i = 0; i < 9; i += 1) {
  lastStatus = (await fetch(`${B}/api/conversations`, { headers: { authorization: 'Bearer wrong-token-here' } })).status;
}
ok('подбор токена упирается в блокировку', lastStatus === 429, lastStatus);
ok('верный токен после блокировки тоже ждёт',
  (await fetch(`${B}/api/conversations`, { headers: h })).status === 429);

ws.close(); await app.close(); globalThis.fetch = nativeFetch; db.close(); rmSync(dir,{recursive:true,force:true});
console.log(fails===0?'\nВеб-слой: все проверки прошли':`\nПровалено: ${fails}`);
process.exit(fails===0?0:1);
