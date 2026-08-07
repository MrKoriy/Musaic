# План: «Моя Волна» уровня Яндекс Музыки

> **Для исполнителя (ИИ-агента):** это техническое задание, а не обсуждение.
> Каждый тикет содержит: проблему, точные места в коде, подсказки по реализации,
> критерии приёмки. Выполнять тикетами в указанном порядке, после каждого —
> проверка (см. «Инженерные правила»). Открытые вопросы из исходного плана уже
> решены — см. раздел «Принятые решения». Ничего не выдумывать: если факт о
> коде расходится с реальностью — верить коду и скорректировать подход.

## Цель

«Моя Волна» должна попадать в точку с первого трека: минимум ранних скипов,
никаких повторов и дизлайкнутого, мгновенная реакция на скипы/лайки в сессии.
Целевые метрики (проверяются через `/api/recommendations/quality`):

- `earlySkipRate` по поверхности `my_vibe` < **0.15** (сейчас измерить и записать baseline);
- `acceptedRequestRate` > **0.5**;
- `canonicalRepeatRate` < **0.05**;
- доля принятых треков от новых артистов ≈ **15%** (баланс 85/15, см. T12).

---

## Проверенный контекст кодовой базы

Всё ниже сверено с кодом лично. Ссылки: `файл:строка`.

**Стек:** сервер — Bun + Hono + `bun:sqlite` (TypeScript, ESM); клиент — iOS
SwiftUI; сайдкар — Python (yandex-music от MarshalX). Сервер живёт постоянно
(VPS, деплой через `deploy-server.sh` → `/opt/musaic-server`), БД —
`server/musaic.db` (путь: `DB_PATH` env или `./musaic.db`,
`server/src/db/index.ts:6`).

**Ключевые файлы:**

- `server/src/routes/recommendations.ts` (~2000 строк) — весь движок станций:
  - `buildStationTracks()` (`:1046`) — сбор кандидатов → скоринг → дедуп → баланс.
  - `scoreVibeCandidate()` (`:464`) — руками расставленные веса (константы).
  - `parseStationSession()` (`:238`) — парсит `recentOutcomes`, `queueTail`,
    `skipStreak`, считает `rapidSkip` (3 из 5 последних скипов с ratio < 0.25)
    и `acceptedSeeds`.
  - `sessionTransitionSignals()` (`:817`) — **уже существующий зачаток CF**:
    пары accepted-событий внутри одной `session_id` с decay 30 дней. T6
    формализует это в персистентную матрицу.
  - `recommendationEnvelope()` (`:364`) — пишет показы в
    `recommendation_impressions` (request_id, user_id, surface, track_id, position).
  - `POST /my-vibe` (`:1673`), `POST /auto-mix` (`:1695`).
  - `GET /quality` (`:1814`) — **уже существует**: earlySkipRate,
    longListenRate, acceptance по поверхностям/провайдерам/бакетам позиций.
    T10 — расширение, а не создание с нуля.
- `server/src/providers/taste-engine.ts` — `buildWeightedProfile()` (`:115`).
  **Важно:** профиль уже читает `liked_tracks` через UNION (`:131-144`), т.е.
  после импорта лайков (T1) профиль станет умным мгновенно, без правок здесь.
  `actionWeight()`: dislike = −4. `buildDailyMix()` (`:305`) — **не исключает
  дизлайкнутые треки вообще** (баг/пробел, чинится в T4).
- `server/src/db/migrations.ts` — миграции v1..v11, паттерн append-only.
  Существуют: `liked_tracks` (v6), богатая `listening_history` v9 (event_id,
  played_ratio, session_id, request_id, surface, position),
  `recommendation_impressions` (v10), `daily_mix_snapshots` (v11).
- `server/src/utils/track-identity.ts` — `songFamilyKey()` (канонический ключ
  песни `artist::base_title`), `normalizeArtistIdentity()`, `baseTrackTitle()`,
  `trackVariantPenalty()`. Все дедупликации/баны делать по family key,
  а не по track id (одна песня живёт в нескольких источниках с разными id).
- `server/sidecar/app.py` — Python-сайдкар Яндекса. Есть `yandex_station`,
  `yandex_validate` и т.д. **Эндпоинта лайков нет** — добавить в T1.
- `server/src/providers/yandex.ts` — TS-обёртка сайдкара (`sidecarGet` +
  заголовок `X-Yandex-Token`). `cacheYandexTracks()` — паттерн кэширования
  треков в `tracks` через `upsertTrack`.
- `server/src/routes/auth.ts` — `/api/auth/likes`, `/likes/sync`, `/likes/set`
  (лайки внутри приложения). Импорт из Яндекса — отдельный эндпоинт (T1).
