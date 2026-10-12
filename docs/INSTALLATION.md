# Installation and server configuration

[Back to Manafolio](../README.md) · [User guide](USER_GUIDE.md)

## Docker

Clone [the Manafolio repository](https://github.com/batman-2099/manafolio) and build the checked-in Compose service:

```bash
git clone https://github.com/batman-2099/manafolio.git
cd manafolio
docker compose up -d --build
```

Open `http://localhost:3001`. Without `DEFAULT_ADMIN_PASSWORD`, the first browser visit creates the owner account; protect access until setup is complete. With it set, startup creates the `admin` account when no users exist, and the first visit is a regular login. Registration is invite-only unless explicitly enabled.

The `manafolio-data` volume contains the SQLite database, automatic backups, TLS material, scan models, and catalogs. To configure optional variables in Compose, uncomment the `environment:` header and the desired entries below it; [`.env.example`](../.env.example) documents available settings. Builds use local source, not an assumed published image or binary. After updating your checkout, run `docker compose up -d --build` again. Existing installations must follow the [migration instructions](#migrate-an-existing-installation) first.

## Migrate an existing installation

Manafolio uses its own database, deployment, browser, and backup names. Startup does not rename previous database files or migrate deployment volumes, browser state, or backup formats. Follow the offline procedure before starting the new service. **Do not start the new service against an empty replacement volume.**

1. Record the current `DB_PATH`, Compose project/volume names, and persistent-data location. Stop every service that can write to the database, then make an offline backup of the entire data directory outside the deployment. Keep the original volume until migration is verified.
2. With all writers stopped, rename the collection database to `manafolio.db` and any matching `-wal` and `-shm` sidecars to `manafolio.db-wal` and `manafolio.db-shm`. Keep them together; never discard a WAL that may contain committed data or overwrite an existing destination.
3. Rename `<previous-DB_PATH>.scryfall-bulk.sqlite` to `manafolio.db.scryfall-bulk.sqlite` in the same directory, including matching sidecars. This rebuildable catalog is not the collection database.
4. Update `.env`, service definitions, external scripts, and mounts. Docker uses `/app/database/manafolio.db`; source defaults to `backend/database/manafolio.db`. Copy the stopped persistent volume's complete contents into the new `manafolio-data` volume, preserving ownership, permissions, backups, TLS material, models, catalogs, and account credentials. Compose project names affect actual volume names: inspect the resolved mount rather than assuming it.
5. Rebuild and restart. Verify accounts, collection quantities, storage, decks, and backups before retiring the old deployment. If a populated installation shows owner creation, stop and correct the mount or `DB_PATH`; do not initialize a replacement collection.

Very old databases containing the `sub_location_1` schema take a destructive legacy migration path that drops collection and location tables. Preserve a verified offline copy and review [`backend/src/db.js`](../backend/src/db.js) before starting Manafolio against such a database.

Browser keys use `manafolio_*`: sign in again and reselect browser-only preferences; old keys are not migrated. Older compatible JSON exports need the explicit [backup format conversion](USER_GUIDE.md#restore-a-backup-into-the-signed-in-account) before restore.

For server recovery, preserve the persistent volume and keep protected backups outside it; snapshots in the same volume do not protect against losing that volume. Stop database writers before an offline whole-volume copy, retaining the database and any WAL/SHM files together. Whole-volume backups may include account credentials and TLS private keys. See [Take a server backup](USER_GUIDE.md#take-a-server-backup) for the administrator's backup controls.

## HTTP, HTTPS, and reverse proxies

| Port | Use |
| --- | --- |
| `3001` | Localhost or a reverse proxy that terminates TLS. |
| `3443` | Direct HTTPS, including camera use from a phone. |

Use HTTPS for remote access. The built-in self-signed certificate is generated in the persistent volume; browsers require explicit acceptance per device. Set `SSL_CERT_PATH` and `SSL_KEY_PATH` to use a trusted certificate. Behind a TLS-terminating reverse proxy, set `TRUST_PROXY=1` and usually publish only port `3001`.

## Configuration

The canonical list is [`.env.example`](../.env.example).

For source or downloaded-server installations, copy `.env.example` to `backend/.env` (the release's `app/backend/.env`). The server and maintenance scripts in `backend/scripts/` keep existing process variables first, then load `.env` from the working directory, then `backend/.env` as a fallback. Leave `DB_PATH` unset to retain the source default regardless of working directory. Use an absolute path for an override; existing relative overrides are still resolved from the process's working directory. In Docker, set variables in Compose rather than copying the source example over the image's defaults.

| Variable | Purpose |
| --- | --- |
| `DB_PATH` | SQLite database path; unset defaults to `backend/database/manafolio.db`, while Docker supplies `/app/database/manafolio.db`. |
| `DEFAULT_ADMIN_PASSWORD` | Bootstrap `admin` password only when no users exist. |
| `PUBLIC_BASE_URL` | External URL for share links and an allowed CORS origin. |
| `TRUST_PROXY` | Reverse-proxy hop count, commonly `1`. |
| `HTTPS_PORT` | Built-in HTTPS port; empty for HTTP-only operation. |
| `SSL_CERT_PATH` / `SSL_KEY_PATH` | Trusted TLS certificate and key. |
| `ALLOW_REGISTRATION` | `true` enables public self-registration. |
| `CV_MODEL_DIR` | Persistent scan models and catalogs. |
| `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP_LAST` | Automatic SQLite snapshot schedule and retention. |
| `OLLAMA_BASE_URL` | Default Ollama service address; users may choose their own. |

## Phone browsers

Open your server's HTTPS address in your phone's browser and sign in with your server account. The responsive web interface includes collection, storage, decks, and [camera scanning](USER_GUIDE.md#scan-physical-cards-with-a-camera); scanning requires browser camera permission and the [server-side assets](#card-scanning) described below.

## Native SSO handoff

The server also supports Android sign-in through an external browser/Custom Tab when the existing OIDC integration is enabled. `GET /api/auth/config` advertises `nativeOidcEnabled`; older servers without that marker do not support this handoff. Keep the identity provider's registered redirect at your server's existing `/api/auth/oidc/callback`, **not** the Android custom URI. No additional IdP client secret belongs in the app, and existing browser sign-in and account provisioning/linking policies are unchanged.

The app supplies its own S256 PKCE challenge and random state to `/api/auth/native/login`, with the only allowed return URI `app.manafolio.app://auth/callback`. After browser sign-in, that callback receives a single-use opaque code, never a reusable session. The app exchanges the code, state, and verifier over your server's trusted HTTPS connection at `/api/auth/native/exchange`. Codes expire after 90 seconds; a server restart or a lost exchange response requires a fresh sign-in. Pending attempts are process-local: run a single backend process, or provide sticky routing for every step before deploying multiple workers. See [the API/security contract](../PROJECT.md#native-sso-contract) for payloads, errors, limits, and regression checks.

## Card scanning

**Add Cards → Scan Cards** uses local ONNX artwork matching, informational title OCR, and footer OCR to verify set code and collector number. It requires a server installation, models, a catalog, and native Tesseract with English data.

1. Fetch models after deployment:

   ```bash
   docker exec manafolio node scripts/fetch-models.mjs
   ```

   From source, run `node scripts/fetch-models.mjs` in `backend/`.
2. Build the relevant language catalog under **Admin → Catalogs**. Downloading data and fingerprinting artwork can take hours. Stopped or failed builds keep the working catalog and cached card data; uncommitted embeddings are discarded. The next build reuses unchanged vectors from the last successful publication.
3. Source installations need Tesseract at `/usr/bin/tesseract`, the path used by the scanner, with `eng` trained data (`/usr/bin/tesseract --list-langs`). On Debian/Ubuntu, install `tesseract-ocr tesseract-ocr-eng`. Source-built Docker images include both.

Phones require HTTPS. See [the image-identification pipeline](../PROJECT.md#image-identification-pipeline) for details and limitations, and [Scan physical cards with a camera](USER_GUIDE.md#scan-physical-cards-with-a-camera) for capture, verification, Scan review, and accuracy warnings.

## Optional AI server configuration

AI is optional. See [Optional AI deck help](USER_GUIDE.md#optional-ai-deck-help) for provider setup, recommendations, saved-deck improvements, and user controls.

### Ollama deployment

Run [Ollama](https://docs.ollama.com/) and install a structured-output model, for example `ollama pull granite4.1:8b`. In **Settings → AI preferences**, enter the service's HTTP(S) address, check the connection, and choose an installed model. A blank address uses `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`). Models are not downloaded automatically, and failures never fall back to ChatGPT.

**Ollama deployment security.** Requests originate from the server, not the browser. Signed-in users can contact server-accessible HTTP(S) addresses, including localhost and private/LAN services. Invite only trusted users and enforce outbound network restrictions with your firewall; URL validation is not an access allowlist. Manafolio does not add Ollama authentication. Do not expose its port publicly.

In Docker, `127.0.0.1` is the container. To reach host Ollama, use `OLLAMA_BASE_URL=http://host.docker.internal:11434` and, on Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the Compose service. Configure Ollama's `OLLAMA_HOST` to listen on an interface reachable from the container, with firewall restrictions. Alternatively use an Ollama service name on a shared Docker network.

### AI data sharing and credentials

Requests send eligible card metadata/counts, the session conversation, and the current draft—including manually edited draft descriptions and strategies—to the chosen provider. They do not send storage locations, container names/IDs, saved private notes, or other users' collections. Source-deck context excludes its saved description and private notes. ChatGPT sends data to OpenAI and uses your Codex limits; an Ollama service may process data locally or remotely depending on its configuration.

Connect only to a trusted Manafolio server. The official [Codex app-server](https://developers.openai.com/codex/app-server/) integration requires a Unix server, including Docker, and disables model access to host files, commands, and external tools. Credentials are separated per user under `<database-directory>/codex/<user-id>/`, but administrators can access them. **Disconnect** removes that user's local Codex data. Collection JSON backups exclude credentials; whole-volume backups include them and must be protected. AI endpoints require browser sessions rather than API keys.

Deleting an account also stops its local Codex work and removes its credential directory without contacting OpenAI or revoking provider-side authorization. A cleanup failure leaves the account undeleted and reports an error; retry deletion after correcting the filesystem problem. Existing backups are not erased.

Gemini and OpenRouter keys are stored separately per user and provider in the server database, not returned to the browser. **Remove API key** deletes that provider's stored key without affecting other providers; revoke it at the provider to invalidate it externally. Administrators and database/volume backups can access these keys; account JSON exports exclude them. Gemini receives requests at Google's API, while OpenRouter forwards them to the selected model's upstream provider. Review both the gateway's and upstream provider's policies before sending data. Adding providers does not change existing saved provider choices.
