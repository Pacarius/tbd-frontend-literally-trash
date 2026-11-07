import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import './styles.css';

const MEDIA_EXTENSIONS = /\.(avif|gif|jpe?g|png|webp|mp4|webm|mov)$/i;
const HANDLE_STORE = 'bookmark-library-handles';

async function saveHandle(key, handle) {
  if (!handle || !window.indexedDB) return;
  await new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_STORE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => {
      const transaction = request.result.transaction('handles', 'readwrite');
      transaction.objectStore('handles').put(handle, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
}

async function readHandle(key) {
  if (!window.indexedDB) return null;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_STORE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => {
      const transaction = request.result.transaction('handles', 'readonly');
      const get = transaction.objectStore('handles').get(key);
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => reject(get.error);
    };
    request.onerror = () => reject(request.error);
  });
}

function isVideoMedia(media, file) {
  return media.type === 'video' || Boolean(file && /\.(mp4|webm|mov)$/i.test(file.name));
}

function mediaTypeLabel(type) {
  if (type === 'animated_gif') return 'GIFs';
  return type === 'video' ? 'Videos' : 'Photos';
}

function classificationLabel(prediction) {
  const label = prediction.className.toLowerCase();
  if (label === 'porn' || label === 'hentai') return 'NSFW';
  if (label === 'sexy') return 'Sensitive';
  return 'Safe';
}

