# Musaic — бэклог улучшений (аудит 2026-09-23)

> Актуальный список задач после полного аудита кода. Старый план (фазы A–D от
> 2026-08-24) устарел: значительная часть уже реализована в рабочем дереве
> (ReplayGain-нормализация, forced-alignment тексты, Keychain-токены, eviction
> кэша и т.д.). Безопасность исключена из рассмотрения по запросу владельца.
> Каждая задача — отдельный коммит; проверки перед каждым коммитом.

## Правила работы

- Сервер: Bun + Hono 4 + `bun:sqlite`. Миграции — только новыми версиями
  (следующая **v26+**) в `server/src/db/migrations.ts`, рекомендательные — v40+ в `migrations-reco.ts`.
- Клиент: SwiftUI (iOS 17+/macOS 15+/watchOS 9), проект генерируется XcodeGen
  из `MusaicApp/project.yml` — новые файлы в `Models/ Services/ Stores/ Views/
  Widgets/ WatchApp/` подхватываются автоматически после `xcodegen generate`.
- Проверки: `cd server && bun run typecheck && bun test src/__tests__` +
  `bun run lint`; клиент — `xcodegen generate` + `xcodebuild -scheme Musaic`.
  ⚠️ CI собирает на Xcode 26.6 — iOS-27 API только под `#if compiler(>=6.3)` /
  `if #available(iOS 27, macOS 27, *)`.
- API-контракт: не ломать эндпоинты без синхронного обновления
  `MusaicApp/Services/APIService.swift` в той же ветке.
- Палитра — золотая (`#e6d8c3`/`#cdb69a`/`#090807`, токены в конце
  `MusaicApp/MusaicApp.swift`). Розовый `#e91e8c` не возвращать.

## Сделано в этой итерации (2026-09-23) — не переделывать

- Word-level тайминги в `lyrics-aligner.ts`, колонка `lyrics_cache.words`
  (миграция v23), `words` + `offsetSec` в `GET /api/lyrics/:id`.
- Караоке-подсветка слов в `LyricsLineView` / `LyricsSection`; удалён хардкод
  `globalLyricsOffset` — смещение теперь серверное.
- Live Activity + Dynamic Island (`Widgets/NowPlayingLiveActivity.swift`,
  `NowPlayingActivityController`), `NSSupportsLiveActivities`.
- Интерактивные кнопки виджета + Live Activity через App Group mailbox
  (`MusaicPlaybackIntent` → `PlayerStore.processPendingWidgetCommands`).
- `TrackRow`: убрана кнопка в кнопке (тапы стабильны), stagger-вход один раз
  на строку, свайп-действия (лайк / в плейлист / в очередь) кастомным жестом.
- Тесты lyrics обновлены под новую форму ответа.

## Сделано 2026-09-25 (PR #1) — не переделывать

- Durable-очередь `background_tasks` (v24, `server/src/jobs/tasks.ts`): воркер
  стартует с сервером, при остановке возвращает прерванные задачи в очередь.
  На ней AI-генерация текстов и `prefetch-all` (закрывает B1 для текстов;
  downloads/import ещё на месте).
- SSE `GET /api/lyrics/:id/events` вместо polling (B3 для текстов; стриминг
  ответа чата — ещё нет).
- Пер-трековая пользовательская юстировка смещения `PUT /api/lyrics/:id/offset`
  (v25, `userOffsetSec` в ответе) — закрывает I4 (кроме таймингов raw-whisper).
- Auth deny-by-default: публичны только login/register, обложки и VK OAuth
  callback; `/audio/*` — всегда с сессией.
- Полная en/ru локализация с русскими плюралами — закрывает I7.
- Swift Testing таргет `MusaicTests` (macOS), job «Swift Unit Tests» в CI.

---

## Backend (server/)

### B1. Долговременные очереди вместо in-memory Map
`lyricAlignQueue` (routes/lyrics.ts), download/eviction-очереди
(routes/local/downloads.ts), `importJobs` (routes/import.ts), буферы
скробблинга (index.ts) теряются при рестарте. Свести к существующей durable
очереди `jobs` (lease + ретраи уже есть). Скробблы — в отдельную таблицу с
донакопом.
**Критерий:** kill -9 во время импорта/генерации — задача доезжает после старта.

