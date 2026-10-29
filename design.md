# Design: Manafolio

The shared system for Manafolio app screens. Preserve the brand and existing workflows; change the system deliberately rather than introducing page-local themes.

## System
- Genre: modern-minimal app, not a marketing website.
- Direction: restrained collection workbench; card artwork is the primary visual material.
- Brand: Outfit UI and Cinzel wordmark with its original static blue gradient, the existing stacked-card logo, Arcane Blue, Jenny and all six mana palettes.
- Composition: a full-width app shell with consistent edge padding; brand/account upper row and destination lower row. Mobile retains its bottom navigation and More menu.
- Dashboard: summary rail alongside collection history on wide screens; card activity and analysis below. Screens share controls and palette but keep task-specific arrangements.
- Storage: binder pockets, page order and box coverflow geometry remain functional representations, not generic cards.

## Tokens
`frontend/src/tokens.css` defines the shared scales and semantic aliases. Existing palette roles remain in `frontend/src/index.css`; `frontend/src/arcane.css` supplies Arcane Blue values only.

```css
:root {
  --color-paper: var(--bg-primary);
  --color-paper-2: var(--bg-secondary);
  --color-paper-3: var(--surface-3);
  --color-ink: var(--text-primary);
  --color-ink-2: var(--text-secondary);
  --color-muted: var(--text-muted);
  --color-rule: var(--border-glass);
  --color-accent: var(--accent-red);
  --color-accent-ink: var(--text-on-accent);
  --color-focus: var(--text-strong);
  --font-display: var(--font-main);
  --font-body: var(--font-main);
  --font-brand: 'Cinzel', Georgia, serif;
}
```

- Spacing: existing `--space-1/2/3/4/6/8` map to 4/8/12/16/24/32px.
- Type: `--text-xs/sm/md/lg/xl/2xl/3xl` map to .75/.875/1/1.2/1.44/1.728/2.074rem. Outfit headings, labels and controls; Cinzel only for the wordmark.
- Surfaces: solid background, section and raised state levels. Group with proximity and dividers, not nested bordered panels.
- Radius: `--radius-sm` 6px controls; `--radius-md` and `--radius-lg` 10px panels/dialogs. Round status symbols and native toggles keep their geometry.
- Primary action uses `--accent-red`, a historical name whose value follows the selected palette. Positive/negative status uses dedicated text tokens.
- Media overlays use `--media-background/foreground`; set-symbol backing uses `--symbol-background`. Chart series preserve the existing categorical palette in `--chart-series-1` through `--chart-series-10` and domain color tokens.

## Controls and states
Controls have 44px hit targets; mobile text inputs remain at least 16px. Fields use `--control-border`; keyboard focus is an immediate outline, never an animated border. Existing loading, empty, error, selection, disabled and confirmation behaviors remain owned by their components.

## Motion and material
No glowing text, ornamental gradients, floating decoration or page-entry animation. Short explicit color/opacity transitions communicate state. Scanner activity and in-flight spinners retain reduced-motion fallbacks. Foil remains identifiable through its existing label, restrained surface and outline, without a moving sheen. Elevation is reserved for overlays using `--shadow-overlay`.

## Exports and validation
`frontend/src/index.css` imports `tokens.css` and `base.css`; `mana.css` retains the palette-picker symbols. No new framework, font or dependency is required. Contrast, responsive rendering, keyboard behavior and Hallmark results must be recorded by the integrated review; this design lock is not a claim of a tested accessibility pass.
