import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import './styles.css';

const MEDIA_EXTENSIONS = /\.(avif|gif|jpe?g|png|webp|mp4|webm|mov)$/i;

function formatDate(value) {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function normalizeTweet(row) {
  return {
    id: String(row.id ?? ''),
    name: row.name || row.author_name || 'Unknown author',
    screenName: row.screen_name || row.author_screen_name || '',
    text: row.full_text || row.text || '',
    createdAt: row.created_at || row.createdAt || '',
    url: row.permanent_url || row.url || `https://x.com/i/status/${row.id}`,
    bookmarked: row.bookmarked || 'yes',
    rating: Number(row.rating || 0),
    media: [],
  };
}

function LibraryCard({ tweet, mediaFiles, onOpen }) {
  return <article className="card" onClick={() => onOpen(tweet)}>
    {tweet.media.length > 0 && <div className={`media-grid media-${Math.min(tweet.media.length, 4)}`}>
      {tweet.media.slice(0, 4).map((media) => <MediaPreview key={media.id} media={media} mediaFiles={mediaFiles} />)}
      {tweet.media.length > 4 && <span className="media-more">+{tweet.media.length - 4}</span>}
    </div>}
    <div className="card-body">
      <div className="author-line"><strong>{tweet.name}</strong><span>@{tweet.screenName || 'unknown'}</span><time>{formatDate(tweet.createdAt)}</time></div>
      <p>{tweet.text || 'No text captured.'}</p>
      <div className="card-footer"><span>{tweet.media.length ? `${tweet.media.length} attachment${tweet.media.length === 1 ? '' : 's'}` : 'Text only'}</span>{tweet.rating > 0 && <span className="rating">{'★'.repeat(tweet.rating)}</span>}</div>
    </div>
  </article>;
}

function MediaPreview({ media, mediaFiles }) {
  const file = mediaFiles.get(media.filename);
  if (!file) return <div className="media-missing"><span>{media.type === 'video' ? '▶' : '◇'}</span><small>{media.filename || media.type}</small></div>;
  const src = URL.createObjectURL(file);
  if (media.type === 'video' || /\.(mp4|webm|mov)$/i.test(file.name)) return <video src={src} muted preload="metadata" />;
  return <img src={src} alt="" />;
}

function App() {
  const [tweets, setTweets] = useState([]);
  const [mediaFiles, setMediaFiles] = useState(new Map());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState('Choose your database to begin.');
  const dbInput = useRef(null);
  const mediaInput = useRef(null);

  const loadDatabase = async (file) => {
    if (!file) return;
    setStatus('Reading database…');
    try {
      const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
      const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
      const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.flat() || [];
      if (!tables.includes('tweets')) throw new Error('This file does not contain a tweets table.');
      const tweetColumns = db.exec('PRAGMA table_info(tweets)')[0]?.values.map((row) => row[1]) || [];
      const mediaColumns = tables.includes('media') ? db.exec('PRAGMA table_info(media)')[0]?.values.map((row) => row[1]) || [] : [];
      const tweetSelect = ['id', 'name', 'screen_name', 'full_text', 'created_at', 'permanent_url', 'bookmarked', 'rating'].map((column) => tweetColumns.includes(column) ? `"${column}"` : `NULL AS "${column}"`).join(',');
      const tweetRows = db.exec(`SELECT ${tweetSelect} FROM tweets ORDER BY created_at DESC`)[0];
      const parsed = (tweetRows?.values || []).map((values) => normalizeTweet(Object.fromEntries(tweetRows.columns.map((key, index) => [key, values[index]]))));
      if (tables.includes('media')) {
        const mediaSelect = ['id', 'tweet_id', 'position', 'index', 'url', 'type', 'downloaded'].map((column) => mediaColumns.includes(column) ? `"${column}"` : `NULL AS "${column}"`).join(',');
        const mediaRows = db.exec(`SELECT ${mediaSelect} FROM media ORDER BY COALESCE(position, "index", 0)`)[0];
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
      setStatus(`${parsed.length.toLocaleString()} bookmarks loaded from ${file.name}.`);
    } catch (error) {
      setStatus(`Could not open database: ${error.message}`);
    }
  };

  const loadMedia = (files) => {
    const map = new Map();
    Array.from(files || []).filter((file) => MEDIA_EXTENSIONS.test(file.name)).forEach((file) => map.set(file.name, file));
    setMediaFiles(map);
    setStatus(`${tweets.length.toLocaleString()} bookmarks loaded · ${map.size.toLocaleString()} local media files linked.`);
  };

  const visibleTweets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return tweets.filter((tweet) => {
      const matchesQuery = !normalized || `${tweet.text} ${tweet.name} ${tweet.screenName}`.toLowerCase().includes(normalized);
      const matchesFilter = filter === 'all' || (filter === 'media' && tweet.media.length > 0) || (filter === 'unrated' && tweet.rating === 0) || (filter === 'rated' && tweet.rating > 0);
      return matchesQuery && matchesFilter;
    }).sort((a, b) => sort === 'oldest' ? new Date(a.createdAt) - new Date(b.createdAt) : new Date(b.createdAt) - new Date(a.createdAt));
  }, [tweets, query, filter, sort]);

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark">✦</div><div><h1>Bookmark Library</h1><p>Local archive · private by default</p></div></div><div className="actions"><button className="button secondary" onClick={() => dbInput.current?.click()}>Open database</button><button className="button" onClick={() => mediaInput.current?.click()}>Link media folder</button><input ref={dbInput} type="file" accept=".db,.sqlite,.sqlite3" hidden onChange={(event) => loadDatabase(event.target.files?.[0])} /><input ref={mediaInput} type="file" webkitdirectory="true" multiple hidden onChange={(event) => loadMedia(event.target.files)} /></div></header>
    <main>
      {tweets.length === 0 ? <section className="empty"><div className="empty-icon">✦</div><h2>Your archive, reconstructed locally.</h2><p>Open the <code>bookmarks.db</code> file created by the downloader, then optionally link its <code>media/</code> folder for previews.</p><div className="empty-actions"><button className="button" onClick={() => dbInput.current?.click()}>Choose bookmarks.db</button><button className="button secondary" onClick={() => mediaInput.current?.click()}>Choose media folder</button></div><p className="privacy">Nothing is uploaded. The database is parsed in this browser tab.</p></section> : <>
        <section className="library-head"><div><p className="eyebrow">YOUR ARCHIVE</p><h2>{visibleTweets.length.toLocaleString()} <span>bookmarks</span></h2><p className="status">{status}</p></div><div className="stats"><span><b>{tweets.filter((tweet) => tweet.media.length).length.toLocaleString()}</b> with media</span><span><b>{tweets.filter((tweet) => tweet.rating > 0).length.toLocaleString()}</b> rated</span></div></section>
        <section className="controls"><label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search bookmarks, authors, or text" /></label><div className="filter-tabs"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button><button className={filter === 'media' ? 'active' : ''} onClick={() => setFilter('media')}>With media</button><button className={filter === 'rated' ? 'active' : ''} onClick={() => setFilter('rated')}>Rated</button></div><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></section>
        <section className="grid">{visibleTweets.map((tweet) => <LibraryCard key={tweet.id} tweet={tweet} mediaFiles={mediaFiles} onOpen={setSelected} />)}</section>
      </>}
    </main>
    {selected && <div className="modal-backdrop" onClick={() => setSelected(null)}><div className="modal" onClick={(event) => event.stopPropagation()}><button className="close" onClick={() => setSelected(null)}>×</button><div className="modal-meta"><strong>{selected.name}</strong><span>@{selected.screenName}</span><time>{formatDate(selected.createdAt)}</time></div><p className="modal-text">{selected.text}</p>{selected.media.length > 0 && <div className="modal-media">{selected.media.map((media) => <MediaPreview key={media.id} media={media} mediaFiles={mediaFiles} />)}</div>}<a className="permalink" href={selected.url} target="_blank" rel="noreferrer">Open original post ↗</a></div></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
