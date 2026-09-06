# Musaic — задачи для ИИ-исполнителя (актуализация от 2026-08-24)

Назначение: исполнимый план улучшений Musaic после повторного аудита **рабочего дерева** (предыдущий пакет задач писался под коммит `9a6d510` и частично устарел). Все ссылки на файлы/строки проверены по текущему коду. Выполнять строго по фазам; каждая задача — отдельный коммит в ветке своей фазы.

## Правила работы для исполняющего ИИ (обязательные)

- Ветки по фазам: `feat/phaseA-security`, `feat/phaseB-player`, `feat/phaseC-design`, `feat/phaseD-ux`. Коммиты вида `phaseA: hash session tokens at rest`.
- Стек: сервер — Bun + Hono 4 + `bun:sqlite` (НЕ better-sqlite3); клиент — SwiftUI (iOS 17+/macOS 15+), проект генерируется XcodeGen из `MusaicApp/project.yml`; сайдкар — Python 3.11 (`server/sidecar/setup.sh`).
- Проверки перед каждым коммитом: `cd server && bun run typecheck && bun test src/__tests__`; клиент — `cd MusaicApp && xcodegen generate && xcodebuild -project Musaic.xcodeproj -scheme Musaic -destination 'platform=macOS' build`.
- Миграции БД — только новые версии (v16, v17, …) в `server/src/db/migrations.ts`. Применённые не редактировать.
- API-контракт: не ломать публичные эндпоинты без синхронного обновления клиента (`MusaicApp/Services/APIService.swift`) в той же ветке.
- Тесты обязательны: меняешь поведение — обнови/добавь тесты (`server/src/__tests__/`, паттерн `setupTestDb`).
- Не добавлять тяжёлые зависимости; предпочитать нативное (`bun:sqlite`, fetch, URLSession, Keychain).
- Палитра приложения — **золотая** (решение владельца): accent `#e6d8c3`, accentStrong `#cdb69a`, bgPrimary `#090807`. Источник токенов — extension в `MusaicApp/MusaicApp.swift:815–823`. Розовый `#e91e8c` из старой спеки НЕ возвращать. DESIGN.md уже приведён к факту — держать его синхронным при изменениях.

## Что уже сделано ранее — НЕ переделывать

Сервер: `requireAuth()` на мутациях и стримах (`server/src/index.ts:260–278`); SSRF-защита artwork (DNS-чек, лимиты размера/типа); вырезание `local_path` из ответов; Yandex proxy с токеном в заголовке; общий секрет сайдкара; миграция `provider_config`; LRU-капы вкусовых кэшей; stratified CV + guard в раннере (`reco/ranker.ts:199–245,317`); lease джоб + ffmpeg-очередь; единый `utils/stream-proxy.ts`; разбиение `routes/local/` и `reco/`; eslint; ~32 тест-сюита; CI собирает оба Swift-таргета + lint; деплой через release-symlink c health-гейтом и rollback.

iOS: токен в Keychain с миграцией (`Services/KeychainService.swift`); Swift 6 strict concurrency; `PlaybackState` c `.buffering` (`AudioPlayer.swift:6–11`); дедупликация идемпотентных GET; `ErrorRetryView` используется; тема auto/dark/light (`SettingsStore.swift:39–40`).

## Операционное состояние прод-сервера (45.146.167.109) — учесть при отладке

- Живая БД: `/opt/musaic-server/musaic.db` (WAL). `/opt/musaic-server/shared/musaic.db` и симлинк `current/server/musaic.db` — устаревшие копии, туда писать бесполезно.
- Сервер запущен **вручную** (`bun src/index.ts`, cwd `/opt/musaic-server`, root) — systemd-юнит существует, но `inactive`. Задача A4 это чинит.
- Бэкап перед вмешательствами: `/root/musaic-backup-2026-08-24.db`. 24.08.2026 из `liked_tracks` удалены 1088 яндекс-лайков (осталось 49: 46 soundcloud + 3 youtube). Реальные лайки в Яндекс.Музыке не затрагивались.
- Клиент после этой чистки требует **разового re-login** (иначе локальный кэш телефона через `POST /api/auth/likes/sync` зальёт удалённые лайки обратно).

