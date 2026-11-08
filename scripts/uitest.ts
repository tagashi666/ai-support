/**
 * Проверки разметки панели.
 *
 * Ловят ровно тот класс ошибок, из-за которого панель уехала: грид с лишними
 * детьми, скрытие, перебитое классом, ссылки на несуществующие id. Браузера
 * здесь нет, поэтому проверяем инварианты структуры, а не пиксели.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const pageSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
// Скрипт панели — нативные ES-модули: public/app.js и public/js/*.js. Для
// проверок подставляем их тексты на место тега точки входа в порядке
// исполнения браузером (сначала зависимости, затем модуль), чтобы проверки
// по-прежнему видели «разметку + скрипт + стили» одним текстом.
const readPublic = (path: string): string => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const moduleOrder: string[] = [];
const visiting = new Set<string>();
const visitModule = (path: string): void => {
  if (moduleOrder.includes(path) || visiting.has(path)) return;
  visiting.add(path);
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const deps = [...readPublic(path).matchAll(/\b(?:from|import)\s*['"]\.\/([^'"\n]+?\.js)['"]/g)].map((m) => dir + m[1]!);
  for (const dep of deps) visitModule(dep);
  moduleOrder.push(path);
};
visitModule('app.js');
const scriptTags = [...pageSource.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
const panelJs = moduleOrder.map(readPublic).join('\n');
const pageHtml = pageSource.replace(/<script type="module" src="\/app\.js"><\/script>/, () => `<script type="module">\n${panelJs}\n</script>`);
// Проверки компонентов должны читать реально подключённые stylesheets. Иначе
// неактивный файл может сохранять старое правило и маскировать регрессию UI.
const activeStylesheets = [...pageHtml.matchAll(/<link\b[^>]*>/g)]
  .map(([tag]) => ({ rel:tag.match(/\brel="([^"]+)"/)?.[1], href:tag.match(/\bhref="\/([^"]+)"/)?.[1] }))
  .filter((link): link is { rel:string; href:string } => link.rel === 'stylesheet' && Boolean(link.href));
const uiCss = activeStylesheets
  .map(({ href }) => readFileSync(new URL(`../public/${href}`, import.meta.url), 'utf8'))
  .join('\n');
// Неактивный legacy-блок CSS из index.html удалён: проверки оформления
// читают разметку вместе с реально подключённым stylesheet.
const html = `${pageHtml}\n${uiCss}`;

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
const markup = pageHtml.slice(0, pageHtml.indexOf('<script type="module">'));
const ids = [...markup.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]!);
const dupes = ids.filter((id, index) => ids.indexOf(id) !== index);
check('дубликатов id нет', dupes.length === 0, dupes);

// 7. Каждая прокручиваемая область ограничена по высоте, иначе страница едет.
check('у списка и треда есть min-height:0',
  /\.scroll-y\s*\{[^}]*min-height:\s*0/.test(html) && /\.thread\s*\{[^}]*min-height:\s*0/.test(html));

// 8. Экраны переключаются по атрибуту, а не удалением из DOM.
check('переключение экранов через hidden', /\$\(`view-\$\{v\}`\)\.hidden = v !== view/.test(html));
check('вкладки используют единый асинхронный lifecycle без пустого кадра',
  /const VIEW_LOADERS = Object\.freeze/.test(html)
  && /prepareViewLoading\(view, token\)/.test(html)
  && /await Promise\.all\(\[runViewLoader\(view\), minimumPaint\]\)/.test(html)
  && /finishViewLoading\(target, token\)/.test(html));
check('переключение workspace использует View Transition с CSS fallback',
  /document\.startViewTransition\(activate\)/.test(html)
  && /::view-transition-new\(workspace\)/.test(uiCss)
  && /:root\s*\{[^}]*view-transition-name:none/s.test(uiCss)
  && /\.supports-view-transitions \.view:not\(\[hidden\]\)/.test(uiCss)
  && /\.view:not\(\[hidden\]\)\s*\{[^}]*animation:view-fallback-in/s.test(uiCss));
check('повторная загрузка сохраняет контент и показывает тонкий progress',
  /section\.dataset\.loaded === 'true'/.test(html)
  && /const viewLoadTasks = new Map\(\)/.test(html)
  && /\.view\.is-refreshing \.view-progress\s*\{[^}]*animation:view-progress/s.test(uiCss)
  && /\.view\.is-refreshing \.view-skeleton\s*\{\s*display:none/.test(uiCss)
  && /\.view\[data-loaded="true"\]:not\(\.is-settling\) \.view-skeleton/.test(uiCss)
  && /view-stats'\)\.dataset\.loaded !== 'true'/.test(html));
check('локальные вкладки меняют содержимое без резкого скачка',
  /function animateContentChange\(element\)/.test(html)
  && /animateContentChange\(\$\('docs'\)\)/.test(html)
  && /animateContentChange\(\$\(`\$\{tab\}Body`\)\)/.test(html)
  && /@keyframes content-switch-in/.test(uiCss));

// 9. Правая колонка прячется вне инбокса.
check('контекстная колонка скрывается вне инбокса',
  /\.app\[data-context="off"\]\s+\.context\s*\{\s*display:\s*none/.test(html));

// 10. Каждый теговый блок закрыт.
for (const tag of ['div', 'section', 'aside', 'main', 'button', 'select', 'textarea']) {
  const open = [...html.matchAll(new RegExp(`<${tag}[\\s>]`, 'g'))].length;
  const close = [...html.matchAll(new RegExp(`</${tag}>`, 'g'))].length;
  check(`теги <${tag}> сбалансированы`, open === close, `${open} открыто, ${close} закрыто`);
}

// 11–12. Проверки тем, акцентов, весов шрифта и радиусов относились к
// удалённому legacy-оформлению; токены ui-v3 устроены иначе.

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
check('разделы настроек используют всю ширину без пустой левой колонки',
  /\.settings-content-column\s*\{[^}]*width:100%/s.test(uiCss)
  && /\.settings-section\s*\{[^}]*display:block/s.test(uiCss)
  && /\.section-copy\s*\{[^}]*margin:0 auto 20px[^}]*text-align:center/s.test(uiCss)
  && /\.settings-section > :not\(\.section-copy\)\s*\{[^}]*width:100%/s.test(uiCss));
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
check('можно ответить на конкретное сообщение', /function setQuote\(/.test(html) && /payload\.replyTo = target\.quoting\.id/.test(html));

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
check('ответ виден без наведения', /\.msg \.act\s*\{[^}]*opacity:\s*\.65/.test(html));
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
check('мастер поддерживает бота, Business, Remnawave и MiniShop', /value="telegram_bot"/.test(html)
  && /value="telegram_business"/.test(html) && /value="remnawave"/.test(html)
  && /value="minishop"/.test(html) && /id="sourceMode"/.test(html));
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
  check('список перерисовывается только при изменении', /listSignature/.test(html));
  check('анимируются только новые сообщения', /\.msg\.fresh/.test(html) && /classList\.add\('fresh'\)/.test(html));
}

// 31. Колонки двигаются мышью и запоминают ширину.
check('ширина запоминается', /localStorage\.setItem\(`layout:/.test(html));

// 32. Правая колонка складывается, сводка занимает пустое место в навигации.
check('разделы карточки сворачиваются', (html.match(/class="fold"/g) ?? []).length >= 4);
check('состояние разделов запоминается', /localStorage\.setItem\(key, fold\.open/.test(html));
check('в навигации есть живая сводка', /renderBoard/.test(html) && /pulseBoard/.test(html));
check('счётчики SLA и базы знаний загружаются до первого открытия экранов',
  /async function loadNavigationCounts\(\)/.test(html)
  && /await loadNavigationCounts\(\)/.test(html)
  && /\$\('cntOverdue'\)\.textContent = String\(overdue\)/.test(html)
  && /\$\('cntKb'\)\.textContent = String\(\(knowledge\.kb \?\? \[\]\)\.length\)/.test(html)
  && /id="cntOverdue">0<\/span>/.test(html));
check('очередь полноширинная, а сроки обслуживания вынесены в toolbar',
  /id="slaPoliciesBtn">Сроки обслуживания<\/button>/.test(html)
  && /\.queue-workspace\s*\{[^}]*display:block/s.test(uiCss)
  && !/class="queue-sidebar"/.test(html)
  && !/id="saveFilterBtn"/.test(html));
check('массовое закрытие тикетов требует подтверждения и использует штатный state API',
  /id="closeAllTickets">Закрыть все тикеты<\/button>/.test(html)
  && /confirmAction\('Закрыть все тикеты\?'/u.test(html)
  && /api\(`\/api\/conversations\/\$\{row\.id\}\/state`, \{ method:'POST', body:JSON\.stringify\(\{ status:'resolved' \}\) \}\)/.test(html));

// 33. Описания свёрнуты, обе модели выбираются, ключ виден.
check('описание раскрывается кнопкой', /class="why"/.test(html) && /why-text/.test(html));
check('запасная модель тоже выбирается', /\['fallbackModel', 'fallbackKey'/.test(html));
check('видно, каким ключом ходит модель', /\/api\/ai\/keys/.test(html) && /Ключ #/.test(html));

// 34. Статистика: период, график, разбивки.
check('период статистики переключается', /statsRange/.test(html) && /days=\$\{statsDays\}/.test(html));
check('меню оператора вынесено из обрезающей таблицы',
  /document\.body\.append\(menu\)/.test(html)
  && /className = 'operator-popover'/.test(html)
  && /\.operator-popover\s*\{[^}]*position:fixed[^}]*z-index:80/s.test(uiCss));
check('у команды есть статистика операторов',
  /data-team-tab="performance"/.test(html)
  && /\/api\/operator-stats\?days=\$\{operatorStatsDays\}/.test(html)
  && /Средний ответ/.test(html) && /Медиана/.test(html));
check('матрица ролей управляет каждым permission',
  /data-team-tab="roles"/.test(html)
  && /data-permission="\$\{esc\(item\.id\)\}"/.test(html)
  && /\/api\/roles\/\$\{selectedRole\}/.test(html)
  && /setting:\$\{el\.dataset\.key\}/.test(html));
check('есть график объёма', /function barChart/.test(html));
check('медиана рядом со средним', /medianFirstResponseMs/.test(html));

// 35. Переключение диалога не должно ждать сеть: шапка рисуется из уже
// загруженного списка, остальное догружается фоном.
check('шапка рисуется до ответа сервера', /function paintHeader/.test(html));
check('на время загрузки показывается заглушка', /function skeleton/.test(html) && /bubble\.skel/.test(html));
check('отметка о прочтении не блокирует отрисовку',
  /markOpenConversationRead\(id\)/.test(html) && /readTimer = setTimeout/.test(html));
check('быстрое переключение не путает диалоги', /openTicket !== openToken/.test(html));
check('подписка грузится по раскрытию раздела', /if \(!wrap\.open\)/.test(html));
check('новые диалоги сразу сливаются из WebSocket в список', /mergeLiveConversation\(frame\.conversation\)/.test(html));
check('пропущенные WS-сообщения догружаются в открытый диалог',
  /function syncCurrentMessages/.test(html) && /last_message_at/.test(html)
  && /void syncCurrentMessages\(openId[,)]/.test(html));
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
check('резервный опрос списка работает только без живого WebSocket',
  /setInterval\(\(\) => \{ if \(document\.visibilityState === 'visible' && !liveOpen\(\)\) void refresh\(\); \}, 5000\)/.test(html)
  && !/setInterval\(\(\) => \{ if \(document\.visibilityState === 'visible'\) void refresh\(\); \}, 5000\)/.test(html));
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
  const end = html.slice(start).search(/\n(?:export )?function renderCollaboration/) + start;
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

check('интерфейсную базу Бедолаги можно посмотреть в панели',
  /data-tab="interface"/.test(html) && /Интерфейс Бедолаги/.test(html) && /docs\.interfaceScreens/.test(html));
check('в справочнике интерфейса есть переключатель вида Full/Lite и бейдж вида магазина',
  /data-iface-mode="\$\{mode\}"/.test(html) && /full:'Полный вид', lite:'Простой вид'/.test(html)
  && /У магазина сейчас:/.test(html) && /\/api\/interface-kb/.test(html));
check('редактор экрана: поля, область правки, стандартное значение, картинка и сброс',
  ['title','routeDescription','keywords','instructions','caption'].every((field) => new RegExp(`'${field}'`).test(html))
  && /К чему применить правку/.test(html) && /<option value="all">Оба вида<\/option>/.test(html)
  && /Стандартно:/.test(html) && /data-restore=/.test(html) && /image\/png,image\/jpeg,image\/webp/.test(html)
  && /Сбросить к стандартному/.test(html) && /Скрыть экран/.test(html) && /Добавить свой экран/.test(html)
  && /\/api\/interface-kb\/overrides/.test(html) && /method:'PUT'/.test(html));
check('справочник интерфейса не вешает inline-обработчики и стили в разметке',
  (() => {
    const start = html.indexOf('/* ═══ справочник интерфейса Бедолаги ═══ */');
    const block = html.slice(start, html.indexOf('function mineStarted()', start));
    return start > 0 && !/\son[a-z]+="/.test(block) && !/style="/.test(block);
  })());
