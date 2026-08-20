import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.BOT_TOKEN = '123:FAKE';
process.env.PANEL_TOKEN = 'test-token-0123456789abcdef';
process.env.AI_MODE = 'off';
process.env.PANEL_PORT = '8099';
process.env.LOG_LEVEL = 'error';
const dir = mkdtempSync(join(tmpdir(), 'web-'));
process.env.DB_PATH = join(dir, 'w.db');

const { Store } = await import('../src/core/store.js');
const { openDatabase } = await import('../src/core/db.js');
const { Outbox } = await import('../src/core/outbox.js');
const { startWeb } = await import('../src/panel/server.js');

const db = openDatabase(); const store = new Store(db);
const outbox = new Outbox(store);
outbox.register('tg_dm', { send: async () => ({ externalMsgId: '1' }) });
store.recordInbound({ channel:'tg_dm', externalId:'555', tgUserId:555, businessConnectionId:'b1',
  username:'client', displayName:'Клиент', text:'привет, не работает', externalMsgId:'1', sentAt: Date.now() });
const app = await startWeb({ store, outbox });
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
const one = await (await fetch(`${B}/api/conversations/${id}`,{headers:h})).json() as any;
ok('тред отдаётся', one.messages.length === 1 && one.messages[0].text === 'привет, не работает');
ok('панель отдаётся статикой', (await (await fetch(`${B}/`)).text()).includes('ai-support'));
ok('404 на несуществующий диалог', (await fetch(`${B}/api/conversations/9999`,{headers:h})).status === 404);
ok('пустой текст отклонён', (await fetch(`${B}/api/conversations/${id}/reply`,{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({text:'  '})})).status === 400);

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

// Подбор токена: без ограничения частоты панель защищена одним секретом,
// который можно перебирать тысячами попыток в секунду.
let lastStatus = 0;
for (let i = 0; i < 9; i += 1) {
  lastStatus = (await fetch(`${B}/api/conversations`, { headers: { authorization: 'Bearer wrong-token-here' } })).status;
}
ok('подбор токена упирается в блокировку', lastStatus === 429, lastStatus);
ok('верный токен после блокировки тоже ждёт',
  (await fetch(`${B}/api/conversations`, { headers: h })).status === 429);

ws.close(); await app.close(); db.close(); rmSync(dir,{recursive:true,force:true});
console.log(fails===0?'\nВеб-слой: все проверки прошли':`\nПровалено: ${fails}`);
process.exit(fails===0?0:1);
