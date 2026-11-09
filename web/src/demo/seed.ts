/**
 * СИНТЕТИЧЕСКИЕ данные прототипа. Все имена, переписки, серверы и суммы
 * выдуманы; ников и телефонов нет. Панель в режиме прототипа к серверу не
 * обращается — всё ниже живёт только в памяти вкладки.
 *
 * Время задаётся от «сейчас», чтобы подписи «ждёт 2 ч» и «вчера» были живыми.
 */
import { t } from '@/i18n/ru';
import type { Author, Chat, ClientInfo, FeedItem } from '@/lib/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Владелец установки и коллега — тоже выдуманные. */
export const ME = { name: 'Иван' } as const;
export const COLLEAGUE = { name: 'Мария' } as const;

let counter = 0;
const nextId = (prefix: string): string => `${prefix}${(counter += 1)}`;

const msg = (author: Author, text: string, at: number, authorName?: string): FeedItem =>
  ({ type: 'message', id: nextId('m'), author, text, at, ...(authorName ? { authorName } : {}) });
const event = (text: string, at: number): FeedItem => ({ type: 'event', id: nextId('e'), text, at });
const note = (authorName: string, text: string, at: number): FeedItem => ({ type: 'note', id: nextId('n'), authorName, text, at });

const client = (now: number, overrides: Partial<ClientInfo> = {}): ClientInfo => ({
  since: now - 240 * DAY,
  subscriptionUntil: now + 33 * DAY,
  trafficUsed: 41,
  trafficTotal: 100,
  devicesUsed: 2,
  devicesTotal: 3,
  server: 'Демо-Север',
  balance: '120 ₽',
  ...overrides,
});