- Клиент `MusaicApp/Stores/PlayerStore.swift`:
  - `stationSkipStreak` (`:43`), инкремент в `recordStationOutcome`-логике
    (`:704-706`); `stationRecentOutcomes` (макс. 20).
  - refill-функция `loadMoreStationTracks` (около `:540`) — вызывает
    `api.getMyVibeTracks(...)`/`getAutoMixTracks(...)` с session-контекстом.
  - `dislikeCurrentTrack()` (`:404`) — кнопка дизлайка уже шлёт scrobble
    `dislike` и сразу переключает трек.
  - UI подключения Яндекса: `MusaicApp/Views/Profile/ProfileView.swift`
    (состояния `yandexConnecting` и т.п., `:52-58`) — сюда кнопку T1.
  - `APIService.getMyVibeTracks()` (`:228`), `syncLikes()` (`:494`).

**Факты окружения:** `LASTFM_API_KEY` есть в `server/.env` (`lastfmGet()`,
`recommendations.ts:61`). Пользователь один. Тесты: `bun test src/__tests__`
(есть `recommendations.test.ts`, `taste-engine.test.ts`, `auth-likes.test.ts`).
Cron-инфраструктуры нет — только разрозненные `setInterval` (см. T0).

---

## Инженерные правила (обязательны для каждого тикета)

1. **Проверка после каждого тикета:** `cd server && bun x tsc --noEmit && bun test src/__tests__`.
   Падающее — чинить до перехода дальше. Для клиентских тикетов (T8) — сборка
   Xcode-проекта, если доступна; минимум — внимательное следование существующим
   паттернам PlayerStore.
2. **Миграции:** только append в `MIGRATIONS` (`migrations.ts`), следующая
   версия — 12+. Старые миграции не трогать. Каждая новая таблица/колонка —
   отдельная миграция с понятным `description`.
3. **Минимальные изменения.** Не рефакторить существующую логику вне тикета.
   Исключение — явно указанные извлечения (T6/T7 просят вынести Last.fm и
   фичи в общие модули).
4. **Новые тесты** на каждый серверный тикет — по образцу существующих в
   `server/src/__tests__/` (там есть `setDbForTest` для изолированной БД).
5. **Идемпотентность джобов:** любой cron/backfill можно прогнать дважды без
   дублей (INSERT OR IGNORE / UPSERT, детерминированные ключи).
6. **Rate limits Last.fm:** не быстрее ~5 rps, агрессивно кэшировать
   (in-memory `getCached/setCached` из taste-engine + персистентные таблицы).
7. **Коммиты** — только если пользователь явно попросит.
8. Все временные метки в БД — unix seconds (следовать существующему стилю).

---

## Принятые решения (развилки из исходного плана закрыты)

- **D1 (CF в T6):** считаем и реальные сессии, **и** Last.fm `track.getSimilar`
  как псевдо-переходы с весом **×0.3** (source='lastfm'). Реальные переходы
  приоритетнее; Last.fm даёт умный холодный старт с первого дня.
- **D2 (LR-ранкер в T7):** shadow-mode с первого дня (считаем оба скора,
  логируем, ранжируем старым). Промоушен модели — только при ≥1000 размеченных
  показов **и** AUC ≥ 0.6 **и** явном флаге `RECO_RANKER=model`. Показы уже
  пишутся (миграция v10) — датасет копится с момента деплоя T0–T5.

---

## Порядок выполнения

```
T0 (инфраструктура ночных джобов)  ← нужен для T2, T3, T6, T7, T10
Фаза 1: T1, T4, T5 (первые, видимый эффект) → T2, T3 (ночные джобы)
Фаза 2: T6 (CF) → T8 (реактивный refill) → T7 (LR-ранкер) → T9 (bandit)
Фаза 3: T10 (метрики) → T11 (A/B) → T12 (тюнинг)
Фаза 4 (опционально): T13, T14
```

Зависимости: T6/T7 используют данные/фичи от T1–T3; T7 использует канал T6 как
признак; T9 использует T3 (теги) и T6 (CF-соседи); T11 зависит от T7.

---

# T0 — Инфраструктура ночных джобов (scheduler)

**Проблема:** cron нужен пяти тикетам, а инфраструктуры нет — только
`setInterval` в `index.ts:68` и пара мест.

**Что сделать:**

1. Миграция: таблица `job_state(name TEXT PRIMARY KEY, last_run_at INTEGER,
   last_status TEXT, last_error TEXT)`.
2. Новый модуль `server/src/jobs/scheduler.ts`:
   ```ts
   registerJob({ name, intervalHours, run: () => Promise<void> })
   ```
   - Тик раз в час + прогон при старте: если `now - last_run_at >= interval` —
     выполнить. Джобы выполнять **последовательно** (не параллельно — бережём
     rate limits Last.fm).
   - Каждый запуск пишет `last_run_at`/`last_status`/`last_error` в `job_state`.
   - Логирование через `server/src/logger.ts`.
   - Обёртка try/catch: падение одной джобы не роняет сервер и остальные.
