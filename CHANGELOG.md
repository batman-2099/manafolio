# Changelog

Release history starts with Manafolio 2.0.

## Unreleased

- Deck Builder now shows a red **Missing cards** status in grid and table views when required copies are unavailable, including archived copies in checked-out decks. Added a matching status filter; the ready filter excludes decks with unavailable copies.

## 2.1.1

- Allowed whole-container archive/restore while cards belong to checked-out decks, preserving deck lists, reservations, and return locations. Locks remain enforced and archived cards remain excluded from available inventory.
- Container list Select all now selects only cards matching the active search and filters, with a matching count; physical-layout selection remains container-wide.
- Removed unreachable storage headers, unused highlighting/callback/state paths, orphaned styles, and stale art-editor comments. The contour detector now exports its stateless function directly, and model downloads share one streaming installer while retaining CLI upgrade checks and separate CLI/admin deadlines.
- Stabilized Collection filter layout when Grading, Mana Value, or other option menus introduce a scrollbar.
- AI deck generation and improvement now include editable deck-specific strategies that save to Notes. Improvements retain existing notes, and saved private notes remain excluded from AI requests.
- Removed standalone Notes from main navigation and added private per-deck Notes below the deck stats, constrained to the stats column beside Customize card back, using the existing Save and unsaved-change protection. Deck duplication and complete backups retain notes; existing standalone notebook data is preserved.
- Added a subtle hover sheen to foil cards in Collection gallery and list views. Touch devices, reduced-motion preferences, and selection mode retain a static finish.
- Added Set (Newest to Oldest) and Set (Oldest to Newest) sorting in Collection, retaining ascending collector-number order within each set.
- Added a container type selector to Container Settings, preserving existing cards and configured capacity rather than applying creation defaults.
- Made storage capacity advisory: moves and filing keep cards in the chosen eligible container rather than rejecting, rerouting, or automatically expanding it when full. Containers and pages/rows display an Over limit warning that clears when usage returns within capacity. Stacking occupancy, filing restrictions, locks, and inventory boundaries are preserved.
- Moved Graded Slab to the last option in Add Cards, after Scan.
- Added a brighter dashboard chart palette, multicolor set-value bars, and distinct blue/gold inventory comparison series across account themes. Chart values, labels, and accessible data tables are unchanged.
- Added a rotating loading icon while waiting for AI deck responses, with a static reduced-motion fallback and an accessible busy state.
- Replaced per-card Commander switches with a single dropdown beneath the commander artwork. It lists all creatures and planeswalkers in the deck, supports clearing the selection, and retains the existing Save workflow.
- Added a Dragon Shield dropdown to Customize card back with 112 sleeve designs selected from the official collection. Standalone and multi-sleeve images are cropped to the back, previewed before Save, and stored as deck-local image copies; failed or cancelled downloads preserve the existing back.
- Grouped Dragon Shield sleeve choices into alphabetized Plain color sleeves and Art sleeves sections.
- Added None/Single/Double/Triple sleeve settings to container creation, settings, and detail displays. Values persist with non-destructive migration and complete backups; capacity and card placement are unchanged.
- Removed unused container-carousel/sidebar styles and consolidated unsorted-card rendering, scanner corner ordering, set-cache processing, and marketplace CSV mapping. Existing layouts, scanner safeguards, scannable-face counts, and format-specific collector-number precedence are preserved.
- Deck Builder's Card Type sort now orders cards alphabetically by displayed name within each type, in both list and grid views.
- Swapped the list and grid icons in the container view toolbar without changing view behavior or Unsorted controls.
- Refined the dashboard with a compact two-column mobile summary, direct Collection/Add Cards actions, recent cards ahead of detailed analytics, quieter theme-aware surfaces, and readable card metadata. Inventory calculations, charts, and card inspection are unchanged.

## 2.1.0

- Refined the dashboard's card total, net worth, invested cost, and unrealized gain summary with clearer typography, theme-aware solid surfaces, and responsive grouping. Moved average market value per card beneath Net Worth; calculations and inventory filters are unchanged.
- Added informational local card-name OCR. Removed name comparison against artwork candidates and name-conflict auto-add gates; footer, reprint, image-quality, catalog, and two-frame safeguards remain unchanged.
- Fixed plain card-name searches from the scanner's Identified Cards Found dialog. The shared search parser now preserves names supplied through `q` for both GET and image-assisted POST requests, while retaining explicit-field precedence and collector-number parsing.
- The Identified Cards Found dialog now shows the name read by OCR separately from artwork candidates, or “No readable name.” Manual searches retain that reading; new scans and scanner-setting changes clear it.
- Expanded upper-left title OCR coverage, restored portrait text proportions after square rectification, and switched to block text recognition. Low-confidence readings remain visible as “uncertain” rather than disappearing; title OCR never allows or blocks auto-add.
- Fixed stale scanner set membership after card metadata is cached or corrected. Set-filtered scans now read current metadata without reloading models; unknown and out-of-set printings remain excluded.
- Scanned cards now enter a persistent, account-scoped Scan review grid instead of owned inventory. Each draft has a saved Foil toggle in place of Edit, plus Discard; use one Add to Collection button for the entire reviewed batch. Finish changes preserve card identity and copy details. Batch confirmation is atomic and consumes each draft once; drafts do not affect collection totals, storage, or decks.
- Let Scan review use the available page width with automatically fitting columns, while keeping the camera and capture controls capped at 600px.
- Removed the ready-made catalog advisory from the scanner, including its dismissal state and unused translations.
- Moved Filter by set below the camera on the main scan page, available before camera activation rather than inside the gear menu. Set and subset symbols appear beside their names when supplied by the provider.
- Made the scanner's set-filter recommendation more prominent with larger, semibold, theme-accent text when no filter is selected. Increased its heading, search text, and set/subset names to 16px without changing set pickers elsewhere.
- Added a confirmed Clear action for Scan review. Clearing is atomic and account-scoped; owned cards and drafts queued after the selected batch remain untouched.
- Selecting a card in Identified Cards Found now queues it directly in Scan review without a second details screen. Pending requests block duplicate submissions; failed saves keep the candidates available for retry.
- Moved Auto-queue matches out of Scan settings to a keyboard-accessible on/off switch below the camera, available before activation and green when enabled. The saved preference and existing scan-safety behavior are preserved.
- Removed the Beta badge from Scan Cards and updated the in-app How-to with the current scanner controls, direct candidate queuing, review actions, persistence, and connection-error recovery.

## 2.0.9

- Combined deck composition, health, and source containers into a responsive, color-coded summary with exact counts and accessible controls.
- Added per-deck sleeve settings: None, Single, Double, and Triple, saved independently of deck drafts.
- Added customizable deck backs beneath commander artwork: original Magic back, solid color, image upload, or direct image URL import. Choices persist in duplicates and complete account backups.
- Restricted automatic sign-out on HTTP 401 to application API requests, so an external image host cannot sign users out.
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
