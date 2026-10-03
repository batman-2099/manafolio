# Manafolio privacy

**Effective date:** September 30, 2026

Manafolio is a self-hosted Magic: The Gathering collection, storage, and deck manager. Your chosen server holds your account and collection; this repository does not provide a central Manafolio account or hosted collection service. Installing the application does not give its maintainers access to your server.

**Self-hosted does not mean offline or confined to one device.** Your browser exchanges data with your server, loads some resources from external services, and can request optional integrations. This document describes the checked-in web application. Your server administrator is responsible for explaining any additional hosting, proxy, logging, backup, or integration practices.

## Data held by your installation

Depending on the features you use, Manafolio handles:

- Accounts: usernames, password hashes, roles, sessions, API/share tokens, preferences, and optional SSO identity links or provider credentials.
- Collection records: card printings, quantities, finishes, languages, conditions, purchase prices, valuations, grading details, missing status, and Physical, Arena, Wishlist, or Graveyard membership.
- Storage and decks: container layouts, placements, reservations, decklists, descriptions, private notes, commander choices, and recorded wins/losses.
- Imported files, exported files, backups, catalog caches, and uploaded replacement card artwork.
- Camera images sent for identification, and optional AI prompts, draft context, and responses processed during a request.
- Pending scan drafts and their reviewed copy details. These remain in your account on the server until you discard them or confirm their addition to Collection; they are separate from the transient camera image.

The server administrator controls the database, persistent files, and access to them. Account separation is not encryption against that administrator. Use a server you trust, especially before entering provider credentials or connecting a ChatGPT account.

## Browser storage

The browser uses local storage for the sign-in token, account data returned by the server, interface language, and device-specific display/scanner preferences. Returned account settings can include configured provider API keys. Browser caches and downloaded exports may retain additional data on the device.

Signing out removes the application's saved sign-in token and user object, but is not a wipe of all preferences, downloads, caches, or operating-system backups. Clear browser site data and downloaded files when retiring a shared device.

## Camera and card identification

Camera use requires permission. The client detects and prepares card frames locally, then sends captured images or crops to your Manafolio server for ONNX artwork matching and local Tesseract title and footer OCR. This scan flow does not send the photographs to a cloud image-recognition service or to Manafolio's maintainers.

The normal scan path processes images in memory rather than adding them to your collection as stored photos. Identification can still trigger external card-data lookups by printing ID, set, or collector number. Building scan catalogs downloads reference card artwork, and model installation downloads model assets. An operator's reverse proxy, diagnostics, or modified deployment may have its own retention behavior; do not assume every installation discards request bodies.

**Uploaded replacement artwork is different from a scan.** Artwork uploads are saved on the server and served through unauthenticated card-art URLs so shared views can display them. They are not private account attachments, even when collection sharing is off. Do not upload images containing personal information. Uploading art does not automatically submit it to the source repository.

**Custom deck backs** are separate from shared card artwork. Uploaded deck-back images are resized and stored in the collection database, returned through account-authenticated deck endpoints, and included in complete account backups. They are not published through the public card-art route.

**Uploaded storage-unit images** are also private account attachments, not shared replacement card artwork. The browser resizes your selected PNG, JPEG or WebP locally; your server validates and re-encodes it without source metadata, stores it in the account database, and includes it in complete account backups. Unit images are returned only through authenticated storage endpoints, not public container shares or public card-art URLs. Choosing card artwork or Automatic image replaces the saved upload; copies in earlier backups may remain. Uploading a local file does not send it to an external image provider.

**Deck history** retains saved composition revisions: card printings, quantities, source-entry references, commander, format, target size, inventory and revision timestamps. It does not snapshot private notes, names, descriptions, results or artwork. History is account-authenticated, excluded from public deck shares, included in complete account backups, and deleted with its deck or account. Restoring a revision does not erase later revisions; copies in older exports or server backups can remain after deletion.

## External network requests

External services receive the network information needed to serve a request, such as the connecting IP address, requested URL, timing, and HTTP headers. Browser requests may also disclose referrer information according to browser policy. The services' own terms, privacy policies, and retention rules apply.