3. Регистрация в `server/src/index.ts` рядом с существующим `setInterval`,
   под флагом `JOBS_ENABLED` (default `1`). **Не стартовать джобы под тестами**
   (проверка `process.env.NODE_ENV === "test"` или существующего механизма
   тестового окружения — посмотреть, как `__tests__/setup.ts` поднимает сервер).

**Подсказки:**
- Не тянуть node-cron — 60 строк своего кода проще и без зависимостей.
- Полезно сразу добавить `POST /api/admin/jobs/:name/run` (ручной прогон для
  отладки; защитить тем же auth, что и остальные роуты — посмотреть, как
  устроен `requestUserId`/middleware).

**Приёмка:** фиктивная джоба с `intervalHours: 24` пишет в `job_state` при
старте; повторный старт в тот же час её не запускает; тест `jobs.test.ts`
зелёный; typecheck чистый.

---

# Фаза 1 — Данные и холодный старт

## T1 — Импорт лайков Яндекс Музыки

**Проблема:** `liked_tracks` пустые, профиль строится вслепую, хотя у
пользователя годы лайков в аккаунте Яндекса. `buildWeightedProfile` уже умеет
читать `liked_tracks` (UNION в `taste-engine.ts:131`) — нужно только наполнить
таблицу.

**Что сделать (4 слоя):**

1. **Сайдкар** `server/sidecar/app.py`: функция `yandex_likes(token)` +
   маршрут `GET /yandex/likes`:
   - `client.users_likes_tracks()` → список `TrackId` (у элементов есть `.id`
     и `.timestamp`).
   - Полные метаданные батчами: `client.tracks([ids])` по ~50 шт., маппинг
     через существующий `_yandex_track_to_dict`.
   - Ответ: `{ tracks: [...], likedAt: { "<track_id>": <unix_ts>, ... } }`.
   - Подсказка: у части лайков трек может быть недоступен — пропускать,
     не падать.
2. **TS-провайдер** `server/src/providers/yandex.ts`: метод
   `getLikedTracks(): Promise<{ tracks: Track[]; likedAt: Map<string, number> }>`,
   кэшировать треки через существующий `cacheYandexTracks()`.
3. **Роут** `server/src/routes/yandex.ts`: `POST /api/yandex/likes/import`
   (требует auth — пользователь один, взять `requestUserId`-паттерн из
   recommendations.ts):
   - Для каждого трека: `upsertTrack` (source='yandex', id=`yandex_<id>`) →
     `INSERT OR IGNORE INTO liked_tracks (user_id, track_id, liked_at)`
     (liked_at из timestamp; если нет — `unixepoch()`).
   - **И** `INSERT OR IGNORE INTO listening_history` события `like` с:
     `event_id = 'yandex-like-import:' || userId || ':' || trackId`
     (детерминированный → реимпорт идемпотентен благодаря UNIQUE-индексу
     `idx_lh_event_id`), `played_at = liked_at`, `surface = 'yandex_import'`,
     `session_id = NULL`, `is_organic = 0`.
     Зачем: статы в `buildStationTracks` (`userStats`/`userArtistStats`,
     `recommendations.ts:1254+`) читают только `listening_history` — без этих
     событий скоринг станций импорт не увидит.
     Безопасность: `surface='yandex_import'` исключает их из `/quality`
     (там фильтр по surface), `session_id IS NULL` — из
     `sessionTransitionSignals`.
   - После импорта: `clearUserRecommendationCaches(userId)`.
   - Ответ: `{ imported, alreadyHad, total }`.
4. **Клиент:** кнопка «Синхронизировать лайки» в `ProfileView.swift` рядом с
   блоком Яндекса + авто-триггер один раз после успешного подключения
   аккаунта (device flow в ProfileView). Метод в `APIService.swift`
   `importYandexLikes()`. Показать результат («Добавлено N лайков»).

**Подводные камни:**
- `liked_tracks.user_id` NOT NULL → если `requestUserId` null, вернуть 401
  (посмотреть, как это делают роуты в `auth.ts`).
- Не делать import «двусторонним»: только Яндекс → Musaic, ничего не удалять.
- Пагинация: у пользователя могут быть тысячи лайков — батчи `client.tracks()`
  обязательны, иначе таймаут.

**Приёмка:** после вызова импорта `GET /api/recommendations/taste-profile`
показывает топ-артистов из реальных лайков Яндекса; повторный импорт —
`imported: 0`; тест (по образцу `auth-likes.test.ts`) зелёный.

---

## T2 — Граф похожих артистов (Last.fm artist.getSimilar)

**Проблема:** соседи артистов сейчас приходят только от `track.getSimilar` для
4 сидов на лету (12ч in-memory кэш). Глубины 2 нет, между запросами ничего не
переиспользуется, RU-покрытие случайное.

**Что сделать:**

