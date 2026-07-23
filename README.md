# freedraw-pdf

freedraw-pdf is an Obsidian plugin for freehand PDF annotation and notebook pages inside Obsidian's native PDF workflow.

## Features

- Annotate PDFs with pen, highlighter, eraser, shapes, text, and images.
- Add temporary notebook pages before or after existing PDF pages.
- Change added-page template, paper size, and paper color.
- Export a mixed document as an annotated PDF.
- Copy annotated page or region embeds into markdown with explicit `freedraw-pdf` code blocks.
- Store annotation data in vault-backed sidecar JSON files.

## Installation

### Manual install

1. Download `manifest.json`, `main.js`, and `styles.css` from the latest GitHub release.
2. Create this folder in your vault:

```text
.obsidian/plugins/freedraw-pdf
```

3. Place the three downloaded files in that folder.
4. Reload Obsidian.
5. Enable **freedraw-pdf** in Community Plugins.

## Development

```powershell
npm install
npm run check
npm run build
```

## Release

The GitHub release must use a tag that exactly matches `manifest.json` version, for example:

```text
0.12.0
```

Release assets should include:

```text
manifest.json
main.js
styles.css
```

## License

MIT
