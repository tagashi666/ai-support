import { randomUUID } from 'node:crypto';
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
process.env.MEDIA_DIR = join(dir, 'media');
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
const bedolagaExtendCalls: Array<{ id: number; days: number }> = [];
const bedolagaTransactionPageCalls: Array<{ userId: number; limit: number; offset: number }> = [];
let failBedolagaStatus = false;
let useLargeBedolagaTransactionPage = false;
let useIncompleteBedolagaExtensionResponse = false;
let failBedolagaExtensionAfterCommit = false;
const secretSubscriptionUrl = 'https://subscription.invalid/live-private-token';
const secretTunnelUrl = 'vless://private-user-id@vpn.invalid:443?security=tls';
const secretTelegramUrl = 'tg://resolve?domain=private-support';
const secretJwt = 'eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LXBheWxvYWQ.c2lnbmF0dXJl';
const secretExternalPaymentId = 'gateway-secret-payment-id';
const secretRawMetadata = 'raw-secret-metadata';
const bedolagaUser = {
  id: 42, telegram_id: 555, username: 'client', first_name: 'Клиент', last_name: 'Тестовый',
  email: 'client@example.invalid', status: 'active', language: 'ru', balance_kopeks: 12_345,
  referral_code: 'TEST42', has_had_paid_subscription: true, has_made_first_topup: true,
  created_at: '2026-01-01T10:00:00Z', last_activity: '2026-09-08T10:00:00Z',
  subscription: {
    id: 900, user_id: 42, status: 'active', actual_status: 'active', is_trial: false,
    start_date: '2026-08-01T10:00:00Z', end_date: '2026-10-01T10:00:00Z',
    traffic_limit_gb: 100, traffic_used_gb: 12.5, device_limit: 5,
    subscription_url: secretSubscriptionUrl, autopay_enabled: true,
  },
};
const staleTelegramUser = { ...bedolagaUser, id: 99, telegram_id: 999, username: 'stale-client' };
const subscriptionWithoutOwner = {
  id: 902, status: 'active', actual_status: 'active', is_trial: false,
  start_date: '2026-08-02T10:00:00Z', end_date: '2026-10-02T10:00:00Z',
};
const bedolaga = {
  setStatus: async (id: number, status: string) => {
    if (failBedolagaStatus) throw new Error('remote rejected');
    bedolagaCalls.push({ id, status });
  },
  userByTelegramId: async (telegramId: number) => telegramId === 555
    ? bedolagaUser
    : (telegramId === 999 ? staleTelegramUser : null),
  searchUsers: async () => [bedolagaUser],
  user: async (userId: number) => userId === 42 ? bedolagaUser : null,
  ticket: async (ticketId: number) => ({ id: ticketId, user_id: 42, title: 'Тестовый тикет', status: 'open', messages: [] }),
  subscriptions: async (userId: number, limit = 50, offset = 0) => ({
    items: userId === 42 ? [bedolagaUser.subscription, subscriptionWithoutOwner] : [],
    total: userId === 42 ? 2 : 0, limit, offset,
  }),
  transactions: async (userId: number, limit = 50, offset = 0) => {
    bedolagaTransactionPageCalls.push({ userId, limit, offset });
    if (userId !== 42) return { items: [], total: 0, limit, offset };
    if (useLargeBedolagaTransactionPage) {
      const total = 101;
      const count = Math.max(0, Math.min(limit, total - offset));
      return {
        items: Array.from({ length: count }, (_, index) => ({
          id: 10_000 + offset + index, user_id: 42, type: 'payment', amount_kopeks: 100,
          payment_method: 'card', is_completed: true, created_at: '2026-09-01T10:00:00Z',
        })),
        total, limit, offset,
      };
    }
    return {
      items: [{
        id: 701, user_id: 42, type: 'payment', amount_kopeks: 25_000,
        description: `Оплата ${secretSubscriptionUrl} ${secretTunnelUrl} Bearer ${secretJwt}`,
        payment_method: 'card', is_completed: true,
        external_id: secretExternalPaymentId, metadata: secretRawMetadata,
        created_at: '2026-09-01T10:00:00Z', completed_at: '2026-09-01T10:01:00Z',
      }],
      total: 1, limit, offset,
    };
  },
  ticketsForUser: async (userId: number, limit = 50, offset = 0) => ({
    items: userId === 42 ? [{
      id: 77, user_id: 42, title: `Не подключается ${secretTelegramUrl}`, status: 'open', priority: 'normal', messages_count: 2,
      created_at: '2026-09-02T10:00:00Z', updated_at: '2026-09-03T10:00:00Z',
    }] : [],
    total: userId === 42 ? 1 : 0, limit, offset,
  }),
  referralDetails: async (userId: number, limit = 50, offset = 0) => userId === 42 ? ({
    referrer: { invited_count: 1, active_referrals: 1, total_earned_kopeks: 5000, referral_commission_percent: 10 },
    referrals: { items: [{ id: 43, username: 'referral', status: 'active' }], total: 1, limit, offset },
  }) : {},
  extendSubscription: async (subscriptionId: number, days: number) => {
    bedolagaExtendCalls.push({ id: subscriptionId, days });
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (failBedolagaExtensionAfterCommit) throw new Error('connection reset after commit');
    if (useIncompleteBedolagaExtensionResponse) return {};
    return { ...bedolagaUser.subscription, id: subscriptionId, user_id: 42, end_date: '2026-10-08T10:00:00Z' };
  },
};
const attachmentCalls: any[] = [];
outbox.register('tg_dm', {
  send: async () => ({ externalMsgId: '1' }),
  sendAttachment: async (_conversation: any, payload: any) => {
    attachmentCalls.push(payload); return { externalMsgId: `file-${attachmentCalls.length}` };
  },
});
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
const extensionBody = (days: number, operationId = randomUUID()) => JSON.stringify({ days, operationId });

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