1. Миграция: `related_artists(artist_key TEXT NOT NULL, related_key TEXT NOT NULL,
   score REAL NOT NULL, source TEXT NOT NULL DEFAULT 'lastfm',
   updated_at INTEGER NOT NULL, PRIMARY KEY (artist_key, related_key, source))`
   + индекс `idx_related_artists_key (artist_key, score DESC)`.
   Ключи — через `normalizeArtistIdentity()` из `utils/track-identity.ts`.
2. Ночная джоба (T0) `server/src/jobs/artist-graph.ts`:
   - Артисты для обхода: топ-20 из `buildWeightedProfile(userId)` + артисты из
     `tracks` с `play_count > 0` или свежими `updated_at` — лимит ~300 за прогон,
     приоритет по весу в профиле. Не охваченные — в следующие ночи (джоба
     резюмируемая: пропускать артистов с `updated_at` младше 30 дней).
   - `artist.getSimilar?limit=50&autocorrect=1` → UPSERT строк
     (score = `match` 0..1, отбросить < 0.15).
   - Пауза 250 мс между запросами.
3. Использование в `buildStationTracks()` (`recommendations.ts`):
   - Для `seedArtists`: соседи глубины 1 (score ≥ 0.3, топ-30) и глубины 2
     (топ-10 соседей каждого соседа глубины 1, effective score = произведение,
     отбросить < 0.1).
   - Новый канал кандидатов: треки из `tracks`, чей нормализованный артист ∈
     соседям: `addCandidates(rows, 5.5 * score * (depth === 2 ? 0.5 : 1))`
     (LIMIT ~10 треков на артиста, общий потолок — следить, чтобы канал не
     доминировал: не более ~120 кандидатов).
   - Существующий Last.fm-канал (`similarTrackSignals`) оставить — они
     дополняют друг друга (трек-уровень vs артист-уровень).

**Подсказки:**
- Сначала вынести `lastfmGet` из `recommendations.ts` в
  `server/src/providers/lastfm.ts` (переиспользуется джобами T2/T3/T6) —
  аккуратно обновить импорты, больше ничего не меняя.
- Запрос к графу — один SQL `IN (...)` по всем сидам, не N+1.

**Приёмка:** после ночной джобы в `related_artists` ≥ N строк по топ-артистам;
в ответе `/my-vibe` появляются треки артистов, которых не было в сидах, но
которые есть в графе; тест на канал кандидатов (мокнуть граф в тестовой БД).

---

## T3 — Теги жанров/настроений (backfill через Last.fm top tags)

**Проблема:** `genre`/`mood` заполнены у ~10% кэша; вся «семантика» ранкера —
LIKE-поиск слова «chill» в названии. `VIBE_MOOD_ALIASES`/`fuzzyTagMatch`
работают по пустому.

**Что сделать:**

1. Миграция: `track_tags(track_id TEXT NOT NULL, tag TEXT NOT NULL,
   weight REAL NOT NULL, source TEXT NOT NULL DEFAULT 'lastfm',
   updated_at INTEGER NOT NULL, PRIMARY KEY (track_id, tag))`
   + индекс `idx_track_tags_tag (tag)`.
2. Канонизация: модуль `server/src/reco/tags.ts` — таблица ~60 канонических
   тегов с алиасами (`hip-hop` ← ["hip hop", "rap", "trap", ...], `russian rap`
   ← ["russian rap", "russian hip-hop", ...], `ambient`, `indie rock`, `metal`,
   `drum and bass`...). Last.fm теги lowercase-нормализуются, маппятся через
   алиасы; немапящееся отбрасывается (кроме очень частотных — логировать топ
   отброшенных раз в прогон для доработки алиасов).
3. Ночная джоба `server/src/jobs/tag-backfill.ts` (T0), темп **30 треков/мин**
   (2 сек на трек):
   - Приоритетная очередь: треки из `liked_tracks` → `listening_history` →
     `play_count DESC` → остальные. Пропускать обновлённые < 90 дней назад.
   - `track.getTopTags`; если пусто — `artist.getTopTags` (source='lastfm_artist',
     weight × 0.8). weight = `count/100` клампнутый до 1.
   - UPSERT в `track_tags`.
   - Цель: ≥80% треков с ≥1 тегом. Прогресс писать в лог раз в 50 треков.
4. Использование в скоринге `scoreVibeCandidate()`:
   - Теги кандидатов подгружать **одним** SQL `IN` по всем id кандидатов
     (не N+1!), класть в `Map<trackId, string[]>` и передавать в контекст
     скоринга; `tags = splitTagField(genre) ∪ splitTagField(mood) ∪ track_tags`.
   - Новый канал кандидатов в `buildStationTracks`: seed-теги (из тегов сидов,
     топ-5) → треки с пересечением ≥2 тегов: `addCandidates(rows, 4 + overlap)`.
   - `getTracksByMood()` (taste-engine) — вторым шагом после exact match
     искать по `track_tags` (canonical tag == mood alias).