export function seedChats(now: number): Chat[] {
  counter = 0;
  const chats: Chat[] = [
    {
      id: 'c101', name: 'Анна К.', channel: 'telegram', section: 'mine',
      reason: { kind: 'asksHuman' }, who: { kind: 'handed', topic: 'просит человека' },
      waitingSince: now - 2 * HOUR - 4 * MIN, lastAt: now - 2 * HOUR + MIN, unread: true,
      windowEndsAt: now + 21 * HOUR + 40 * MIN,
      feed: [
        msg('client', 'Здравствуйте! Не могу подключить на айфоне, пишет ошибку', now - 2 * HOUR - 4 * MIN),
        msg('assistant', 'Здравствуйте, Анна! Какая именно ошибка? Пришлите, пожалуйста, текст или снимок экрана.', now - 2 * HOUR - 3 * MIN),
        msg('client', 'Просто «не удалось». Позовите человека, пожалуйста', now - 2 * HOUR + MIN),
        event(t('event.handed', { topic: 'клиент просит человека' }), now - 2 * HOUR + MIN),
      ],
      draft: {
        text: 'Здравствуйте, Анна! Удалите профиль в приложении и добавьте его заново по ссылке из личного кабинета. Если ошибка повторится — пришлите снимок экрана, разберёмся.',
        level: 'check',
        reason: 'про ошибку «не удалось» статьи нет',
        sources: ['Подключение на iOS', 'данные подписки'],
      },
      client: client(now, { server: 'Демо-Север' }),
    },
    {
      id: 'c102', name: 'Дина С.', channel: 'business', section: 'mine',
      reason: { kind: 'aiSilent' }, who: { kind: 'aiAuto' },
      waitingSince: now - 4 * MIN, lastAt: now - 4 * MIN, unread: true,
      windowEndsAt: now + 23 * HOUR + 56 * MIN,
      feed: [
        msg('client', 'Добрый день. Верните, пожалуйста, деньги за месяц — я так и не смогла пользоваться', now - 4 * MIN),
      ],
      client: client(now, { trafficUsed: 0, devicesUsed: 0, balance: '0 ₽' }),
    },
    {
      id: 'c103', name: 'Пётр В.', channel: 'telegram', section: 'mine',
      reason: { kind: 'draftUnsure' }, who: { kind: 'aiSuggest' },
      waitingSince: now - 25 * MIN, lastAt: now - 25 * MIN, unread: false,
      windowEndsAt: now + 23 * HOUR + 35 * MIN,
      feed: [
        msg('client', 'Можно перенести подписку на другой аккаунт? Хочу отдать её брату', now - 25 * MIN),
      ],
      draft: {
        text: 'Да, подписку можно передать: напишите новый аккаунт, и мы перенесём остаток срока.',
        level: 'unsure',
        reason: 'в знаниях нет правила о переносе подписки',
        sources: [],
      },
      client: client(now, { subscriptionUntil: now + 12 * DAY }),
    },
    {
      id: 'c104', name: 'Елена П.', channel: 'telegram', section: 'colleagues',
      reason: { kind: 'colleagueLeads', name: COLLEAGUE.name }, who: { kind: 'colleague', name: COLLEAGUE.name, until: now + 12 * MIN },
      waitingSince: now - 9 * MIN, lastAt: now - 9 * MIN, unread: false,
      windowEndsAt: now + 23 * HOUR,
      feed: [
        msg('client', 'Можно подключить второй телефон к той же подписке?', now - 9 * MIN),
        note(COLLEAGUE.name, 'Проверяю, сколько устройств в тарифе, отвечу сама.', now - 3 * MIN),
      ],
      client: client(now, { devicesUsed: 3 }),
    },
    {
      id: 'c105', name: 'Михаил Р.', channel: 'telegram', section: 'ai',
      reason: { kind: 'aiReplied', at: now - 41 * MIN }, who: { kind: 'aiAuto' },
      lastAt: now - 41 * MIN, unread: false, windowEndsAt: now + 23 * HOUR,
      feed: [
        msg('client', 'Где взять ссылку на подписку? Потерял', now - 42 * MIN),
        msg('assistant', 'Ссылку на подписку отправил в этот чат — откройте её на телефоне, приложение добавит профиль само.', now - 41 * MIN),
      ],
      client: client(now),
    },
    {
      id: 'c106', name: 'Тимур С.', channel: 'telegram', section: 'ai',
      reason: { kind: 'aiReplied', at: now - 2 * HOUR - 19 * MIN }, who: { kind: 'aiAuto' },
      lastAt: now - 2 * HOUR - 19 * MIN, unread: false, windowEndsAt: now + 21 * HOUR,
      feed: [
        msg('client', 'А через вайфай в гостинице заработает?', now - 2 * HOUR - 20 * MIN),
        msg('assistant', 'Да, подойдёт любая сеть. Если страница входа гостиницы не открывается — сначала выключите защиту, войдите в сеть, потом включите снова.', now - 2 * HOUR - 19 * MIN),
      ],
      client: client(now),
    },
    {
      id: 'c107', name: 'Олег Т.', channel: 'telegram', section: 'client',
      reason: { kind: 'waitingClient' }, who: { kind: 'youLead' },
      waitingSince: now - 3 * HOUR, lastAt: now - 3 * HOUR, unread: false, windowEndsAt: now + 20 * HOUR,
      feed: [
        msg('client', 'Медленно грузит видео вечером', now - 3 * HOUR - 6 * MIN),
        event(t('event.youTook'), now - 3 * HOUR - 4 * MIN),
        msg('you', 'Попробуйте переключиться на сервер «Демо-Юг» в приложении — вечером он свободнее.', now - 3 * HOUR),
      ],
      client: client(now),
    },
    {
      id: 'c108', name: 'Светлана Г.', channel: 'telegram', section: 'client',
      reason: { kind: 'waitingClient' }, who: { kind: 'aiSuggest' },
      waitingSince: now - 6 * HOUR, lastAt: now - 6 * HOUR, unread: false, windowEndsAt: now + 18 * HOUR,
      feed: [
        msg('client', 'После обновления приложения пропал профиль', now - 6 * HOUR - 10 * MIN),
        msg('you', 'Добавьте профиль заново по ссылке из личного кабинета. Напишите, если не заработает.', now - 6 * HOUR),
      ],
      client: client(now),
    },
    {
      id: 'c109', name: 'Роман Д.', channel: 'telegram', section: 'client',
      reason: { kind: 'windowClosed' }, who: { kind: 'aiSuggest' },
      waitingSince: now - 26 * HOUR, lastAt: now - 26 * HOUR, unread: false, windowEndsAt: now - 2 * HOUR,
      feed: [
        msg('client', 'Не работает на телевизоре, что делать?', now - 26 * HOUR),
      ],
      client: client(now, { devicesUsed: 1 }),
    },
    {
      id: 'c110', name: 'Ксения Л.', channel: 'bedolaga', section: 'client',
      reason: { kind: 'waitingClient' }, who: { kind: 'aiSuggest' },
      waitingSince: now - DAY - 2 * HOUR, lastAt: now - DAY - 2 * HOUR, unread: false,
      feed: [
        msg('client', 'Заявка: не пришёл чек об оплате', now - DAY - 3 * HOUR),
        msg('you', 'Отправили чек повторно на почту из заявки. Проверьте, пожалуйста, папку «Спам».', now - DAY - 2 * HOUR),
      ],
      client: client(now),
    },
    {
      id: 'c111', name: 'Глеб Ф.', channel: 'telegram', section: 'client',
      reason: { kind: 'waitingClient' }, who: { kind: 'aiSuggest' },
      waitingSince: now - 2 * DAY, lastAt: now - 2 * DAY, unread: false, windowEndsAt: now - DAY,
      feed: [
        msg('client', 'Как сменить тариф на годовой?', now - 2 * DAY - 20 * MIN),
        msg('assistant', 'Сменить тариф можно в личном кабинете, раздел «Подписка». Остаток текущего срока пересчитается автоматически.', now - 2 * DAY),
      ],
      client: client(now),
    },
    {
      id: 'c112', name: 'Вера Н.', channel: 'minishop', section: 'client',
      reason: { kind: 'waitingClient' }, who: { kind: 'aiSuggest' },
      waitingSince: now - 3 * DAY, lastAt: now - 3 * DAY, unread: false,
      feed: [
        msg('client', 'Заказ: оплатила два месяца, а продлилось на один', now - 3 * DAY - HOUR),
        msg('you', 'Проверили — второй месяц добавили. Срок теперь до конца января.', now - 3 * DAY),
      ],
      client: client(now),
    },
    {
      id: 'c113', name: 'Алла Б.', channel: 'telegram', section: 'done',
      reason: { kind: 'resolved', at: now - DAY + 3 * HOUR }, who: { kind: 'resolved' },
      lastAt: now - DAY + 3 * HOUR, unread: false, windowEndsAt: now + 3 * HOUR,
      feed: [
        msg('client', 'Спасибо, всё заработало!', now - DAY + 2 * HOUR),
        event(t('event.resolved'), now - DAY + 3 * HOUR),
      ],
      client: client(now),
    },
    {
      id: 'c114', name: 'Денис К.', channel: 'business', section: 'done',
      reason: { kind: 'resolved', at: now - 2 * DAY }, who: { kind: 'resolved' },
      lastAt: now - 2 * DAY, unread: false,
      feed: [
        msg('client', 'Подписка продлилась, вопрос снят', now - 2 * DAY - HOUR),
        event(t('event.resolved'), now - 2 * DAY),
      ],
      client: client(now),
    },
  ];
  return chats;
}

/** Новые выдуманные клиенты для кнопки «демо: новое сообщение». */
export const NEW_CLIENTS: readonly { name: string; text: string; topic: string }[] = [
  { name: 'Ольга Н.', text: 'Оплатила, а подписка не продлилась. Можно человека?', topic: 'вопрос про оплату' },
  { name: 'Савелий Ж.', text: 'Списали деньги дважды, разберитесь, пожалуйста', topic: 'двойное списание' },
  { name: 'Ирина М.', text: 'Позовите оператора, бот не понимает', topic: 'просит человека' },
  { name: 'Лев Ч.', text: 'Хочу вернуть деньги за год', topic: 'возврат денег' },
];

export const FOLLOW_UPS: readonly string[] = [
  'Спасибо, сейчас попробую',
  'Сделала, но всё так же: «не удалось»',
  'Вот, переустановила приложение',
  'Понял, жду',
];

export const newClientInfo = client;
export const ids = { next: nextId };
export { msg as demoMessage, event as demoEvent, note as demoNote };
