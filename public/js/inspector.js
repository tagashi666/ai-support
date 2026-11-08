// Панель: инбокс: карточка клиента, подписка, профиль.
// Первый import — предыдущий раздел: так модули исполняются в исходном порядке (см. app.js).
import './thread.js';
import { state } from './state.js';
import { $, esc } from './dom.js';
import { api, json, mutate } from './api.js';
import { canPermission } from './access.js';
import { toast, sheet, closeSheet } from './nav.js';
import { fmtTime, fmtDate, channelLabel, conversationStatus, gb, initials } from './inbox-list.js';
import { open } from './conversation.js';

export function renderCustomer(profile) {
  const card = $('customerCard');
  if (!state.current) { card.innerHTML = '<div class="item"><span class="hint">Выберите диалог.</span></div>'; return; }
  const rows = [
    ['Telegram ID', profile?.identity?.telegramId ?? state.current.tg_user_id ?? '—'],
    ['Ник', (profile?.identity?.username ?? state.current.username) ? '@' + (profile?.identity?.username ?? state.current.username).replace(/^@/,'') : '—'],
    ['Канал', state.current.channel === 'tg_dm' ? 'личка' : 'тикет'],
  ];
  const sub = profile?.subscription;
  if (sub?.status) rows.push(['Подписка', sub.status]);
  if (sub?.expiresAt) rows.push(['Действует до', fmtDate(sub.expiresAt)]);
  if (sub?.trafficUsed !== undefined) rows.push(['Трафик', `${gb(sub.trafficUsed)}${sub.trafficLimit ? ` из ${gb(sub.trafficLimit)}` : ''}`]);
  if (sub?.devices !== undefined) rows.push(['Устройств', `${sub.devices}${sub.deviceLimit ? ` из ${sub.deviceLimit}` : ''}`]);
  const act = profile?.activity;
  if (act?.dailyAverageBytes) rows.push(['В среднем в день', gb(act.dailyAverageBytes)]);
  if (act?.firstSeen) rows.push(['Клиент с', fmtDate(act.firstSeen)]);
  if (act?.lastNode) rows.push(['Последний сервер', act.lastNode]);
  if (profile?.balance?.amount !== undefined) rows.push(['Баланс', `${profile.balance.amount} ${profile.balance.currency ?? ''}`]);

  card.innerHTML =
    rows.map(([k,v]) => `<div class="item"><span class="lbl">${esc(k)}</span><span class="val mono">${esc(v)}</span></div>`).join('')
    + (act?.topNodes?.length
        ? `<div class="item col-item"><span class="lbl">Чаще всего использует</span>`
          + act.topNodes.map((n) => `<div class="device"><span class="grow">${esc(n.name)}</span><span class="mono">${gb(n.bytes)}</span></div>`).join('')
          + `</div>` : '')
    + (state.current.sub_link
        ? `<div class="item col-item"><span class="lbl">Клиент прислал ключ</span>
             <span class="mono" style="overflow-wrap:anywhere">${esc(state.current.sub_link.slice(0, 120))}</span></div>`
        : '')
    + (canPermission('bedolaga:view') && (state.current.channel === 'bedolaga' || state.settings?.channels?.bedolaga)
        ? `<div class="item"><button class="btn primary wide" id="bedolagaCardBtn">Полная карточка Bedolaga</button></div>`
        : '')
    + (canPermission('conversation:profile') ? `<div class="item"><button class="btn wide" id="refreshCust">Обновить карточку</button></div>` : '')
    + (profile?.found
        ? `<div class="item"><span class="hint">Источники: ${esc((profile.sources ?? []).join(', ') || '—')}</span></div>`
        : `<div class="item"><span class="hint">Клиент не найден в Bedolaga, MiniShop или Remnawave.</span></div>`)
    + ((profile?.trace ?? []).length
        ? `<div class="item col-item"><span class="hint">${(profile.trace).map((t) => esc(t)).join('<br>')}</span></div>` : '');

  if ($('bedolagaCardBtn')) $('bedolagaCardBtn').onclick = () => openBedolagaCard();
  if ($('refreshCust')) $('refreshCust').onclick = async () => {
    $('refreshCust').disabled = true;
    const id = state.current.id;
    const data = await mutate(`/api/conversations/${id}/customer/refresh`, { method:'POST' }, 'Карточка обновлена');
    // Карточка другого клиента не должна лечь в инспектор уже открытого диалога.
    if (state.current?.id !== id) return;
    if ($('refreshCust')) $('refreshCust').disabled = false;
    if (data) renderCustomer(data.customer);
  };
}