const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from('test-image')]);
const uploadHeaders = {
  ...h, 'content-type':'application/vnd.ai-support.attachment', 'x-file-name':encodeURIComponent('screen.png'),
  'x-file-type':encodeURIComponent('image/png'), 'x-upload-batch':'batch_test_01',
  'x-upload-batch-size':'1', 'x-upload-index':'0', 'x-caption':encodeURIComponent('Смотрите'),
};
const upload = await fetch(`${B}/api/conversations/${id}/attachments`, { method:'POST', headers:uploadHeaders, body:png });
const uploadBody = await upload.json() as any;
ok('PNG загружается и отправляется именно как фото', upload.status === 200
  && attachmentCalls[0]?.mediaType === 'photo' && attachmentCalls[0]?.caption === 'Смотрите', uploadBody);
const withUpload = await (await fetch(`${B}/api/conversations/${id}`, { headers:h })).json() as any;
const uploadedAttachment = Object.values(withUpload.attachments).flat().find((item:any) => item.original_name === 'screen.png') as any;
ok('исходный файл и метаданные сохранены в истории', uploadedAttachment?.mime_type === 'image/png'
  && uploadedAttachment?.bytes === png.length, uploadedAttachment);
const downloadUpload = await fetch(`${B}/api/attachments/${uploadedAttachment.id}`, { headers:h });
ok('проверенное изображение отдаётся inline с nosniff', downloadUpload.status === 200
  && downloadUpload.headers.get('content-type')?.startsWith('image/png') === true
  && downloadUpload.headers.get('x-content-type-options') === 'nosniff');
ok('сервер запрещает пакет больше 10 файлов', (await fetch(`${B}/api/conversations/${id}/attachments`, {
  method:'POST', headers:{...uploadHeaders,'x-upload-batch':'batch_too_many','x-upload-batch-size':'11'}, body:png,
})).status === 400);
const exeHeaders = {...uploadHeaders,'x-file-name':encodeURIComponent('tool.exe'),'x-file-type':encodeURIComponent('application/x-msdownload'),
  'x-upload-batch':'batch_exe_01'};
ok('исполняемый файл требует отдельного подтверждения', (await fetch(`${B}/api/conversations/${id}/attachments`, {
  method:'POST', headers:exeHeaders, body:Buffer.from('MZdanger'),
})).status === 409);
const confirmedExe = await fetch(`${B}/api/conversations/${id}/attachments`, {
  method:'POST', headers:{...exeHeaders,'x-upload-batch':'batch_exe_02','x-dangerous-confirmed':'yes'}, body:Buffer.from('MZdanger'),
});
ok('после подтверждения произвольный файл отправляется документом', confirmedExe.status === 200
  && attachmentCalls.at(-1)?.mediaType === 'document');

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
ok('viewer не получает финансовую карточку Bedolaga',
  (await fetch(`${B}/api/conversations/${id}/bedolaga/customer`, { headers: viewerH })).status === 403);
