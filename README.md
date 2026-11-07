# Bookmark Library

A standalone, local-only frontend for `twitter-bookmarks-downloader`.

## Run

```bash
npm install
npm run dev
```

Open the local Vite URL, choose the downloader's `bookmarks.db`, then choose
the `media/` directory if you want local image and video previews. In browsers
with the File System Access API, tag changes are written back to the selected
database automatically after the browser grants write permission. The
**Download tagged database** button remains available as a fallback. Use
**Close database** when finished; the app also closes its in-memory SQLite
connection when the tab is closed or navigated away from.

The database is parsed and edited in the browser with SQLite/WASM. Nothing is
uploaded and the downloader does not need to be running. The app supports both
the downloader's legacy GORM schema and its current Ent schema.

## Production build

```bash
npm run build
npm run preview
```
