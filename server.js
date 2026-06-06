/**
 * SOUNDBAGD — Backend Server
 * Stack: Express + SQLite (better-sqlite3) + iTunes Search API (no key needed)
 *
 * HOW TO RUN:
 *   1. npm install
 *   2. node server.js   (or: npm run dev for auto-restart)
 *   3. Open http://localhost:3000
 */

'use strict';

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const Database = require('better-sqlite3');
const fetch    = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'soundbagd-dev-secret-change-in-prod';

// ── Middleware ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));   // serve HTML/CSS/JS

// ── Database ───────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'soundbagd.db');
const db = new Database(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    email           TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    password_hash   TEXT    NOT NULL,
    bio             TEXT    DEFAULT '',
    initials        TEXT,
    avatar_gradient TEXT    DEFAULT 'linear-gradient(135deg,#d4af37,#7c5cbf)',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS albums (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    itunes_id   TEXT    UNIQUE,
    title       TEXT    NOT NULL,
    artist      TEXT    NOT NULL,
    artwork_url TEXT    DEFAULT '',
    year        INTEGER,
    genre       TEXT    DEFAULT '',
    media_type  TEXT    DEFAULT 'Album',
    track_count INTEGER,
    itunes_url  TEXT    DEFAULT '',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    album_id    INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    rating      REAL    NOT NULL CHECK(rating >= 0.5 AND rating <= 5.0),
    review_text TEXT,
    dsp_url     TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, album_id)
  );

  CREATE TABLE IF NOT EXISTS top5_albums (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 5),
    UNIQUE(user_id, position)
  );

  CREATE TABLE IF NOT EXISTS top5_songs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    song_title  TEXT NOT NULL,
    artist      TEXT NOT NULL,
    album_title TEXT,
    artwork_url TEXT DEFAULT '',
    itunes_id   TEXT,
    position    INTEGER NOT NULL CHECK(position BETWEEN 1 AND 5),
    UNIQUE(user_id, position)
  );

  CREATE TABLE IF NOT EXISTS top5_artists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    artist_name TEXT NOT NULL,
    artwork_url TEXT DEFAULT '',
    genre       TEXT DEFAULT '',
    itunes_id   TEXT,
    position    INTEGER NOT NULL CHECK(position BETWEEN 1 AND 5),
    UNIQUE(user_id, position)
  );

  CREATE TABLE IF NOT EXISTS lists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT    NOT NULL,
    description TEXT    DEFAULT '',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS list_items (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id  INTEGER NOT NULL REFERENCES lists(id)  ON DELETE CASCADE,
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(list_id, album_id)
  );

  CREATE INDEX IF NOT EXISTS idx_reviews_album  ON reviews(album_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_user   ON reviews(user_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_recent ON reviews(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_lists_user     ON lists(user_id);
  CREATE INDEX IF NOT EXISTS idx_list_items     ON list_items(list_id);
`);

// ── In-Memory Cache ────────────────────────────────────────
const cache    = new Map();
const CACHE_1H = 60 * 60 * 1000;
const CACHE_5M = 5  * 60 * 1000;

async function cachedFetch(url, ttl = CACHE_1H) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Soundbagd/1.0 (music review app)' },
    timeout: 12000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const data = await res.json();
  cache.set(url, { data, ts: Date.now() });
  return data;
}

// ── iTunes Helpers ─────────────────────────────────────────
function artworkHQ(url, size = 600) {
  if (!url) return '';
  return url
    .replace(/\d+x\d+bb/, `${size}x${size}bb`)
    .replace(/\d+x\d+/, `${size}x${size}`);
}

function formatAlbum(item) {
  return {
    itunesId:  String(item.collectionId || ''),
    title:     item.collectionName   || '',
    artist:    item.artistName        || '',
    artwork:   artworkHQ(item.artworkUrl100),
    year:      item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
    genre:     item.primaryGenreName || '',
    mediaType: item.collectionType   || 'Album',
    trackCount:item.trackCount       || null,
    itunesUrl: item.collectionViewUrl|| '',
  };
}

// ── Auth Middleware ────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session — please sign in again' });
  }
}

// ── AUTH ROUTES ────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  let { username, email, password } = req.body || {};
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Username, email, and password are required' });

  username = username.trim().toLowerCase();
  email    = email.trim().toLowerCase();

  if (username.length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (!/^[a-z0-9_]+$/.test(username))
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Please enter a valid email address' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const initials = username.slice(0, 2).toUpperCase();
    const gradients = [
      'linear-gradient(135deg,#d4af37,#7c5cbf)',
      'linear-gradient(135deg,#ff6b6b,#d4af37)',
      'linear-gradient(135deg,#7c5cbf,#ff6b6b)',
      'linear-gradient(135deg,#d4af37,#ff6b6b)',
      'linear-gradient(135deg,#4facfe,#7c5cbf)',
    ];
    const gradient = gradients[Math.floor(Math.random() * gradients.length)];

    const result = db.prepare(
      'INSERT INTO users (username,email,password_hash,initials,avatar_gradient) VALUES (?,?,?,?,?)'
    ).run(username, email, hash, initials, gradient);

    const token = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: result.lastInsertRowid, username, email, initials, gradient } });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      if (err.message.includes('username')) return res.status(409).json({ error: 'That username is already taken' });
      if (err.message.includes('email'))    return res.status(409).json({ error: 'An account with that email already exists' });
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    user: { id: user.id, username: user.username, email: user.email, initials: user.initials, gradient: user.avatar_gradient, bio: user.bio },
  });
});

// GET /api/auth/me
app.get('/api/auth/me', auth, (req, res) => {
  const u = db.prepare(
    'SELECT id,username,email,bio,initials,avatar_gradient,created_at FROM users WHERE id=?'
  ).get(req.user.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(u);
});

// ── MUSIC ROUTES (iTunes Search API — no key needed) ───────

// GET /api/music/trending
app.get('/api/music/trending', async (req, res) => {
  try {
    // Apple's official charts RSS (completely free, no key)
    const data = await cachedFetch(
      'https://rss.applemarketingtools.com/api/v2/us/music/most-played/25/albums.json',
      CACHE_1H
    );
    const albums = (data.feed?.results || []).map(item => ({
      itunesId:  String(item.id),
      title:     item.name,
      artist:    item.artistName,
      artwork:   artworkHQ(item.artworkUrl100),
      year:      item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
      genre:     item.genres?.[0]?.name || '',
      mediaType: 'Album',
      itunesUrl: item.url || '',
    }));
    res.json(albums);
  } catch (err) {
    console.error('Trending error:', err.message);
    // Fallback: recent popular albums via search
    try {
      const data = await cachedFetch(
        'https://itunes.apple.com/search?term=album+2024+2025&entity=album&limit=20&sort=recent',
        CACHE_1H
      );
      res.json((data.results || []).filter(r => r.collectionType).map(formatAlbum));
    } catch { res.json([]); }
  }
});

// GET /api/music/search?q=…&type=album|track|artist&limit=20
app.get('/api/music/search', async (req, res) => {
  const { q, type = 'album', limit = 20 } = req.query;
  if (!q?.trim()) return res.status(400).json({ error: 'Query required' });

  const entityMap = { album: 'album', track: 'song', artist: 'musicArtist' };
  const entity = entityMap[type] || 'album';

  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=${entity}&limit=${Math.min(Number(limit), 50)}`;
    const data = await cachedFetch(url, CACHE_5M);

    const results = (data.results || []).map(item => {
      if (type === 'artist') return {
        itunesId: String(item.artistId || ''),
        name:     item.artistName || '',
        genre:    item.primaryGenreName || '',
        artwork:  artworkHQ(item.artworkUrl100 || ''),
        url:      item.artistLinkUrl || '',
      };
      if (type === 'track') return {
        itunesId:  String(item.trackId || ''),
        title:     item.trackName    || '',
        artist:    item.artistName   || '',
        album:     item.collectionName || '',
        albumId:   String(item.collectionId || ''),
        artwork:   artworkHQ(item.artworkUrl100),
        year:      item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
        duration:  item.trackTimeMillis || 0,
        itunesUrl: item.trackViewUrl || '',
      };
      return formatAlbum(item);
    });

    res.json(results);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed — please try again' });
  }
});