ok('viewer не может начислять дни Bedolaga',
  (await fetch(`${B}/api/conversations/${id}/bedolaga/subscriptions/900/extend`, {
    method: 'POST', headers: { ...viewerH, 'content-type': 'application/json' }, body: extensionBody(7),
  })).status === 403 && bedolagaExtendCalls.length === 0);
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

const bedolagaCardResponse = await fetch(`${B}/api/conversations/${id}/bedolaga/customer`, { headers: agentH });
const bedolagaCardText = await bedolagaCardResponse.text();
const bedolagaCard = JSON.parse(bedolagaCardText) as any;
ok('agent получает полную карточку Bedolaga', bedolagaCardResponse.status === 200
  && bedolagaCard.customer.user.id === 42
  && bedolagaCard.customer.subscriptions.items[0]?.id === 900
  && bedolagaCard.customer.transactions.items[0]?.id === 701
  && bedolagaCard.customer.tickets.items[0]?.id === 77
  && bedolagaCard.customer.referrals.items[0]?.id === 43
  && bedolagaCard.customer.activity.items.some((item: any) => item.eventType === 'transaction_completed')
  && bedolagaCard.customer.activity.items.some((item: any) => item.eventType === 'subscription_started')
  && bedolagaCard.customer.activity.items.some((item: any) => item.eventType === 'ticket_opened')
  && bedolagaCard.customer.gifts.available === false
  && bedolagaCard.customer.gifts.total === 0
  && bedolagaCard.capabilities.canExtendSubscription === true, bedolagaCard);
ok('карточка не раскрывает ссылку подписки, внешний платёжный ID и сырые метаданные',
  !bedolagaCardText.includes(secretSubscriptionUrl)
  && !bedolagaCardText.includes(secretTunnelUrl)
  && !bedolagaCardText.includes(secretTelegramUrl)
  && !bedolagaCardText.includes(secretJwt)
  && !bedolagaCardText.includes(secretExternalPaymentId)
  && !bedolagaCardText.includes(secretRawMetadata));
const forbiddenBedolagaKeys = new Set([
  'subscription_url', 'subscription_crypto_link', 'external_id', 'provider_payment_id', 'metadata',
]);
const containsForbiddenBedolagaKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsForbiddenBedolagaKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    forbiddenBedolagaKeys.has(key.toLowerCase()) || containsForbiddenBedolagaKey(child));
};
ok('карточка рекурсивно не содержит сырых credential-полей Bedolaga',
  !containsForbiddenBedolagaKey(bedolagaCard));

const staleBedolagaConversation = store.upsertConversation({
  channel: 'bedolaga', externalId: '77', tgUserId: 999, username: 'stale-client', subject: 'Тикет со старым Telegram ID',
});
const authoritativeCardResponse = await fetch(
  `${B}/api/conversations/${staleBedolagaConversation.id}/bedolaga/customer`,
  { headers: agentH },
);
const authoritativeCard = await authoritativeCardResponse.json() as any;
ok('владелец Bedolaga-тикета определяется по ticket.user_id, а не по устаревшему tg_user_id',
  authoritativeCardResponse.status === 200
    && authoritativeCard.customer?.user?.id === 42,
  authoritativeCard);

// API Bedolaga сообщает total отдельно от текущей страницы. Карточка не
// должна выдавать первые 100 строк за полную историю: допустимы либо
// последовательная догрузка всех страниц, либо явный признак/предупреждение
// о неполной выборке, на основании которого UI сможет показать пагинацию.
useLargeBedolagaTransactionPage = true;
bedolagaTransactionPageCalls.length = 0;
const largeCardResponse = await fetch(`${B}/api/conversations/${id}/bedolaga/customer`, { headers: agentH });
const largeCardPayload = await largeCardResponse.json() as any;
useLargeBedolagaTransactionPage = false;
const largeTransactions = largeCardPayload.customer?.transactions ?? {};
const loadedTransactions = Array.isArray(largeTransactions.items) ? largeTransactions.items.length : 0;
const explicitlyPartial = largeTransactions.hasMore === true
  || largeTransactions.truncated === true
  || largeTransactions.complete === false
  || Number(largeTransactions.loaded) === loadedTransactions
  || (largeCardPayload.customer?.warnings ?? []).some((warning: unknown) =>
    /(?:непол|част|первые|показан|страниц|101)/iu.test(String(warning)));
ok('карточка не выдаёт страницу из 100 записей за полную историю',
  largeCardResponse.status === 200
    && Number(largeTransactions.total) === 101
    && (loadedTransactions === 101 || explicitlyPartial), {
      loadedTransactions,
      total: largeTransactions.total,
      explicitlyPartial,
      pageCalls: bedolagaTransactionPageCalls,
    });