check('в настройках есть выбор вида кабинета рядом с тумблером справочника',
  /key:'bedolagaInterfaceMode'[^}]*options:\[\['auto','Авто — как у магазина'\],\['full','Полный вид'\],\['lite','Простой вид'\]\]/.test(html)
  && /'bedolagaInterfaceKb','bedolagaInterfaceMode'/.test(html));
check('стили справочника интерфейса лежат в ui-v3.css',
  /\.iface-bar\b/.test(uiCss) && /\.iface-default\b/.test(uiCss) && /\.iface-tag\b/.test(uiCss));
check('AI-студия отмечает использованные интерфейсные источники',
  /body\.usedSources\?\.includes\(x\)/.test(html));
check('старый Telegram-диалог можно скрыть без удаления истории',
  /id="hideConversationBtn"/.test(html) && /JSON\.stringify\(\{ hidden:true \}\)/.test(html));

console.log('\n[ производительность панели ]');
check('подключён только ui-v3.css, старых стилей нет',
  activeStylesheets.length === 1 && activeStylesheets[0]?.href === 'ui-v3.css'
  && !/ui(?:-v2)?\.css/.test(html.replace(/ui-v3\.css/g, ''))
  && !existsSync(new URL('../public/ui.css', import.meta.url))
  && !existsSync(new URL('../public/ui-v2.css', import.meta.url)), activeStylesheets);