function formatDate(value) {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function normalizeTweet(row) {
  const rawTags = row.tags;
  return {
    id: String(row.id ?? ''),
    name: row.name || row.author_name || 'Unknown author',
    screenName: row.screen_name || row.author_screen_name || '',
    text: row.full_text || row.text || '',
    createdAt: row.created_at || row.createdAt || '',
    url: row.permanent_url || row.url || `https://x.com/i/status/${row.id}`,
    bookmarked: row.bookmarked || 'yes',
    rating: Number(row.rating || 0),
    tags: Array.isArray(rawTags) ? rawTags : (typeof rawTags === 'string' ? (() => { try { return JSON.parse(rawTags) || []; } catch { return rawTags ? rawTags.split(',').map((tag) => tag.trim()).filter(Boolean) : []; } })() : []),
    media: [],
  };
}

function LibraryCard({ tweet, mediaFiles, onOpen, onImageOpen, classifications }) {
  return <article className="card" onClick={() => onOpen(tweet)}>
    {tweet.media.length > 0 && <div className={`media-grid media-${Math.min(tweet.media.length, 4)}`}>
      {tweet.media.slice(0, 4).map((media) => <MediaPreview key={media.id} media={media} mediaFiles={mediaFiles} onImageOpen={onImageOpen} classification={classifications.get(media.filename)} />)}
      {tweet.media.length > 4 && <span className="media-more">+{tweet.media.length - 4}</span>}
    </div>}
    <div className="card-body" role="button" tabIndex="0" onClick={() => onOpen(tweet)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onOpen(tweet); }}>
      <div className="author-line"><span className="avatar">{(tweet.name || '?').slice(0, 1).toUpperCase()}</span><strong>{tweet.name}</strong><span>@{tweet.screenName || 'unknown'}</span><time>{formatDate(tweet.createdAt)}</time></div>
      <p>{tweet.text || 'No text captured.'}</p>
      {tweet.tags.length > 0 && <div className="tag-list">{tweet.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>}
      <div className="card-footer"><span>{tweet.media.length ? `${tweet.media.length} attachment${tweet.media.length === 1 ? '' : 's'}` : 'Text only'}</span>{tweet.rating > 0 && <span className="rating">{'★'.repeat(tweet.rating)}</span>}</div>
    </div>
  </article>;
}

function MediaPreview({ media, mediaFiles, onImageOpen, classification }) {
  const file = mediaFiles.get(media.filename);
  const [src, setSrc] = useState('');
  const videoRef = useRef(null);
  const mediaFrameRef = useRef(null);
  useEffect(() => {
    if (!file) {
      setSrc('');
      return undefined;
    }
    const objectUrl = URL.createObjectURL(file);
    setSrc(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  useEffect(() => {
    const frame = mediaFrameRef.current;
    const video = videoRef.current;
    if (!frame || !video || !isVideoMedia(media, file)) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) video.pause();
    }, { threshold: 0.1 });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [file, media, src]);
  if (!file) return <div className="media-frame media-missing"><span>{media.type === 'video' ? '▶' : '◇'}</span><small>{media.filename || media.type}</small></div>;
  if (!src) return <div className="media-frame media-missing"><span>◇</span></div>;
  if (isVideoMedia(media, file)) return <div ref={mediaFrameRef} className="media-frame video-frame" onClick={(event) => event.stopPropagation()}><video ref={videoRef} src={src} muted preload="metadata" controls playsInline /></div>;
  return <div ref={mediaFrameRef} className="media-frame image-frame" onClick={(event) => { event.stopPropagation(); onImageOpen?.({ media, src }); }}><img src={src} alt="" />{classification && <span className={`classification classification-${classification.category.toLowerCase()}`}>{classification.category} {Math.round(classification.score * 100)}%</span>}</div>;
}

function App() {
  const [tweets, setTweets] = useState([]);
  const [mediaFiles, setMediaFiles] = useState(new Map());
  const [classifications, setClassifications] = useState(new Map());
  const [classifying, setClassifying] = useState(false);
  const classifyAbortRef = useRef(null);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState('all');
  const [mediaTypeFilter, setMediaTypeFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(24);
  const [selected, setSelected] = useState(null);
  const [viewer, setViewer] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [tagDraft, setTagDraft] = useState('');
  const [contextMenu, setContextMenu] = useState(null);
  const [recentTags, setRecentTags] = useState(() => JSON.parse(localStorage.getItem('bookmark-library-recent-tags') || '[]'));
  const [databaseName, setDatabaseName] = useState('bookmarks.db');
  const [hasCachedFiles, setHasCachedFiles] = useState(false);
  const [status, setStatus] = useState('Choose your database to begin.');
  const dbInput = useRef(null);
  const mediaInput = useRef(null);
  const databaseRef = useRef(null);
  const databaseHandleRef = useRef(null);
  const mediaDirectoryHandleRef = useRef(null);
  const tagInputRef = useRef(null);

  const releaseDatabase = () => {
    if (databaseRef.current) {
      databaseRef.current.close();
      databaseRef.current = null;
    }
    databaseHandleRef.current = null;
  };

  const closeDatabase = () => {
    releaseDatabase();
    setTweets([]);
    setSelected(null);
    setMediaFiles(new Map());
    setStatus('Database closed.');
  };

  const openImage = ({ media, src }) => {
    setZoom(1);
    setViewer({ media, src });
  };

  const closeViewer = () => {
    setViewer(null);
    setZoom(1);
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeViewer();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  useEffect(() => {
    window.addEventListener('pagehide', releaseDatabase);
    return () => {
      window.removeEventListener('pagehide', releaseDatabase);
      releaseDatabase();
    };
  }, []);

  const loadDatabase = async (file) => {
    if (!file) return;
    setStatus('Reading database…');
    try {
      if (databaseRef.current) databaseRef.current.close();
      const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
      const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
      databaseRef.current = db;
      setDatabaseName(file.name);
      setStatus(`${file.name} loaded. Reading bookmarks…`);
      const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.flat() || [];
      if (!tables.includes('tweets')) throw new Error('This file does not contain a tweets table.');
      const tweetColumns = db.exec('PRAGMA table_info(tweets)')[0]?.values.map((row) => row[1]) || [];
      const mediaColumns = tables.includes('media') ? db.exec('PRAGMA table_info(media)')[0]?.values.map((row) => row[1]) || [] : [];
      const tweetSelect = ['id', 'name', 'screen_name', 'full_text', 'created_at', 'permanent_url', 'bookmarked', 'rating', 'tags'].map((column) => tweetColumns.includes(column) ? `"${column}"` : `NULL AS "${column}"`).join(',');
      const tweetRows = db.exec(`SELECT ${tweetSelect} FROM tweets ORDER BY created_at DESC`)[0];
      const parsed = (tweetRows?.values || []).map((values) => normalizeTweet(Object.fromEntries(tweetRows.columns.map((key, index) => [key, values[index]]))));
      if (tables.includes('media')) {
        const mediaSelect = ['id', 'tweet_id', 'position', 'index', 'url', 'type', 'downloaded'].map((column) => mediaColumns.includes(column) ? `"${column}"` : `NULL AS "${column}"`).join(',');
        const mediaOrder = mediaColumns.includes('position') ? '"position"' : mediaColumns.includes('index') ? '"index"' : 'rowid';
        const mediaRows = db.exec(`SELECT ${mediaSelect} FROM media ORDER BY ${mediaOrder}`)[0];
        const byId = new Map(parsed.map((tweet) => [tweet.id, tweet]));
        (mediaRows?.values || []).forEach((values) => {
          const row = Object.fromEntries(mediaRows.columns.map((key, index) => [key, values[index]]));
          const tweet = byId.get(String(row.tweet_id));
          if (!tweet) return;
          const source = row.url || '';
          const path = source.split('?')[0];
          const extension = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
          const filenameBase = `twitter-@${tweet.screenName}-${new Date(tweet.createdAt).toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-')}-${tweet.id}`;
          const count = (mediaRows.values || []).filter((item) => String(item[mediaRows.columns.indexOf('tweet_id')]) === tweet.id).length;
          const position = row.position ?? row.index ?? 0;
          const filename = `${filenameBase}${count > 1 ? `-${position}` : ''}${extension}`;
          tweet.media.push({ id: String(row.id), type: row.type || 'photo', url: source, filename, downloaded: Boolean(row.downloaded) });
        });
      }
      setTweets(parsed);
      const hasClassificationTable = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='image_classifications'")[0];
      const savedClassifications = hasClassificationTable ? db.exec("SELECT filename, category, source_label, score, model, classified_at FROM image_classifications")[0] : null;
      if (savedClassifications) {
        setClassifications(new Map(savedClassifications.values.map((row) => [row[0], {
          category: row[1], source: row[2], score: Number(row[3]), model: row[4], classifiedAt: row[5],
        }])));
      } else {
        setClassifications(new Map());
      }
      setStatus(`${parsed.length.toLocaleString()} bookmarks loaded from ${file.name}.`);
    } catch (error) {
      setStatus(`Could not open database: ${error.message}`);
    }
  };

  const chooseDatabase = async () => {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{ description: 'SQLite database', accept: { 'application/vnd.sqlite3': ['.db', '.sqlite', '.sqlite3'] } }],
        });
        if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted' &&
          (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
          setStatus('Read/write permission is required to save tags automatically.');
          return;
        }
        databaseHandleRef.current = handle;
        await saveHandle('database', handle);
        await loadDatabase(await handle.getFile());
        return;
      } catch (error) {
        if (error.name === 'AbortError') return;
        setStatus(`Could not open database: ${error.message}`);
        return;
      }
    }
    dbInput.current?.click();
  };

  const chooseMediaDirectory = async () => {
    if (window.showDirectoryPicker) {
      try {
        const handle = await window.showDirectoryPicker();
        mediaDirectoryHandleRef.current = handle;
        await saveHandle('media-directory', handle);
        const files = [];
        for await (const entry of handle.values()) {
          if (entry.kind === 'file' && MEDIA_EXTENSIONS.test(entry.name)) files.push(await entry.getFile());
        }
        loadMedia(files);
        return;
      } catch (error) {
        if (error.name !== 'AbortError') setStatus(`Could not open media folder: ${error.message}`);
        return;
      }
    }
    mediaInput.current?.click();
  };

  const saveTags = async (tweet, tags) => {
    const cleaned = [...new Map(tags.map((tag) => [tag.trim().toLowerCase(), tag.trim()])).values()].filter(Boolean).slice(0, 30);
    if (!databaseRef.current) return;
    const hasTagsColumn = databaseRef.current.exec('PRAGMA table_info(tweets)')[0]?.values.some((row) => row[1] === 'tags');
    if (!hasTagsColumn) databaseRef.current.run("ALTER TABLE tweets ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    databaseRef.current.run('UPDATE tweets SET tags = ? WHERE id = ?', [JSON.stringify(cleaned), tweet.id]);
    setTweets((current) => current.map((item) => item.id === tweet.id ? { ...item, tags: cleaned } : item));
    setSelected((current) => current && current.id === tweet.id ? { ...current, tags: cleaned } : current);
    const updatedRecentTags = [...new Set([...cleaned, ...recentTags])].slice(0, 12);
    setRecentTags(updatedRecentTags);
    localStorage.setItem('bookmark-library-recent-tags', JSON.stringify(updatedRecentTags));
    const handle = databaseHandleRef.current;
    if (handle) {
      try {
        const permission = await handle.queryPermission({ mode: 'readwrite' });
        if (permission !== 'granted' && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Write permission was not granted');
        const writable = await handle.createWritable();
        await writable.write(databaseRef.current.export());
        await writable.close();
        setStatus(`Saved tags for ${tweet.name} directly to ${databaseName}.`);
        return;
      } catch (error) {
        setStatus(`Tags updated, but could not write the database: ${error.message}`);
        return;
      }
    }
    setStatus(`Saved tags for ${tweet.name} in memory. Download the updated database to keep them.`);
  };

  const allTags = useMemo(() => [...new Set(tweets.flatMap((tweet) => tweet.tags))].sort((a, b) => a.localeCompare(b)), [tweets]);

  const openTagEditor = (tweet, event) => {
    event?.preventDefault();
    event?.stopPropagation();
    setContextMenu(null);
    setSelected(tweet);
    setTagDraft('');
    setTimeout(() => tagInputRef.current?.focus(), 0);
  };

  const downloadDatabase = () => {
    if (!databaseRef.current) return;
    const blob = new Blob([databaseRef.current.export()], { type: 'application/vnd.sqlite3' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = databaseName.replace(/\.(db|sqlite|sqlite3)$/i, '') + '-tagged.db';
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('Updated database downloaded with your tags.');
  };

  const loadMedia = (files) => {
    const map = new Map();
    Array.from(files || []).filter((file) => MEDIA_EXTENSIONS.test(file.name)).forEach((file) => map.set(file.name, file));
    setMediaFiles(map);
    setStatus(`${tweets.length.toLocaleString()} bookmarks loaded · ${map.size.toLocaleString()} local media files linked.`);
  };

  const classifyImages = async () => {
    const images = [...mediaFiles.entries()].filter(([name]) => /\.(avif|gif|jpe?g|png|webp)$/i.test(name));
    if (!images.length) {
      setStatus('No local images are linked. Choose the media folder first.');
      return;
    }
    setClassifying(true);
    classifyAbortRef.current = new AbortController();
    setStatus('Loading local image safety model…');
    try {
      const [{ load }, tf] = await Promise.all([import('nsfwjs'), import('@tensorflow/tfjs')]);
      // Keep inference off the compositor/GPU. WebGL tensor allocations can
      // accumulate across a large archive and take the desktop session down.
      const backend = 'cpu';
      await tf.setBackend(backend);
      await tf.ready();
      databaseRef.current?.run(`CREATE TABLE IF NOT EXISTS image_classifications (
        filename TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        source_label TEXT NOT NULL,
        score REAL NOT NULL,
        model TEXT NOT NULL,
        classified_at TEXT NOT NULL
      )`);
      const model = await load('MobileNetV2');
      const results = new Map(classifications);
      for (let index = 0; index < images.length; index += 1) {
        if (classifyAbortRef.current.signal.aborted) break;
        const [filename, file] = images[index];
        const objectUrl = URL.createObjectURL(file);
        const canvas = document.createElement('canvas');
        canvas.width = 224;
        canvas.height = 224;
        try {
          const image = new Image();
          image.src = objectUrl;
          await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
          });
          const context = canvas.getContext('2d', { willReadFrequently: true });
          context.drawImage(image, 0, 0, 224, 224);
          tf.engine().startScope();
          let predictions;
          try {
            predictions = await model.classify(canvas);
          } finally {
            tf.engine().endScope();
          }
          const top = predictions.sort((a, b) => b.probability - a.probability)[0];
          const result = { category: classificationLabel({ className: top.className }), score: top.probability, source: top.className, model: `NSFWJS MobileNetV2 (${backend})`, classifiedAt: new Date().toISOString() };
          results.set(filename, result);
          databaseRef.current?.run(
            'INSERT OR REPLACE INTO image_classifications (filename, category, source_label, score, model, classified_at) VALUES (?, ?, ?, ?, ?, ?)',
            [filename, result.category, result.source, result.score, result.model, result.classifiedAt],
          );
        } finally {
          URL.revokeObjectURL(objectUrl);
          canvas.width = 0;
          canvas.height = 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        setStatus(`Classifying local images… ${index + 1}/${images.length}`);
      }
      model.dispose?.();
      setClassifications(results);
      setStatus(`Classified ${Math.min(images.length, results.size).toLocaleString()} local images using ${backend}. Results saved to the database.`);
    } catch (error) {
      setStatus(`Could not load the local image model: ${error.message}`);
    } finally {
      classifyAbortRef.current = null;
      setClassifying(false);
    }
  };

  const stopClassification = () => {
    classifyAbortRef.current?.abort();
    setStatus('Stopping image classification…');
  };

  const restoreLastFiles = async (requestPermission = false) => {
    try {
      const databaseHandle = await readHandle('database');
      if (databaseHandle) {
        const permission = await databaseHandle.queryPermission({ mode: 'read' });
        if (permission === 'granted' || (requestPermission && await databaseHandle.requestPermission({ mode: 'read' }) === 'granted')) {
          databaseHandleRef.current = databaseHandle;
          await loadDatabase(await databaseHandle.getFile());
        }
      }
      const mediaHandle = await readHandle('media-directory');
      if (mediaHandle) {
        const permission = await mediaHandle.queryPermission({ mode: 'read' });
        if (permission === 'granted' || (requestPermission && await mediaHandle.requestPermission({ mode: 'read' }) === 'granted')) {
          mediaDirectoryHandleRef.current = mediaHandle;
          const files = [];
          for await (const entry of mediaHandle.values()) {
            if (entry.kind === 'file' && MEDIA_EXTENSIONS.test(entry.name)) files.push(await entry.getFile());
          }
          loadMedia(files);
        }
      }
      setHasCachedFiles(false);
    } catch (error) {
      setStatus(`Could not restore files: ${error.message}`);
    }
  };

  useEffect(() => {
    Promise.all([readHandle('database'), readHandle('media-directory')])
      .then(async ([databaseHandle, mediaHandle]) => {
        setHasCachedFiles(Boolean(databaseHandle || mediaHandle));
        if (databaseHandle && await databaseHandle.queryPermission({ mode: 'read' }) === 'granted') restoreLastFiles();
      })
      .catch(() => {});
  }, []);

  const visibleTweets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return tweets.filter((tweet) => {
      const matchesQuery = !normalized || `${tweet.text} ${tweet.name} ${tweet.screenName}`.toLowerCase().includes(normalized);
      const matchesTag = tagFilter === 'all' || tweet.tags.includes(tagFilter);
      const matchesMediaType = mediaTypeFilter === 'all' || tweet.media.some((media) => media.type === mediaTypeFilter);
      return matchesQuery && matchesTag && matchesMediaType;
    }).sort((a, b) => sort === 'oldest' ? new Date(a.createdAt) - new Date(b.createdAt) : new Date(b.createdAt) - new Date(a.createdAt));
  }, [tweets, query, tagFilter, mediaTypeFilter, sort]);

  useEffect(() => {
    setPage(1);
  }, [query, tagFilter, mediaTypeFilter, sort, pageSize]);

  const pageCount = Math.max(1, Math.ceil(visibleTweets.length / pageSize));
  const pagedTweets = visibleTweets.slice((page - 1) * pageSize, page * pageSize);

  const mediaTypeCounts = useMemo(() => ['photo', 'video', 'animated_gif'].reduce((counts, type) => {
    counts[type] = tweets.reduce((total, tweet) => total + (tweet.media.some((media) => media.type === type) ? 1 : 0), 0);
    return counts;
  }, {}), [tweets]);

  const tagCounts = useMemo(() => tweets.reduce((counts, tweet) => {
    tweet.tags.forEach((tag) => { counts[tag] = (counts[tag] || 0) + 1; });
    return counts;
  }, {}), [tweets]);

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark">✦</div><div><h1>Bookmark Library</h1><p>Local archive · private by default</p></div></div><div className="actions"><button className="button secondary" onClick={chooseDatabase}>Open database</button>{tweets.length > 0 && <><button className="button secondary" onClick={downloadDatabase}>Download tagged database</button><button className="button secondary" onClick={closeDatabase}>Close database</button></>}{classifying ? <button className="button secondary" onClick={stopClassification}>Stop classification</button> : <button className="button secondary" disabled={mediaFiles.size === 0} onClick={classifyImages}>Classify images</button>}<button className="button" onClick={chooseMediaDirectory}>Link media folder</button><input ref={dbInput} type="file" accept=".db,.sqlite,.sqlite3" hidden onChange={(event) => loadDatabase(event.target.files?.[0])} /><input ref={mediaInput} type="file" webkitdirectory="true" multiple hidden onChange={(event) => loadMedia(event.target.files)} /></div></header>
    <main>
      {tweets.length === 0 ? <section className="empty"><div className="empty-icon">✦</div><h2>Your archive, reconstructed locally.</h2><p>Open the <code>bookmarks.db</code> file created by the downloader, then choose its <code>media/</code> directory for previews.</p><div className="empty-actions"><button className="button" onClick={chooseDatabase}>Choose bookmarks.db</button><button className="button secondary" onClick={chooseMediaDirectory}>Choose media folder</button>{hasCachedFiles && <button className="button secondary" onClick={() => restoreLastFiles(true)}>Restore last files</button>}</div><p className="privacy">Nothing is uploaded. The database is parsed in this browser tab.</p></section> : <>
        <section className="library-head"><div><p className="eyebrow">YOUR ARCHIVE</p><h2>{visibleTweets.length.toLocaleString()} <span>bookmarks</span></h2><p className="status">{status}</p></div><div className="stats"><span><b>{tweets.filter((tweet) => tweet.media.length).length.toLocaleString()}</b> with media</span><span><b>{tweets.filter((tweet) => tweet.rating > 0).length.toLocaleString()}</b> rated</span></div></section>
        <section className="controls"><label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search bookmarks, authors, or text" /></label><select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="all">All tags</option>{Object.entries(tagCounts).sort(([a], [b]) => a.localeCompare(b)).map(([tag, count]) => <option key={tag} value={tag}>#{tag} ({count})</option>)}</select><select value={mediaTypeFilter} onChange={(event) => setMediaTypeFilter(event.target.value)}><option value="all">Any media type</option>{['photo', 'video', 'animated_gif'].map((type) => <option key={type} value={type}>{mediaTypeLabel(type)} ({mediaTypeCounts[type]})</option>)}</select><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select><label className="page-size">Show <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}><option value="12">12</option><option value="24">24</option><option value="48">48</option><option value="96">96</option></select> per page</label></section>
        <section className="grid">{pagedTweets.map((tweet) => <div key={tweet.id} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ tweet, x: event.clientX, y: event.clientY }); }}><LibraryCard tweet={tweet} mediaFiles={mediaFiles} classifications={classifications} onOpen={setSelected} onImageOpen={openImage} /></div>)}</section>
        <nav className="pagination" aria-label="Pagination"><button className="button secondary" disabled={page === 1} onClick={() => setPage((current) => current - 1)}>Previous</button><span>Page {page} of {pageCount}</span><button className="button secondary" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>Next</button></nav>
      </>}
    </main>
    {contextMenu && <><div className="context-dismiss" onClick={() => setContextMenu(null)} /><div className="context-menu" style={{ left: Math.min(contextMenu.x, window.innerWidth - 190), top: Math.min(contextMenu.y, window.innerHeight - 70) }}><button onClick={() => openTagEditor(contextMenu.tweet)}>＋ Add/edit tags</button></div></>}
    {selected && <div className="modal-backdrop" onClick={() => setSelected(null)}><div className="modal" onClick={(event) => event.stopPropagation()}><button className="close" onClick={() => setSelected(null)}>×</button><div className="modal-meta"><strong>{selected.name}</strong><span>@{selected.screenName}</span><time>{formatDate(selected.createdAt)}</time></div><p className="modal-text">{selected.text}</p><div className="tag-editor"><div className="tag-list">{selected.tags.map((tag) => <button key={tag} type="button" onClick={() => saveTags(selected, selected.tags.filter((item) => item !== tag))}>#{tag} ×</button>)}</div><div className="recent-tags"><small>Recent tags</small>{recentTags.map((tag) => <button key={tag} type="button" onClick={() => saveTags(selected, [...selected.tags, tag])} disabled={selected.tags.includes(tag)}>#{tag}</button>)}</div><form onSubmit={(event) => { event.preventDefault(); if (tagDraft.trim()) { saveTags(selected, [...selected.tags, tagDraft]); setTagDraft(''); } }}><input ref={tagInputRef} list="existing-tags" value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="Add a tag" /><datalist id="existing-tags">{allTags.map((tag) => <option key={tag} value={tag} />)}</datalist><button className="button secondary" type="submit">Add</button></form></div>{selected.media.length > 0 && <div className="modal-media">{selected.media.map((media) => <MediaPreview key={media.id} media={media} mediaFiles={mediaFiles} onImageOpen={openImage} classification={classifications.get(media.filename)} />)}</div>}<a className="permalink" href={selected.url} target="_blank" rel="noreferrer">Open original post ↗</a></div></div>}
    {viewer && <div className="image-viewer" onClick={closeViewer}><div className="viewer-toolbar" onClick={(event) => event.stopPropagation()}><button onClick={() => setZoom((value) => Math.max(.5, value - .25))}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom((value) => Math.min(5, value + .25))}>+</button><button onClick={closeViewer}>×</button></div><img src={viewer.src} alt="" style={{ transform: `scale(${zoom})` }} onWheel={(event) => { event.preventDefault(); setZoom((value) => Math.min(5, Math.max(.5, value + (event.deltaY < 0 ? .25 : -.25)))); }} onClick={(event) => event.stopPropagation()} /></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