const bedMoney = (value) => value !== undefined && value !== null && Number.isFinite(Number(value))
  ? new Intl.NumberFormat('ru-RU', { style:'currency', currency:'RUB', maximumFractionDigits:2 }).format(Number(value))
  : '—';
const bedDate = (value) => value ? fmtDate(value) : '—';
const bedValue = (value, fallback = '—') => value === undefined || value === null || value === '' ? fallback : value;
const bedStatus = (value) => {
  if (value === 'active') return 'Активна';
  if (value === 'disabled') return 'Отключена';
  if (value === 'blocked') return 'Заблокирован';
  if (value === 'open') return 'Открыт';
  if (value === 'answered') return 'Ждём клиента';
  if (value === 'pending') return 'В ожидании';
  if (value === 'closed') return 'Закрыт';
  if (value === 'completed') return 'Завершён';
  return bedValue(value);
};
const bedEvent = (value) => ({
  user_registered:'Регистрация',
  user_updated:'Профиль обновлён',
  user_activity:'Последняя активность',
  subscription_started:'Подписка началась',
  transaction_completed:'Платёж завершён',
  transaction_created:'Платёж создан',
  ticket_opened:'Тикет открыт',
  ticket_updated:'Тикет обновлён',
  ticket_closed:'Тикет закрыт',
}[value] ?? bedValue(value));
let bedolagaCard = null, bedolagaCardTab = 'overview', bedolagaCardConversation = null;
let bedolagaCardRequest = 0;
let bedolagaCapabilities = { canExtendSubscription:false };
const bedolagaExtensionPending = new Set();
const bedolagaExtensionUncertain = new Set();

function bedKpi(label, value) {
  return `<div class="bed-kpi"><span>${esc(label)}</span><b>${esc(bedValue(value))}</b></div>`;
}

