/**
 * Проверки разметки панели.
 *
 * Ловят ровно тот класс ошибок, из-за которого панель уехала: грид с лишними
 * детьми, скрытие, перебитое классом, ссылки на несуществующие id. Браузера
 * здесь нет, поэтому проверяем инварианты структуры, а не пиксели.
 */
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
// Проверки компонентов должны читать реально подключённые stylesheets. Иначе
// неактивный файл может сохранять старое правило и маскировать регрессию UI.
const activeStylesheets = [...html.matchAll(/<link\b[^>]*>/g)]
  .map(([tag]) => ({ rel:tag.match(/\brel="([^"]+)"/)?.[1], href:tag.match(/\bhref="\/([^"]+)"/)?.[1] }))
  .filter((link): link is { rel:string; href:string } => link.rel === 'stylesheet' && Boolean(link.href));
const uiCss = activeStylesheets
  .map(({ href }) => readFileSync(new URL(`../public/${href}`, import.meta.url), 'utf8'))
  .join('\n');

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) console.log(`  ok    ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}`, detail ?? ''); }
};

console.log('\n[ разметка панели ]');

// 1. Скрытие обязано побеждать любой display у класса.
check('правило [hidden] стоит с !important',
  /\[hidden\][^{]*\{\s*display:\s*none\s*!important/.test(html));

// 2. У грида .app ровно три прямых ребёнка — иначе он разложит их в два ряда.
const appBlock = html.slice(html.indexOf('<div class="app"'), html.indexOf('<div class="backdrop"'));
const directChildren = [...appBlock.matchAll(/^ {2}<(aside|main|div|section)\b/gm)].length;
check('у .app ровно три прямых ребёнка', directChildren === 3, directChildren);

// 3. Все экраны лежат внутри <main>, а не рядом с ним.
const mainBlock = appBlock.slice(appBlock.indexOf('<main'), appBlock.indexOf('</main>'));
const viewsTotal = [...appBlock.matchAll(/class="view"/g)].length;
const viewsInMain = [...mainBlock.matchAll(/class="view"/g)].length;
check('все экраны внутри <main>', viewsTotal > 0 && viewsTotal === viewsInMain, `${viewsInMain} из ${viewsTotal}`);

// 4. Ровно один экран виден при загрузке.
const visibleViews = [...appBlock.matchAll(/<section class="view" id="view-[a-z]+"(?!\s+hidden)/g)].length;
check('при загрузке открыт ровно один экран', visibleViews === 1, visibleViews);

// 5. Каждый id, который дёргает скрипт, существует в разметке.
const declared = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]!));
const script = html.slice(html.indexOf('<script type="module">'));
const referenced = [...script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]!);
// Элементы, которые скрипт создаёт сам внутри листов и карточек.
const dynamic = new Set(['sheetX','cancel','save','create','run','no','yes','sgSend','sgEdit','sgNo',
  'refreshCust','bedolagaCardBtn','bedCardBody','copySub','resetDev','revoke','logBox','docText','nTitle','nText','mSource','mLimit','mDry']);
const missing = [...new Set(referenced)].filter((id) => !declared.has(id) && !dynamic.has(id));
check('скрипт не обращается к несуществующим id', missing.length === 0, missing);

// 6. Дубликаты id ломают getElementById молча. Смотрим только разметку:
// в скрипте id повторяются по шаблонам листов, но лист в DOM всегда один.
const markup = html.slice(0, html.indexOf('<script type="module">'));
const ids = [...markup.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]!);
const dupes = ids.filter((id, index) => ids.indexOf(id) !== index);
check('дубликатов id нет', dupes.length === 0, dupes);

// 7. Каждая прокручиваемая область ограничена по высоте, иначе страница едет.
check('у списка и треда есть min-height:0',
  /\.scroll-y\s*\{[^}]*min-height:\s*0/.test(html) && /\.thread\s*\{[^}]*min-height:\s*0/.test(html));