**Приёмка:** ≥80% треков с тегами после прогона; `matchesMoodFilter` находит
треки по каноническому тегу, а не по слову в title; тест на маппинг алиасов и
на канал кандидатов.

---

## T4 — Hard-бан дизлайков (трек 30 дней, артист ×0.5 на 14 дней)

**Проблема:** дизлайкнутый трек отфильтровывается навсегда
(`scoreVibeCandidate:485`), а артист после 2+ дизлайков получает лишь разовый
аддитивный штраф (`:516-517`) — рецидивы возвращаются. Плюс `buildDailyMix`
вообще не смотрит на дизлайки.

**Что сделать:**

1. `scoreVibeCandidate()`: заменить вечный бан трека на окно:
   ```ts
   const DISLIKE_BAN_SEC = 30 * 86400;
   // lastDislikedAt > lastLikedAt (лайк «отменяет» бан) и дизлайк свежее 30 дней → null
   ```
   После окна — не бан, а затухающий штраф: `score -= 25 * exp(-ageDays/14)`.
2. Артист: расширить агрегат `userArtistStats` (`:1254-1310`) полем
   `lastDislikedAt` (MAX played_at где action='dislike'). Если
   `dislikeCount >= 2` и прошло < 14 дней — `score *= 0.5` (мультипликативно,
   вместо/поверх текущего `−min(30, balance*12)` — оставить один механизм,
   предпочтительно мультипликативный; аддитивный убрать или уменьшить до −6).
3. `buildDailyMix()` (`taste-engine.ts:305`): добавить исключение треков,
   дизлайкнутых за последние 30 дней (подзапрос по `listening_history`,
   паттерн как у `recentSkipCutoff`).
4. Тот же 30-дневный фильтр применить в `getTracksByMood` fallback-ветках
   (по желанию — если меньше 30 строк diff).

**Приёмка:** тесты: дизлайкнутый вчера трек не попадает в `/my-vibe` и
`/daily-mix`; через 31 день (подмена времени в тесте) — может вернуться со
штрафом; артист с 2 дизлайками — score ровно в 2 раза ниже. Клиент ничего не
меняет (кнопка уже шлёт `dislike`).

---

## T5 — Cooldown повторов волны (12 часов)

**Проблема:** refill станции может вернуть песню, которая уже звучала в этой
волне недавно — проверка идёт только по `queueTail` (12 треков, клиентский
контекст) и `excludeIds`.

**Что сделать (`buildStationTracks`):**

1. Перед сбором кандидатов (только для режимов станций `my_vibe`/`auto_mix`)
   построить `cooldownSongKeys: Set<string>`:
   - `SELECT track_id FROM listening_history WHERE played_at > now-12h AND
     action IN ('play','complete','skip') AND surface IN ('my_vibe','auto_mix')
     AND (user match)` → map в `songFamilyKey`;
   - плюс `SELECT track_id FROM recommendation_impressions WHERE created_at >
     now-12h AND surface = options.mode AND (user match)` (не проигранные, но
     уже показанные — тоже не дублируем) → `songFamilyKey`.
   - Лимит 1000 id на запрос, JOIN к `tracks` для artist/title.
2. Объединить с существующим `excludedSongKeys` (механизм уже есть,
   `:1067-1075`) — но **с байпасом**: финальный fallback-канал
   (глобальный топ, `:1245-1252`) cooldown игнорирует, иначе при маленьком
   кэше волна может опустеть. Реализовать флагом в `addCandidates`
   (`ignoreCooldown = false`).
3. Окно конфигурируемо: `RECO_REPEAT_COOLDOWN_HOURS` (default 12).

**Приёмка:** интеграционный тест: проигранный 2 ч назад трек не возвращается в
том же surface; в другом surface (daily_mix) — может; при пустом пуле
кандидатов fallback всё равно наполняет выдачу.

---

# Фаза 2 — Умный ранкер

## T6 — Item-item collaborative filtering (ночная матрица)

**Проблема:** единственный «кто с кем звучит» сигнал — `sessionTransitionSignals`,
считается на лету за 120 дней и только от текущих сидов. Нужна персистентная
матрица похожести треков.

**Что сделать:**

1. Миграция: `similar_items(track_id TEXT NOT NULL, other_id TEXT NOT NULL,
   score REAL NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL,
   PRIMARY KEY (track_id, other_id, source))`
   + индекс `idx_similar_items_track (track_id, score DESC)`.