function bedTable(headers, rows) {
  if (!rows.length) return '<div class="bed-empty">В этом разделе пока нет данных.</div>';
  return `<div class="bed-table-wrap"><table class="bed-table"><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${esc(bedValue(cell))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function bedTabLabel(label, section) {
  const total = section?.total ?? 0;
  return section?.truncated ? `${label} · ${(section.items ?? []).length} из ${total}` : `${label} · ${total}`;
}

function bedolagaTabBody(card, tab) {
  const user = card.user ?? {};
  if (tab === 'overview') {
    const promo = user.promoGroup;
    return `<section class="bed-section"><h3>Клиент</h3><div class="bed-kpis">
      ${bedKpi('Статус', bedStatus(user.status))}${bedKpi('Язык', user.language)}${bedKpi('Регистрация', bedDate(user.createdAt))}
      ${bedKpi('Последняя активность', bedDate(user.lastActivity))}${bedKpi('Платная подписка', user.hasHadPaidSubscription ? 'Была' : 'Не было')}
      ${bedKpi('Первое пополнение', user.hasMadeFirstTopup ? 'Есть' : 'Нет')}${bedKpi('Реферальный код', user.referralCode)}
      ${bedKpi('Приглашён пользователем', user.referredById ? `#${user.referredById}` : '—')}
    </div></section>
    ${promo ? `<section class="bed-section"><h3>Промо-группа</h3><div class="bed-kpis">
      ${bedKpi('Название', promo.name)}${bedKpi('Скидка сервера', promo.serverDiscountPercent == null ? '—' : `${promo.serverDiscountPercent}%`)}
      ${bedKpi('Скидка трафика', promo.trafficDiscountPercent == null ? '—' : `${promo.trafficDiscountPercent}%`)}
      ${bedKpi('Скидка устройств', promo.deviceDiscountPercent == null ? '—' : `${promo.deviceDiscountPercent}%`)}
    </div></section>` : ''}`;
  }
  if (tab === 'subscriptions') {
    const items = card.subscriptions?.items ?? [];
    if (!items.length) return '<div class="bed-empty">Подписки не найдены.</div>';
    return `<div class="bed-stack">${items.map((sub) => {
      const pending = bedolagaExtensionPending.has(Number(sub.id));
      const uncertain = bedolagaExtensionUncertain.has(Number(sub.id));
      return `<article class="bed-sub">
      <div><b>Подписка #${esc(sub.id)} · ${esc(bedStatus(sub.actualStatus ?? sub.status))}</b>
        <div class="meta"><span>${sub.isTrial ? 'Пробная' : 'Обычная'}</span><span>до ${esc(bedDate(sub.endDate))}</span>
        <span>трафик ${esc(bedValue(sub.trafficUsedGb))} / ${esc(bedValue(sub.trafficLimitGb))} ГБ</span>
        <span>устройств: ${esc(bedValue(sub.deviceLimit))}</span><span>сквадов: ${esc(sub.connectedSquadsCount)}</span>
        <span>${sub.autopayEnabled ? 'автопродление включено' : 'автопродление выключено'}</span>
        <span>${sub.hasAccessLink ? 'ссылка выпущена' : 'ссылки нет'}</span></div></div>
      ${bedolagaCapabilities.canExtendSubscription ? `<div class="bed-extend"><input type="number" min="1" max="36500" value="7" aria-label="Дополнительные дни для подписки ${esc(sub.id)}" data-bed-days="${esc(sub.id)}" ${pending || uncertain ? 'disabled' : ''}><button class="btn primary" data-bed-extend="${esc(sub.id)}" ${pending || uncertain ? 'disabled' : ''}>${pending ? 'Продлеваю…' : (uncertain ? 'Сначала проверьте срок' : 'Добавить дни')}</button></div>` : ''}
    </article>`;
    }).join('')}</div>`;
  }
  if (tab === 'transactions') return bedTable(['ID','Тип','Сумма','Описание','Метод','Статус','Дата'],
    (card.transactions?.items ?? []).map((item) => [item.id, item.type, bedMoney(item.amountRubles), item.description, item.paymentMethod, item.isCompleted ? 'Завершён' : 'Не завершён', bedDate(item.completedAt ?? item.createdAt)]));
  if (tab === 'tickets') return bedTable(['ID','Тема','Статус','Приоритет','Сообщений','Создан','Закрыт'],
    (card.tickets?.items ?? []).map((item) => [item.id, item.title, bedStatus(item.status), item.priority, item.messageCount, bedDate(item.createdAt), bedDate(item.closedAt)]));
  if (tab === 'referrals') return `<div class="bed-kpis">
      ${bedKpi('Приглашено', card.referrals?.invitedCount)}${bedKpi('Активных', card.referrals?.activeReferrals)}
      ${bedKpi('Заработано', bedMoney(card.referrals?.totalEarnedRubles))}${bedKpi('За месяц', bedMoney(card.referrals?.monthEarnedRubles))}
      ${bedKpi('Комиссия', card.referrals?.commissionPercent == null ? '—' : `${card.referrals.commissionPercent}%`)}</div>
    ${bedTable(['ID','Клиент','Username','Статус','Баланс','Заработано','Пополнений','Активность'],
      (card.referrals?.items ?? []).map((item) => [item.id, item.fullName, item.username ? `@${item.username}` : '—', bedStatus(item.status), bedMoney(item.balanceRubles), bedMoney(item.totalEarnedRubles), item.topupsCount, bedDate(item.lastActivity)]))}`;
  if (tab === 'activity') return bedTable(['ID','Событие','Подписка','Транзакция','Тикет','Сумма','Дата'],
    (card.activity?.items ?? []).map((item) => [item.id, bedEvent(item.eventType), item.subscriptionId ? `#${item.subscriptionId}` : '—', item.transactionId ? `#${item.transactionId}` : '—', item.ticketId ? `#${item.ticketId}` : '—', bedMoney(item.amountRubles), bedDate(item.occurredAt ?? item.createdAt)]));
  if (card.gifts?.available === false) {
    return `<div class="bed-empty">${esc(card.gifts.reason ?? 'История подарков недоступна для этой интеграции.')}</div>`;
  }
  return bedTable(['ID','Тип','Подписка','Эффект','Скидка','Бонус','Истекает','Статус'],
    (card.gifts?.items ?? []).map((item) => [item.id, item.notificationType, item.subscriptionId ? `#${item.subscriptionId}` : '—', item.effectType, item.discountPercent == null ? '—' : `${item.discountPercent}%`, bedMoney(item.bonusAmountRubles), bedDate(item.expiresAt), item.isActive ? 'Активен' : (item.claimedAt ? 'Получен' : 'Неактивен')]));
}