// GET /api/music/album/:id  — full album with tracks + our review stats
app.get('/api/music/album/:id', async (req, res) => {
  try {
    const data = await cachedFetch(
      `https://itunes.apple.com/lookup?id=${encodeURIComponent(req.params.id)}&entity=song`,
      CACHE_1H
    );
    const results = data.results || [];
    const collection = results.find(r => r.wrapperType === 'collection' || r.kind === 'album');
    if (!collection) return res.status(404).json({ error: 'Album not found' });

    const tracks = results
      .filter(r => r.wrapperType === 'track' && r.kind === 'song')
      .map(t => ({
        number:    t.trackNumber,
        title:     t.trackName,
        duration:  t.trackTimeMillis,
        itunesUrl: t.trackViewUrl,
      }));

    const album = { ...formatAlbum(collection), tracks };

    // Attach review stats from our DB
    const dbRow = db.prepare('SELECT id FROM albums WHERE itunes_id=?').get(req.params.id);
    if (dbRow) {
      const stats = db.prepare(`
        SELECT COUNT(*) as total, ROUND(AVG(rating),2) as avg,
               SUM(CASE WHEN rating=5   THEN 1 ELSE 0 END) as r5,
               SUM(CASE WHEN rating=4.5 THEN 1 ELSE 0 END) as r4h,
               SUM(CASE WHEN rating=4   THEN 1 ELSE 0 END) as r4,
               SUM(CASE WHEN rating=3.5 THEN 1 ELSE 0 END) as r3h,
               SUM(CASE WHEN rating=3   THEN 1 ELSE 0 END) as r3,
               SUM(CASE WHEN rating<=2.5 THEN 1 ELSE 0 END) as rLow
        FROM reviews WHERE album_id=?
      `).get(dbRow.id);
      album.stats = stats;
    } else {
      album.stats = { total: 0, avg: null };
    }

    res.json(album);
  } catch (err) {
    console.error('Album fetch error:', err.message);
    res.status(500).json({ error: 'Could not load album' });
  }
});