2. Ночная джоба `server/src/jobs/similar-items.ts`:
   - **co_listen:** события `listening_history` за 180 дней, группировка по
     `session_id` (и разрыв ≤ 45 мин — логика как в `sessionTransitionSignals`);
     пары accepted-событий (complete / ratio ≥ 0.5 / legacy play без ratio);
     вес пары: recency half-life 30 дн. × (0.7 + 0.6·ratio).
     Нормализация: `score = sumWeights / (sqrt(totalA * totalB) + 5)`
     (косинусоподобная, штрафует глобально-популярные). Топ-50 на трек,
     отбросить < 0.05. Вставлять **в обе стороны** (a→b и b→a) — чтение
     становится одним запросом.
   - **lastfm** (решение D1): для топ-~150 треков (лайки + топ профиля +
     частые в истории) `track.getSimilar` (переиспользовать вынесенный в T2
     `providers/lastfm.ts`; in-memory кэш 12 ч уже есть — для джобы поднять
     TTL или персистить ответы). Сохранять с `score = match * 0.3`,
     source='lastfm'.
   - Чистить строки старше 60 дней для source='co_listen'.
3. Чтение в `buildStationTracks()`: новый канал кандидатов —
   ```sql
   SELECT other_id, MAX(score) AS s FROM similar_items
   WHERE track_id IN (<seedIDs ∪ acceptedSeed ids>) GROUP BY other_id
   ORDER BY s DESC LIMIT 200
   ```
   → `addCandidates(rows, 6 * normalizedScore)` (нормализовать к max=1 внутри
   выборки). Вес ~6 — выше Last.fm-канала (4–6): это наши переходы.

**Подсказки:** в тесте сгенерировать 3 сессии с известными переходами и
проверить симметрию/ранжирование матрицы. Следить, чтобы канал не душил
diversity: итоговое разнообразие уже обеспечивает `selectDiverseTracks`.

**Приёмка:** трек B, принятый вслед за сидом A в прошлых сессиях, появляется
в выдаче `/my-vibe` с сидом A; `similar_items` наполнена; тест зелёный.

---

## T7 — Обучаемый ранкер (logistic regression) + shadow-mode

**Проблема:** скоринг — константы на глаз; датасет
(`recommendation_impressions` ⋈ `listening_history` по `request_id`+`track_id`)
лежит мёртвым грузом.

**Архитектурное требование (важно!):** признаки считаются в одном месте и для
тренировки, и для инференса. Вынести вычисление признаков кандидата в
`server/src/reco/features.ts` (~15 штук) и вызывать его из
`scoreVibeCandidate` и из тренера. Иначе train/serve skew съест всю пользу.

**Признаки (стартовый набор):** `baseScore`, `signalCount`, `artistPositiveCount`,
`artistEarlySkipRate`, `tagOverlap` (после T3), `cfSimilarity` (после T6),
`lastfmMatch`, `familiar` (0/1), `logHoursSincePlay` (capped), `hoursSinceSkip`
(capped), `sourceScore` (local=1/yandex=.8/sc=.4/yt=.1), `variantPenalty`,
`moodMatchCount`, `seedArtistOverlap`, `logPlayCount`.

**Что сделать:**

1. Миграция: `reco_models(id INTEGER PRIMARY KEY AUTOINCREMENT,
   version TEXT UNIQUE, trained_at INTEGER, impressions_used INTEGER,
   auc REAL, weights_json TEXT)`; **и** в `recommendation_impressions`:
   `ALTER TABLE ... ADD COLUMN hand_score REAL`, `model_score REAL`,
   `model_version TEXT`, `reco_variant TEXT` (variant пригодится в T11).
2. Тренер: логика в `server/src/reco/train-ranker.ts` (importable) + тонкий
   скрипт `server/scripts/train-ranker.ts` (`bun run scripts/train-ranker.ts`)
   + ночная джоба через T0:
   - Датасет: impressions за 90 дней ⋈ listening_history.
     **Label:** accepted = like / complete / played_ratio ≥ 0.5; negative =
     skip с ratio < 0.25. Показ без события — **negative только если в том же
     request_id был проигран другой трек** (иначе запрос мог быть фоновым
     prefetch — такие строки пропускать).
   - Модель: логистическая регрессия, градиентный спуск на чистом TS
     (~200 строк, ноль зависимостей): standardization (mean/std хранить в
     `weights_json`), L2 `1e-4`, lr `0.05`, ~300 итераций full-batch.
   - Валидация: последние 20% по времени → AUC. Сохранять строку в
     `reco_models` всегда (история), с честным `auc`.
3. Инференс в `scoreVibeCandidate()`:
   - Загрузка последней модели, in-memory кэш 5 мин.
   - Режим из env `RECO_RANKER`: `hand` (default сейчас) | `shadow` | `model`.
   - `shadow`: считать оба скора, ранжировать по hand, писать `hand_score`/
     `model_score`/`model_version` в impression (нужно протащить скоры до
     `recommendationEnvelope` — положить их в объект трека как служебные поля
     и там же снять).
   - `model`: ранжировать по `sigmoid(w·x)`; fallback на hand, если модели нет
     или `auc < 0.55`.
4. Промоушен (решение D2): ручной, когда `SELECT COUNT(*) FROM
   recommendation_impressions WHERE model_score IS NOT NULL` ≥ 1000 и AUC
   последних 3 моделей ≥ 0.6 → выставить `RECO_RANKER=model` на сервере.