function renderBedolagaCard() {
  const box = $('bedCardBody');
  if (!box || !bedolagaCard) return;
  const card = bedolagaCard, user = card.user ?? {};
  const tabs = [
    ['overview','Обзор'], ['subscriptions',bedTabLabel('Подписки', card.subscriptions)],
    ['transactions',bedTabLabel('Платежи', card.transactions)], ['tickets',bedTabLabel('Тикеты', card.tickets)],
    ['referrals',bedTabLabel('Рефералы', card.referrals)], ['activity',`Активность · ${card.activity?.total ?? 0}`],
    ['gifts',`Подарки · ${card.gifts?.total ?? 0}`],
  ];
  const display = user.fullName || (user.username ? `@${user.username}` : `#${user.id}`);
  box.className = '';
  box.innerHTML = `<div class="bed-shell">
    <div class="bed-summary"><span class="avatar">${esc(initials(display))}</span><div class="identity"><b>${esc(display)}</b>
      <span>${user.username ? `@${esc(user.username)} · ` : ''}Telegram ${esc(bedValue(user.telegramId))} · Bedolaga #${esc(user.id)}${user.email ? ` · ${esc(user.email)}` : ''}</span></div>
      <div class="balance"><b>${esc(bedMoney(user.balanceRubles))}</b><span>баланс</span></div></div>
    ${(card.warnings ?? []).map((warning) => `<div class="bed-warning">${esc(warning)}</div>`).join('')}
    <nav class="bed-tabs" aria-label="Разделы карточки">${tabs.map(([id,label]) => `<button data-bed-tab="${id}" aria-pressed="${id === bedolagaCardTab}">${esc(label)}</button>`).join('')}</nav>
    <div id="bedTabBody">${bedolagaTabBody(card, bedolagaCardTab)}</div>
    <span class="hint">Обновлено: ${esc(fmtTime(card.loadedAt))}. Секретная ссылка подписки и служебные идентификаторы платежей скрыты.</span>
  </div>`;
  for (const button of box.querySelectorAll('[data-bed-tab]')) button.onclick = () => {
    bedolagaCardTab = button.dataset.bedTab;
    renderBedolagaCard();
  };
  for (const button of box.querySelectorAll('[data-bed-extend]')) button.onclick = () => {
    const subscriptionId = Number(button.dataset.bedExtend);
    if (bedolagaExtensionPending.has(subscriptionId) || bedolagaExtensionUncertain.has(subscriptionId)) return;
    const input = box.querySelector(`[data-bed-days="${subscriptionId}"]`);
    const days = Number(input?.value);
    if (!Number.isSafeInteger(days) || days < 1 || days > 36500) return toast('Введите целое число дней от 1 до 36500');
    const conversationId = bedolagaCardConversation;
    confirmAction('Начислить дополнительные дни?', `Подписка #${subscriptionId} будет продлена на ${days} дн. Действие сразу уйдёт в Bedolaga.`, async () => {
      if (bedolagaExtensionPending.has(subscriptionId)) return null;
      bedolagaExtensionPending.add(subscriptionId);
      const operationId = crypto.randomUUID();
      let result = null;
      try {
        let response;
        try {
          response = await api(`/api/conversations/${conversationId}/bedolaga/subscriptions/${subscriptionId}/extend`,
            { method:'POST', body:JSON.stringify({ days, operationId }) });
        } catch (err) {
          bedolagaExtensionUncertain.add(subscriptionId);
          renderBedolagaCard();
          toast(`Связь оборвалась после отправки. Проверьте срок подписки перед повтором: ${err.message}`);
          return null;
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) { toast(payload.error ?? `Ошибка ${response.status}`); return null; }
        result = payload;
        if (result.outcome === 'unknown') bedolagaExtensionUncertain.add(subscriptionId);
        toast(result.warning || `Добавлено ${days} дн.`);
        return result;
      } finally {
        bedolagaExtensionPending.delete(subscriptionId);
        // Не открываем старую карточку поверх другого диалога и не создаём
        // впечатление успеха повторным открытием после отказа Bedolaga.
        if (result && state.current?.id === conversationId) {
          await openBedolagaCard(conversationId, 'subscriptions');
        }
      }
    });
  };
}

