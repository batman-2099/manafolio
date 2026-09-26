# Changelog

Release history starts with Manafolio 2.0.

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