ok('некорректное число дней отклоняется до Bedolaga', (await fetch(`${B}/api/conversations/${id}/bedolaga/subscriptions/900/extend`, {
  method: 'POST', headers: { ...agentH, 'content-type': 'application/json' }, body: JSON.stringify({ days: 0 }),
})).status === 400 && bedolagaExtendCalls.length === 0);
ok('чужую подписку нельзя продлить подменой ID', (await fetch(`${B}/api/conversations/${id}/bedolaga/subscriptions/901/extend`, {
  method: 'POST', headers: { ...agentH, 'content-type': 'application/json' }, body: extensionBody(7),
})).status === 404 && bedolagaExtendCalls.length === 0);
ok('подписка без подтверждённого владельца не продлевается',
  (await fetch(`${B}/api/conversations/${id}/bedolaga/subscriptions/902/extend`, {
    method: 'POST', headers: { ...agentH, 'content-type': 'application/json' }, body: extensionBody(7),
  })).status === 404 && bedolagaExtendCalls.length === 0);

// Совпадение username не доказывает личность: ник можно сменить или занять.
// Такой fallback годится для read-only карточки, но не для денежной мутации.
const usernameOnly = store.recordInbound({
  channel: 'tg_bot', externalId: 'username-only', sourceId: 'bot-username-only',
  username: 'client', displayName: 'Совпадение только по username',
  text: 'проверка', externalMsgId: 'username-only-1', sentAt: Date.now(),
})!.conversation;
const usernameFallbackBefore = bedolagaExtendCalls.length;
const usernameFallbackExtension = await fetch(
  `${B}/api/conversations/${usernameOnly.id}/bedolaga/subscriptions/900/extend`,
  { method: 'POST', headers: { ...agentH, 'content-type': 'application/json' }, body: extensionBody(7) },
);
ok('совпадение только по username не разрешает мутацию Bedolaga',
  usernameFallbackExtension.status >= 400
    && usernameFallbackExtension.status < 500
    && bedolagaExtendCalls.length === usernameFallbackBefore,
  { status: usernameFallbackExtension.status, body: await usernameFallbackExtension.text() });

// Одна подписка может быть видна из нескольких связанных диалогов. Lock
// обязан быть глобальным для subscription id, иначе два оператора начислят
// дни дважды через разные conversations.
const sameCustomerOtherConversation = store.recordInbound({
  channel: 'tg_bot', externalId: 'same-customer-second-dialog', sourceId: 'bot-second',
  tgUserId: 555, username: 'client', displayName: 'Клиент',
  text: 'ещё один диалог', externalMsgId: 'same-customer-second-dialog-1', sentAt: Date.now(),
})!.conversation;
const globalLockBefore = bedolagaExtendCalls.length;
const globalLockResponses = await Promise.all([
  fetch(`${B}/api/conversations/${id}/bedolaga/subscriptions/900/extend`, {
    method: 'POST', headers: { ...agentH, 'content-type': 'application/json' }, body: extensionBody(3),
  }),
  fetch(`${B}/api/conversations/${sameCustomerOtherConversation.id}/bedolaga/subscriptions/900/extend`, {
    method: 'POST', headers: { ...agentH, 'content-type': 'application/json' }, body: extensionBody(3),
  }),
]);
const globalLockBodies = await Promise.all(globalLockResponses.map((response) => response.text()));
const globalLockStatuses = globalLockResponses.map((response) => response.status).sort((left, right) => left - right);
ok('одна подписка блокируется глобально между разными диалогами',
  globalLockStatuses[0] === 200
    && globalLockStatuses[1] === 409
    && bedolagaExtendCalls.length === globalLockBefore + 1,
  { globalLockStatuses, globalLockBodies, calls: bedolagaExtendCalls.slice(globalLockBefore) });

const extendBefore = bedolagaExtendCalls.length;
const duplicateOperationId = randomUUID();
const concurrentExtensions = await Promise.all([
  fetch(`${B}/api/conversations/${id}/bedolaga/subscriptions/900/extend`, {
    method: 'POST', headers: { ...agentH, 'content-type': 'application/json' }, body: extensionBody(7, duplicateOperationId),
  }),
  fetch(`${B}/api/conversations/${id}/bedolaga/subscriptions/900/extend`, {
    method: 'POST', headers: { ...agentH, 'content-type': 'application/json' }, body: extensionBody(7, duplicateOperationId),
  }),
]);
const extensionBodies = await Promise.all(concurrentExtensions.map((response) => response.text()));
const extensionStatuses = concurrentExtensions.map((response) => response.status).sort((left, right) => left - right);
ok('оператор начисляет дни, а одновременный дубль блокируется', extensionStatuses[0] === 200
  && extensionStatuses[1] === 409
  && bedolagaExtendCalls.length === extendBefore + 1
  && bedolagaExtendCalls[extendBefore]?.id === 900
  && bedolagaExtendCalls[extendBefore]?.days === 7, { extensionStatuses, extensionBodies });
