# freedraw-pdf

freedraw-pdf adds a freehand annotation workspace to Obsidian's PDF workflow. It lets you draw on PDF pages, insert notebook pages between PDF pages, and export the combined result as a finished annotated PDF.

The plugin is designed for people who read, mark up, and study PDFs inside Obsidian and want their handwritten notes to stay with the vault instead of living in a separate annotation app.

## What You Can Do

- Draw on PDF pages with pen and highlighter tools.
- Erase, select, move, resize, duplicate, reorder, and delete annotations.
- Add shapes, text boxes, and images to PDF or notebook pages.
- Insert temporary notebook pages before or after PDF pages.
- Choose page templates, paper sizes, and paper colors for inserted pages.
- Export a mixed document containing PDF pages, inserted pages, and annotations.
- Copy annotated page or region embeds into Markdown notes with explicit `freedraw-pdf` code blocks.

## How It Stores Data

freedraw-pdf does not overwrite your source PDF while you annotate it. Annotation data is saved in vault-backed sidecar JSON files next to the relevant document data. Exporting creates a separate annotated PDF when you want a finished copy.

This means:

- Your original PDF remains available.
- Your annotations stay inside your Obsidian vault.
- You can choose when to create a flattened, shareable PDF export.

## Installation

### From Obsidian Community Plugins

After the plugin is accepted into the Obsidian community directory:

1. Open Obsidian settings.
2. Go to **Community plugins**.
3. Search for **freedraw-pdf**.
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
5. Enable **freedraw-pdf** in **Community plugins**.

## Basic Workflow

1. Open a PDF in Obsidian.
2. Enable the freedraw-pdf annotation mode from the command palette, ribbon, or PDF controls.
3. Draw, highlight, add text, or insert notebook pages.
4. Use the page and document actions to navigate, manage pages, or copy Markdown embeds.
5. Export an annotated mixed PDF when you need a finished document.

## Notes And Limitations

- The plugin depends on Obsidian's native PDF viewer structure, so some behavior may need updates when Obsidian changes its PDF internals.
- Source PDFs are not edited in place during annotation.
- Exported PDFs are flattened output files intended for sharing or archiving.
- The plugin is still early and should be tested with copies of important documents until your workflow is comfortable.

## Privacy And Permissions

- No account, payment, network service, ads, telemetry, or self-update mechanism is required.
- Annotation files, copied embeds, imported images, and exported PDFs are written inside your Obsidian vault.
- Inserting an image uses the browser file picker. The plugin only reads the image file you choose, then stores a vault copy for the annotation.

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
0.12.0
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
