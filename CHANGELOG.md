# Changelog

Release history starts with Manafolio 2.0.

## Unreleased

- Added a source-location dropdown to Deck Builder card previews. Physical decks can save a location/compartment for each card, combine available copies there, and use those exact reservations for checkout and return without moving stored cards.
- Source-location changes now automatically save the entire deck draft. Normal saves allow unavailable cards and retained unavailable sources; checkout still validates availability. Failed autosaves preserve the draft for manual retry.
- Enabled zoom in Deck Builder's List view and centered the List/Grid, zoom, and sort controls together. List rows wrap at larger sizes and retain usable touch targets when zoomed out.
- Made List-view card artwork grow slightly faster than the surrounding row when zooming in, while keeping its default size unchanged.
- Made the scanner's card-shaped placement guide visible before detection, with a white border and dark outline; capture geometry and recognition behavior are unchanged.
- Overlapped scan footer OCR with candidate metadata lookup, reused the local Scryfall bulk snapshot for uncached card-ID lookups, and exposed per-frame timing diagnostics. Scanner presets now describe their actual upload/confirmation controls; unused ORB parameters were removed without weakening verification.

## 2.0.8

- Restored Supertype Breakdown, Color & Land Distribution, Deck Health, and the commander card directly below the deck description, before the card editor.
- Restored beveled edges, a shaded finish, and raised shadows to Commander tags in deck list and grid views.
- Added a detailed user guide covering first use, inventories, imports, scanning, storage, decks, AI, sharing, preferences, backups, Notes, administration, and troubleshooting; linked it from the README.
- Added How-to immediately after Notes, including full-guide search, chapter navigation, keyboard-accessible reading controls, and responsive tables; the in-app guide uses the same Markdown source as the repository documentation.

## 2.0.7

- Gave all six mana themes matching header emblems, page-title symbols, large background watermarks, and stronger color accents while preserving the stationary logo and Arcane Blue/Jenny appearances.
- Replaced the theme dropdown with responsive, symbol-led radio choices; keyboard focus stays on the selected theme while saving.
- Removed unused move-feedback, advanced-configuration, and stack-inspector styles; consolidated scanner tensor normalization, collection sort mappings, and immediate-revoke file downloads.
- Replaced GSAP/ScrollTrigger with native viewport observation and Web Animations for once-only heading reveals, retaining reduced-motion handling, keyboard/focus cancellation, and cleanup.

## 2.0.6

- Removed Disney Lorcana provider, UI, translation, scanning, and maintenance integration. Magic workflows remain supported; existing stored records retain their identities, and unsupported backups are rejected before restore can replace account data.
- Removed unused storage styles and backend helpers; scanner geometry now consumes existing convex hulls instead of recomputing them.
- Unified audited deck, storage, setup, and account dialogs with native modal focus, Escape dismissal, focus restoration, and placement above mobile navigation; balanced browser-back guards during Strict Mode remounts while retaining existing themes and API contracts.
- Fixed narrow-screen deck editing and draw-hand layouts, enlarged storage controls, associated form labels, and made account actions and collection inventories discoverable on phones.
- Added accessible data tables to the remaining dashboard charts, consolidated unavailable analytics, and improved settings navigation, form widths, provider feedback, and theme-aware links.
- Corrected collection filter counts and empty-state actions, bounded advanced filters, kept search progress visible, standardized mobile input sizing, and removed duplicated deck-health quantities.

## 2.0.5

- Pointed Settings support, contribution, source, and update checks to the Manafolio repository instead of Bindarr.
- Prevented the Settings footer Source link from using a stale backend release URL.

## 2.0.4

- Enlarged container tile card counts and aligned them on the right in subtly raised plaques with shared spacing/radius tokens and readable unit labels, keeping names and mana symbols on the left.
- Fixed container mana badges to use actual card colors instead of Commander color identity, so off-color abilities do not add misleading symbols.

## 2.0.3

- Added Gemini and OpenRouter to AI deck settings with per-user API keys, explicit model selection, and existing inventory/draft validation. Provider keys stay server-side and are excluded from account exports; database backups include them.
- Gave Collection gallery rarity and Foil tags beveled edges and subtle depth, with a static iridescent finish for Foil.
- Storage container tiles now show mana/color symbols from their stored Magic cards, including colorless cards. Symbols are scoped to the account and Physical/Graveyard inventory; empty containers have no symbols.

## 2.0.2

- Added once-only GSAP ScrollTrigger reveals to below-the-fold dashboard analytics and Settings headings. Content remains visible; reduced-motion preferences, keyboard use, focus, and view cleanup cancel reveals without delaying navigation.

## 2.0.1

- Replaced Light, Magic, and LCARS with six mana-inspired account themes: White, Blue, Black, Red, Green, and Colorless. Retained Arcane Blue and Jenny, localized theme choices, and shared-link theme support. Removed theme preferences fall back to Arcane Blue without affecting collection data.
- Tuned Red Mana from amber-brown to crimson surfaces, ruby borders, and red accents.
- Renamed the mana themes to Plains, Island, Swamp, Mountain, Forest, and Wastes across supported languages, and labeled the default theme Arcane Blue instead of Dark; saved theme keys and selections are unchanged.
- Refined Arcane Blue into an artwork-first collection interface with layered navy backgrounds, raised panels, luminous controls, clearer typography, and consistent toolbars. Existing account palettes and the stationary logo remain; rarity glows and continuous foil/hover motion stay removed.
- Prioritized owned counts and value in a compact dashboard summary, grouped analytics, moved storage creation into the heading, and placed card ownership/location/deck actions before market history.
- Simplified collection filters, settings, and login; removed promotional filler, localized clearer deck status labels, and hid pagination when a collection fits on one page. Browser zoom remains available on phones.
- Restored the Deck Builder's banner, two-row search/filter toolbar, accent-bordered deck cards, capacity panels, and table presentation while retaining accessible control labels and current status wording.
- Improved keyboard access to collection cards and nested card dialogs, shared focus visibility across themes, filter dismissal, and reduced-motion support.
- Simplified phone navigation to four main destinations plus More, combined collection exports, and made notifications readable, dismissible, and severity-aware above navigation.
- Removed unused indexing/name helpers, game-setting exports, and an inactive build override; reused shared scanner geometry, stopped generating unused detector images, and simplified text-file imports with the browser's native API.
- Let the desktop app and Deck Builder use the available screen width while retaining edge padding and bounded dialogs.
- Improved phone layouts: dashboard charts and controls stay within the viewport, deck tables become labeled stacked rows, all navigation destinations remain accessible, and the demo notice no longer covers navigation. Desktop layouts retain their existing grids and tables.
- Show the application version beside the branding on the login screen and app header.
- Use theme-appropriate dark text on light card-count badges.
- Fixed CI import tests that depended on local collection exports.
- Enabled GitHub Pages for the existing demo deployment workflow.

## 2.0.0

- Magic: The Gathering collection, storage, and deck management.
- Responsive, web-only interface with the Arcane Blue theme.
- Planeswalker terminology in Admin.

For setup, migration, and backup instructions, see the [README](README.md).