| Feature | Connection and information involved |
| --- | --- |
| Card search, prices, imports, and related tokens | The server contacts Scryfall (`api.scryfall.com` and its bulk-data hosts) for card names, search terms, printing IDs, set/collector numbers, rules, prices, and catalog snapshots. Repeated lookups can reveal cards of interest; these calls do not deliberately upload your complete account or collection database. |
| Card artwork and set symbols | The browser can load provider URLs directly, including `cards.scryfall.io` and `svgs.scryfall.io`. These requests expose the requested artwork or symbol and the client's network information. They are not all proxied through your server. Catalog building may also fetch reference artwork from the server. |
| Custom deck-back imports | Choosing a Dragon Shield or Ultra PRO sleeve downloads its selected image directly from the shop's image CDN (`cdn.shopify.com`); a manual image URL contacts its supplied host. These browser downloads omit credentials and referrer headers but expose the client's IP address and requested image. Ultimate Guard previews are bundled with Manafolio and loaded from your server, not from Ultimate Guard at runtime; following an official-shop link contacts that supplier's website. Saving stores a resized copy with the deck; later displays use that saved copy without another source download. |
| Interface fonts | The page loads Google Fonts stylesheets and font files from `fonts.googleapis.com` and `fonts.gstatic.com`, including on the login screen. These are external requests even if you never enable AI or sharing. |
| Preconstructed decks | The server downloads deck catalog/list data from MTGJSON (`mtgjson.com`). |
| Scan models and supplied catalogs | Installation/admin download actions contact Hugging Face (`huggingface.co`) and its download infrastructure. These download assets, not your camera frames. |
| Optional PSA certification lookup | The server sends the certificate number and configured PSA API token to `api.psacard.com`; returned card information may be used in provider searches. |
| Optional SSO | The browser visits the configured OpenID Connect provider; the server exchanges authorization codes and receives identity claims according to that provider and the administrator's configured scopes. The default scopes are `openid profile email`. |
| Optional AI | The server sends the request context described below to OpenAI, Google Gemini, OpenRouter and its upstream provider, or the selected Ollama service. |
| Links to marketplaces or other sites | Following an external link contacts that site. Card-specific links can include names, identifiers, or search terms. |

Manafolio's provider integrations support Magic only. Previously stored records can still contain external artwork URLs, which a browser may request when those records are displayed. Customized deployments may use additional services and need corresponding disclosures. The table above is not a promise that every deployment contacts only a fixed list of hosts.

The application does not include an advertising or third-party tracking analytics integration. Its collection dashboard analytics are calculations about your saved cards and decks, not a telemetry service. This does not prevent external resource providers, your hosting provider, or your administrator from logging the requests they receive.

## Optional AI

Collection, storage, and deck management do not require AI. If you use the AI builder or **Improve with AI**, the chosen provider receives:

- Eligible card printing IDs, names, available quantities, and rules metadata.
- Your requested inventory, format, target size, selected deck type and its explanation/play style, target power level and its description/pace, planning options, and color/set filters.
- Your prompt, the current conversation, and the current draft, including its description and strategy, whether AI-generated or manually edited.
- When improving a saved deck, its inventory/format/size, commander, and card list. The source deck's saved description and private notes are not included automatically.

Container filtering is applied on the server. The generated payload excludes container names/IDs, storage locations, saved private notes, and other users' collections. Anything you type or paste into a prompt or draft is still sent: do not enter secrets or personal information you do not want the provider to process.

**ChatGPT/Codex:** Connecting uses your OpenAI account's device-verification flow. AI requests go to OpenAI and use that account's Codex access and limits. The integration disables model access to host files, commands, and external tools, but this does not make the submitted prompt private from OpenAI. Provider retention and account policies remain applicable.

**Ollama:** Requests originate from the Manafolio server and go to the configured HTTP(S) service. That service may run locally, on a LAN, or remotely; choosing Ollama alone is not a guarantee of local-only processing. Check the service, model, and any upstream provider it uses. Manafolio does not add Ollama authentication. Signed-in users can choose server-reachable addresses, including localhost and private networks, so operators must invite trusted users and enforce outbound network restrictions. Do not expose an unauthenticated Ollama port publicly.

**Gemini and OpenRouter:** You supply your own API key for each provider. Gemini requests go to Google; OpenRouter routes requests to an upstream provider serving the selected model. Free tiers have quotas and may have different data-use terms from paid service; Google lists free-tier content as used to improve its products, subject to its terms. Review the selected provider's retention and training policies. There is no automatic fallback to a different model or provider.

