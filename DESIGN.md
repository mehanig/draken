# Shared visual identity

Draken uses the same blocky Bauhaus identity as GifGun. This is the product family's signature, not a temporary theme or a user-selectable skin.

The reference is `gifgun-online/src/visualTheme.css`, including its geometric controls and concrete material. Draken keeps its own dragon logo and sync workflow. It does not depend on the GifGun checkout at runtime.

## Palette

The tokens live in `client/src/styles/index.css`.

| Token | Color | Use |
|---|---|---|
| `--paper` | `#c7c6c0` | Concrete background |
| `--panel` | `#deddd7` | Reading surfaces and controls |
| `--ink` | `#111111` | Text and structural borders |
| `--muted` | `#4f4d47` | Supporting text, not low-contrast light gray |
| `--accent` | `#9136d8` | Primary actions, focus, prominent hard shadows |
| `--yellow` | `#f2c230` | Selected navigation, small labels, decision-panel shadow |
| `--blue` | `#1746a2` | Evidence links and inspected evidence |
| `--red` | `#e33b2e` | Error accents and the welcome symbol |
| `--green` | `#0b7a53` | Success and local-status accents |

## Rules

- Use square panels, inputs, buttons, and status labels. Use 2px ink borders for structural surfaces. Circles are deliberate geometric symbols, not rounded cards or pills.
- Use solid offset shadows with no blur. Primary cards use an 8px purple shadow. Keep secondary surfaces quieter. Leave space for the shadow on narrow screens.
- Use the local font stack from GifGun: Avenir Next, Futura, Century Gothic, Arial Narrow, Arial, sans-serif. Do not load remote fonts.
- Use heavy, tightly spaced uppercase headings. Use compact uppercase action labels. Keep conversations, notes, code, and evidence in their original case, with generous line spacing.
- Put texture on the background, not behind long-form reading surfaces. Use the bundled inline concrete texture and grid; no image service or external asset is needed.
- Use color sparingly. Preserve text labels for status and errors. Color must not be the only way to distinguish a result.
- Keep a visible keyboard focus outline on every control, including selects and disclosure summaries. Respect reduced motion and forced colors.
- Keep the UI lean. Styling must not bring back per-sync model controls, permission checkboxes, decorative dashboards, or extra setup steps.

## Verification

`tests/ui/appearance.spec.ts` checks the palette, square geometry, hard shadows, text contrast, keyboard focus, responsive widths, login errors, reduced motion, forced colors, and absence of external asset requests. The sync browser test covers the same style during failure, resume, citation inspection, discussion, and completion.

Screenshots in `.test-artifacts/` use synthetic sessions. They stay local and are not committed or uploaded.