async function openBedolagaCard(conversationId = state.current?.id, tab = bedolagaCardTab) {
  if (!conversationId) return;
  const requestId = ++bedolagaCardRequest;
  bedolagaCardConversation = conversationId;
  bedolagaCardTab = tab;
  bedolagaCard = null;
  bedolagaCapabilities = { canExtendSubscription:false };
  sheet('Карточка клиента Bedolaga', '<div id="bedCardBody" class="bed-empty">Загружаю данные Bedolaga…</div>', '', 'wide');
  let response;
  try { response = await api(`/api/conversations/${conversationId}/bedolaga/customer`); }
  catch (err) {
    if (requestId !== bedolagaCardRequest || bedolagaCardConversation !== conversationId || state.current?.id !== conversationId) return;
    const box = $('bedCardBody');
    if (box) box.textContent = `Нет связи с сервером: ${err.message}`;
    return;
  }
  const payload = await response.json().catch(() => ({}));
  if (requestId !== bedolagaCardRequest || bedolagaCardConversation !== conversationId || state.current?.id !== conversationId) return;
  const box = $('bedCardBody');
  if (!box) return;
  if (!response.ok) { box.textContent = payload.error ?? `Ошибка ${response.status}`; return; }
  bedolagaCapabilities = payload.capabilities ?? { canExtendSubscription:false };
  bedolagaCard = payload.customer;
  renderBedolagaCard();
}

export function renderCollaboration(value = state.current?.collaboration) {
  const card = $('collabCard');
  if (!state.current) { card.innerHTML = '<div class="item"><span class="hint">Выберите диалог.</span></div>'; return; }
  const owner = value?.owner;
  const presence = value?.presences ?? [];
  $('foldOwner').textContent = owner?.name ?? 'свободен';
  card.innerHTML = `<div class="item"><span class="lbl">Ответственный</span><span class="val">${esc(owner?.name ?? 'не назначен')}</span></div>
    ${owner?.until ? `<div class="item"><span class="lbl">Lease до</span><span class="val mono">${esc(fmtTime(owner.until))}</span></div>` : ''}
    ${presence.length ? `<div class="item col-item"><span class="lbl">Сейчас в диалоге</span>${presence.map((p) => `<span class="mini-note">${esc(p.name)} · ${p.state === 'typing' ? 'печатает' : 'смотрит'}</span>`).join('')}</div>` : ''}
    ${canPermission('conversation:status') ? `<div class="item context-action"><button class="btn wide" id="claimBtn">Взять диалог</button></div>
    <div class="item context-action"><button class="btn quiet wide" id="releaseBtn">Освободить</button></div>` : '<div class="item"><span class="hint">Режим просмотра: закрепление недоступно.</span></div>'}`;
  if (!canPermission('conversation:status')) return;
  $('claimBtn').onclick = async () => {
    const result = await mutate(`/api/conversations/${state.current.id}/engage`, { method:'POST' }, 'Диалог закреплён');
    if (result?.collaboration) { state.current.collaboration = result.collaboration; renderCollaboration(result.collaboration); }
  };
  $('releaseBtn').onclick = async () => {
    const result = await mutate(`/api/conversations/${state.current.id}/release`, { method:'POST' }, 'Диалог освобождён');
    if (result) { state.current.collaboration = { owner:null, presences:[] }; renderCollaboration(state.current.collaboration); }
  };
}

