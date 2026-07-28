# Freedraw PDF

Freedraw PDF adds a freehand annotation workspace to Obsidian's PDF workflow. It lets you draw on PDF pages, insert blank/template pages between PDF pages, copy annotated embeds into notes, and export the combined result as a finished annotated PDF.

The plugin is designed for people who read, mark up, and study PDFs inside Obsidian and want handwritten notes to stay with the vault instead of living in a separate annotation app.

## Main Features

- Draw on PDF pages with pen and highlighter tools.
- Add text boxes, shapes, and images to PDF pages or inserted blank/template pages.
- Select, move, resize, duplicate, reorder, copy, cut, paste, and delete annotations.
- Erase contacted annotations without recalculating or fragmenting surviving strokes.
- Insert temporary blank/template pages before, after, or at the end of PDF documents.
- Choose inserted page templates, paper sizes, and paper colors.
- Export PDF pages, inserted pages, and annotations as one flattened PDF.
- Copy annotated page and selected-region embeds into Markdown notes with `freedraw-pdf` code blocks.
- Keep annotation data in vault-backed sidecar files instead of overwriting the source PDF.

## Installation

### From Obsidian Community Plugins

After the plugin is accepted into the Obsidian community directory:

1. Open Obsidian settings.
2. Go to **Community plugins**.
3. Search for **Freedraw PDF**.
4. Install and enable the plugin.

### Manual Install

1. Download these files from the latest GitHub release:
   - `manifest.json`
   - `main.js`
   - `styles.css`
2. Create this folder in your vault:

```text
.obsidian/plugins/freedraw-pdf
```

3. Place the three downloaded files in that folder.
4. Reload Obsidian.
5. Enable **Freedraw PDF** in **Community plugins**.

## Basic Workflow

1. Open a PDF in Obsidian.
2. Enable Freedraw PDF annotation mode from the command palette, ribbon, or PDF controls.
3. Draw, highlight, add text, add shapes, insert images, or add blank/template pages.
4. Use the page actions to navigate, duplicate, clear, or remove added pages.
5. Copy Markdown embeds when you want annotated PDF content inside a note.
6. Export an annotated mixed PDF when you need a finished document.

## Annotation Tools

### Pen

Use the pen tool for freehand writing and drawing. Strokes are smoothed with `perfect-freehand` and can use simulated pressure or stylus pressure, depending on your settings and device support.

### Highlighter

Use the highlighter for translucent emphasis over PDF content. Highlighter width and color can be adjusted separately from the pen defaults.

### Eraser

Use the eraser to remove annotation marks. Object mode removes complete contacted objects, while segment mode follows the eraser path without manufacturing or replaying fragmented survivor strokes.

### Select

Use select mode to click or drag around annotations. Selected annotations can be moved, resized, duplicated, reordered, copied, cut, pasted, or deleted.

### Shapes

Add simple visual markers such as rectangles, ellipses, and lines. Shapes are useful for boxing content, calling out diagrams, or marking regions for review.

### Text

Add text boxes directly onto PDF pages or inserted blank/template pages. Text boxes can be positioned and resized like other annotation objects.

### Images

Insert an image onto the current page through the file picker. The selected image is copied into your vault and then used as an annotation item.

## Inserted Pages

Freedraw PDF can insert temporary blank/template pages into the active PDF session. These pages appear between PDF pages while you work and are included when you export the mixed document.

Inserted page options include:

- Blank, ruled, grid, and dot templates.
- A4, letter, compact, and long page sizes.
- Paper color presets.
- Insert before the current PDF page.
- Insert after the current PDF page.
- Add a page to the end of the document.
- Duplicate an added page with or without its annotations.
- Clear or delete added pages from the current session.

## Markdown Embeds

Freedraw PDF can copy annotated page references into Markdown notes using explicit `freedraw-pdf` code blocks.

Use embeds when you want a note to show:

- A full annotated PDF page.
- A selected region from a PDF page.
- A refreshed view of current annotation data.
- A block that can be copied, opened, or refreshed from the rendered note.

The embed feature is useful for study notes, research summaries, lecture notes, and review documents where the annotated PDF page should appear next to your written notes.

## Export

The export action creates a new flattened PDF that combines:

- Original PDF pages.
- Inserted blank/template pages.
- Freehand strokes.
- Highlights.
- Text boxes.
- Shapes.
- Images.

The source PDF is not edited in place. Export creates a separate finished PDF intended for sharing, archiving, or printing.

## How Data Is Stored

Freedraw PDF keeps annotation data in vault-backed sidecar JSON files. The source PDF remains unchanged while you annotate it.

This means:

- Your original PDF remains available.
- Your annotations stay inside your Obsidian vault.
- You can choose when to create a flattened PDF export.
- Annotation data can be backed up with the rest of your vault.

## Settings

The settings tab lets you tune workflow and rendering behavior:

- Prefer Obsidian's native PDF toolbar or use the fallback floating toolbar.
- Show or hide region and copy-embed toolbar buttons.
- Show or hide headers on rendered annotated embeds.
- Choose which pointer inputs can draw.
- Configure simulated or stylus pressure.
- Tune ink thinning, streamline, smoothing, easing, and taper.
- Set autosave delay.
- Set default pen, highlighter, and eraser widths.

## Privacy And Permissions

- No account, payment, network service, ads, telemetry, or self-update mechanism is required.
- Annotation files, copied embeds, imported images, and exported PDFs are written inside your Obsidian vault.
- Inserting an image uses the browser file picker. The plugin only reads the image file you choose, then stores a vault copy for the annotation.

## Notes And Limitations

- The plugin depends on Obsidian's native PDF viewer structure, so some behavior may need updates when Obsidian changes its PDF internals.
- Source PDFs are not edited in place during annotation.
- Exported PDFs are flattened output files intended for sharing or archiving.
- The plugin is still early and should be tested with copies of important documents until your workflow is comfortable.

## Troubleshooting

- If toolbar controls do not appear, try toggling the native PDF toolbar preference in settings.
- If touch input draws unexpectedly, change the ink input mode to keep fingers available for scrolling.
- If annotation data does not appear, confirm that the PDF and its sidecar annotation file are still in the expected vault location.
- If an export looks different from the live view, update the plugin and retry with a copy of the source PDF.

## Support

Use GitHub issues to report bugs, request improvements, or ask questions about the plugin. For security-sensitive reports, follow the guidance in `SECURITY.md`.

## Development

```powershell
npm install
npm run check
npm run build
```

## Release

The GitHub release tag must exactly match `manifest.json` and `versions.json`. For example:

```text
0.12.4
```

Release assets should include only:

```text
manifest.json
main.js
styles.css
```

## License

MIT

## Credits

- [perfect-freehand](https://github.com/steveruizok/perfect-freehand), used for freehand stroke rendering, is licensed under MIT.