const successfulExtensionBody = extensionBodies[concurrentExtensions.findIndex((response) => response.status === 200)] ?? '';
ok('ответ продления также не раскрывает credential', !successfulExtensionBody.includes(secretSubscriptionUrl));
const replayBefore = bedolagaExtendCalls.length;
const confirmedReplay = await fetch(`${B}/api/conversations/${id}/bedolaga/subscriptions/900/extend`, {
  method: 'POST', headers: { ...agentH, 'content-type': 'application/json' }, body: extensionBody(7, duplicateOperationId),
});
ok('повтор подтверждённого operationId не выполняет второй POST Bedolaga',
  confirmedReplay.status === 200 && bedolagaExtendCalls.length === replayBefore,
  { status: confirmedReplay.status, body: await confirmedReplay.text() });

// После успешного неидемпотентного POST пустая/изменённая
// форма ответа не должна показать failure и подтолкнуть оператора
// начислить те же дни ещё раз.
useIncompleteBedolagaExtensionResponse = true;
const incompleteBefore = bedolagaExtendCalls.length;
const incompleteExtension = await fetch(`${B}/api/conversations/${id}/bedolaga/subscriptions/900/extend`, {
  method: 'POST', headers: { ...agentH, 'content-type': 'application/json' }, body: extensionBody(2),
});
const incompleteBody = await incompleteExtension.json() as { warning?: string; subscription?: { id?: number; userId?: number } };
useIncompleteBedolagaExtensionResponse = false;
ok('неполный 2xx-ответ Bedolaga считается принятым и не раскрывает чужие поля',
  incompleteExtension.status === 200
    && typeof incompleteBody.warning === 'string'
    && incompleteBody.subscription?.id === 900
    && incompleteBody.subscription?.userId === 42
    && bedolagaExtendCalls.length === incompleteBefore + 1,
  { status: incompleteExtension.status, incompleteBody, calls: bedolagaExtendCalls.slice(incompleteBefore) });

const originalAddNote = store.addNote.bind(store);
(store as unknown as { addNote: typeof store.addNote }).addNote = (() => { throw new Error('audit unavailable'); }) as typeof store.addNote;
const auditFailureBefore = bedolagaExtendCalls.length;
const auditFailureExtension = await fetch(`${B}/api/conversations/${id}/bedolaga/subscriptions/900/extend`, {
  method: 'POST', headers: { ...agentH, 'content-type': 'application/json' }, body: extensionBody(1),
});
(store as unknown as { addNote: typeof store.addNote }).addNote = originalAddNote;
ok('ошибка локальной audit-заметки не превращает уже выполненное продление в failure',
  auditFailureExtension.status === 200 && bedolagaExtendCalls.length === auditFailureBefore + 1,
  { status: auditFailureExtension.status, body: await auditFailureExtension.text() });

const unknownOperationId = randomUUID();
failBedolagaExtensionAfterCommit = true;
const unknownBefore = bedolagaExtendCalls.length;
const unknownExtension = await fetch(`${B}/api/conversations/${id}/bedolaga/subscriptions/900/extend`, {
  method: 'POST', headers: { ...agentH, 'content-type': 'application/json' }, body: extensionBody(4, unknownOperationId),
});
failBedolagaExtensionAfterCommit = false;
const unknownReplay = await fetch(`${B}/api/conversations/${id}/bedolaga/subscriptions/900/extend`, {
  method: 'POST', headers: { ...agentH, 'content-type': 'application/json' }, body: extensionBody(4, unknownOperationId),
});
const unknownPayload = await unknownExtension.json() as any;
ok('неопределённый исход не провоцирует повторный POST с тем же operationId',
  unknownExtension.status === 202
    && unknownReplay.status === 202
    && unknownPayload.outcome === 'unknown'
    && bedolagaExtendCalls.length === unknownBefore + 1,
  { first: unknownExtension.status, replay: unknownReplay.status, unknownPayload });
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