### B2. Rollup статистики
`routes/stats.ts` сканирует `play_events` целиком на каждый запрос. Дневная
агрегат-таблица + инкрементальная запись при logPlay.
**Критерий:** время ответа `/api/stats/*` не растёт с историей.

### B3. SSE вместо polling
Генерация текстов опрашивается каждые 2 с (до 60 раз). `GET
/api/lyrics/:id/events` (SSE) + стриминг ответа `reco/chat.ts`.
**Критерий:** 1 запрос вместо ~60; чат печитает токены по мере генерации.

### B4. Пагинация и N+1
`local.ts`, `local/playlists.ts` отдают полные массивы — cursor-пагинация как
в feed. `track-identity.saveMatch` — батчинг. Кэш профиля (`reco/profile.ts`)
с инвалидацией по watermark последнего play event.
**Критерий:** библиотека 20k треков грузится страницами; импорт 500
плейлистов не делает тысячи запросов.

### B5. Гигиена логирования
~100 пустых `catch {}` по коду — минимум `log.warn` с контекстом (logger уже
структурированный), особенно в provider-путях (vk/yandex/soundcloud).

---

## iOS / macOS (MusaicApp/)

### I1. `@Observable` миграция сторов
`ObservableObject` + `@Published` перерисовывают целые экраны на каждый тик
позиции. Макрос `@Observable` + `@State` → per-property observation.
**Критерий:** Instruments — нет лишних body-вызовов во время скраба.

### I2. Dynamic Type
~267 фиксированных `.system(size:)` не масштабируются. Семантические стили /
`.system(size:, relativeTo:)`; закрепить максимум для мини-плеера.

### I3. Фоновые загрузки
`DownloadManager` на обычном `URLSession` — умирает в фоне.
`URLSessionConfiguration.background` + обработка делегата после перезапуска.

### I4. Караоке-полировка
Пер-трековая юстировка смещения (пользовательская подстройка ±, хранить на
сервере рядом со словами); тайминги из raw-whisper пути (`source: ai`).

### I5. iPod-колесо: режимы
Цикл режимов по MENU (volume/shuffle/repeat), как в оригинале; сейчас колесо
только скрабит.

### I6. Watch: crown-scrubbing + текст на часах.

### I7. Локализация остатков
Хардкод-английские строки (`LyricsSheet`, `ImportTrackRow`, виджет) — в
`Localizable.xcstrings`; кириллические хардкоды в `HomeView` тоже.

---

## iOS 27 (WWDC26) — под гейтом `#if compiler(>=6.3)`

### W1. Нативные свайп-действия
`swipeActionsContainer()` на ScrollView + `swipeActions(onPresentationChanged:)`
на строках — замена кастомного жеста из `TrackRow` (сейчас он работает везде и
на iOS 17 — это осознанный компромисс под Xcode 26.6 в CI).

### W2. Декларативный reorder
`reorderContainer` + `reorderable()` для очереди и плейлистов (и watchOS 27);
`dragContainer` для длинных списков.

### W3. Презентации и тулы
`alert(_:item:)` / `alert(error:)` вместо булевых флагов; `toolbarMinimizeBehavior`,
`visibilityPriority`, `ToolbarOverflowMenu`, `topBarPinnedTrailing` в
детальных экранах.

### W4. Внешность
Interactive Liquid Glass вместо ручного `GlassModifier`; `TabRole.prominent`
для таба плеера; `NavigationTransition.crossFade`; resizable iPhone apps.

### W5. Идеи
Document API — экспорт плейлистов (M3U/JSON) через `fileExporter`; App Intents
фразы для Siri («запусти мою волну») поверх `MusaicPlaybackIntent`.

---

## Чек-лист перед сдачей

- [ ] `bun run typecheck && bun test src/__tests__ && bun run lint` — зелёные
- [ ] `xcodegen generate && xcodebuild` (Musaic + MusaicMac) — без ошибок
- [ ] Миграции только добавлены (v24+), применённые не тронуты
- [ ] API-контракт и клиент обновлены синхронно
- [ ] Новые анимации уважают Reduce Motion; кнопки имеют accessibility labels