export async function loadUnifiedProfile(conversationId = state.current?.id) {
  if (!conversationId) return;
  const data = await json(`/api/conversations/${conversationId}/profile`);
  if (!data || state.current?.id !== conversationId) return;
  renderUnifiedProfile(data.profile);
}

function renderUnifiedProfile(profile) {
  const card = $('profileCard');
  if (!state.current || !profile) { card.innerHTML = '<div class="item"><span class="hint">Профиль пока пуст.</span></div>'; return; }
  $('foldProfile').textContent = profile.company || profile.display_name || '';
  const tags = profile.tags ?? [];
  const notes = profile.notes ?? [];
  const related = profile.related ?? [];
  const rows = [['Имя', profile.display_name || '—'], ['Компания', profile.company || '—'], ['Email', profile.email || '—'], ['Телефон', profile.phone || '—']];
  card.innerHTML = rows.map(([k,v]) => `<div class="item"><span class="lbl">${esc(k)}</span><span class="val">${esc(v)}</span></div>`).join('')
    + `<div class="item col-item"><span class="lbl">Теги</span><div class="profile-tags">${tags.length ? tags.map((t) => `<span class="badge">${esc(t)}</span>`).join('') : '<span class="hint">нет</span>'}</div></div>`
    + (notes.length ? `<div class="item col-item"><span class="lbl">Последние заметки</span>${notes.slice(0,4).map((n) => `<span class="mini-note">${esc(n.text)}<br><span class="hint">${esc(n.actor_key)} · ${fmtTime(n.created_at)}</span></span>`).join('')}</div>` : '')
    + (related.length > 1 ? `<div class="item col-item"><span class="lbl">Связанные диалоги</span>${related.slice(0,8).map((r) => `<button class="btn quiet" data-related="${r.id}">${esc(channelLabel(r))} · ${esc(conversationStatus(r.status))}</button>`).join('')}</div>` : '')
    + (canPermission('conversation:profile') ? `<div class="item context-action"><button class="btn wide" id="editProfile">Изменить профиль</button></div>` : '')
    + (canPermission('conversation:notes') ? `<div class="item context-action"><button class="btn wide" id="addProfileNote">Добавить заметку</button></div>` : '');
  for (const b of card.querySelectorAll('[data-related]')) b.onclick = () => open(Number(b.dataset.related));
  if ($('editProfile')) $('editProfile').onclick = () => {
    sheet('Единый профиль', `<div class="frow"><label>Имя</label><input id="pfName" value="${esc(profile.display_name || '')}"></div>
      <div class="frow"><label>Компания</label><input id="pfCompany" value="${esc(profile.company || '')}"></div>
      <div class="frow"><label>Email</label><input id="pfEmail" value="${esc(profile.email || '')}"></div>
      <div class="frow"><label>Телефон</label><input id="pfPhone" value="${esc(profile.phone || '')}"></div>
      <div class="frow"><label>Теги через запятую</label><input id="pfTags" value="${esc(tags.join(', '))}"></div>`,
      '<button class="btn" id="pfCancel">Отмена</button><button class="btn primary" id="pfSave">Сохранить</button>');
    $('pfCancel').onclick = closeSheet;
    $('pfSave').onclick = async () => {
      const result = await mutate(`/api/conversations/${state.current.id}/profile`, { method:'PATCH', body:JSON.stringify({
        display_name:$('pfName').value, company:$('pfCompany').value, email:$('pfEmail').value, phone:$('pfPhone').value,
        tags:$('pfTags').value.split(',').map((x) => x.trim()).filter(Boolean),
      }) }, 'Профиль сохранён');
      if (result?.profile) { closeSheet(); renderUnifiedProfile(result.profile); }
    };
  };
  if ($('addProfileNote')) $('addProfileNote').onclick = () => {
    sheet('Заметка о клиенте', '<textarea id="pfNote" rows="6" placeholder="Контекст для следующего оператора"></textarea>', '<button class="btn" id="pfCancel">Отмена</button><button class="btn primary" id="pfAdd">Добавить</button>');
    $('pfCancel').onclick = closeSheet;
    $('pfAdd').onclick = async () => {
      const result = await mutate(`/api/conversations/${state.current.id}/profile/notes`, { method:'POST', body:JSON.stringify({ text:$('pfNote').value }) }, 'Заметка добавлена');
      if (result) { closeSheet(); loadUnifiedProfile(); }
    };
  };
}