**Приёмка:** `bun run scripts/train-ranker.ts` на сидированной тестовой БД
пишет модель с осмысленным AUC (> 0.5 на синтетике с явным сигналом); в
shadow-режиме impressions содержат оба скора; unit-тест на sigmoid/градиент
(сходимость на линейно-разделимой выборке).

---

## T8 — Реактивный refill (dislike/3 скипа → мгновенный сдвиг)

**Проблема:** сервер уже понимает `skipStreak`/`rapidSkip`
(`recommendations.ts:503-506`), но узнаёт о них только когда клиент сам
пришёл за refill у конца очереди. Реакция должна быть за 3 трека, не за день.

**Клиент (`PlayerStore.swift`):**

1. В логике, где инкрементируется `stationSkipStreak` (`:704-706`), при
   достижении **3** (а также при `dislike` текущего трека в режиме станции и
   при смене `stationFilters`) вызывать новый
   `refreshUpcomingStationTracks()`:
   - guard: `stationMode != nil`, не чаще 1 раза в 60 сек, идёт плеер;
   - вызов `api.getMyVibeTracks(..., reactionRefresh: true)` (добавить
     параметр в `APIService.getMyVibeTracks` body);
   - **заменить** ближайшие 6 треков очереди после текущего (текущий не
     трогаем): удалить из `queue`/`originalQueue`, вставить свежие,
     перевыставить `recommendationRequestIds`/`recommendationPositions` по
     образцу refill-функции (`:583-591`);
   - `stationSkipStreak = 0` после успешной замены.

**Сервер (`recommendations.ts`):**

2. `parseStationSession`: принять `body.reactionRefresh` (boolean).
3. В `buildStationTracks` при `reactionRefresh`:
   - исключить из кандидатов family-ключи `queueTail` **и** последних 20
     `recentOutcomes` (не только артистов — сами песни);
   - `warmExternalCandidateCatalog` — **не await**, fire-and-forget (это
     fast-path, латентность важнее полноты каталога);
   - остальное уже работает: `rapidSkip`/`skipStreak>=3` дают +10 знакомым /
     −10 незнакомым.

**Подсказки:** не забыть `rememberStationTrack`-дедуп по `canonicalFamilyId`
при вставке (как в refill). Если свежих пришло < 6 — заменить сколько пришло.

**Приёмка:** ручной сценарий: 3 ранних скипа подряд → в течение ~1 сек очередь
после текущего трека обновлена, скипнутые артисты исчезли из ближайших 6.
Серверный тест: `reactionRefresh` исключает queueTail-family из выдачи.

---

## T9 — Bandit-усиление в сессии (волна подстраивается за один лайк)

**Проблема:** `acceptedSeeds` уже подмешиваются в seeds (`:1064`), но это
меняет только сид-пул следующего ответа линейно — без усиления «семьи»
принятого трека.

**Что сделать (только сервер, в `buildStationTracks`/`scoreVibeCandidate`):**

1. Из `session.acceptedSeeds` построить контекст усиления: `acceptedArtists`
   (normalized), `acceptedFamilies` (songFamilyKey), `acceptedTags` (теги этих
   треков через `track_tags` из T3 / genre-поля), `acceptedCfNeighbors`
   (топ-10 similar_items для каждого accepted id, из T6).
2. В `scoreVibeCandidate` добавить сессионный бонус (с крышей **+12** суммарно):
   - тот же артист: **+8**;
   - CF-сосед accepted-трека: **+5**;
   - пересечение ≥1 канонического тега: **+3**;
   - вес бонуса затухает по давности accepted-события в `recentOutcomes`
     (последний accepted — ×1.0, шестой — ×0.5).
3. Не стакать бесконтрольно с существующими seed-бонусами: итоговый
   session-блок ограничить крышей (см. выше) и применять только в режиме
   `my_vibe`.

**Приёмка:** тест: accepted-трек артиста X в сессии поднимает другого трека
артиста X и его CF-соседа в топ-5 выдачи; без accepted — не поднимает.

---

# Фаза 3 — Контроль качества и тюнинг

## T10 — Метрики «Моей Волны»

**База:** `GET /api/recommendations/quality` уже существует
(`recommendations.ts:1814`) — расширить, не ломая текущий формат ответа.

**Добавить:**

1. **skipRateByPosition:** join impressions.position с lh (skip, ratio<0.2) —
   сейчас есть бакеты 0-4/5-9/10+, добавить acceptance-кривую по позициям
   0..9 точно (там живёт «первое впечатление» волны).
2. **% новых артистов принятых:** accepted-трек считается «новым», если у
   артиста (normalized) нет accepted-событий раньше начала того дня.
3. **session length:** по `session_id`: среднее число событий и медианная
   длительность (max-min played_at) на сессию, surface='my_vibe'.
