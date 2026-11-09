/**
 * Словарь новой панели (план, раздел 9). Все подписи интерфейса — только
 * отсюда, через t('ключ'). Сырые значения перечислений на экран не попадают:
 * для них есть карты «значение → ключ» рядом с типами (lib/labels.ts).
 * Тест i18n/ru.test.ts ловит неиспользуемые ключи, запрещённые слова и
 * латиницу вне белого списка названий.
 *
 * Подстановки: {name}. Склонения: формы через «|» (один|несколько|много),
 * функция tn() выбирает форму по Intl.PluralRules.
 */
export const ru = {
  // Навигация (5.1)
  'nav.search': 'Найти',
  'nav.today': 'Сегодня',
  'nav.chats': 'Диалоги',
  'nav.knowledge': 'Знания',
  'nav.assistant': 'Помощник',
  'nav.reports': 'Отчёты',
  'nav.connections': 'Подключения',
  'nav.team': 'Команда',
  'nav.system': 'Система',
  'nav.more': 'Ещё',
  'nav.device': 'Это устройство',
  'nav.classic': 'Вернуться к классической',
  'nav.main': 'Разделы',
  'nav.role.owner': 'Владелец',
  'nav.back': 'Назад',

  // Строка состояния
  'status.paused': 'Помощник на паузе до {time}',
  'status.resume': 'Возобновить',

  // Сегодня (6.1)
  'today.morning': 'Доброе утро, {name}',
  'today.day': 'Добрый день, {name}',
  'today.evening': 'Добрый вечер, {name}',
  'today.night': 'Доброй ночи, {name}',
  'today.waiting': 'Вас ждёт {n} {dialogs}.',
  'today.waitingMany': 'Вас ждут {n} {dialogs}.',
  'today.calm': 'Остальное спокойно.',
  'today.nobody': 'Никто не ждёт ответа.',
  'today.aiLeads': 'Помощник ведёт {n} {dialogs}.',
  'today.pausedVerdict': 'Помощник на паузе до {time} — новые вопросы ждут вас.',
  'today.waitingCard': 'Ждут вас',
  'today.allChats': 'Все диалоги',
  'today.away': 'Пока вас не было',
  'today.awaySince': 'с {time}',
  'today.awayText': '{n} новых диалога · помощник ответил на 2 · 1 передан вам',
  'today.openFirst': 'Открыть первый',
  'today.assistant': 'Помощник',
  'today.modeSuggest': 'Подсказывает',
  'today.modeSuggestHint': 'Готовит черновик, отправляете вы.',
  'today.modePaused': 'На паузе до {time}',
  'today.modePausedHint': 'Клиентам сам не отвечает, черновики пишет. Новые вопросы ждут вас.',
  'today.pause': 'Пауза на час',
  'today.change': 'Изменить',
  'today.dayStats': 'За сутки: ответил сам 2, черновиков 3 (2 без правок), передал вам 1.',
  'today.lastAction': 'Последнее: {name}, {time}',
  'today.look': 'Посмотреть',
  'today.wrong': 'Это неверно',
  'today.attention': 'Нужно внимание',
  'today.ideas': '7 идей для статей ждут проверки',
  'today.ideasAction': 'Разобрать',
  'today.version': 'Вышла версия 2.8.0',
  'today.versionAction': 'Что нового',
  'today.system': 'Система',
  'today.systemOk': 'всё работает · связь в порядке',
  'today.empty': 'Сегодня тихо. Новых обращений не было.',

  // Диалоги: список (6.2)
  'chats.title': 'Диалоги',
  'chats.search': 'Имя, @ник или текст…',
  'chats.view.waiting': 'Ждут вас',
  'chats.view.open': 'Открытые',
  'chats.view.done': 'Решённые',
  'chats.views': 'Виды списка',
  'chats.mineHint': 'Сначала срочные, дальше — кто дольше ждёт',
  'chats.nobodyWaits': 'Никто не ждёт ответа. Помощник ведёт {n} {dialogs}.',
  'chats.nothingFound': 'Нет совпадений по «{q}».',
  'chats.clear': 'Очистить',
  'chats.noneDone': 'Решённых диалогов пока нет.',
  'chats.updates': '{n} {updates}',
  'chats.updatesLabel': 'Показать новые изменения в списке',
  'chats.collapse': 'Свернуть секцию',
  'chats.expand': 'Развернуть секцию',
  'chats.unread': 'не прочитано',

  'section.mine': 'Ждут вас',
  'section.colleagues': 'Ведут коллеги',
  'section.ai': 'Помощник ведёт',
  'section.client': 'Ждём клиента',
  'section.done': 'Решённые',

  // Причина в строке (7.1)
  'reason.asksHuman': 'Просит человека',
  'reason.handedOver': 'Помощник передал вам: {topic}',
  'reason.slaOver': 'Срок ответа вышел {ago} назад',
  'reason.aiSilent': 'Помощник не ответил',
  'reason.draftUnsure': 'Помощник не уверен — проверьте черновик',
  'reason.draftReady': 'Черновик готов',
  'reason.important': 'Отмечено важным',
  'reason.slaSoon': 'Срок ответа через {left}',
  'reason.waiting': 'Ждёт ответа {for}',
  'reason.aiReplying': 'Помощник отвечает…',
  'reason.aiReplied': 'Помощник ответил · {time}',
  'reason.colleagueLeads': 'Ведёт {name}',
  'reason.waitingClient': 'Ждём ответа клиента · {for}',
  'reason.windowClosed': 'Ответить в Telegram уже нельзя',
  'reason.resolved': 'Решён {when}',
  'reason.waitsFor': 'ждёт {for}',
  'reason.handoff': 'Передан человеку',
  'reason.urgent': 'Срочная заявка',
  'reason.check': 'Проверьте диалог',

  // Превью: кто писал последним
  'preview.you': 'Вы:',
  'preview.assistant': 'Помощник:',
  'preview.draft': 'Черновик:',
  'preview.operator': 'Оператор:',
  'preview.system': 'Служебное:',
  'preview.attachment': 'Вложение',

  // Живой список (этап 2): данные сервера, только чтение
  'live.badge': 'Только чтение',
  'live.text': 'Живой список с сервера. Диалог открывается в классической панели.',
  'live.toDemo': 'Прототип',
  'live.toLive': 'Войти по ключу',
  'live.toLiveShort': 'Войти',
  'live.signOut': 'Выйти',
  'live.openClassic': 'Открыть в классической',
  'live.threadHint': 'Диалог откроется в классической панели. Здесь пока только список.',
  'live.noName': 'Без имени · №{id}',
  'live.loading': 'Загружаем список…',
  'live.error': 'Список не загрузился',
  'live.errorHint': 'Сервер не ответил. Попробуйте ещё раз.',
  'live.code': 'Код: {code}',
  'live.retry': 'Повторить',
  'live.waitingHuman': 'Ждут человека',
  'live.rightsChanged': 'Ваши права изменились',
  'live.todayLater': '«Сегодня» на живых данных появится позже. Пока — сводка списка.',

  // Связь с сервером (6.14): в норме строки нет
  'connection.restoring': 'Восстанавливаем связь…',
  'connection.offline': 'Нет связи · данные на {time}',
  'connection.syncing': 'Связь есть, обновляем…',
  'connection.retry': 'Повторить',

  // Вход по ключу
  'login.title': 'Вход по ключу',
  'login.again': 'Войдите снова',
  'login.expired': 'Ключ входа перестал действовать (его сменили или отключили).',
  'login.hint': 'Тот же ключ, что и для классической панели.',
  'login.key': 'Ключ входа',
  'login.submit': 'Войти',
  'login.wrong': 'Ключ не подошёл. Проверьте его и попробуйте снова.',
  'login.network': 'Нет связи с сервером. Попробуйте ещё раз.',
  'login.toDemo': 'Посмотреть прототип',

  // Каналы
  'channel.telegram': 'Telegram',
  'channel.business': 'Telegram Business',
  'channel.bedolaga': 'Bedolaga',
  'channel.minishop': 'MiniShop',

  // Диалог: шапка (6.3.1)
  'thread.resolve': 'Решено',
  'thread.reopen': 'Открыть снова',
  'thread.more': 'Ещё действия',
  'thread.client': 'Клиент',
  'thread.waits': 'ждёт {for}',
  'thread.youLead': 'вы ведёте',
  'thread.windowLeft': 'ответить можно ещё {left}',
  'thread.markImportant': 'Отметить важным',
  'thread.unmarkImportant': 'Снять отметку',
  'thread.hide': 'Убрать из списка',
  'thread.copyLink': 'Скопировать ссылку на диалог',
  'thread.actions': 'Действия с диалогом',
  'thread.statusWaitClient': 'Статус: Ждём клиента',

  // Чип «кто отвечает»
  'who.aiAuto': 'Помощник отвечает',
  'who.aiSuggest': 'Помощник подсказывает',
  'who.aiWatch': 'Помощник наблюдает',
  'who.aiOffHere': 'Помощник выключен здесь',
  'who.paused': 'Помощник на паузе до {time}',
  'who.handed': 'Передано вам: {topic}',
  'who.youLead': 'Вы ведёте',
  'who.youTyping': 'Вы пишете — помощник ждёт',
  'who.colleague': '{name} ведёт · до {time}',
  'who.resolved': 'Решён',
  'who.take': 'Взять себе',
  'who.giveBack': 'Вернуть помощнику',
  'who.resume': 'Возобновить',
  'who.intercept': 'Перехватить…',
  'who.sheetTitle': 'Кто отвечает в этом диалоге',
  'who.sheetHint': 'Человек всегда главнее: пока вы печатаете, помощник молчит.',
  'who.asEverywhere': 'Как везде (сейчас: подсказывает)',
  'who.suggestHere': 'Подсказывать здесь',
  'who.watchHere': 'Наблюдать здесь',
  'who.offHere': 'Выключить здесь',
  'who.autoHere': 'Включить «Отвечает сам» здесь…',
  'who.interceptTitle': '{name} сейчас ведёт этот диалог. Перехватить?',
  'who.interceptText': '{name} увидит, что диалог перешёл к вам. Её неотправленный текст останется у неё.',
  'who.interceptYes': 'Перехватить диалог',
  'who.autoTitle': 'Включить «Отвечает сам» в этом диалоге?',
  'who.autoWas': 'Было: помощник готовит черновик, отправляете вы.',
  'who.autoWill': 'Станет: помощник отвечает клиенту сам. Если не уверен — передаст диалог вам.',
  'who.autoYes': 'Включить «Отвечает сам»',
  'who.modeChanged': 'Режим в этом диалоге: {mode}',

  // Лента (6.3.2)
  'feed.today': 'Сегодня',
  'feed.yesterday': 'Вчера',
  'feed.you': 'Вы',
  'feed.assistant': 'Помощник',
  'feed.auto': 'Автосообщение',
  'feed.noteTitle': 'Заметка для команды · клиент не видит',
  'feed.sendingIn': 'отправим через {s} с',
  'feed.undo': 'Отменить',
  'feed.label': 'Переписка',
  'feed.newMessage': 'Новое сообщение от {name}',
  'feed.newBelow': 'Новые · {n}',
  'feed.clientA11y': 'Клиент {name}',

  'event.handed': 'Помощник передал вам: {topic}',
  'event.youTook': 'Вы взяли диалог',
  'event.backToAi': 'Вы вернули диалог помощнику',
  'event.resolved': 'Статус: решён',
  'event.reopened': 'Диалог открыт снова',
  'event.intercepted': 'Вы перехватили диалог у {name}',

  // Черновик помощника (6.3.4)
  'draft.title': 'Черновик помощника',
  'draft.sure': 'Уверен',
  'draft.check': 'Проверьте',
  'draft.unsure': 'Не уверен',
  'draft.whyCheck': 'Почему «Проверьте»: {reason}',
  'draft.basedOn': 'Основано на: {sources}',
  'draft.noSources': 'Источников нет',
  'draft.send': 'Отправить',
  'draft.edit': 'Править',
  'draft.reject': 'Не подходит',
  'draft.rejected': 'Черновик убран',
  'draft.unsureTitle': 'Помощник не уверен — лучше ответить самому.',
  'draft.unsureReason': 'Причина: {reason}',
  'draft.show': 'Показать черновик',
  'draft.hide': 'Скрыть',
  'draft.full': 'Показать целиком',
  'draft.collapse': 'Свернуть',
  'draft.hasDraft': 'Есть черновик помощника',
  'draft.windowClosed': 'Окно Telegram закрыто',
  'draft.shortcut': '⌘↵ — отправить черновик как есть',

  // Поле ответа (6.3.3)
  'composer.reply': 'Ответ',
  'composer.note': 'Заметка',
  'composer.modes': 'Что пишете',
  'composer.placeholder': 'Ваш ответ…',
  'composer.notePlaceholder': 'Заметка для команды…',
  'composer.noteHint': 'Клиент не увидит',
  'composer.send': 'Отправить',
  'composer.saveNote': 'Сохранить заметку',
  'composer.windowLeft': 'Ответить можно ещё {left}',
  'composer.replyBusy': 'Ответ (занят)',
  'composer.sendHint': '⌘↵ — отправить',
  'composer.colleagueLeads': 'Диалог ведёт {name}. Вы можете оставить заметку для команды. Ответить — после неё или через «Перехватить».',

  // Окно 24 часа (6.3.6)
  'window.closedTitle': 'Ответить в Telegram уже нельзя: клиент писал больше суток назад.',
  'window.closedText': 'Telegram разрешает отвечать сутки после сообщения клиента. Что можно сделать:',
  'window.note': 'Заметка для команды',
  'window.waitClient': 'Ждём клиента',
  'window.resolve': 'Решено',
  'window.comesBack': 'Напишет снова — диалог вернётся в «Ждут вас».',

  // Тосты и отмена (7.6)
  'toast.undo': 'Отменить',
  'toast.resolved': 'Диалог решён · {name}',
  'toast.reopened': 'Диалог открыт снова · {name}',
  'toast.took': 'Вы взяли диалог',
  'toast.gaveBack': 'Диалог возвращён помощнику',
  'toast.paused': 'Помощник на паузе до {time}',
  'toast.resumed': 'Помощник снова подсказывает',
  'toast.waitsYou': '{name} ждёт вас',
  'toast.open': 'Открыть',
  'toast.noteSaved': 'Заметка сохранена',
  'toast.important': 'Отмечено важным',
  'toast.unimportant': 'Отметка снята',
  'toast.hidden': 'Диалог убран из списка',
  'toast.linkCopied': 'Ссылка скопирована',
  'toast.waitClient': 'Ждём ответа клиента',
  'toast.close': 'Закрыть уведомление',
  'toast.region': 'Уведомления',

  // Лист и общие
  'sheet.close': 'Закрыть',
  'sheet.cancel': 'Не надо',

  // Клиент (минимум для прототипа)
  'client.title': 'Клиент',
  'client.since': 'клиент с {when}',
  'client.subscription': 'Подписка',
  'client.until': 'до {date}',
  'client.daysLeft': 'ещё {n} {days}',
  'client.traffic': 'Трафик',
  'client.trafficValue': '{used} из {total} ГБ',
  'client.devices': 'Устройства',
  'client.devicesValue': '{used} из {total}',
  'client.server': 'Сервер',
  'client.balance': 'Баланс',
  'client.later': 'Остальное о клиенте — на следующих этапах.',

  // Заглушки разделов
  'placeholder.title': 'Раздел «{name}» появится позже',
  'placeholder.text': 'В прототипе работают «Сегодня» и «Диалоги». Здесь будет раздел по плану.',
  'placeholder.toToday': 'К сводке дня',

  // Демо
  'demo.badge': 'Прототип',
  'demo.open': 'Демо',
  'demo.title': 'Прототип на вымышленных данных',
  'demo.text': 'Все имена и переписки придуманы. Панель не обращается к серверу.',
  'demo.incoming': 'Демо: новое сообщение',
  'demo.incomingShort': 'Новое сообщение',
  'demo.incomingHint': 'Пока курсор над списком, строки стоят, а изменения копятся в пилюле внизу.',
  'demo.state': 'Состояние открытого диалога',
  'demo.state.handed': 'Передано вам',
  'demo.state.aiAuto': 'Помощник отвечает',
  'demo.state.youLead': 'Вы ведёте',
  'demo.state.colleague': 'Ведёт коллега',
  'demo.state.window': 'Окно 24 ч закрыто',
  'demo.draft': 'Черновик помощника',
  'demo.theme': 'Тема',
  'demo.theme.auto': 'Авто',
  'demo.theme.light': 'Светлая',
  'demo.theme.dark': 'Тёмная',
  'demo.reset': 'Начать сначала',
  'demo.noChat': 'Откройте диалог, чтобы менять его состояние.',

  // Время
  'time.yesterday': 'вчера',
  'time.lessMinute': 'меньше минуты',
  'time.hours': '{h} ч',
  'time.hoursMinutes': '{h} ч {m} мин',

  // Склонения: один | несколько | много
  'plural.dialogs': 'диалог|диалога|диалогов',
  'plural.updates': 'обновление|обновления|обновлений',
  'plural.days': 'день|дня|дней',
  'plural.minutes': 'мин|мин|мин',
} as const;

export type Key = keyof typeof ru;
export type PluralKey = Extract<Key, `plural.${string}`>;

const pluralRules = new Intl.PluralRules('ru');

/** Строка словаря с подстановками {name}. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const template: string = ru[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole);
}

/** Форма слова для числа: tn('plural.dialogs', 3) → «диалога». */
export function tn(key: PluralKey, n: number): string {
  const forms = ru[key].split('|');
  const rule = pluralRules.select(n);
  const index = rule === 'one' ? 0 : rule === 'few' ? 1 : rule === 'many' ? 2 : 1;
  return forms[index] ?? forms[forms.length - 1] ?? '';
}