/** Перезапускает анимацию появления модуля: снимаем класс, форсируем reflow,
 *  возвращаем. Без reflow повторное добавление того же класса анимацию не
 *  перезапускает. */
function reveal(el) {
  el.classList.remove('reveal');
  void el.offsetWidth;
  el.classList.add('reveal');
}

export async function renderSubscription() {
  const wrap = $('subWrap');
  if (!state.current || !state.settings?.remnawave || !canPermission('bedolaga:view')) { wrap.hidden = true; $('devicesWrap').hidden = true; return; }
  wrap.hidden = false;
  // Диалог, для которого грузим подписку. Запрос в Remnawave небыстрый, и при
  // быстром переключении ответ мог прийти, когда открыт уже другой диалог —
  // тогда он затирал актуальную панель. После каждого await сверяемся: если
  // диалог сменился, тихо выходим и правую колонку не трогаем.
  const cid = state.current.id;
  // Свёрнутый раздел не грузим: это запрос в Remnawave на каждый диалог.
  if (!wrap.open) {
    $('subBody').innerHTML = '<div class="item"><span class="hint">Разверните, чтобы загрузить.</span></div>';
    $('devicesWrap').hidden = true;
    return;
  }
  $('subBody').innerHTML = '<div class="item"><span class="hint">Загружаю…</span></div>';
  const res = await api(`/api/conversations/${cid}/subscription`);
  if (state.current?.id !== cid) return;
  if (!res.ok) {
    $('devicesWrap').hidden = true;
    $('subBody').innerHTML = `<div class="item col-item"><span class="hint">${esc((await res.json()).error)}</span>
      <button class="btn" id="explainBtn">Почему не нашёлся</button></div>`;
    reveal($('subBody'));
    $('explainBtn').onclick = async () => {
      $('explainBtn').disabled = true;
      const data = await json(`/api/conversations/${state.current.id}/subscription/explain`);
      if (!data) return toast('Разбор не удался');
      sheet('Связка с Remnawave',
        `<div class="log">${esc(data.steps.join('\n'))}</div>
         <div class="hint">Записей в индексе: ${data.indexSize}</div>
         ${data.near?.length ? `<div class="cap">Похожие записи</div><div class="log">${esc(data.near.join('\n'))}</div>` : ''}`,
        `<button class="btn" id="closeX">Понятно</button>`);
      $('closeX').onclick = closeSheet;
    };
    return;
  }
  const { profile, devices } = await res.json();
  if (state.current?.id !== cid) return;
  $('foldSub').textContent = profile?.status ?? '—';
  const rows = profile ? [['Статус', profile.status ?? '—'],
    ['Действует до', profile.expiresAt ? fmtDate(profile.expiresAt) : '—'],
    ['Трафик', `${gb(profile.trafficUsed)} из ${profile.trafficLimit ? gb(profile.trafficLimit) : '∞'}`],
    ['Лимит устройств', profile.deviceLimit ?? '—'], ['Short ID', profile.shortId ?? '—']] : [];
  $('subBody').innerHTML =
    (rows.length ? rows.map(([k,v]) => `<div class="item"><span class="lbl">${esc(k)}</span><span class="val mono">${esc(v)}</span></div>`).join('')
      : '<div class="item"><span class="hint">Профиль не найден.</span></div>')
    + (profile?.subscriptionUrl ? `<div class="item"><button class="btn wide" id="copySub">Скопировать ссылку</button></div>` : '')
    + (canPermission('bedolaga:devices') ? `<div class="item"><button class="btn wide" id="resetDev">Сбросить все устройства</button></div>
       <div class="item"><button class="btn wide danger" id="revoke">Перевыпустить подписку</button></div>` : '<div class="item"><span class="hint">Сброс устройств и перевыпуск доступны только администратору.</span></div>');
  reveal($('subBody'));

  // Устройств бывает полтора десятка — им отдельная прокручиваемая группа,
  // иначе они выдавливают всё остальное из колонки.
  $('devicesWrap').hidden = !devices?.length;
  if (devices?.length) {
    $('devicesCap').textContent = `${devices.length}`;
    $('devicesBody').innerHTML = devices.map((d) => `<div class="device">
      <span class="grow">${esc(d.platform ?? '?')} · ${esc(d.model ?? d.hwid.slice(0,10))}</span>
      ${canPermission('bedolaga:devices') ? `<button class="btn danger" data-hwid="${esc(d.hwid)}">Удалить</button>` : ''}</div>`).join('');
    reveal($('devicesBody'));
  }

  if (profile?.subscriptionUrl) $('copySub').onclick = () => { navigator.clipboard.writeText(profile.subscriptionUrl); toast('Ссылка скопирована'); };
  if (!canPermission('bedolaga:devices')) return;
  for (const b of document.querySelectorAll('#devicesBody [data-hwid]')) {
    b.onclick = () => confirmAction('Удалить устройство?', 'Клиент потеряет доступ с него до повторного подключения.',
      () => subAction('delete-device', b.dataset.hwid));
  }
  $('resetDev').onclick = () => confirmAction('Сбросить все устройства?',
    'Все привязки снимутся. Клиенту придётся подключить приложения заново.', () => subAction('reset-devices'));
  $('revoke').onclick = () => confirmAction('Перевыпустить подписку?',
    'Старая ссылка перестанет работать сразу. Клиенту нужно будет добавить новую.', () => subAction('revoke'));
}

