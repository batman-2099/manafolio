# Changelog

Release history starts with Manafolio 2.0.

## Unreleased

- Removed unused indexing/name helpers, game-setting exports, and an inactive build override; reused shared scanner geometry, stopped generating unused detector images, and simplified text-file imports with the browser's native API.
- Let the desktop app and Deck Builder use the available screen width while retaining edge padding and bounded dialogs.
- Improved phone layouts: dashboard charts and controls stay within the viewport, deck tables become labeled stacked rows, all navigation tabs remain visible, and the demo notice no longer covers navigation. Desktop layouts retain their existing grids and tables.
- Show the application version beside the branding on the login screen and app header.
- Use theme-appropriate dark text on light card-count badges.
- Fixed CI import tests that depended on local collection exports.
- Enabled GitHub Pages for the existing demo deployment workflow.

## 2.0.0

- Magic: The Gathering collection, storage, and deck management.
- Responsive, web-only interface with the Arcane Blue theme.
- Planeswalker terminology in Admin.

For setup, migration, and backup instructions, see the [README](README.md).
