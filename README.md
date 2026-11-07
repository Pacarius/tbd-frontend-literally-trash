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

The last database and media folder are cached in the browser. On the next
launch, the app attempts to reopen them when the browser still grants access.
If the browser requires a gesture before restoring access, use **Restore last
files**; this is required by browser file-permission rules and cannot be done
silently on startup.

**Classify images** runs the bundled NSFWJS MobileNet model locally against
linked images. It labels the top result as Safe, Sensitive, or NSFW and never
uploads image data. Classification is opt-in; videos are skipped because this
small model is image-only. Results are written to an `image_classifications` table in the opened SQLite
database. Inference uses a downscaled 224px canvas and the CPU backend to
avoid GPU/WebGL resource pressure. TensorFlow scopes and the model are
released after each run, classification yields between images, and **Stop
classification** cancels a large run.

## Downloader duplicate-skip patch

`tbd-duplicate-skip.patch` updates the original `sync-bookmarks.user.js` so
duplicate-limit responses no longer stop normal scrolling. Apply it from the
original downloader checkout:

```bash
git apply tbd-duplicate-skip.patch
```

If you already applied that patch and still see the same duplicate page
repeatedly, also apply `tbd-scroll-followup.patch`. It forces incremental
scroll events so X requests the next virtualized timeline cursor:

```bash
git apply tbd-scroll-followup.patch
```

## Desktop app

The project includes an Electron wrapper so the library can run as one desktop
application without starting Vite manually:

```bash
npm run electron
```

On Linux, Electron follows the desktop session (including Wayland when
available). Running Electron as root is not recommended; this project only
disables Chromium's sandbox automatically when it detects root so local
development can still start.

To create an installable package for the current platform:

```bash
npm run package
```

## Production build

```bash
npm run build
npm run preview
```