The builder's conversation is session-only in the interface, not a saved Manafolio chat history. This is not a guarantee of deletion from provider infrastructure or operator logs. Saving a draft explicitly stores its resulting deck in Manafolio.

ChatGPT credentials are stored separately for each user under `<database-directory>/codex/<user-id>/`. Server administrators can access those files. **Disconnect** removes that user's local Codex data; it does not erase provider-side records or older backups. Account JSON exports exclude these credentials, while whole-volume backups include them.

Account deletion stops that user's local Codex processes and removes the credential directory without contacting OpenAI. It does not revoke provider-side authorization or erase older backups. If local cleanup fails, deletion reports an error and retains the database account.

Gemini and OpenRouter API keys are stored per user/provider in the server database. They are never returned in account or preferences responses and are excluded from account JSON exports, but database snapshots and whole-volume backups include them. Administrators can access them. Removing a key deletes the current stored copy, not older backups or provider records; revoke the key at its provider when necessary.

See the [AI workflow and deployment guidance](README.md#get-an-ai-deck-recommendation) before enabling a provider.

## Opt-in public sharing and exports

Collection sharing and location sharing are off by default. Enabling collection sharing makes the share-token URL accessible without a login: anyone with that link can view the shared Physical collection, trade list, and Wishlist, including your username, quantities, card details, and public valuations. Purchase prices and private notes are not included. Arena and Graveyard are not exposed by these shared collection views.

Location sharing is a separate opt-in. It exposes container names and allows public container layouts, including compartments and card positions. Treat share links as access credentials; recipients can forward them. Disable sharing or regenerate the share token to invalidate access through the old link. Neither action recalls screenshots, downloads, or copies others have already made.

Deck sharing is a separate, per-deck opt-in and does not enable collection or location sharing. A deck link discloses your username and that deck's saved name, description, format, category, wins, losses, commander, card printings, artwork, and quantities. Physical, Arena, and Graveyard deck definitions can be shared, including cards you do not own. Private Notes, custom deck backs, storage locations, owned-copy availability, reservations, prices, and purchase details are excluded. Anyone with the link can read and forward it; later saved deck changes appear at the same link. Revoke the individual link or delete the deck to stop access, without recalling copies already retained by recipients.

Deck links are not copied by deck duplication or account JSON export/restore; restored decks need new links. Full database backups contain these access credentials, so restoring an older database can restore its links.

Read-only API keys also grant access to account data; give them only to trusted clients and revoke them when no longer needed. Exported CSV, decklists, account JSON, and database backups are files under your control. Sending one to another person or posting it in a support issue is a separate disclosure.

## Retention, deletion, and operator responsibilities

The operator controls database retention, server/proxy logs, backups, and access to persistent storage. Users can remove collection data through the application and ask the administrator about account deletion and retained copies. Do not assume deleting an account or record automatically erases exported files, snapshots, uploaded shared artwork, provider records, or credentials in older backups.

Operators should:

- Use HTTPS for remote access, secure the host and network, apply updates, and limit administrative access.
- Protect session/API/share tokens, provider credentials, TLS private keys, and backups. Password hashing does not encrypt the rest of the database.
- Keep recovery backups outside the live data volume, with a documented retention/deletion policy. Whole-volume backups can contain authentication material as well as collection data.
- Explain the deployment's hosting, proxy, SSO, AI, logging, and backup arrangements to users, and handle applicable privacy obligations and requests.
- Review what is being shared before making an instance, collection, or artwork publicly accessible.

Follow the [backup and restore guidance](README.md#back-up-or-move-an-account) rather than deleting or moving live database files casually. Removing the only database or volume without a verified backup can permanently destroy the collection.

## Children's privacy

Manafolio is not directed at children. This repository does not operate a service that collects children's account data; an operator offering an installation to others remains responsible for its users and any applicable obligations.

## Changes and contact

Updates to this document are published in the repository with a revised effective date. For questions about your data or requests to remove it, contact your Manafolio server administrator. For application issues, use the [Manafolio issue tracker](https://github.com/batman-2099/manafolio/issues), without posting passwords, tokens, private collection exports, or other sensitive information.
