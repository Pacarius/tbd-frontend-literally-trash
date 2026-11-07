# Bookmark Library

A standalone, local-only frontend for `twitter-bookmarks-downloader`.

## Run

```bash
npm install
npm run dev
```

Open the local Vite URL, choose the downloader's `bookmarks.db`, then choose
the `media/` directory if you want local image and video previews.

The database is parsed in the browser with SQLite/WASM. Nothing is uploaded.
The app supports both the downloader's legacy GORM schema and its current Ent
schema.

## Production build

```bash
npm run build
npm run preview
```
