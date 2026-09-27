# Manafolio contributor guide

## Product scope

Manafolio is a self-hosted, multi-user Magic: The Gathering collection, storage, and deck manager. Physical and Arena inventories are separate; Wishlist plans acquisitions and Graveyard retains archived records without supplying owned totals or decks. The React/Vite frontend and Express backend share one SQLite collection database. Docker packages the web application for desktop and phone browsers.

Only Magic provider integrations are supported. Preserve existing records and their game identities when changing shared code; removing an integration must not delete or relabel stored collections.

Read [README.md](README.md) for installation and user workflows, [PROJECT.md](PROJECT.md) for architecture, and [PRIVACY.md](PRIVACY.md) for data handling.

## Entry points and ownership

| Area | Location and responsibility |
| --- | --- |
| Frontend startup | `frontend/src/main.jsx`: localization, application mount, and styles. |
| Session and navigation | `frontend/src/App.jsx`: auth-aware fetch, session/tab/toast state, lazy views, and public shares. |
| Backend composition | `backend/src/server.js`: middleware, route mounts, startup jobs, static files, and optional TLS. |
| Domain endpoints | `backend/src/routes/`: HTTP validation and account-scoped collection, storage, deck, import, and settings operations. |
| Persistence | `backend/src/db.js`: schema/migrations, shared connection, Promise SQL helpers, and transactions. |
| Shared policies | `backend/src/utils/`: provider selection, languages, prices, placement, TLS, and related domain rules. |
| Scanning | `backend/src/cvScan.js` and `backend/src/catalog.js`: matching and stateful catalogs; frontend camera components manage capture. |
| Appearance | `frontend/src/index.css`: shared tokens and themes; `frontend/src/arcane.css`: default dark Arcane Blue design. |
| Localization | `frontend/src/utils/i18n.jsx` and `frontend/src/locales/`: translation context and BCP-47 dictionaries. |
| Shared assets | `shared/`: runtime JSON and image-processing code; not an npm workspace. |

Production serves `frontend/dist` through Express after API routes. Docker persists databases, backups, TLS material, models, and catalogs under `/app/database`. Maintenance utilities live in `backend/scripts/`; they are not ordinary startup hooks.

## Local commands

Use npm. Root, backend, and frontend have separate manifests and lockfiles; this is not an npm workspace.

```sh
npm run install:all
npm run dev
npm run dev:backend
npm run dev:frontend
npm run build:frontend
npm test
npm start
```

Run package-specific commands from the corresponding directory, or use npm's prefix option:

```sh
npm run test:e2e --prefix backend
npm run lint --prefix frontend
npm run check:locales --prefix frontend
npm run preview --prefix frontend
docker compose up -d --build
```

Use `npm ci` separately in each package for reproducible installs. Development serves HTTPS at `https://localhost:5173`, with the backend at `http://localhost:3001`; Vite proxies `/api`, `/models`, and `/ort`. Both services are needed for ordinary development. A running `node src/server.js` needs a restart after backend edits; the backend development script watches for changes.

Follow the Node versions in Docker and CI when reproducing builds. Native dependencies such as `sqlite3`, `sharp`, and `onnxruntime-node` must be installed for the target platform; the production image uses Debian/glibc, not Alpine.

## Implementation rules

- **Module boundaries:** backend uses CommonJS; frontend uses ESM/JSX. Match each file's formatting. No formatter or TypeScript check is configured.
- **Naming:** camelCase values/functions, PascalCase React components, snake_case database/API fields. Persist game values in lower case.
- **Routes:** validate at the HTTP boundary, use parameterized SQL and `db.run/get/all`, catch asynchronous failures with operational logging, and return safe `{ error: '...' }` responses. Do not add raw callback-based SQLite operations.
- **Authorization:** account mutations use `req.user.id`, not client-supplied ownership. Preserve mount order: public auth/share/art paths must not accidentally pass through or bypass the wrong authenticated gate.
- **Transactions:** preserve WAL, migrations, and `withTransaction`. Collection, placement, reservations, and deck changes that form one operation must not leave partial state.
- **Providers:** normalize/cache through the existing Scryfall client. Reuse `cardApi` for supported stored card IDs; reject unsupported provider identities rather than guessing conversions or relabeling records.
- **Errors:** auth, ownership, and mutations fail explicitly. Noncritical warmups may remain nonblocking; do not move their downloads onto request paths.
- **React:** use function components and hooks; clean up requests/listeners in effects. Keep local loading/error state with its view. Use `useT()` and stable keys rather than literal UI copy.
- **Styles:** reuse existing tokens and classes. Scope Arcane Blue to the dark theme; retain other account themes, readable contrast, keyboard focus, and responsive controls. Keep the brand logo stationary.
- **Inventory:** Physical reservations must not consume Arena copies. Wishlist and Graveyard do not supply owned inventory. Respect existing archive/restore, missing-copy, and checkout rules rather than treating every stored card as available.
- **Placement:** storage positions use `slot * 1000`, not an array index. Preserve existing filing, locking, capacity, and transaction conventions.

## Runtime data and secrets

`.env.example` is the configuration reference. Preserve `DB_PATH`, TLS, CORS, `PUBLIC_BASE_URL`, `TRUST_PROXY`, bootstrap authentication, and supported credential semantics. Namespace changes require the documented offline migration; startup does not rename previous database files. Very old `sub_location_1` schemas take a destructive migration path: retain explicit operator warnings and offline-backup guidance.

Never commit real environment files, credentials, collection exports, SQLite/WAL files, build output, or downloaded models/catalogs. Screenshots and demos must use clearly identified sample data. Production must not inherit demo sessions or fixtures.

Scan assets are persistent downloads outside the image. A missing catalog must retain the `503 notBuilt` behavior; do not invent matches. Follow the existing capture/OCR safety gates rather than weakening automatic-add checks to improve apparent success rates.

## Verification

- Root `npm test` runs backend unit and E2E checks, then frontend utilities and locale validation.
- Backend assertions use Node/assert, not Jest/Vitest. Unit files live under `backend/test/`; `backend/test/e2e/` runs real Express processes serially.
- Set `DB_PATH` before importing database-dependent modules. Use a temporary database isolated by process and clean its database, WAL, and SHM files. Prefer real SQLite over mocked persistence.
- Provider checks remain deterministic/offline through checked-in fixtures and existing Axios interception.
- Frontend utility checks use `node:test` and `node:assert` alongside utilities. Do not add a testing framework.
- Frontend lint treats warnings as failures. Locale changes must pass `npm run check:locales --prefix frontend`; preserve English key order, placeholders, and language-specific plural forms.
- Exercise changed flows in the actual app as well as focused automated checks. For visual work, inspect desktop/mobile layouts and affected account themes.
- CI gates backend checks, frontend lint, and locale validation. No coverage threshold or coverage tool is configured.