check('URL вложений и аватарок без токена — их авторизует cookie-билет',
  /const attachmentUrl = \(id, suffix = ''\) => `\/api\/attachments\/\$\{id\}\$\{suffix\}`;/.test(html)
  && /avatar\?v=\$\{encodeURIComponent\(c\.avatar_version/.test(html)
  && !/avatar\?token=/.test(html) && !/&retry=\$\{Date\.now\(\)\}/.test(html));
check('недокачанное вложение показывается скелетоном и ждёт по 202',
  /box\.classList\.add\('media-pending'\)/.test(html) && /status === 202/.test(html)
  && /method:'HEAD'/.test(html) && /\.bubble \.shot\.media-pending::after/.test(uiCss));
check('WebSocket открывается сразу после билета, до загрузки списка', (() => {
  const boot = html.slice(html.indexOf('async function boot()'), html.indexOf('let savedTokenCheck'));
  const connectAt = boot.indexOf('connect();');
  return connectAt > boot.indexOf('await refreshTicket()') && connectAt < boot.indexOf('await loadInboxMeta()');
})());
check('ротация билета открывает новый сокет до закрытия старого',
  /async function rotateTicket\(\)/.test(html) && /if \(liveOpen\(\)\) connect\(\)/.test(html)
  && /previous\.close\(1000/.test(html) && /refresh\(\{ fullThread:true \}\)/.test(html));
check('кадр WS с карточкой не перезапрашивает весь список',
  /if \(!frame\.conversation\) refreshSoon\(\);/.test(html));
check('фоновая синхронизация переписки берёт только новые сообщения',
  /\?after=\$\{lastId\}/.test(html));
check('загруженные аватарки не пересоздаются при перерисовке списка',
  /loadedAvatars\.get\(/.test(html) && /freshAvatar\.replaceWith\(keptAvatar\)/.test(html));

console.log('\n[ скрипты и CSP ]');
// CSP разрешает только script-src 'self': встроенный код и обработчики в
// атрибутах браузер молча заблокирует.
check('в index.html нет встроенных скриптов, подключена только точка входа app.js',
  scriptTags.length === 1 && scriptTags[0]![2]!.trim() === ''
  && /^\s*type="module"\s+src="\/app\.js"\s*$/.test(scriptTags[0]![1]!), scriptTags.map((m) => m[1]));
check('в разметке нет inline-обработчиков и javascript:-ссылок',
  !/\son[a-z]+\s*=/i.test(pageSource.replace(/<!--[\s\S]*?-->/g, '')) && !/javascript:/i.test(pageSource));
{
  const jsDir = new URL('../public/js/', import.meta.url);
  const onDisk = existsSync(jsDir) ? readdirSync(jsDir).filter((name) => name.endsWith('.js')).map((name) => `js/${name}`) : [];
  const orphans = onDisk.filter((path) => !moduleOrder.includes(path));
  check('каждый модуль public/js подключён из app.js', orphans.length === 0, orphans);
}
// Порядок исполнения модулей задаёт цепочка: первый import каждого модуля —
// предыдущий раздел. Тогда обход от app.js исполняет разделы в исходном порядке.
{
  const firstImport = (path: string): string | undefined => {
    const spec = readPublic(path).match(/^import\s+(?:[^'"]*?\sfrom\s+)?['"]\.\/([^'"]+)['"]/m)?.[1];
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    return spec === undefined ? undefined : dir + spec;
  };
  const broken = moduleOrder.slice(1).filter((path, index) => firstImport(path) !== moduleOrder[index]);
  check('модули исполняются цепочкой: первый import — предыдущий раздел', moduleOrder[0] === 'js/state.js'
    && !/^import\b/m.test(readPublic('js/state.js')) && broken.length === 0, broken);
}
// Браузера здесь нет, поэтому ошибки, которые иначе всплыли бы только в
// рантайме, ловит компилятор TypeScript: синтаксис, неизвестные имена (забытый
// import), несуществующий экспорт и присваивание импортированной переменной.
{
  const files = moduleOrder.map((path) => fileURLToPath(new URL(`../public/${path}`, import.meta.url)));
  const program = ts.createProgram(files, {
    allowJs:true, checkJs:true, noEmit:true, skipLibCheck:true, types:[],
    target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.ESNext, moduleResolution:ts.ModuleResolutionKind.Bundler,
    lib:['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  });
  // 2304/2552 — неизвестное имя, 2305/2614/2724 — нет такого экспорта, 2307 — нет модуля,
  // 2632 — присваивание импорту, 2300/2440/2451 — повторное объявление.
  const fatal = new Set([2300, 2304, 2305, 2307, 2440, 2451, 2552, 2614, 2632, 2724]);
  const problems = files.flatMap((file) => {
    const source = program.getSourceFile(file)!;
    return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source).filter((d) => fatal.has(d.code))]
      .map((d) => `${file.slice(file.lastIndexOf('/public/') + 8)}:${source.getLineAndCharacterOfPosition(d.start ?? 0).line + 1} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  });
  check('модули панели: синтаксис, импорты и имена сходятся, импортам не присваивают', problems.length === 0, problems.slice(0, 20));
}
console.log('\n[ живое состояние панели ]');
{
  // Чистые правила (public/js/rules.js) исполняются в node; state.js при
  // импорте читает localStorage — подставляем пустой.
  (globalThis as any).localStorage ??= { getItem: () => null };
  const rules = await import(new URL('../public/js/rules.js', import.meta.url).href) as any;
  const pending = { id: 7, status: 'pending' };
  const conversation = { id: 1, status: 'open' };
  const after = (frame: any) => rules.suggestionAfterFrame(pending, { conversation, ...frame });
  check('предложку снимает новый вопрос клиента', after({ type:'message', message:{ direction:'in', author:'client' } }) === null);
  check('предложку снимает ответ человека, в том числе из Telegram мимо панели',
    after({ type:'message', message:{ direction:'out', author:'agent', suggestion_id:null } }) === null);
  check('предложку снимает отправка этого же черновика AI',
    after({ type:'message', message:{ direction:'out', author:'ai', suggestion_id:7 } }) === null);
  check('сообщение AI о передаче человеку предложку не снимает',
    after({ type:'message', message:{ direction:'out', author:'ai', suggestion_id:null } }) === pending);
  check('заметка и импорт истории предложку не снимают',
    after({ type:'message', message:{ direction:'note', author:'agent' } }) === pending
    && after({ type:'message', message:{ direction:'in', author:'client', is_backfill:1 } }) === pending);
  check('решение по предложке в другой вкладке её снимает',
    after({ type:'suggestion', suggestion:{ id:7, status:'rejected' } }) === null
    && after({ type:'suggestion', suggestion:{ id:6, status:'superseded' } }) === pending);
  check('новая предложка заменяет прежнюю', after({ type:'suggestion', suggestion:{ id:8, status:'pending' } })?.id === 8);
  check('закрытие диалога снимает предложку',
    rules.suggestionAfterFrame(pending, { type:'conversation', conversation:{ id:1, status:'resolved' } }) === null
    && after({ type:'conversation' }) === pending);
  check('закрытый без ответа диалог не висит в «Ждут» и «Без ответа»',
    !rules.awaitingReply({ unread:0, first_response_at:null, status:'resolved' })
    && !rules.unanswered({ first_response_at:null, last_inbound_at:1, status:'resolved' })
    && rules.awaitingReply({ unread:0, first_response_at:null, status:'open' })
    && rules.awaitingReply({ unread:2, first_response_at:5, status:'resolved' })
    && rules.unanswered({ first_response_at:null, last_inbound_at:1, status:'open' }));
  check('скрытый диалог живой кадр в список не возвращает', !rules.listable({ hidden_at:5 }) && rules.listable({ hidden_at:null }));

  const body = (path: string, start: string): string => {
    const source = readPublic(path);
    const from = source.indexOf(start);
    const next = source.indexOf('\nexport ', from + start.length);
    return from < 0 ? '' : source.slice(from, next < 0 ? undefined : next);
  };
  const merge = body('js/conversation.js', 'export function mergeLiveConversation');
  check('живой кадр открытого диалога перерисовывает шапку, окно и режим AI',
    /paintHeader\(state\.current, \{ keepError:true \}\)/.test(merge) && /renderWindow\(\)/.test(merge)
    && /renderAiNote\(\)/.test(merge) && /listable\(conversation\)/.test(merge));
  check('живой кадр подбирает предложку по правилам', /suggestionAfterFrame\(state\.suggestion, frame\)/.test(readPublic('js/live.js'))
    && !/frame\.type === 'suggestion' && state\.current/.test(readPublic('js/live.js')));
  check('удаление процитированного сообщения снимает цитату',
    /state\.quoting\.id === frame\.message\.external_msg_id\) clearQuote\(\)/.test(readPublic('js/live.js')));
  const openBody = body('js/conversation.js', 'export async function open');
  check('переключение диалога меняет черновик и сбрасывает цитату до загрузки',
    openBody.indexOf('swapDraft(state.current?.id, id)') > 0
    && openBody.indexOf('state.quoting = null; renderQuoting();') < openBody.indexOf('const known'));
  const windowBody = body('js/inbox-list.js', 'export function renderWindow');
  check('закрытое окно 24 ч блокирует ответ, но не заметку',
    /\$\('send'\)\.disabled = windowState === 'closed';/.test(windowBody)
    && /\$\('input'\)\.disabled = windowState === 'closed' && !canPermission\('conversation:notes'\)/.test(windowBody));
  const composer = readPublic('js/composer.js');
  check('пачка файлов и ответ уходят в диалог, где нажали «Отправить»',
    !/state\.current\.id\}\/(?:attachments|reply)/.test(composer) && /\/api\/conversations\/\$\{target\.id\}\/attachments/.test(composer)
    && /\/api\/conversations\/\$\{target\.id\}\/reply/.test(composer));
  check('смена режима AI в настройках обновляет подпись в диалоге',
    /state\.settings\.runtime = saved\.runtime;[\s\S]{0,120}renderAiNote\(\)/.test(readPublic('js/settings.js')));
  check('обновлённая карточка клиента не ложится в другой диалог',
    /customer\/refresh`[\s\S]{0,200}if \(state\.current\?\.id !== id\) return;/.test(readPublic('js/inspector.js')));
}

const serverSource = readFileSync(new URL('../src/panel/server.ts', import.meta.url), 'utf8');
check('CSP: script-src только self, без unsafe-inline и хэшей',
  /script-src 'self';/.test(serverSource) && !/script-src[^;]*(?:unsafe-inline|unsafe-eval|sha256-)/.test(serverSource));

console.log(failures === 0 ? '\nВсе проверки прошли' : `\nПровалено: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