// ── DSP IMPORT ─────────────────────────────────────────────

// POST /api/dsp/import   { url: "https://..." }
app.post('/api/dsp/import', async (req, res) => {
  const { url } = req.body || {};
  if (!url?.trim()) return res.status(400).json({ error: 'URL required' });

  try {
    // ── Spotify ──────────────────────────────────────────
    if (url.includes('open.spotify.com') || url.includes('spotify.com')) {
      const oe = await cachedFetch(
        `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
        CACHE_1H
      );
      // Spotify oEmbed title format: "Album Name by Artist" or just "Track Name"
      let title = oe.title || '';
      let artist = '';
      if (title.includes(' by ')) {
        const idx = title.lastIndexOf(' by ');
        artist = title.slice(idx + 4).trim();
        title  = title.slice(0, idx).trim();
      }
      return res.json({ dsp: 'Spotify', title, artist, artwork: oe.thumbnail_url || '', year: null, embedHtml: oe.html });
    }

    // ── Apple Music ──────────────────────────────────────
    if (url.includes('music.apple.com')) {
      // Extract album/playlist ID from URL, e.g. .../album/some-name/123456789
      const match = url.match(/\/album\/[^/]+\/(\d+)/);
      if (match) {
        const data = await cachedFetch(
          `https://itunes.apple.com/lookup?id=${match[1]}&entity=song`,
          CACHE_1H
        );
        const col = (data.results || []).find(r => r.wrapperType === 'collection' || r.collectionType);
        if (col) return res.json({ dsp: 'Apple Music', ...formatAlbum(col) });
      }
      // Fallback: try the ID at end of URL
      const idMatch = url.match(/\/(\d{6,})(?:\?|$)/);
      if (idMatch) {
        const data = await cachedFetch(`https://itunes.apple.com/lookup?id=${idMatch[1]}`, CACHE_1H);
        const item = (data.results || [])[0];
        if (item) return res.json({ dsp: 'Apple Music', ...formatAlbum(item) });
      }
      return res.status(422).json({ error: 'Could not extract album ID from Apple Music URL' });
    }

    // ── TIDAL ────────────────────────────────────────────
    if (url.includes('tidal.com')) {
      try {
        const oe = await cachedFetch(
          `https://oembed.tidal.com/oembed?url=${encodeURIComponent(url)}`,
          CACHE_1H
        );
        return res.json({
          dsp:     'TIDAL',
          title:   oe.title   || '',
          artist:  oe.description || '',
          artwork: oe.thumbnail_url || '',
          year:    null,
        });
      } catch {
        return res.json({ dsp: 'TIDAL', title: '', artist: '', artwork: '', year: null,
          error: 'TIDAL metadata is limited — please fill in the details manually.' });
      }
    }

    // ── YouTube Music ────────────────────────────────────
    if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com')) {
      try {
        const oe = await cachedFetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
          CACHE_1H
        );
        return res.json({ dsp: 'YouTube Music', title: oe.title || '', artist: oe.author_name || '', artwork: oe.thumbnail_url || '', year: null });
      } catch {
        return res.json({ dsp: 'YouTube Music', title: '', artist: '', artwork: '', year: null,
          error: 'Could not fetch YouTube metadata — please fill in manually.' });
      }
    }

    // ── Amazon Music ─────────────────────────────────────
    if (url.includes('amazon.com/music') || url.includes('music.amazon.com')) {
      return res.json({ dsp: 'Amazon Music', title: '', artist: '', artwork: '', year: null,
        error: 'Amazon Music does not expose public metadata. Please fill in the details manually.' });
    }

    // ── Deezer ───────────────────────────────────────────
    if (url.includes('deezer.com')) {
      try {
        const oe = await cachedFetch(
          `https://www.deezer.com/oembed?url=${encodeURIComponent(url)}&format=json`,
          CACHE_1H
        );
        return res.json({ dsp: 'Deezer', title: oe.title || '', artist: oe.description || '', artwork: oe.thumbnail_url || '', year: null });
      } catch {
        return res.json({ dsp: 'Deezer', title: '', artist: '', artwork: '', year: null,
          error: 'Could not fetch Deezer metadata — please fill in manually.' });
      }
    }

    res.status(400).json({ error: 'Unsupported link. Paste a URL from Spotify, Apple Music, TIDAL, YouTube Music, Amazon Music, or Deezer.' });
  } catch (err) {
    console.error('DSP import error:', err.message);
    res.status(500).json({ error: 'Failed to fetch metadata from that link. The DSP may be temporarily unavailable.' });
  }
});