export function confirmAction(title, text, run) {
  sheet(title, `<p style="font-size:13px">${esc(text)}</p>`,
    `<button class="btn" id="no">Отмена</button><button class="btn primary danger" id="yes">Подтвердить</button>`);
  $('no').onclick = closeSheet;
  $('yes').onclick = async () => { closeSheet(); await run(); };
}
async function subAction(action, hwid) {
  const done = await mutate(`/api/conversations/${state.current.id}/subscription/action`,
    { method:'POST', body: JSON.stringify({ action, hwid }) }, 'Готово');
  if (done) { renderSubscription(); open(state.current.id); }
}

/**
 * Режим диалога сильнее глобального — кроме «Выключен везде».
 * Пишем это прямо в карточке: иначе непонятно, почему auto не сработал.
 */
export function renderAiNote() {
  const note = $('aiModeNote');
  if (!note || !state.current) return;
  const global = state.settings?.runtime?.aiMode;
  const own = state.current.ai_mode;
  note.textContent =
    state.current.handoff_at ? 'Диалог у человека — AI по существу не отвечает'
    : global === 'off' ? 'AI выключен в настройках — режим диалога не действует'
    : own === 'inherit' ? `Сейчас действует режим из настроек: ${global === 'auto' ? 'отвечает сам' : global === 'shadow' ? 'только анализирует' : 'предлагает'}`
    : own === 'auto' ? 'Ответы уходят клиенту без подтверждения'
    : own === 'shadow' ? 'AI анализирует сообщения, но ничего не отправляет клиенту'
    : own === 'off' ? 'В этом диалоге AI молчит'
    : 'AI пишет предложку, отправляете вы';
}
