# Manafolio — Architecture & Developer Guide

Manafolio is a self-hosted **Magic: The Gathering collection, storage, and deck manager**. Its core domain is exact card printings and the copies a user keeps in Physical Collection, Arena, Wishlist, or Graveyard. Physical storage and deck reservations connect those records to the cards on the table; Arena stays a separate inventory.

This guide describes the current implementation and the contracts to preserve when changing it. For installation, migration, and user workflows, start with [README.md](README.md). Manafolio originated as a fork of Bindarr by thenotoriousJeremy and contributors; attribution remains in the [README](README.md#acknowledgments-and-license) and [MIT license](LICENSE).

## Contents

- [System overview](#system-overview)
- [Repository layout](#repository-layout)
- [Domain and data model](#domain-and-data-model)
- [Backend and API boundaries](#backend-and-api-boundaries)
- [Database transactions and persistence](#database-transactions-and-persistence)
- [Card data, languages, and prices](#card-data-languages-and-prices)
- [Storage and sorting](#storage-and-sorting)
- [Deck editing, checkout, and check-in](#deck-editing-checkout-and-check-in)
- [Imports, exports, and backups](#imports-exports-and-backups)
- [Image identification pipeline](#image-identification-pipeline)
- [Optional AI decks](#optional-ai-decks)
- [Frontend and Arcane Blue](#frontend-and-arcane-blue)
- [Development and verification](#development-and-verification)

## System overview

| Layer | Implementation |
| --- | --- |
| Browser | React SPA, Vite, Recharts, translated UI, account themes; ONNX corner detection in a worker |
| Server | Node.js, Express, Helmet, rate limiting, compressed API/static responses |
| Persistence | SQLite via `sqlite3`; one collection database, plus a separate rebuildable Scryfall bulk database |
| Magic data | Scryfall cards, sets, images, languages, prices, and token relations; MTGJSON preconstructed decklists |
| Scanning | `onnxruntime-node` and `sharp` for artwork matching; native Tesseract footer OCR |
| Optional AI | OpenAI Codex app-server, Gemini, OpenRouter, or a user-selected Ollama service |
| Delivery | One container serves API and built frontend to desktop and phone browsers |

The active search, scan, sets, statistics, and deck surfaces are Magic-focused. Lorcana data and provider tooling remain available. Preserve stored game and provider identities when maintaining shared code; removing an integration must not delete existing records or relabel them as Magic.

## Repository layout

Paths below are relative to the repository root.

| Path | Responsibility |
| --- | --- |
| `backend/src/server.js` | Middleware ordering, router mounts, readiness, startup jobs, static SPA, HTTP/HTTPS listeners |
| `backend/src/db.js` | SQLite connection, queued queries, transactions, schema initialization/migrations, password hashing |
| `backend/src/middleware/auth.js` | Session/API-key authentication, administrator checks, rate limiters |
| `backend/src/routes/` | HTTP handlers; see the route map below |
| `backend/src/scryfallApi.js` | Scryfall normalization, search, printing resolution, token relations, live price refresh |
| `backend/src/scryfallBulk.js`, `scryfallBulkSchedule.js` | Persistent bulk catalog and daily UTC download scheduling |
| `backend/src/mtgjsonApi.js` | Preconstructed deck discovery and downloads |
| `backend/src/utils/cardApi.js`, `cardCache.js` | Provider dispatch, hydration, and normalized cache writes |
| `backend/src/utils/collectionHelpers.js` | Shared placement, stack quantity, and checkout-allocation helpers |
| `backend/src/utils/compartmentSort.js` | Storage eligibility, sorting, stacking, and slot recommendations |
| `backend/src/utils/deckRules.js`, `aiDecks.js` | Deck validation and inventory-aware AI request/save rules |
| `backend/src/codexDeckClient.js`, `ollamaDeckClient.js`, `hostedDeckClient.js` | Provider-specific AI transport and lifecycle |
| `backend/src/cvScan.js`, `catalog.js`, `cardSets.js` | Scan inference, resumable artwork catalogs, and set caching |
| `backend/src/utils/scanOcr.js`, `modelAssets.js`, `npz.js` | Footer OCR, optional model downloads, published catalog reader |
| `backend/src/utils/priceHelpers.js` | Price precedence, timestamps, price-history recording, sweep gates |
| `backend/src/psaApi.js` | Certification lookup |
| `backend/src/cardArt.js`, `backup.js` | Artwork overrides and server-level SQLite snapshots |
| `backend/scripts/` | Model fetching, catalog tooling, and scan-gate measurements |
| `backend/test/`, `backend/test/e2e/` | Backend unit and HTTP integration runners |
| `frontend/src/main.jsx`, `App.jsx` | Initialization, translations, authentication state, fetch wrapper, tab-based navigation |
| `frontend/src/components/` | Collection, storage, deck, scanner, settings, administration, and shared views |
| `frontend/src/index.css`, `arcane.css` | Base/component/theme styles and the default dark Arcane Blue overrides |
| `frontend/src/utils/`, `locales/` | Display/domain helpers, scanner worker, translations, and frontend unit tests |
| `frontend/src/demo/` | Fixture-backed demonstration build, separate from a server installation |
| `shared/` | Shared card geometry and domain tables used by client and server |
| `Dockerfile`, `docker-compose.yml`, `.github/workflows/` | Container packaging, local deployment, and release/demo automation |

The main persistent assets are the collection database and its sidecars, automatic backups, TLS material, uploaded card art, Codex account data, scan models/catalogs, and the separate Scryfall bulk database. In Docker these live under `/app/database`; the Compose service mounts `manafolio-data` there. Models are explicitly downloaded rather than bundled in the image.

## Domain and data model

### Inventories and identity

| User-facing destination | `collection.list_type` | Supplies owned/deck inventory | Physical storage |
| --- | --- | --- | --- |
| Physical Collection | `collection` | Physical decks | Physical containers |
| Arena | `arena` | Arena decks | None |
| Wishlist | `wishlist` | No | None |
| Graveyard | `graveyard` | No; separate archived statistics | Graveyard containers |

`locations.inventory_type` is `collection` or `graveyard`; `decks.inventory_type` is `collection` or `arena`. These fields are related but are not interchangeable enums. Trade status is an `is_trade` flag, not a fifth inventory destination.

A provider card ID identifies an exact printing in `card_cache`. A `collection.id`, exposed as `entry_id`, identifies a user's stored entry. Storage highlights, edits, and pull lists use **entry identity**, not `card_id + position`, which can collide across compartments. Add paths normally create individual-copy rows; quantity-bearing rows and aggregated display stacks also exist, so consumers must sum `quantity`, not count rows.

Missing/Found is a flag on an entry, not deletion or archival. Individual inventory transfers clear incompatible placement. Archiving retains quantities and metadata but removes the cards from owned totals and deck supply. Restoring an individual card to Physical returns it to Unassigned Pile. A whole-container transfer instead preserves its layout and placements.

### Main tables

`db.js` creates the schema and applies column migrations. This is a domain map, not a substitute for the schema when writing SQL.

| Table | Meaning and important fields |
| --- | --- |
| `users` | Identity, PBKDF2 password hash, role, theme, share controls, OIDC subject, provider credentials, read-only API key, AI preferences |
| `sessions` | Opaque token, user ID, expiration |
| `card_cache` | Provider ID, `game`, searchable `name`, `printed_name`, language, set/number, art, Magic rules/identity fields, prices and currency/source |
| `collection` | User/card relationship, quantity, finish (`printing`), condition, language, purchase price, inventory, storage IDs/position, favorite/trade/missing flags, slab identity, per-copy value |
| `locations` | User-owned container, type, inventory, sorting/filter rules, locks, stacking and cover configuration |
| `compartments` | Ordered pages/rows within a container, capacity, label, rules, lock |
| `compartment_assignments` | Filing categories assigned to compartments |
| `decks` | User-owned definition, inventory, format, target size, commander, metadata, checkout state, wins/losses |
| `deck_cards` | Printing quantities per deck; `checked_out` here records **Pulled**, not the deck's reservation state |
| `sets` | Provider set metadata and ordering |
| `price_history` | Changed card prices over time |
| `notes` | User-owned notes and pinning |
| `app_settings` | Singleton settings row, including public URL and refresh schedules |
| `psa_cert` | Cached certification responses |
| `tcgplayer_product`, `set_data_gaps` | Lorcana scan mappings and shared catalog coverage gaps |

## Backend and API boundaries

### Request lifecycle and authentication

`server.js` applies security headers, CORS, body parsers, and compression before routing. The default JSON limit is 1 MB; `/api/import`, `/api/scan-match`, and `/api/search` receive a 15 MB parser. Do not infer that every import-related URL has the larger allowance.

Public routes are mounted deliberately **before** the single `app.use('/api', authenticateToken)` gate. Admin routes authenticate and authorize themselves; card-art reads are public and writes authenticate inside their router. Every remaining API router sits behind the central gate. Adding a router above it changes the security boundary.

- Login verifies a PBKDF2 password hash and creates an expiring opaque session in SQLite; this is not JWT authentication.
- Authentication resolves a Bearer token to `sessions` and `users`, then populates `req.user`.
- A token matching `users.api_key` instead is GET-only. `requireAdmin` rejects API keys even for administrator accounts, and `/auth/me` removes provider credentials from API-key responses.
- AI account/model/preferences and suggestion operations require a browser session. The read-only AI inventory endpoint remains accessible with an API key.
- Local auth/bootstrap and optional OIDC live in `routes/auth.js` and `utils/oidc.js`. Registration is closed unless `ALLOW_REGISTRATION=true`.
- On an empty installation, `DEFAULT_ADMIN_PASSWORD` seeds `admin`; otherwise `/api/auth/bootstrap` creates that account through first-run setup. Protect access until setup is complete. Passwords must not be logged.

`GET /api/health` is public, checks database readiness and a query, and returns `{"status":"ok"}` when healthy or HTTP 503 while unavailable. It is the Docker healthcheck target.

### Route map

File names in this table are under `backend/src/routes/`. The table groups actual router ownership rather than assigning every `/api` operation to `collection.js`.

| Mount | Module | Responsibilities |
| --- | --- | --- |
| `/api/auth` | `auth.js` | Config/bootstrap, registration/login/logout/me, OIDC, account settings/theme, API keys |
| `/api/shared` | `shared.js` | Opt-in public collection and container views by share token |
| `/api/admin` | `admin.js` | Users, seed data, catalogs/build/stop/progress, model assets, backup management |
| `/api/card-art` | `cardArt.js` | Public art index/images; authenticated upload/delete |
| `/api` | `collection.js` | Search, scan coverage/match, certification lookup, collection CRUD/bulk operations/placement/value, printing localization, related tokens, MTGJSON precons/import |
| `/api` | `storage.js` | Locations/compartments, locks/rules/covers, inventory transfer, recommend/recommend-batch/apply-all/resort |
| `/api` | `stats.js` | `/stats`, `/stats/history`, `/stats/networth`, `/cards/:id/price-history` |
| `/api` | `importExport.js` | `/export`, `/import/preview`, `/import`, `/import-container`, `/import-container/move` |
| `/api` | `notes.js` | `/notes` CRUD |
| `/api/sets` | `sets.js` | Magic set catalog |
| `/api/decks` | `decks.js` | CRUD, from-container, complete editor save, records, commander, duplicate, cards/Pulled, checkout/return, locations |
| `/api/ai-decks` | `aiDecks.js` | AI connection/preferences/models, eligible inventory, streamed suggestions, validated create/replace |
| `/api/settings` | `settings.js` | Effective settings/version, administrator changes and Scryfall bulk download |

The built frontend is served from `frontend/dist`. Non-API paths fall back to the SPA. `/models/cornelius.onnx` exposes only the public corner-model weights, not the entire model/catalog directory.

### Deployment security

- Helmet's CSP is **Report-Only**, not enforced protection. Its image/font allowlists and WebAssembly directive still matter when preparing enforcement.
- CORS allows configured public origins plus localhost/private-LAN origins. It is not authentication or an outbound network policy.
- Phone cameras require HTTPS. Built-in TLS supports persistent self-signed material or operator-provided certificates; use trusted TLS for remote access. Behind a TLS proxy, configure `TRUST_PROXY` correctly for rate limits.
- Public sharing is explicitly opt-in. Collection sharing and location disclosure have separate controls; Graveyard containers are not public physical-container shares.
- Treat database files, volume backups, provider tokens, TLS keys, and Codex account directories as sensitive. Client-side session tokens also require protection against script injection.

## Database transactions and persistence

The main SQLite connection enables foreign keys, WAL, and a five-second busy timeout. Promise wrappers `db.run/get/all` pass through a shared queue. `db.withTransaction(fn)` holds that queue across `BEGIN IMMEDIATE`, the callback, and commit/rollback; `AsyncLocalStorage` lets callback queries use the same transaction without deadlocking behind themselves. Nested transactions are rejected.

Use this helper for a multi-statement invariant rather than issuing ad hoc `BEGIN`/`COMMIT` calls. Without the queue boundary, another request's statements can enter the same connection's transaction. Keep domain validation and writes that must agree inside the transaction. Do not describe every mutation as transactional: for example, checkout currently performs its availability read and flag update as separate queries.

Current transactional workflows include complete deck editor saves, AI deck saves/replacements, precon import, collection import, account restore, container import/move, and Physical/Graveyard whole-container transfer. Their details differ: a transaction does not imply every unresolved row is fatal. In particular, ordinary collection import can report individual failures while saving valid entries; precon import with deck creation rejects unresolved cards rather than saving a partial deck.

### Migration and backup cautions

Use [the offline migration procedure](README.md#migrate-an-existing-installation) before changing an existing deployment. Preserve the entire stopped data directory, mount identity, ownership, and matching WAL/SHM sidecars; a WAL can contain committed data not yet in the main file. Never treat an unexpected setup screen as permission to initialize a replacement database.

Startup does not rename previous database files; complete the offline procedure before restarting. **Very old schemas containing `collection.sub_location_1` trigger a destructive collection/location reset in `initDb`.** Back up and inspect such databases before starting this version; automatic initialization is not a lossless upgrade for that schema.

Server snapshots are handled by `backup.js`. For an offline whole-volume copy, stop all writers and retain the database and any sidecars together. Snapshots stored only in the same volume do not protect against loss of that volume.

## Card data, languages, and prices

### Magic catalog and normalization

`Scryfall → scryfallApi.normalizeCard → utils/cardCache.cacheNormalizedCards → card_cache` is the main card-data path. Cache writes use upserts so refreshing a provider's fields does not delete/recreate a row or reset unrelated metadata. Keep normalized fields aligned with consumers and database selections.

The Scryfall bulk catalog lives at `<DB_PATH>.scryfall-bulk.sqlite`. `scryfallBulk.js` builds and validates a temporary replacement before publishing it, preserving the previous catalog if an update fails. `scryfallBulkSchedule.js` controls the daily UTC refresh; settings default to 10:00 UTC. A missing catalog warms in the background. Imports use local identifier/name resolution first and API fallback for unresolved rows; they do not wait for a full bulk download. Live price sweeps and stale-cache refreshes keep the API path rather than reusing snapshot prices.

MTGJSON provides precon lists, not user ownership. Scryfall supplies token relations. Related-token ownership is inventory-scoped and name-based, including front names of double-faced tokens; same-named tokens can differ in rules or stats, so the UI must not imply an exact printing/rules match. Token references do not count as deck slots or reserve copies.

### Names and printing languages

`card_cache.name` is the searchable/canonical name; `printed_name` is the localized name on the card. Display helpers use `printed_name || name`; search considers both. Name-based copy rules, marketplace queries, and exports must not accidentally split the same card solely because its printed name differs.

A requested language must resolve to a real printing, not overwrite the language label on an English row. `cardApi.printingInLanguage` and Scryfall's set/collector-number lookup perform that resolution for add flows. Scan fallback retains the actual printing and reports language mismatch when it cannot confirm the requested language.

### Pricing and analytics

`utils/priceHelpers.resolveCardPrice` resolves a **positive** per-copy `market_value` first, then an available positive finish-specific price, then `price_trend` (or zero). Queries that value owned copies must select the per-copy value as well as provider price columns. `frontend/src/utils/resolveCardPrice.js` mirrors display-side precedence.

Scryfall pricing chooses a consistent source currency for a row, using USD where applicable and EUR fallback rather than mixing USD normal with EUR foil prices. `price_source` and `price_currency` travel with the record. **No exchange-rate conversion occurs.** Mixed-currency sums are not a converted portfolio value; net-worth responses include currency information.

A manually entered copy value writes `market_value` with source/timestamp metadata. Certification lookup identifies the slab; it is not a market quote. Automatic graded-price lookup is not provided.

`price_history` records price changes rather than duplicate points on every sweep. Parse SQLite's naive timestamp strings as UTC through `parseSqliteUtc`. Dashboard growth is derived from retained owned quantities and original addition dates, not an immutable acquisition ledger. Deck performance is saved wins/losses, not match history. Graveyard analytics are separate and reflect currently archived entries, not historical archive membership.

### Lorcana data

`lorcastApi.js` supplies Disney Lorcana cards and prices. Shared dispatch in `utils/cardApi.js` handles supported stored IDs. Do not guess cross-provider conversions or reinterpret unsupported records as Magic cards.

## Storage and sorting

`utils/compartmentSort.js` chooses eligible compartments and positions. `utils/collectionHelpers.js` is the neutral shared module for collection, storage, and import routes; those route modules should not import each other to share helpers.

- Locations contain ordered compartments: binder pages, box rows, and other layouts. Rules and locks affect filing eligibility.
- Stored `position` uses slot-scale units: slot 1 is 1000, slot 2 is 2000. Fractional offsets can distinguish split copies before rebalancing. Use the existing position/display helpers rather than a rendered array index.
- Custom sorting preserves manual order; structured comparators support name, set/number, price, type/color, language, and finish ordering. The same categories drive storage dividers.
- Capacity depends on stacking configuration: a stacking container counts eligible stacks/slots rather than treating every duplicate as a new pocket.
- Storage assignment must validate user ownership, the compartment's parent container, and matching inventory. Physical cards cannot silently land in Graveyard storage or vice versa.
- Whole-container transfer changes the container and all contained entries atomically, preserving placement/configuration. It rejects locked containers/compartments and reserved copies. Individual archive/restore has different placement semantics.
- ManaBox container import files matching **already-owned** physical copies; it does not add missing inventory. Follow-up move requests fill the remaining requested quantities without moving the same copies twice. Missing and nonphysical entries are excluded, and the destination must retain the required unlocked/custom/unrestricted layout.

## Deck editing, checkout, and check-in

`DeckBuilder` maintains a local draft. `PUT /api/decks/:id/editor` validates and writes properties, quantities, Pulled state, and commander in one transaction; a failure rolls the save back. The UI keeps a failed draft for retry and guards navigation with unsaved changes. Win/loss record updates are separate operations.

Deck definitions use one inventory. Switching inventory requires destination ownership and an unchecked-out deck. `utils/deckRules.js` owns shared addition/copy-limit checks. Commander selection is a single existing card; the UI's commander workflow is not a promise of full tournament legality, partner commanders, or sideboards.

Physical checkout reserves quantities by setting `decks.checked_out` and `checked_out_at`; it does **not** move collection entries. Availability subtracts copies reserved by other checked-out Physical decks. Arena decks cannot check out.

`GET /api/decks/:id/locations` provides specific entries, containers, compartments, slot positions, and missing counts for the pull list. `checkedOutAllocation` assigns reserved quantities to entries so storage can grey out the same copies. These allocations are derived, not separate permanent reservation rows. **Pulled** is the per-deck-card checklist state (`deck_cards.checked_out`), distinct from the deck-level reservation flag.

Return clears the deck-level reservation state. Checkout/check-in use the same stored location for pulling and re-filing. Return a deck before changing its composition or archiving its reserved copies. Storage reassignment itself need not release a reservation.

`POST /api/decks/from-container` uses a physical container's complete saved contents, not the current UI selection/filter. It creates an unchecked-out definition without moving cards, and can include missing/reserved copies that must be resolved before play. Duplicating a deck copies its definition/metadata, not its checkout state or win/loss record.

## Imports, exports, and backups

`routes/importExport.js` handles CSV/TXT review, collection import, account backup/restore, and ManaBox container workflows. Mapping and export helpers live under `backend/src/utils/`.

- Import preview is validation and mapping, not a committed save. Progress distinguishes lookup/preparation from saving; losing the progress connection does not roll back an in-flight import. Check the destination before retrying.
- Collection-view CSV/TXT export represents the matching view across pages, including its inventory, filters, ordering, and stacking. It is not a whole-account backup.
- Complete account backup uses the `manafolio-backup` format. Restore replaces the signed-in user's collection, storage, and decks in a transaction rather than merging. Preserve the original export before any explicit format-marker conversion; see [account backup instructions](README.md#back-up-or-move-an-account).
- Account JSON contains collection/storage/deck data and cached card metadata, not login/provider credentials or the entire server. Whole-volume backups have a different scope and can contain Codex credentials and TLS private keys.
- Precon import is handled in `collection.js`: Scryfall resolves MTGJSON entries, optional storage is sized for the cards, and optional deck creation checks out the imported Physical deck. With deck creation requested, unresolved entries fail the operation rather than producing a partial deck.

## Image identification pipeline

Scanning is a beta artwork-matching workflow with footer verification, not general card OCR or condition/foil detection. It needs the optional models, a usable catalog, and native OCR. Source and Docker setup steps are in [README.md](README.md#card-scanning).

### Capture and match

1. `frontend/src/utils/detectWorker.js` runs **cornelius** in a worker via `onnxruntime-web`, drawing the live corner outline. `CameraScanner.localDewarp` uses shared geometry to rectify the captured card to 896×896 pixels, retaining footer detail for OCR.
2. `cvScan.match` accepts a rectified upload (`cropped: true`) without repeating corner detection. A whole frame instead goes through server-side detection/dewarping. The embedder receives a 448×448 image.
3. **milo** produces a 128-dimensional normalized embedding. The server sweeps normalized catalog vectors with dot products (cosine similarity), merges/deduplicates hits, and returns ranked candidates.
4. `/api/scan-match` hydrates Scryfall printings, resolves requested language where possible, evaluates blur/glare/context, and applies `utils/scanOcr.js` to the rectified footer.
5. The client requires **two fresh decoded video frames** to agree on the resolved printing and pass safety checks before auto-add, including Turbo. Changes to settings, pause, and unmount cancel verification; network failure is not agreement.

The shared image geometry lives in `shared/imgproc.mjs` and `shared/cardDetectPure.mjs`. Do not create a different preview crop from the one used for matching.

### Gates and limitations

A nearest-neighbor search always returns a nearest row, even when the real card is absent. `CV_SCAN_GAP` (default 0.10) gates the winner against ranks 2–11 within **its own catalog**, avoiding duplicate-language matches flattening the neighborhood. `notInCatalog` preserves manual candidates but blocks automatic addition.

Set scope filters rows before scoring, separately for each catalog. A catalog with no in-scope rows is not silently searched unscoped as if it satisfied the filter. Global fallback is reported as `set_fallback` and requires manual selection. Requested-language and English fallback catalogs may both contribute; unresolved printing language reports `language_fallback` and also blocks auto-add.

The response's `safety` object contains `autoAddSafe`, reason codes, OCR status, quality flags, and context. Near ties/same-artwork printings remain ambiguous unless corroborating evidence narrows them. OCR only corroborates visually plausible candidates: an exact cached footer match outside that shortlist can be shown manually but cannot acquire an invented visual score.

`scanOcr.js` spawns **`/usr/bin/tesseract`**, without a shell, using `eng` data. The Docker runtime installs it there; a source installation must provide that path, not merely a differently located executable on PATH. Processing has bounded image/output sizes, a five-second subprocess timeout, and at most two concurrent jobs. Missing OCR, execution errors, and conflicting readings block auto-add while preserving manual candidates. An `unreadable` result supplies no corroborating evidence but is **not by itself** an auto-add rejection in the current gate; artwork, ambiguity, quality, and context checks still apply.

These checks are heuristics, not guaranteed printing accuracy. Older footers, sleeves, glare, focus, and reprinted artwork require care. No gate detects condition or finish.

### Models and catalogs

[cornelius](https://huggingface.co/HanClinto/cornelius) and [milo](https://huggingface.co/HanClinto/milo) carry **AGPL-3.0** licenses; Manafolio code is MIT. The models are not bundled in the repository/image. Operators deliberately fetch them using `node scripts/fetch-models.mjs` from `backend/` (or the README's Docker command), with optional published catalogs via `--catalogs`. Review the model licenses before redistribution.

`CV_MODEL_DIR` holds models and catalogs: source default `backend/data/models`, Docker `/app/database/models`. Keep the Docker directory on the persistent volume. Models alone do not identify cards. A missing usable catalog returns HTTP 503 with `notBuilt`, not a misleading empty match list.

`catalog.js` builds a `(game, language)` catalog in two resumable phases:

1. Cache the provider's sets/cards with `cardSets.cacheSetCards`.
2. Embed available artwork and write `milo-<game>[-<language>]-local.bin` plus JSON IDs/dimensions/source URLs.

Completed vectors with unchanged embedded source URLs are reused; stopped builds retain partial work. Scoped set builds merge into the existing local catalog. Local catalogs use `card_cache.id` and take precedence over published NPZ catalogs. Coverage denominators distinguish a completed build from complete provider coverage. The active Admin catalog language picker requests Magic; retained catalog tooling can still contain other games.

For a catalog-backed diagnostic, run from `backend/`:

```bash
node scripts/measure-scan-floor.js mtg English 60
```

The harness samples catalog rows, degrades reference art, compares genuine matches with the same rows masked out, and sweeps candidate thresholds. It requires models/catalog data and reference-art access. Synthetic degradation is not a substitute for real-camera verification and does not model every glare/shadow condition; do not turn historical sample measurements into current accuracy promises.

## Optional AI decks

`routes/aiDecks.js` orchestrates provider requests; `utils/aiDecks.js` selects eligible inventory, constructs bounded payloads, validates drafts, and rechecks saves. `AiDeckBuilder` is a review/edit surface, not automatic collection mutation. A suggestion, conversation reply, or progress event is not a saved deck.

Inventory is scoped to the signed-in user and selected Physical/Arena destination, with optional color/set/container filters. Missing physical copies are excluded. Including checked-out cards permits planning with them, not sharing their reservations. Improving a saved deck can retain eligible source-deck copies despite its own reservation/filters; other decks' reservations still matter. Create/replace revalidates ownership, quantities, and cached rules transactionally. Replacing a checked-out deck is rejected; saving never moves cards or checks out a deck.

ChatGPT integration uses the pinned official Codex app-server package and device login, with per-user data under `<database-directory>/codex/<user-id>/`. The client disables model host-file, command, and external-tool access, rejects unsupported app-server actions, and requires a Unix server. Administrators can still read persisted credentials. Disconnect removes the user's local Codex data; account JSON backups exclude it, but volume backups include it.

Ollama uses the selected HTTP(S) address or `OLLAMA_BASE_URL`, defaults to server loopback, requires an installed structured-output model, and does not silently fall back to ChatGPT. Requests originate from the **server**. URL syntax validation is not a destination allowlist: signed-in users can reach server-accessible private/LAN services. Use trusted accounts and outbound firewall controls, and do not expose an unauthenticated Ollama port publicly.

Gemini and OpenRouter use fixed official API endpoints and per-user/provider keys stored in the users table. Browser-session-only credential endpoints never return keys; account JSON exports omit them, while SQLite/volume backups include them. Users explicitly select a model; hosted requests do not fall back to a different model/provider. Structured responses still pass the shared inventory and draft validation before review or saving.

Requests contain eligible card metadata/counts, conversation, and the current draft. Keep storage identities, saved private notes, other users' records, and saved source-deck descriptions out of provider context. User-edited draft descriptions are part of the sent draft. Suggestions are limited by cached rule data and provider output quality; invalid/incomplete or oversized requests are rejected, not silently trimmed into a different deck. See [the AI workflow and security instructions](README.md#get-an-ai-deck-recommendation).

## Frontend and Arcane Blue

`App.jsx` holds session/user state and tab navigation, lazily loads major views, and wraps API fetches with a Bearer header and session-aware logout handling. `/share/:token` and shared-container views are unauthenticated surfaces. The web client uses relative `/api` requests to its server; the demonstration build installs fixture-backed behavior before rendering and is not a writable server.

| Components | Responsibility |
| --- | --- |
| `Login`, `SetupWizard` | Sign-in and first-run configuration |
| `Dashboard`, `DashboardAnalytics`, `PriceHistoryChart` | Inventory value, growth, deck comparisons, and accessible chart data |
| `AddCards`, `CardSearch`, `MtgDeckImport` | Search/rapid add, collection imports, precons, scanner entry |
| `CameraScanner` | Camera/detection/capture, verification, candidate review, add flow |
| `CollectionList`, `CardInspectorModal`, `RelatedTokens` | Inventory views, bulk operations, copy metadata, token references |
| `LocationManager`, `CompartmentView`, `CreateContainerModal`, `SortFilterBuilder` | Storage gallery/layout, filing, rules, capacity, covers, archives |
| `DeckBuilder`, `CheckoutWizardModal`, `AiDeckBuilder` | Local deck draft, play/pull list, draw simulation, AI drafts |
| `Settings`, `CodexSettings`, `AdminPanel`, `CatalogPanel` | Preferences, AI connections, user administration, scan assets |
| `SharedCollection`, `SharedContainer`, `Notes` | Public sharing and private notes |

Pricing, sorting, names/languages, printing/rarity, card options, and shuffling reuse the helpers in `frontend/src/utils/`. `I18nProvider` and locale JSON provide translations with English fallback; shared tables and geometry prevent client/server domain drift.

### Styling contract

`main.jsx` imports **`index.css` first, then `arcane.css`**. Arcane Blue remains the default `dark` account theme. The supported keys are `dark`, `jenny`, `mana-white`, `mana-blue`, `mana-black`, `mana-red`, `mana-green`, and `mana-colorless`, defined in `shared/themes.json`. Account settings, API validation, startup theme selection, and public-share query parameters use this same list. Unsupported or retired themes fall back to `dark`; database startup normalizes obsolete account preferences without changing inventory or game identities.

`arcane.css` supplies layered surfaces, luminous controls, typography, tables/cards, and focus indicators for Arcane Blue and the six explicitly scoped mana palettes. White uses ivory/gold over warm charcoal; Blue deep sea/cyan; Black charcoal/violet; Red ember; Green forest; Colorless slate/silver. Jenny retains its separate palette. Outfit carries controls and data; Cinzel is reserved for page titles, and the existing logo stays stationary and metallic. Shared layout classes and responsive behavior remain unchanged. Preserve keyboard focus, disabled states, browser zoom, and chart-data access when changing appearance.

The dashboard uses a compact owned-count/value summary with supporting cost/gain figures and grouped analytics. Collection pagination appears only for multiple pages; ownership, location, and deck actions precede pricing in the inspector. Storage creation is a heading action, not a gallery item. Deck capacity status describes the target count rather than promising format legality. Rarity edges and foil treatments are static; motion is reserved for meaningful state changes.

## Development and verification

Installation prerequisites are in [README.md](README.md#development) and environment settings in [`.env.example`](.env.example). Match the installed toolchain's engine requirements as well as the checked-in container configuration.

From the repository root:

```bash
npm run install:all
npm run dev
```

The Vite frontend uses `https://localhost:5173`; the API uses `http://localhost:3001`. `frontend/vite.config.js` proxies `/api`, `/models`, and `/ort` to port 3001. The frontend's `predev`/`prebuild` scripts stage ONNX browser runtime assets. Backend `npm run dev` uses nodemon; `npm start`/production `node src/server.js` do not reload automatically.

| Command from repository root | Scope |
| --- | --- |
| `npm test` | Backend unit runner and HTTP e2e runner, then frontend utility tests and locale checks |
| `npm test --prefix backend` | Backend unit and e2e runners |
| `npm run test:e2e --prefix backend` | Backend e2e only |
| `npm test --prefix frontend` | Node frontend utility tests plus locale validation |
| `npm run lint --prefix frontend` | ESLint, zero warnings |
| `npm run check:locales --prefix frontend` | Translation key/placeholder checks |
| `npm run build:frontend` | Production frontend build |
| `npm start` | Backend serving API and an existing `frontend/dist` build |

When changing a workflow, exercise the actual user path as well as relevant tests: inventory boundaries, ownership checks, rollback behavior, lost progress connections, deck draft saves, and physical placement are consumer-visible contracts. Scanner validation needs actual models/catalogs and camera conditions; AI verification needs the selected provider. Do not claim these optional integrations were exercised by an unrelated unit suite.