// ── REVIEW ROUTES ──────────────────────────────────────────

// Ensure album exists in our DB, return its internal ID
function upsertAlbum({ itunesId, title, artist, artwork, year, genre, mediaType, trackCount, itunesUrl }) {
  const existing = itunesId
    ? db.prepare('SELECT id, artwork_url FROM albums WHERE itunes_id=?').get(String(itunesId))
    : null;
  if (existing) {
    // Patch missing artwork if a better image is now available
    if (!existing.artwork_url && artwork) {
      db.prepare('UPDATE albums SET artwork_url=? WHERE id=?').run(artwork, existing.id);
    }
    return existing.id;
  }
  const r = db.prepare(
    'INSERT INTO albums (itunes_id,title,artist,artwork_url,year,genre,media_type,track_count,itunes_url) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(String(itunesId || `custom-${Date.now()}`), title, artist, artwork || '', year || null, genre || '', mediaType || 'Album', trackCount || null, itunesUrl || '');
  return r.lastInsertRowid;
}

// POST /api/reviews
app.post('/api/reviews', auth, (req, res) => {
  const { itunesId, title, artist, artwork, year, genre, mediaType, trackCount, itunesUrl, rating, reviewText, dspUrl } = req.body || {};

  if (!title)   return res.status(400).json({ error: 'Album title is required' });
  if (!rating)  return res.status(400).json({ error: 'Rating is required' });
  const r = Number(rating);
  if (isNaN(r) || r < 0.5 || r > 5 || (r * 2) % 1 !== 0)
    return res.status(400).json({ error: 'Rating must be 0.5–5.0 in half-star steps' });

  try {
    const albumId = upsertAlbum({ itunesId, title, artist, artwork, year, genre, mediaType, trackCount, itunesUrl });
    db.prepare(`
      INSERT INTO reviews (user_id, album_id, rating, review_text, dsp_url)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, album_id) DO UPDATE SET
        rating      = excluded.rating,
        review_text = excluded.review_text,
        dsp_url     = excluded.dsp_url,
        created_at  = CURRENT_TIMESTAMP
    `).run(req.user.id, albumId, r, reviewText?.trim() || null, dspUrl?.trim() || null);

    res.json({ success: true });
  } catch (err) {
    console.error('Review error:', err);
    res.status(500).json({ error: 'Failed to save review' });
  }
});

// DELETE /api/reviews/:itunesId
app.delete('/api/reviews/:itunesId', auth, (req, res) => {
  const album = db.prepare('SELECT id FROM albums WHERE itunes_id=?').get(req.params.itunesId);
  if (!album) return res.json({ success: true });
  db.prepare('DELETE FROM reviews WHERE user_id=? AND album_id=?').run(req.user.id, album.id);
  res.json({ success: true });
});

// PUT /api/reviews/:itunesId
app.put('/api/reviews/:itunesId', auth, (req, res) => {
  const { rating, reviewText, dspUrl } = req.body || {};
  const r = Number(rating);
  if (!rating || isNaN(r) || r < 0.5 || r > 5 || (r * 2) % 1 !== 0)
    return res.status(400).json({ error: 'Rating must be 0.5–5.0 in half-star steps' });

  const album = db.prepare('SELECT id FROM albums WHERE itunes_id=?').get(req.params.itunesId);
  if (!album) return res.status(404).json({ error: 'Review not found' });

  const result = db.prepare(`
    UPDATE reviews SET rating=?, review_text=?, dsp_url=?, created_at=CURRENT_TIMESTAMP
    WHERE user_id=? AND album_id=?
  `).run(r, reviewText?.trim() || null, dspUrl?.trim() || null, req.user.id, album.id);

  if (!result.changes) return res.status(404).json({ error: 'Review not found' });
  res.json({ success: true });
});

// GET /api/reviews/album/:itunesId
app.get('/api/reviews/album/:itunesId', (req, res) => {
  const album = db.prepare('SELECT id FROM albums WHERE itunes_id=?').get(req.params.itunesId);
  if (!album) return res.json([]);

  const reviews = db.prepare(`
    SELECT r.id, r.rating, r.review_text, r.dsp_url, r.created_at,
           u.username, u.initials, u.avatar_gradient
    FROM reviews r JOIN users u ON r.user_id = u.id
    WHERE r.album_id = ?
    ORDER BY r.created_at DESC
    LIMIT 100
  `).all(album.id);

  res.json(reviews);
});

// GET /api/reviews/recent?limit=20
app.get('/api/reviews/recent', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const reviews = db.prepare(`
    SELECT r.id, r.rating, r.review_text, r.created_at,
           u.username, u.initials, u.avatar_gradient,
           a.title, a.artist, a.artwork_url, a.itunes_id, a.media_type
    FROM reviews r
    JOIN users u ON r.user_id = u.id
    JOIN albums a ON r.album_id = a.id
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json(reviews);
});

// GET /api/reviews/mine/:itunesId  — did the current user review this?
app.get('/api/reviews/mine/:itunesId', auth, (req, res) => {
  const album = db.prepare('SELECT id FROM albums WHERE itunes_id=?').get(req.params.itunesId);
  if (!album) return res.json(null);
  const review = db.prepare(
    'SELECT rating, review_text, dsp_url FROM reviews WHERE user_id=? AND album_id=?'
  ).get(req.user.id, album.id);
  res.json(review || null);
});

// ── USER ROUTES ────────────────────────────────────────────

// GET /api/users/:username
app.get('/api/users/:username', (req, res) => {
  const u = db.prepare(
    'SELECT id, username, bio, initials, avatar_gradient, created_at FROM users WHERE username=?'
  ).get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found' });

  const stats = db.prepare(
    'SELECT COUNT(*) as reviews, ROUND(AVG(rating),2) as avg_rating FROM reviews WHERE user_id=?'
  ).get(u.id);

  res.json({ ...u, ...stats });
});

// GET /api/users/:username/reviews
app.get('/api/users/:username/reviews', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found' });

  const reviews = db.prepare(`
    SELECT r.id, r.rating, r.review_text, r.dsp_url, r.created_at,
           a.title, a.artist, a.artwork_url, a.itunes_id, a.media_type
    FROM reviews r JOIN albums a ON r.album_id = a.id
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC
  `).all(u.id);

  res.json(reviews);
});

// GET /api/users/:username/top5
app.get('/api/users/:username/top5', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found' });

  const albums  = db.prepare(`
    SELECT t.position, a.title, a.artist, a.artwork_url, a.itunes_id
    FROM top5_albums t JOIN albums a ON t.album_id = a.id
    WHERE t.user_id=? ORDER BY t.position
  `).all(u.id);
  const songs   = db.prepare('SELECT * FROM top5_songs   WHERE user_id=? ORDER BY position').all(u.id);
  const artists = db.prepare('SELECT * FROM top5_artists WHERE user_id=? ORDER BY position').all(u.id);

  res.json({ albums, songs, artists });
});

// PUT /api/users/me/top5/albums   { entries: [{position,itunesId,title,artist,artwork,year,genre}] }
app.put('/api/users/me/top5/albums', auth, (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries array required' });

  const run = db.transaction(() => {
    db.prepare('DELETE FROM top5_albums WHERE user_id=?').run(req.user.id);
    for (const e of entries.slice(0, 5)) {
      const albumId = upsertAlbum({ itunesId: e.itunesId, title: e.title, artist: e.artist, artwork: e.artwork, year: e.year, genre: e.genre, mediaType: 'Album' });
      db.prepare('INSERT OR REPLACE INTO top5_albums (user_id,album_id,position) VALUES (?,?,?)').run(req.user.id, albumId, e.position);
    }
  });
  run();
  res.json({ success: true });
});

// PUT /api/users/me/top5/songs
app.put('/api/users/me/top5/songs', auth, (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries array required' });

  const run = db.transaction(() => {
    db.prepare('DELETE FROM top5_songs WHERE user_id=?').run(req.user.id);
    for (const e of entries.slice(0, 5)) {
      db.prepare(
        'INSERT OR REPLACE INTO top5_songs (user_id,song_title,artist,album_title,artwork_url,itunes_id,position) VALUES (?,?,?,?,?,?,?)'
      ).run(req.user.id, e.songTitle, e.artist, e.albumTitle || '', e.artwork || '', e.itunesId || null, e.position);
    }
  });
  run();
  res.json({ success: true });
});

// PUT /api/users/me/top5/artists
app.put('/api/users/me/top5/artists', auth, (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries array required' });

  const run = db.transaction(() => {
    db.prepare('DELETE FROM top5_artists WHERE user_id=?').run(req.user.id);
    for (const e of entries.slice(0, 5)) {
      db.prepare(
        'INSERT OR REPLACE INTO top5_artists (user_id,artist_name,artwork_url,genre,itunes_id,position) VALUES (?,?,?,?,?,?)'
      ).run(req.user.id, e.artistName, e.artwork || '', e.genre || '', e.itunesId || null, e.position);
    }
  });
  run();
  res.json({ success: true });
});

// PUT /api/users/me/profile   { bio }
app.put('/api/users/me/profile', auth, (req, res) => {
  const { bio } = req.body || {};
  db.prepare('UPDATE users SET bio=? WHERE id=?').run((bio || '').trim().slice(0, 500), req.user.id);
  res.json({ success: true });
});

// ── LIST ROUTES ────────────────────────────────────────────

// GET /api/users/:username/lists
app.get('/api/users/:username/lists', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found' });
  const lists = db.prepare(`
    SELECT l.id, l.title, l.description, l.created_at,
           COUNT(li.id) AS item_count
    FROM lists l
    LEFT JOIN list_items li ON li.list_id = l.id
    WHERE l.user_id = ?
    GROUP BY l.id
    ORDER BY l.created_at DESC
  `).all(u.id);
  res.json(lists);
});

// POST /api/lists
app.post('/api/lists', auth, (req, res) => {
  const { title, description } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  const result = db.prepare(
    'INSERT INTO lists (user_id, title, description) VALUES (?,?,?)'
  ).run(req.user.id, title.trim().slice(0, 100), (description || '').trim().slice(0, 300));
  res.json({ id: result.lastInsertRowid, success: true });
});

// PUT /api/lists/:id
app.put('/api/lists/:id', auth, (req, res) => {
  const { title, description } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  const result = db.prepare(
    'UPDATE lists SET title=?, description=? WHERE id=? AND user_id=?'
  ).run(title.trim().slice(0, 100), (description || '').trim().slice(0, 300), req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'List not found' });
  res.json({ success: true });
});

// DELETE /api/lists/:id
app.delete('/api/lists/:id', auth, (req, res) => {
  db.prepare('DELETE FROM lists WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

// GET /api/lists/:id
app.get('/api/lists/:id', (req, res) => {
  const list = db.prepare(`
    SELECT l.*, u.username, u.initials, u.avatar_gradient
    FROM lists l JOIN users u ON l.user_id = u.id
    WHERE l.id = ?
  `).get(req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found' });
  const items = db.prepare(`
    SELECT a.itunes_id, a.title, a.artist, a.artwork_url, a.year, a.media_type, a.genre,
           li.position, li.id AS item_id
    FROM list_items li JOIN albums a ON li.album_id = a.id
    WHERE li.list_id = ?
    ORDER BY li.position, li.added_at
  `).all(req.params.id);
  res.json({ ...list, items });
});

// POST /api/lists/:id/items
app.post('/api/lists/:id/items', auth, (req, res) => {
  const list = db.prepare('SELECT id FROM lists WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!list) return res.status(404).json({ error: 'List not found or not yours' });
  const { itunesId, title, artist, artwork, year, genre, mediaType } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Album title required' });
  try {
    const albumId = upsertAlbum({ itunesId, title, artist, artwork, year, genre, mediaType });
    const maxPos  = db.prepare('SELECT COALESCE(MAX(position),0) AS m FROM list_items WHERE list_id=?').get(req.params.id);
    db.prepare('INSERT OR IGNORE INTO list_items (list_id, album_id, position) VALUES (?,?,?)').run(req.params.id, albumId, maxPos.m + 1);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add item' });
  }
});

// DELETE /api/lists/:id/items/:itunesId
app.delete('/api/lists/:id/items/:itunesId', auth, (req, res) => {
  const list = db.prepare('SELECT id FROM lists WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!list) return res.status(404).json({ error: 'List not found or not yours' });
  const album = db.prepare('SELECT id FROM albums WHERE itunes_id=?').get(req.params.itunesId);
  if (album) db.prepare('DELETE FROM list_items WHERE list_id=? AND album_id=?').run(req.params.id, album.id);
  res.json({ success: true });
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users)   AS members,
      (SELECT COUNT(*) FROM reviews) AS reviews,
      (SELECT COUNT(*) FROM albums)  AS albums
  `).get();
  res.json(stats);
});

// ── Catch-all: serve index.html for unknown routes ─────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   🎵  Soundbagd server started       ║
║   Open:  http://localhost:${PORT}       ║
║   Stop:  Ctrl + C                    ║
╚══════════════════════════════════════╝
  `);
});