---

## Фаза A — Безопасность и инфраструктура сервера (ветка feat/phaseA-security)

### A1. HTTPS end-to-end

Контекст: клиент даунгрейдит https→http (`MusaicApp/Services/APIService.swift:746–753`, дефолт `http://45.146.167.109:3001`); ATS разрешает всё (`NSAllowsArbitraryLoads` в обоих Info.plist); сервер без TLS. Bearer-токен ходит открытым текстом.

Что сделать:
1. Поднять TLS-терминацию Caddy (добавить `deploy/Caddyfile`: домен, auto-HTTPS Let's Encrypt, reverse_proxy на 127.0.0.1:3001; лимиты тела, gzip).
2. Клиент: убрать даунгрейд-логику; `NSAllowsArbitraryLoads: false` + `NSAllowsLocalNetworking: true`; дефолтный URL → https; предупреждение в настройках при вводе http:// для не-local хостов.
3. Обновить `deploy-server.sh` и README (инструкция по DNS/домену).

Критерии: сборка проходит, ATS не блокирует https; curl по https отвечает; HTTP к не-local хостам режется ОС.

### A2. Session-токены: хранение хешем, async KDF

Контекст: токены сессий лежат в БД открытым текстом (`server/middleware/auth.ts:26–48` читает/пишет сырой token), регистрация/логин считают scrypt синхронно (`server/routes/auth.ts:~33`, блокирует event loop).

Что сделать:
1. При создании сессии хранить только SHA-256 хеш токена (колонка `token_hash`; миграция v16: добавить колонку, залить хеши существующих, удалить старую колонку нельзя — оставь legacy-чтение на один релиз).
2. Middleware ищет по `token_hash`; сырой токен нигде не логируется.
3. `scryptSync` → async `crypto.scrypt` (промисифицированный) в register/login/change-password.

Критерии: grep по коду не находит записи сырого токена в БД; typecheck+тесты зелёные; тест: после логина в sessions нет сырого токена.

### A3. Rate-limit: per-real-IP и per-route бакеты

Контекст: все не-auth запросы попадают в один бакет `"direct-client"` (`server/utils/rate-limit.ts:39–48`) — один активный клиент душит остальных; за прокси реальный IP берётся неверно.

Что сделать:
1. Уважать `X-Forwarded-For` только при `TRUST_PROXY=1` (env), иначе — remote address; ключ бакета = IP + route-group.
2. Отдельные лимиты: `/api/auth/*`, `/api/vk/auth`, `/api/recommendations/chat` (уже есть token-bucket — оставить), дефолт для остального.
3. Добавить `TRUST_PROXY` в `.env.example` и Caddyfile-конфиг (прокси всегда шлёт XFF).

Критерии: тесты лимитера с разными IP; два разных клиента не блокируют друг друга; документированный env.

### A4. systemd: перевести прод на юнит, hardening, секреты вне репо

Контекст: прод работает вручную под root (см. «Операционное состояние»); `deploy-server.sh` содержит захардкоженный `root@45.146.167.109`; юнит `deploy/musaic-server.service` исполняется от root.

Что сделать:
1. Юнит: `User=musaic` (создать пользователя, chown `/opt/musaic-server`), `EnvironmentFile`, `Restart=on-failure`, hardening-директивы (`NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=/opt/musaic-server`, `PrivateTmp`).
2. Переключить прод на юнит: остановить ручной процесс, `systemctl enable --now musaic-server`, проверить health.
3. `deploy-server.sh`: хост/путь/юзер — из env или config-файла `deploy/deploy.env` (в .gitignore); убрать пароль из скрипта — только SSH-ключи.
4. Починить расхождение путей: рабочая БД должна быть одна (перенести данные из `/opt/musaic-server/musaic.db` в `shared/`, симлинк оставить, DB_PATH задать абсолютным).

Критерии: `systemctl status` active (non-root), рестарт сервера переживает, деплой-скрипт без секретов в гите; в БД один источник правды.

### A5. Ночные бэкапы БД + восстановление

Контекст: бэкап делается только руками/при деплое; потеря диска = потеря библиотеки.

Что сделать:
1. `scripts/backup-db.sh` на сервере: python3 sqlite3 backup API (безопасно при WAL) → `/opt/musaic-server/backups/musaic-YYYY-MM-DD.db`, ротация 14 штук.
2. systemd timer `musaic-backup.timer` (ночью) + такой же шаг опционально в deploy-скрипте.
3. `scripts/restore-db.sh <file>`: стоп сервиса → подмена → старт → health.

Критерии: таймер активен, бэкап появляется, restore возвращает работоспособный сервис (проверить на стейджинг-копии).

### A6. Artwork-прокси: закрыть TOCTOU/DNS-rebinding

Контекст: `/api/artwork*` резолвит DNS, проверяет IP, потом делает отдельный fetch — между проверкой и запросом DNS может ответить другим адресом.

Что сделать: резолвить один раз и подключаться к полученному IP с `Host`/SNI оригинального домена (undici custom lookup / Agent), либо проверять соединение post-connect (remoteAddress) и обрывать при чужом адресе. Редиректы — повторная проверка. Юнит-тест с моком двойного резолва.

Критерии: тест «DNS ответил публичным адресом вторым вызовом» → 400; обычные обложки работают.

### A7. Сайдкар: стриминг вместо полной буферизации; VK callback

Контекст: `server/sidecar/app.py:325–338` буферизует весь трек в память перед ответом (пики RAM = размер трека × параллельные запросы). В `server/src/routes/vk.ts:23–29` OAuth redirect_uri строится из заголовка Host — подменяемый Host ведёт на чужой домен.

Что сделать:
1. app.py: отдавать поток (chunked) напрямую из upstream-ответа yt-dlp/pafy, поддержать Range passthrough; буфер только служебной обвязки.
2. vk.ts: redirect_base из env (`VK_REDIRECT_BASE`) либо whitelist-host проверка; тест на подменённый Host → 400.

Критерии: память сайдкара при стриме длинного трека не растёт пропорционально длительности; Range работает; host-injection тест зелёный.

### A8. Ретенция: eviction downloads-кэша

Контекст: `server/jobs/retention.ts` архивирует историю, но кэш скачанных файлов в `DOWNLOADS_DIR` растёт без предела.

Что сделать: LRU/TTL-очистка: удалять файлы, к которым не обращались N дней (env `DOWNLOADS_TTL_DAYS`, дефолт 60), с суммарным капом (env, дефолт 20 ГБ); логировать освобождённое; не трогать файлы моложе TTL.

Критерии: тест с фейковыми mtime удаляет только старьё; конфигурируется через env; задокументировано в .env.example.

---

## Фаза B — Надёжность плеера iOS (ветка feat/phaseB-player)

### B1. Audio session: interruptions и смена маршрута

Контекст: `MusaicApp/Services/AudioPlayer.swift:74–110` активирует сессию, но нет наблюдателей `AVAudioSession.interruptionNotification` и `routeChangeNotification` — звонок/наушники оставляют плеер в неверном состоянии (не возобновляется или играет в динамик).

Что сделать:
1. Подписаться на interruption: `.began` → сохранить wasPlaying/позицию; `.ended` с `.shouldResume` → восстановить воспроизведение.
2. Route change: `.oldDeviceUnavailable` (вынули наушники) → пауза; `.newDeviceAvailable` → продолжить если играл.
3. macOS-таргет: обернуть AVAudioSession-код в `#if os(iOS)` (на macOS API недоступен).

Критерии: сценарий «звонок → отклонить» возобновляет музыку; «вынул наушники» ставит паузу; обе платформы собираются.

### B2. Пауза во время кроссфейда

Контекст: `AudioPlayer.swift:191–204` — тап паузы в окне кроссфейда глушит только исходящий item, входящий продолжает играть (или наоборот) — музыка играет при «паузе».

Что сделать: pause() должен останавливать ОБА активных плеера и отменять запланированный переход; resume — корректно восстанавливать состояние кроссфейда (или честно продолжать без кроссфейда для текущего трека). Покрыть юнит-тестом состояния (fake clock если есть).

Критерии: пауза в любой момент → тишина; play → продолжение с той же позиции; state machine без зависших таймеров.

### B3. Гонка метаданных Now Playing

Контекст: `AudioPlayer.swift:776–804` — параллельные обновления `nowPlayingInfo` могут перезаписать друг друга (устаревший title/artwork в локскрине при быстром переключении треков).

Что сделать: сериализовать обновления через единственный actor/очередь; каждое обновление строит info заново из актуального snapshot'а трека, а не мутирует слепок; отменять устаревшие Task по trackId.

Критерии: быстрое перелистывание 5 треков подряд → в MPNowPlayingInfoCenter финальный трек; тест на последовательность обновлений.

### B4. Политика 401: не уничтожать пользовательские данные

Контекст: `APIService.swift:130–139` при 401 вызывает logout, а `SettingsStore.logout()` (`SettingsStore.swift:195–198`) стирает сессию; локальные лайки чистятся при следующем prepareForUser — сетевой сбой/ротация ключа сервера выглядит как пропажа библиотеки. Известный инцидент: массовая чистка лайков на проде 24.08 потребует re-login именно из-за этой связки.

Что сделать:
1. Разделить «сервер сказал 401» и «данные стереть»: ввести `AuthState.expired`, показывать баннер «Сессия истекла — войдите снова», сохранять локальные лайки/плейлисты до явного действия пользователя.
2. `logout()` — только по кнопке выхода; авто-разлогин лишь после N неудачных refresh-подходов.
3. После повторного входа — тихий resync (существующий merge уже умеет).

Критерии: имитация 401 не очищает UserDefaults-лайки; баннер виден; повторный вход восстанавливает синк без дублей.

### B5. DownloadManager: прогресс и фоновые потоки

Контекст: `DownloadManager.swift:83` — прогресс всегда 0% (делитель/единицы не сходятся), file I/O на main thread, URLSession пересоздаётся.

Что сделать: считать progress из `bytesWritten/expectedBytes` делегата; переносить копирование/удаление файлов в background Task; переиспользовать один URLSession; публиковать прогресс как @Observable-поле с throttling (не чаще 10 Гц).

Критерии: скачивание показывает плавный 0→100%; UI не фризится на большом файле; отмены не текут.

### B6. Санитайзер `try? await`

Контекст: в сторах/сервисах есть `try? await api.…` — ошибки проглатываются, UI показывает успех при провале (точки: LibraryStore, PlaylistStore, ProfileStore — собрать grep'ом `try\? await`).

Что сделать: заменить на do/catch с минимальным действием (тост/лог/повторная пометка dirty); там, где результат критичен — пробрасывать в существующий ErrorRetryView. Grep-критерий: `try? await` в Stores/ отсутствует (кроме обоснованных TODO с комментарием).

Критерии: grep чист; ручной сценарий «сервер выключен → действие → видимая ошибка».

---

## Фаза C — Дизайн: консолидация золотой палитры (ветка feat/phaseC-design)

### C1. Единый слой токенов

Контекст: канонические токены объявлены в `MusaicApp/MusaicApp.swift:815–823` (accent `#e6d8c3`, bgPrimary `#090807` и т.д.), но по Views размазано ~60 литералов `Color(hex:)`, 13 значений радиусов вне шкалы, разные opacity-наборы стекол. DESIGN.md приведён к палитре — код должен совпадать.

Что сделать:
1. `DesignTokens.swift`: enum Radius { xs=8, sm=12, md=16, lg=20, pill }, enum Spacing, расширения Color (уже есть) + GlassStyle (regular/prominent) поверх GlassModifier.
2. Заменить литералы на токены механически (grep `Color(hex:` по MusaicApp/Views → 0 вью-файлов с литералами, кроме DesignTokens.swift).
3. Скриншот-проверка Home/NowPlaying/Library до/после — визуально идентично.

Критерии: grep-чистота; сборка обеих платформ; визуальный diff пуст.

### C2. Dynamic Type

Контекст: ~267 фиксированных `.system(size:)` — масштабирование системных настроек игнорируется.

Что сделать: заменить на семантические стили (.headline/.subheadline/.caption + .bold() где нужно) или `.system(size:, relativeTo:)` для кастомных; зафиксировать максимум масштаба для мини-плеера (`.dynamicTypeSize(...DynamicTypeSize.xxxLarge)`), чтобы вёрстку не рвало; проверить ключевые экраны на 310%.

Критерии: grep `.system(size:` возвращает только relativeTo-варианты; скриншоты XXL-масштаба без обрезок.

### C3. Touch targets

Контекст: часть glyph-кнопок < 44×44pt (мини-плеер, карточки очереди).

Что сделать: аудит через grep `frame(width: \d{1,2}` рядом с Button/Image; увеличить contentShape/hit-box до 44pt без визуального роста (padding + contentShape(Rectangle())).

Критерии: список мест до/после; визуально ничего не разъехалось.

### C4. Сплит гигантов

Контекст: ContentView — 673 строки внутри `MusaicApp.swift`, `HomeView.swift` — 825.

Что сделать: `Views/Root/MainTabView.swift` (таб-роутинг), `HomeView` → секции (HeroSection, MoodChipsSection, RecentSection) в `Views/Home/Sections/`; поведение идентично.

Критерии: ни один новый файл > 400 строк; сборка; визуально идентично.

---

## Фаза D — Локализация и UX (ветка feat/phaseD-ux)

### D1. String Catalog RU/EN

Контекст: смесь хардкод-строк (русские в HomeView:307–525, английские в остальных) — язык интерфейса не переключается.

Что сделать: `Localizable.xcstrings` с RU+EN; базовый язык RU; перенести строки всех Tab/кнопок/заголовков/ошибок (grep `Text("…")` с кириллицей и типовыми английскими); навигационные заголовки — navigationTitle(LocalizedStringKey).

Критерии: смена языка системы меняет UI; grep кириллицы в .swift (кроме комментариев/файлов каталога) пуст; EN-перевод вычитан.

### D2. Dead-end состояния и онбординг источников

Контекст: при пустом результате/недоступном источнике часть экранов показывает просто пустоту; подключение VK/Yandex/SoundCloud спрятано в Profile.

Что сделать: переиспользуя EmptyStateView/ErrorRetryView — покрыть Library/Search/Home/Downloads; онбординг-карточка при первом запуске без источников (переиспользовать флоу Profile); deep-link из пустого состояния сразу в подключение источника.

Критерии: сценарий «свежая установка без источников» приводит к онбордингу; отключённый сервер → Retry, а не пустота.

### D3. Полировка iPod-деталей

Что сделать: haptic на like/unlike (iOS, medium); анимация смены обложки в NowPlaying (opacity+scale 0.25s, уважая reduceMotion — паттерн есть в HomeView); iPad — разрешить все ориентации в project.yml и проверить size-class вёрстку; scroll-position индикатор в большой очереди.

Критерии: reduceMotion отключает анимации; iPad в landscape без сломанных layout'ов; FPS не деградирует (Instruments при возможности).

---

## Чек-лист перед сдачей

- [ ] `bun run typecheck && bun test src/__tests__` — зелёные
- [ ] `xcodebuild` (Musaic iOS + MusaicMac) — без ошибок и новых warning'ов
- [ ] Миграции только добавлены (v16+, применённые не тронуты)
- [ ] `grep -rn "Color(hex:" MusaicApp/Views` — пусто; кириллических хардкод-строк в .swift — нет
- [ ] Ни одного сырого токена сессии в БД/логах; `NSAllowsArbitraryLoads=false`
- [ ] Прод переведён на systemd non-root, ночной бэкап настроен, restore проверен
- [ ] Каждая задача — отдельный коммит в ветке своей фазы; PR с описанием