4. **Ночной summary:** джоба (T0) раз в сутки пишет одну JSON-строку в лог
   (`[reco-quality] {...}`) через `logger.ts` — earlySkipRate, acceptance,
   repeat rate, new-artist acceptance по каждому surface.

**Приёмка:** `/quality?days=7` отдаёт новые поля; baseline-значения записаны в
комментарий к PR/задаче (понадобятся для T12).

---

## T11 — A/B заготовка (`reco_variant`)

1. Колонка `reco_variant` в `recommendation_impressions` уже добавлена в T7 —
   здесь заполнение и использование:
   - Вариант: env `RECO_VARIANT` (ручной override: `A`/`B`) **или**, если не
     задан, детерминированно по неделе: `stableHash(userId + ISOWeek) % 2`.
     Для одного пользователя ручной режим удобнее — неделю живёшь на A,
     неделю на B.
   - Записывать вариант в каждый impression.
2. Семантика вариантов: `A` = hand-ранкер, `B` = model-ранкер (когда
   `RECO_RANKER=model`; до этого оба варианта = hand, колонка просто копится).
3. `/quality` принимает `?variant=A|B` — фильтр по колонке.

**Приёмка:** в impressions виден вариант; `/quality?variant=A&days=7` vs
`?variant=B` дают сравнимые числа.

---

## T12 — Тюнинг exploration (85/15)

**Цель:** happy-path баланс ≈ 85% знакомое/похожее / 15% открытия.

1. Сейчас `discoveryRatio` зашит в `balanceFamiliarity()` (`:876-881`):
   favorite=0.3, unfamiliar=0.7, popular=0.2, auto_mix=0.45.
2. Вынести в конфиг: таблица `reco_settings(key TEXT PRIMARY KEY, value TEXT)`
   (миграция) или env `RECO_DISCOVERY_RATIO` — **env проще, начать с него**;
   per-mode переопределения `RECO_DISCOVERY_RATIO_FAVORITE` и т.д.
3. Процедура (задокументировать в этом файле, выполнить через 1–2 недели
   после Фазы 2): смотрим `/quality?days=7`:
   - `earlySkipRate` на позициях 0–4 > 0.2 → discoveryRatio −0.05;
   - `canonicalRepeatRate` > 0.05 → +cooldown-часы / −discoveryRatio;
   - новые артисты принимаются < 10% → discoveryRatio +0.05;
   - целевой `earlySkipRate` < 0.15 при сохранении new-artist acceptance ≈ 15%.
4. Каждое изменение — запись в лог/комментарий: дата, старое → новое, метрики
   через неделю.

**Приёмка:** задокументированный чек-лист + конфигурируемые ratio; числа
baseline и post-tuning зафиксированы.

---

# Фаза 4 (опционально)

## T13 — Audio embeddings (Essentia sidecar)

- Для локальных FLAC: Python-джоба в сайдкаре (`server/sidecar/.venv` уже
  существует) — `essentia` (или облегчённый вариант: spectral-priznaki +
  усреднение). Эмбеддинг → таблица `audio_embeddings(track_id TEXT PRIMARY KEY,
  vector BLOB, dim INTEGER, updated_at INTEGER)`.
- Канал кандидатов: косинусная близость к сидам (считать в TS, вектора 128-d
  float32 — читать батчем). Вес ~4, ниже CF.
- **Осторожно:** essentia тяжёлая; ставить в отдельный venv, джоба только
  ночью, обрабатывать по 50 треков/прогон. Если установка essentia блочит —
  отложить тикет, он не критичен.

## T14 — Тематические станции («линейка волн»)

- `GET /api/recommendations/station?type=artist|genre&key=...` — тонкая
  обёртка над `buildStationTracks`: type=artist → seeds = топ треков артиста
  из кэша; type=genre → seeds = топ треков по тегу (T3). Никакого нового
  движка.
- Клиент: позже, отдельной задачей (UI-линейка на HomeView).

---

## Что НЕ делать

- Не менять протокол scrobble (`/api/recommendations/scrobble`) и формат
  `listening_history` — на них завязано всё.
- Не трогать `sessionTransitionSignals` — T6 строится рядом, не вместо.
- Не добавлять внешние зависимости в сервер без крайней нужды (LR — руками).
- Не хранить токены/секреты в новых таблицах и не логировать их.
- Не «улучшать» дизайн/UX клиента вне T1 (кнопка) и T8 (refill).

## Финальный чек-лист фаз

- **Фаза 1 done:** волна открывается с реальных лайков Яндекса; в выдаче есть
  соседи по графу; теги ≥80%; дизлайкнутое и недавнее не возвращается.
- **Фаза 2 done:** CF-канал работает; shadow-ранкер пишет оба скора; 3 скипа →
  замена 6 треков за секунду; лайк в сессии сдвигает волну.
- **Фаза 3 done:** `/quality` отвечает на вопрос «стало ли лучше» числами;
  варианты A/B сравнимы; discoveryRatio подкручен по измеренному скип-рейту.
