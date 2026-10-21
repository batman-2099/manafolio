<div align="center">

<img src="frontend/public/logo.svg" width="120" height="120" alt="Manafolio" />

# Manafolio

**Magic collection, storage, and decks on your own server.**

[Install](#install) · [User guide](docs/USER_GUIDE.md) · [Screenshots](#screenshots) · [Documentation](#documentation) · [Get help](#help-and-contributing)

</div>

Manafolio is a self-hosted, multi-user collection, storage, and deck manager for **Magic: The Gathering**. Track exact printings, find the box holding a copy, and prepare decks for play without mixing physical ownership with Arena inventory.

Built with React, Express, and SQLite, it runs as one Docker service or from source and works in desktop and phone browsers. No hosted Manafolio account or AI subscription is required.

## Features

- **Separate inventories:** Physical and Arena collections, Wishlist acquisition plans, and Graveyard archives. Wishlist and Graveyard do not inflate owned totals.
- **Collection management:** Search exact printings, track condition, finish, language, purchase prices, and graded slabs; check set completion and estimated value.
- **[Double-sided tokens](docs/USER_GUIDE.md#track-a-double-sided-token):** Choose a same-set reverse when adding a token, or leave an unknown/blank back unpaired. A unique collector-number match selects the reverse automatically. Search either face and see both images in card details and container galleries, while tracking one physical quantity, storage location, and checkout allocation. Cards from Token/Tokens sets are recognized as tokens even without token type metadata.
- **Physical storage:** Organize boxes and binders by page, row, and slot; group containers into storage units, print QR labels, and reconcile copies with Take Stock.
- **[Tokens in storage](docs/USER_GUIDE.md#capacity-stacking-and-locks):** Container galleries give tokens their own section. Deck Boxes exclude tokens from card totals and over-limit warnings; other container types still count them. Tokens remain selectable and included in Take Stock.
- **Deck building and play:** Import lists and precons, choose commanders, simulate draws, track results, compare revisions, and reserve physical copies with storage-aware pull lists.
- **Planning and trading:** Combine deck shortfalls into a Shopping List, add confirmed deficits to Wishlist, and review both sides of a Physical inventory exchange.
- **Import, export, and recovery:** Review collection imports, export filtered views or decklists, and create complete account backups and server snapshots.
- **Scanning and price checks:** Identify printing candidates with local models and OCR. Review scans before adding inventory, or check prices without adding cards. Requires [server scan setup](docs/INSTALLATION.md#card-scanning).
- **Optional AI:** Use your own ChatGPT/Codex account, Gemini or OpenRouter key, or Ollama service; review and edit suggestions before saving.
- **Your own server:** Multi-user accounts, invite-only registration by default, read-only API keys, opt-in public shares, account themes, translated interfaces, and opt-in text-only offline collection lookup.

## Install

For a **new installation**, install Docker with Compose, then run:

```bash
git clone https://github.com/batman-2099/manafolio.git
cd manafolio
docker compose up -d --build
```

Open **http://localhost:3001**. Without `DEFAULT_ADMIN_PASSWORD`, the first browser visit creates the owner account; **protect access until setup is complete**. With that variable set, startup creates `admin` when no users exist and the first visit shows login. Registration is invite-only unless explicitly enabled.

The `manafolio-data` volume holds the database, backups, TLS material, scan models, and catalogs. Keep protected backups outside that volume. Use **HTTPS for remote access and phone scanning**.

**Existing installation?** Read the [offline migration procedure](docs/INSTALLATION.md#migrate-an-existing-installation) before starting a renamed or moved deployment. Back up the stopped data directory first; very old `sub_location_1` schemas take a destructive migration path. An unexpected owner-creation screen means you should stop and check the volume mount and `DB_PATH`, not initialize a replacement collection.

See the [installation guide](docs/INSTALLATION.md) for updates, configuration, HTTPS/reverse proxies, phone access, and scanning assets. Available environment variables are documented in [`.env.example`](.env.example).

## Screenshots

### Dashboard

Collection totals, valuation, and inventory breakdowns.

![Manafolio dashboard with sample collection statistics and charts](docs/images/manafolio-dashboard.webp)

### Deck Builder

Deck definitions and the inventory supplying them.

![Manafolio Deck Builder showing decks](docs/images/manafolio-decks.webp)

<details>
<summary>More screenshots: collection, storage, trading, card backs, and AI</summary>

### Collection

![Manafolio collection showing sample Magic cards and collection controls](docs/images/manafolio-collection.webp)

### Storage

![Manafolio storage gallery with sample card containers](docs/images/manafolio-storage.webp)

### Trade workbench

Build both sides of an exchange, then adjust selected quantities before review. This snapshot uses **sample data**, not a personal collection or a completed trade.

![Manafolio Trade workbench with Giving and Receiving card panels and selected entries in Cards being traded](docs/images/manafolio-trade-workbench.webp)

### Customize card back

Preview a sleeve design, solid color, or custom image before saving it for your deck.

![Manafolio Customize card back dialog showing an Ultra PRO Chocobo sleeve preview, image controls, and Save and Cancel buttons](docs/images/manafolio-card-back.webp)

### AI Deck Builder

Choose inventory filters, format, play style, and target power level. Live AI requests are disabled in the demo.

![Manafolio AI Deck Builder options showing inventory filters, Aggro archetype guidance, and the target power-level slider](docs/images/manafolio-ai-options.webp)

</details>

## Documentation

| Guide | What it covers |
| --- | --- |
| [Installation and administration](docs/INSTALLATION.md) | Docker, upgrades/migration, configuration, HTTPS, native SSO, scanning assets, and Ollama deployment |
| [User guide](docs/USER_GUIDE.md) | Collection, storage, decks, trading, shopping, scanning, AI, sharing, and troubleshooting |
| [Backup and restore](docs/USER_GUIDE.md#back-up-restore-or-move-account-data) | Complete account exports, destructive restore warnings, and format compatibility |
| [Server backups](docs/USER_GUIDE.md#take-a-server-backup) | SQLite snapshots and offline whole-volume recovery precautions |
| [Offline collection lookup](docs/USER_GUIDE.md#look-up-your-collection-without-your-server) | Opt-in setup, trusted-device requirements, and read-only limits |
| [Dashboard analytics](docs/USER_GUIDE.md#what-the-numbers-mean) | What the charts count and how to interpret them |
| [API access](PROJECT.md#api-access) | Read-only keys, example requests, and health checks |
| [Architecture and development](PROJECT.md) | Components, data model, security boundaries, and verification commands |
| [Privacy](PRIVACY.md) | Stored data, external services, credentials, and operator responsibilities |

The user guide is also available under **How-to** in the app (**More → How-to** on a phone), with full-guide search and chapter navigation. Guide text is currently English. Returning after an update? Start with [recent workflow changes](docs/USER_GUIDE.md#catch-up-with-recent-changes).

## Help and contributing

Start with [troubleshooting](docs/USER_GUIDE.md#troubleshooting). For bugs or feature requests, use the [issue tracker](https://github.com/batman-2099/manafolio/issues). Include your version, browser/device, reproduction steps, and relevant errors—never credentials or private collection exports. For account or hosting problems, contact your server administrator.

Contributions are welcome through pull requests. Read the [contributor guide](AGENTS.md) and [architecture guide](PROJECT.md) before changing application behavior.

### Development

Use Node 20.19+ within Node 20, or Node 22.12+ (including newer major versions), and npm 9+. Prefer a currently supported LTS release; these minimums match the locked Vite toolchain and SQLite dependency. Shared JSON uses native import attributes.

```bash
npm run install:all
npm run dev
```

Frontend: `https://localhost:5173`. Backend: `http://localhost:3001`.

Run `npm test` from the repository root. Before submitting frontend changes, also run `npm run lint --prefix frontend`, `npm run check:locales --prefix frontend`, and `npm run build:frontend`. See [development and verification](PROJECT.md#development-and-verification) for command details.

### Translating

Follow the [translation guide](docs/TRANSLATING.md) to add or update a language. Start from [`en.json`](frontend/src/locales/en.json), preserve placeholders and plural forms, and submit a pull request. Missing keys fall back to English.

## Acknowledgments and license

Manafolio began as a fork of [Bindarr](https://github.com/thenotoriousJeremy/bindarr), by **thenotoriousJeremy and contributors**, based on upstream **1.8.5**. Thank you for the foundation.

Licensed under the [MIT License](LICENSE).