// 8. Экраны переключаются по атрибуту, а не удалением из DOM.
check('переключение экранов через hidden', /\$\(`view-\$\{v\}`\)\.hidden = v !== view/.test(html));

// 9. Правая колонка прячется вне инбокса.
check('контекстная колонка скрывается вне инбокса',
  /\.app\[data-context="off"\]\s+\.context\s*\{\s*display:\s*none/.test(html));

// 10. Каждый теговый блок закрыт.
for (const tag of ['div', 'section', 'aside', 'main', 'button', 'select', 'textarea']) {
  const open = [...html.matchAll(new RegExp(`<${tag}[\\s>]`, 'g'))].length;
  const close = [...html.matchAll(new RegExp(`</${tag}>`, 'g'))].length;
  check(`теги <${tag}> сбалансированы`, open === close, `${open} открыто, ${close} закрыто`);
}

// 11. Каждая тема объявляет полный набор токенов — иначе она наследует
// чужие цвета и выглядит наполовину сломанной.
// Лестница поверхностей: canvas → s1 → s2 → s3, плюс границы и чернила.
// Тема, где не хватает хоть одного токена, наследует чужой цвет и выглядит
// наполовину сломанной.
const TOKENS = ['--bg','--bg-1','--bg-2','--bg-3','--line','--line-2','--fg','--fg-2','--fg-3','--glass','--glass-edge','--tint'];
const themes = [...html.matchAll(/\[data-theme="([a-z]+)"\]\s*\{([^}]+)\}/g)];
check('тем в оформлении не меньше пяти', themes.length >= 5, themes.length);
for (const [, name, body] of themes) {
  const missingTokens = TOKENS.filter((t) => !(body ?? "").includes(`${t}:`));
  check(`тема ${name} объявляет все токены`, missingTokens.length === 0, missingTokens);
}
const accents = [...html.matchAll(/\[data-accent="([a-z]+)"\]/g)].length;
check('акцентов не меньше семи', accents >= 7, accents);

// 12. Компактная высота контрола: плотность — часть характера интерфейса.
const ctl = /--ctl:\s*(\d+)px/.exec(html);
check('высота контрола в рабочем диапазоне', !!ctl && Number(ctl[1]) >= 22 && Number(ctl[1]) <= 28, ctl?.[1]);

// 12a. Одно имя — одна роль. Тема, переопределяющая токен отступа цветом,
// превращает padding: var(--x) в padding: #141618 — свойство отбрасывается,
// и интерфейс теряет отступы целиком. Ровно так и случилось.
{
  const rootBlock = /:root\s*\{([^}]+)\}/.exec(html)?.[1] ?? '';
  const lengthTokens = new Set(
    [...rootBlock.matchAll(/(--[\w-]+)\s*:\s*[\d.]+(px|rem|em|%)/g)].map((m) => m[1]!),
  );
  const collisions: string[] = [];
  for (const [, body] of themes) {
    for (const [, name] of (body ?? '').matchAll(/(--[\w-]+)\s*:/g)) {
      if (lengthTokens.has(name!)) collisions.push(name!);
    }
  }
  check('темы не переопределяют токены размеров', collisions.length === 0, [...new Set(collisions)]);
}

// 12b. Идентичность несут ограничения, а не палитра: узкий диапазон
// насыщенности и отсутствие теней. Жирное ломает характер.
const weights = [...html.matchAll(/font-weight:\s*(\d{3})/g)].map((m) => Number(m[1]));
const inlineWeights = [...html.matchAll(/font:\s*(\d{3})\s/g)].map((m) => Number(m[1]));
const allWeights = [...new Set([...weights, ...inlineWeights])];
check('насыщенность только 400 / 510 / 590',
  allWeights.every((w) => [400, 510, 590].includes(w)), allWeights);
// Тени допустимы только там, где по материалу положено: стекло и листы.
{
  const css = html.slice(0, html.indexOf('</style>'));
  const shadowed = [...css.matchAll(/([.#][\w-]+[^{]*)\{[^}]*box-shadow:\s*[^n][^;]*/g)]
    .map((m) => m[1]!.trim())
    // Кольца состояния и подсветка выбора — не тени: у них нулевое
    // смещение, они очерчивают элемент, а не отбрасывают глубину.
    .filter((sel) => !/gate-card|sheet|toast|focus|seg button|pulse|aria-pressed|lightbox|keyframes|flash/.test(sel));
  check('тени только на стеклянных и всплывающих слоях', shadowed.length === 0, shadowed);
}
check('радиусов ровно три', /--r-ctl:/.test(html) && /--r-box:/.test(html) && /--r-pill:/.test(html));

// 13. Тема и акцент переживают перезагрузку.
check('выбор оформления сохраняется', /localStorage\.setItem\('theme'/.test(html) && /localStorage\.setItem\('accent'/.test(html));

// 14. Функции-хелперы объявлены раньше первого использования: const в модуле
// попадает во временную мёртвую зону, и панель падает уже в рантайме.
const scriptBody = html.slice(html.indexOf('<script type="module">'));
for (const helper of ['gb', 'fmtTime', 'fmtLeft', 'esc', 'nameOf']) {
  const declaration = scriptBody.indexOf(`const ${helper} = `);
  const uses = [...scriptBody.matchAll(new RegExp(`(?<![\\w.])${helper}\\(`, 'g'))].map((m) => m.index!);
  const firstUse = uses.find((index) => index > declaration + helper.length + 10 || index < declaration);
  check(`${helper} объявлена до первого использования`,
    declaration !== -1 && (firstUse === undefined || firstUse > declaration), `декл ${declaration}, исп ${firstUse}`);
}

// 15. Сухого прогона в панели больше нет — он путал больше, чем помогал.
check('в диалоге сбора нет dry-run', !/dryRun:\s*\$\('mDry'\)/.test(html));
check('выгрузка Telegram загружается из панели', /\/api\/kb\/mine\/export/.test(html));
check('манера ответа правится из панели', /styleBox/.test(html) && /replyStyle/.test(html));

// 16. Выбранный пункт списка сравнивается строками: в runtime булево true,
// в option — строка 'true', и строгое равенство ничего не подсвечивало.
check('выбранный пункт списка сравнивается строками',
  /String\(v\)\s*===\s*selected/.test(html) && /const selected =/.test(html));
check('передача человеку управляется из панели', /handoffBtn/.test(html) && /handoffMessage/.test(html));

// 17. Дети flex-колонки обязаны иметь flex:0 0 auto — иначе при длинном
// содержимом блоки сжимаются и кнопки налезают друг на друга.
check('блоки правой колонки не сжимаются', /\.context\s*>\s*\*\s*\{[^}]*flex:\s*0 0 auto/.test(html));
check('длинный список устройств прокручивается сам', /\.group\.scrolls\s*\{[^}]*max-height/.test(html));

// 18. Ошибки сервера обязаны быть видны: раньше отказ возвращался как null,
// и кнопка «Опубликовать» выглядела мёртвой, хотя падала на правах доступа.
check('изменения идут через обёртку с показом ошибок', /async function mutate\(/.test(html));
const swallowed = [...html.matchAll(/if \(await json\(`[^`]+`, \{ method:/g)].length;
check('мутаций через молчаливый json не осталось', swallowed === 0, swallowed);

// 19. Заголовок content-type без тела Fastify считает ошибкой, поэтому
// клиент обязан ставить его только когда тело есть.
check('content-type ставится только при наличии тела',
  /options\.body !== undefined && headers\['content-type'\] === undefined/.test(html));

// 20. Пузырь без текста и без вложения выглядит как потерянное сообщение —
// такой случай обязан отрисовываться явно.
check('пустой пузырь не остаётся без содержимого',
  /if \(!m\.text && !files\.length\)/.test(html));
check('подробность уведомлений настраивается', /notifyLevel/.test(html));
check('клавиши подстраиваются под платформу', /function applyPlatformShortcuts\(/.test(html)
  && /applePlatform/.test(html) && /navigator\.userAgentData/.test(html)
  && /aria-keyshortcuts/.test(html));

// 22. Вход отдельным экраном: prompt() не показывает ошибку и не даёт
// стереть неверный токен.
// Комментарии не считаем: в них объясняется, почему prompt() убран.
const liveScript = html
  .slice(html.indexOf('<script type="module">'))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
check('экран входа вместо prompt', /class="gate"/.test(html) && !/\bprompt\(/.test(liveScript));
check('неверный токен показывает причину', /Токен не подошёл/.test(html));

// 23. Ширины текучие: на широком мониторе колонки должны расти. Переписка
// занимает всю ширину колонки (входящие слева, исходящие справа), а читаемость
// держится на уровне пузыря, а не всей полосы.
check('колонки масштабируются с шириной окна', /grid-template-columns:\s*clamp\(/.test(html));
check('переписка привязана к краям колонки', /\.thread-inner\s*\{[^}]*width:\s*100%/.test(html));
check('пузырь ограничен комфортной строкой', /\.msg\s*\{[^}]*max-width:\s*min\(/.test(html));
check('место под скроллбар зарезервировано', /scrollbar-gutter:\s*stable/.test(html));

// Активная v3-тема должна сохранять базовые layout-контракты. Эти проверки
// намеренно читают подключённый stylesheet: legacy CSS не может маскировать
// повторное появление переносов и наложений.
check('поиск очереди не получает вторую рамку от глобального input',
  /\.queue-search\s*\{[^}]*min-width:0[^}]*overflow:hidden/s.test(uiCss)
  && /\.queue-search input#listSearch\s*\{[^}]*min-width:0[^}]*border:0!important[^}]*box-shadow:none!important/s.test(uiCss));
check('кнопка держит иконку и текст в одной строке',
  /\.btn\s*\{[^}]*display:inline-flex[^}]*align-items:center[^}]*white-space:nowrap/s.test(uiCss));
check('иконка инспектора оптически центрирована',
  /\.inspector-toggle\s*\{[^}]*display:grid[^}]*place-items:center/s.test(uiCss));
check('inspector не наследует отступы и gap старого layout',
  /\.context\s*\{[^}]*padding:0[^}]*gap:0/s.test(uiCss));
check('статус обращения переведён в UI без изменения API-значений',
  /const CONVERSATION_STATUS = Object\.freeze\(\{[\s\S]*?open:'Открыто'[\s\S]*?pending:'Ждёт клиента'[\s\S]*?resolved:'Решено'/.test(html)
  && /<option value="open">Открыто<\/option>/.test(html)
  && /<option value="pending">Ждёт клиента<\/option>/.test(html)
  && /<option value="resolved">Решено<\/option>/.test(html));
check('статус можно изменить из inspector на любой ширине',
  /id="contextStatusSel"/.test(html)
  && /\$\('contextStatusSel'\)\.onchange = \(e\) => setState\(\{ status: e\.target\.value \}\)/.test(html)
  && /\['statusSel', 'contextStatusSel', 'aiSel'/.test(html));
check('сообщения v3 привязаны к краям рабочей области',
  /\.thread-inner\s*\{[^}]*width:100%[^}]*margin:0/s.test(uiCss)
  && !/@media \(min-width:1900px\)[\s\S]*?\.thread-inner\s*\{/u.test(uiCss));
check('серверы ограничены и центрированы',
  /\.nodes-shell\s*\{[^}]*width:min\(1240px,100%\)[^}]*margin:0 auto/s.test(uiCss));
check('настройки открываются сверху и считают координаты относительно scroller',
  /settingsScroller\.scrollTop = 0/.test(html)
  && /section\.getBoundingClientRect\(\)\.top/.test(html)
  && /settingsScroller\.getBoundingClientRect\(\)\.top/.test(html));
check('источники используют скруглённый системный glyph',
  /\.source-kind\s*\{[^}]*border-radius:6px/s.test(uiCss));
check('обновления и проверка уведомлений имеют собственную раскладку',
  /class="update-safety"/.test(html)
  && /\.update-safety\s*\{[^}]*display:grid/s.test(uiCss)
  && /\.health-action > div\s*\{[^}]*display:grid/s.test(uiCss));
check('2K и 4K получают масштаб без двойного увеличения HiDPI',
  /@media \(min-width:2400px\) and \(min-height:1200px\)[\s\S]*?zoom:1\.15/.test(uiCss)
  && /@media \(min-width:3400px\) and \(min-height:1800px\)[\s\S]*?zoom:1\.45/.test(uiCss));

// 21. Цитаты: показываем, на что отвечает сообщение, и даём ответить
// на конкретное — половина смысла переписки в Telegram именно в этом.
check('цитата отрисовывается в переписке', /function quoteBlock\(/.test(html));
check('можно ответить на конкретное сообщение', /function setQuote\(/.test(html) && /payload\.replyTo = quoting\.id/.test(html));

// 24. Вложение в переписке — превью, а не полотно. Вертикальный скриншот
// с телефона без ограничения занимает весь экран.
check('вложение ограничено по высоте', /\.bubble \.shot\s*\{[^}]*max-height:\s*\d+px/.test(html));
check('композер принимает выбор, drop и вставку файлов', html.includes('id="filePicker"')
  && html.includes("'dragenter','dragover'") && html.includes("addEventListener('paste'"));
check('клиентский предел отправки — 10 файлов по 45 МБ', html.includes('pendingFiles.length + incoming.length > 10')
  && html.includes('45 * 1024 * 1024'));
check('загрузка показывает фактический прогресс', html.includes('xhr.upload.onprogress') && uiCss.includes('.upload-meter'));
check('редактор создаёт PNG-копию и сохраняет оригинал', html.includes("`${base}-edited.png`")
  && html.includes('originalFile:file') && html.includes("'image/png'"));
check('редактор содержит полный набор инструментов', ['draw','line','arrow','rect','ellipse','text','pixel','crop']
  .every((tool) => html.includes(`data-tool="${tool}"`)) && html.includes('data-action="resize"'));
check('ранее отправленное изображение можно править копией', html.includes('openImageEditorFromUrl(attachmentUrl(a.id)'));
check('есть горячие клавиши загрузки и снимка', html.includes("event.key.toLowerCase()==='u'")
  && html.includes("event.key.toLowerCase()==='s'") && html.includes('getDisplayMedia'));
check('полный размер открывается по клику', /function openImage\(/.test(html) && /className = 'lightbox'/.test(html));
check('просмотр картинки всегда можно закрыть', /lightbox-close/.test(uiCss)
  && /closeButton\.onclick\s*=/.test(html)
  && /e\.key === 'Escape'/.test(html));
check('аватар ограничен собственным containing block',
  /class="avatar-frame \$\{className\}"/.test(html)
  && /\.avatar-frame\s*\{[^}]*position:relative[^}]*overflow:hidden[^}]*contain:layout paint/s.test(uiCss)
  && /\.avatar-photo\s*\{[^}]*position:absolute[^}]*max-width:100%\s*!important[^}]*max-height:100%\s*!important/s.test(uiCss)
  && /\.row-avatar\s*\{[^}]*max-width:36px[^}]*max-height:36px/s.test(uiCss)
  && /\.title-avatar\s*\{[^}]*max-width:38px[^}]*max-height:38px/s.test(uiCss));

// 25. Действие «ответить» не спрятано за наведение: невидимую кнопку
// не находят.
check('ответ виден без наведения', /\.act\s*\{[^}]*opacity:\s*\.65/.test(html));
check('цитата ведёт к исходному сообщению', /function jumpTo\(/.test(html) && /data-mid/.test(html));

// 26. Пузырь обязан обнимать содержимое: без align-items колонка растягивает
// его до ширины строки времени, и короткое «Да» получает пустоту справа.
check('пузырь не растягивается строкой времени',
  /\.msg\.in\s*\{[^}]*align-items:\s*flex-start/.test(html)
  && /\.msg\.out\s*\{[^}]*align-items:\s*flex-end/.test(html));
check('вложение вписывается, а не обрезается', /\.bubble \.shot img\s*\{[^}]*object-fit:\s*contain/.test(html));

// 27. Песочница, выбор модели и проверка связи — из панели.
check('песочница AI есть', /id="view-lab"/.test(html) && /\/api\/ai\/try/.test(html));
check('связь проверяется кнопкой', /\/api\/ai\/ping/.test(html));
check('модель выбирается из списка провайдера', /\/api\/ai\/models/.test(html));
check('подозрительные видны в списке', /нет в базах/.test(html));

// 38. Подключение источников должно быть обнаруживаемым действием в панели,
// а не требовать ручного редактирования .env. Секрет вводится как пароль и
// сразу удаляется из DOM после постановки root-only задания в очередь.
check('в настройках есть явное добавление источника', /Добавить источник/.test(html)
  && /function openSourceWizard\(/.test(html));
check('мастер поддерживает бота, Business и Remnawave', /value="telegram_bot"/.test(html)
  && /value="telegram_business"/.test(html) && /value="remnawave"/.test(html));
check('токен источника скрыт и очищается', /id="sourceToken" type="password"/.test(html)
  && /\$\('sourceToken'\)\.value = ''/.test(html));
check('подключение источника использует отдельный безопасный API', /\/api\/sources\/request/.test(html)
  && /\/api\/sources\/status/.test(html) && /watchSourceApply/.test(html));
check('Telegram Business подключается понятной инструкцией', /Настройки → Telegram Business → Чат-боты/.test(html)
  && /Один бот может обслуживать несколько Business-аккаунтов/.test(html));

// 28. У каждой настройки обязано быть объяснение: без него оператор меняет
// значение, не видит эффекта и считает параметр сломанным.
{
  const fieldsBlock = html.slice(html.indexOf('const FIELDS = ['), html.indexOf('function nearestLevel'));
  const keys = [...fieldsBlock.matchAll(/key:'(\w+)'/g)].map((m) => m[1]!);
  const hints = [...fieldsBlock.matchAll(/hint:'/g)].length;
  check('описание есть у каждой настройки', keys.length === hints, `${keys.length} полей, ${hints} описаний`);
  check('порог уверенности задаётся уровнями',
    /CONFIDENCE_LEVELS = \[/.test(html) && /kind:'level'/.test(html));
  check('неактивные настройки помечаются', /Сейчас не действует/.test(html));
}

// 29. Иконка нейтральная: чужой бренд в шапке инструмента неуместен.
check('в знаке нет привязки к бренду',
  !/gate-mark"[^>]*>\s*66/.test(html) && !/brand-mark"[^>]*>\s*66/.test(html));

// 30. Производительность: размытие фона на больших поверхностях
// пересчитывается при каждой перерисовке и на 2K съедает кадр.
{
  const css = html.slice(0, html.indexOf('</style>'));
  const blurred = [...css.matchAll(/([.#][\w-]+[^{]*)\{[^}]*backdrop-filter:/g)].map((m) => m[1]!.trim());
  const heavy = blurred.filter((sel) => /sidebar|\.bar|composer|context|thread|\.list/.test(sel));
  check('крупные поверхности без размытия фона', heavy.length === 0, heavy);
  check('список перерисовывается только при изменении', /listSignature/.test(html));
  check('анимируются только новые сообщения', /\.msg\.fresh/.test(html) && /classList\.add\('fresh'\)/.test(html));
}

// 31. Колонки двигаются мышью и запоминают ширину.
check('колонки растягиваются', /col-resize/.test(html) && html.includes('const LAYOUT ='));
check('ширина запоминается', /localStorage\.setItem\(`layout:/.test(html));

// 32. Правая колонка складывается, сводка занимает пустое место в навигации.
check('разделы карточки сворачиваются', (html.match(/class="fold"/g) ?? []).length >= 4);
check('состояние разделов запоминается', /localStorage\.setItem\(key, fold\.open/.test(html));
check('в навигации есть живая сводка', /renderBoard/.test(html) && /pulseBoard/.test(html));

// 33. Описания свёрнуты, обе модели выбираются, ключ виден.
check('описание раскрывается кнопкой', /class="why"/.test(html) && /why-text/.test(html));
check('запасная модель тоже выбирается', /\['fallbackModel', 'fallbackKey'/.test(html));
check('видно, каким ключом ходит модель', /\/api\/ai\/keys/.test(html) && /Ключ #/.test(html));

// 34. Статистика: период, график, разбивки.
check('период статистики переключается', /statsRange/.test(html) && /days=\$\{statsDays\}/.test(html));
check('есть график объёма', /function barChart/.test(html));
check('медиана рядом со средним', /medianFirstResponseMs/.test(html));

// 35. Переключение диалога не должно ждать сеть: шапка рисуется из уже
// загруженного списка, остальное догружается фоном.
check('шапка рисуется до ответа сервера', /function paintHeader/.test(html));
check('на время загрузки показывается заглушка', /function skeleton/.test(html) && /bubble\.skel/.test(html));
check('отметка о прочтении не блокирует отрисовку',
  /markOpenConversationRead\(id\)/.test(html) && /readTimer = setTimeout/.test(html));
check('быстрое переключение не путает диалоги', /ticket !== openToken/.test(html));
check('подписка грузится по раскрытию раздела', /if \(!wrap\.open\)/.test(html));
check('новые диалоги сразу сливаются из WebSocket в список', /mergeLiveConversation\(frame\.conversation\)/.test(html));
check('пропущенные WS-сообщения догружаются в открытый диалог',
  /function syncCurrentMessages/.test(html) && /last_message_at/.test(html)
  && /void syncCurrentMessages\(openId\)/.test(html));
check('live-сообщения не дублируются', /data-message-id/.test(html)
  && /inner\.querySelector\(`\.msg\[data-message-id=/.test(html));
check('видео-стикеры показываются зацикленным WebM-видео',
  /a\.media_type === 'video_sticker'/.test(html) && /video\.playsInline = true/.test(html));
check('TGS загружается локальным Lottie-рендерером',
  /function renderTgsSticker/.test(html) && /\/vendor\/lottie\.min\.js/.test(html)
  && /a\.media_type === 'tgs_sticker'/.test(html));
check('билеты обновляют уже созданные lazy-media URL',
  /function refreshMediaTicketUrls/.test(html) && /data-attachment-id/.test(html)
  && /attachmentUrl\(a\.id\)/.test(html));
check('редактирование и удаление сообщений обрабатываются live',
  /frame\.type === 'message_updated'/.test(html) && /frame\.type === 'message_deleted'/.test(html));
check('новое входящее в открытом диалоге сразу отмечается прочитанным',
  /markOpenConversationRead\(frame\.conversation\.id\)/.test(html));
check('список имеет резервный опрос не реже пяти секунд',
  /setInterval\(\(\) => \{ if \(document\.visibilityState === 'visible'\) void refresh\(\); \}, 5000\)/.test(html));
check('ошибка аватара повторяется, а не удаляет картинку навсегда',
  /function armAvatars/.test(html) && !/onerror="this\.remove\(\)"/.test(html));

// 36. Анимации только на transform и opacity: всё остальное заставляет
// браузер пересчитывать раскладку, и на высокой частоте это заметно.
{
  const css = html.slice(0, html.indexOf('</style>'));
  const frames = [...css.matchAll(/@keyframes\s+[\w-]+\s*\{([^@]*?)\}\s*(?=@|\.|#|\/\*|$)/g)]
    .map((m) => m[1]!);
  const bad = frames.filter((body) =>
    /(?:^|[;{\s])(width|height|top|left|right|bottom|margin|padding)\s*:/.test(body));
  check('покадровая анимация не трогает раскладку', bad.length === 0, bad.length);
  check('выделение строки анимируется трансформацией',
    /\.row\[aria-selected="true"\]::before\s*\{\s*transform:scaleY\(1\)/.test(css));
}

// 37. Место под вложение резервируется заранее: иначе каждая догрузившаяся
// картинка меняет высоту и толкает переписку — это и выглядит как дёрганье.
{
  check('под картинку отводится место по пропорциям',
    /box\.style\.aspectRatio/.test(html) && /a\.width && a\.height/.test(html));
  check('переписка не спорит с автоподкруткой', /overflow-anchor:none/.test(html));
  check('пузыри не анимируются по одному при открытии', !/animationDelay/.test(html));
}

// 38. Карточка Bedolaga: сервер определяет право изменения, а UI защищён
// от повторного клика и честно показывает недоступные разделы.
check('продление Bedolaga показывается по серверному capability',
  html.includes('bedolagaCapabilities.canExtendSubscription ? `<div class="bed-extend"')
    && !html.includes('canAdmin() ? `<div class="bed-extend"'));
check('двойное продление Bedolaga блокируется в UI',
  /bedolagaExtensionPending\.has\(subscriptionId\)/u.test(html)
    && /bedolagaExtensionPending\.add\(subscriptionId\)/u.test(html)
    && /crypto\.randomUUID\(\)/u.test(html)
    && /bedolagaExtensionUncertain\.add\(subscriptionId\)/u.test(html));
check('недоступные подарки объясняются честно',
  /card\.gifts\?\.available === false/u.test(html)
    && /card\.gifts\.reason/u.test(html));
check('активность Bedolaga показывает связанные тикеты',
  html.includes("'Тикет','Сумма','Дата'")
    && /ticketId/u.test(html));
check('карточка Bedolaga оформлена активным stylesheet, а не отключённым legacy-ui',
  /\.sheet\.wide\s*\{[^}]*width:min\(\d+px,100%\)/.test(uiCss)
    && uiCss.includes('.bed-tabs button[aria-pressed="true"]')
    && /\.bed-sub\s*\{[^}]*display:grid;/.test(uiCss));

// Запрос карточки A может завершиться после того, как оператор уже открыл
// карточку B. Результат A нельзя записывать в общие state/DOM: нужен либо
// conversation guard, либо отдельный монотонный request token.
{
  const start = html.indexOf('async function openBedolagaCard');
  const end = html.indexOf('\nfunction renderCollaboration', start);
  const body = html.slice(start, end);
  const guardedByConversation = /bedolagaCardConversation\s*!==\s*conversationId/u.test(body);
  const tokenDeclaration = body.match(/(?:const|let)\s+([A-Za-z_$][\w$]*(?:token|ticket|request)[\w$]*)\s*=\s*\+\+([A-Za-z_$][\w$]*)/iu);
  const guardedByToken = Boolean(tokenDeclaration
    && new RegExp(`${tokenDeclaration[1]}\\s*!==\\s*${tokenDeclaration[2]}`, 'u').test(body));
  check('запоздалый ответ карточки Bedolaga не перезаписывает новый диалог',
    start >= 0 && end > start && (guardedByConversation || guardedByToken), {
      guardedByConversation,
      guardedByToken,
    });
}

console.log(failures === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
