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

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const Database  = require('better-sqlite3');
const fetch     = require('node-fetch');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

// ── JWT Secret ─────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (IS_PROD) {
    console.error('FATAL: JWT_SECRET environment variable is not set. Set it in Railway → Variables.');
    process.exit(1);
  } else {
    console.warn('WARNING: JWT_SECRET not set. Using insecure dev secret — NEVER run this in production without setting JWT_SECRET.');
  }
}
const _JWT_SECRET = JWT_SECRET || 'soundbagd-dev-secret-change-in-prod';

// ── Security Headers (Helmet) ──────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,   // disabled — we load external images (iTunes, Spotify) and inline scripts
  crossOriginEmbedderPolicy: false,
}));

// ── CORS ───────────────────────────────────────────────────
// In production, only allow requests from our own domain
const ALLOWED_ORIGINS = [
  'https://soundbagd.up.railway.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (no Origin header) and known origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));

// ── Body size limit ────────────────────────────────────────
app.use(express.json({ limit: '64kb' }));   // prevent body-bomb attacks
app.use(express.static(path.join(__dirname)));   // serve HTML/CSS/JS

// ── Rate Limiters ──────────────────────────────────────────
// Auth endpoints: 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please wait 15 minutes and try again.' },
  skipSuccessfulRequests: true, // only count failures toward the limit
});

// Write actions (reviews, comments, flags): 30 per minute
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down a bit.' },
});

// Search / read: 120 per minute
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});

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

  CREATE TABLE IF NOT EXISTS follows (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    follower_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(follower_id, following_id)
  );

  CREATE TABLE IF NOT EXISTS review_likes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    review_id  INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, review_id)
  );

  CREATE TABLE IF NOT EXISTS review_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id  INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_reviews_album    ON reviews(album_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_user     ON reviews(user_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_recent   ON reviews(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_lists_user       ON lists(user_id);
  CREATE INDEX IF NOT EXISTS idx_list_items       ON list_items(list_id);
  CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
  CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
  CREATE INDEX IF NOT EXISTS idx_review_likes     ON review_likes(review_id);
  CREATE INDEX IF NOT EXISTS idx_review_comments  ON review_comments(review_id);
`);

// ── DB Migrations (add columns to existing tables) ────────
try { db.exec("ALTER TABLE reviews ADD COLUMN tags TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE reviews ADD COLUMN last_listened TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN ban_reason TEXT DEFAULT ''"); } catch {}

// All-time Top 5 tables
db.exec(`
  CREATE TABLE IF NOT EXISTS top5_albums_alltime (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 5),
    UNIQUE(user_id, position)
  );
  CREATE TABLE IF NOT EXISTS top5_songs_alltime (
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
  CREATE TABLE IF NOT EXISTS top5_artists_alltime (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    artist_name TEXT NOT NULL,
    artwork_url TEXT DEFAULT '',
    genre       TEXT DEFAULT '',
    itunes_id   TEXT,
    position    INTEGER NOT NULL CHECK(position BETWEEN 1 AND 5),
    UNIQUE(user_id, position)
  );
`);

// Flagged reviews table
db.exec(`
  CREATE TABLE IF NOT EXISTS review_flags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id   INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    reporter_id INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    reason      TEXT    DEFAULT '',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(review_id, reporter_id)
  );
  CREATE INDEX IF NOT EXISTS idx_flags_review ON review_flags(review_id);
`);

// ── In-Memory Cache ────────────────────────────────────────
const cache    = new Map();
const CACHE_1H = 60 * 60 * 1000;
const CACHE_5M = 5  * 60 * 1000;

// ── Spotify Credentials ────────────────────────────────────
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     || '671ec2ef78314d90bf3a765a8cc53aa5';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '2317e36fc8b742eba75c71b747b7bf1b';

// Client Credentials token (app-level, no playlist access)
let ccToken    = null;
let ccTokenExp = 0;

async function getClientCredToken() {
  if (ccToken && Date.now() < ccTokenExp - 30000) return ccToken;
  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!resp.ok) throw new Error(`Spotify CC auth failed: ${resp.status}`);
  const data = await resp.json();
  ccToken    = data.access_token;
  ccTokenExp = Date.now() + data.expires_in * 1000;
  return ccToken;
}

// OAuth User Token (needed for playlist access)
// Loaded from env var set during one-time /spotify-setup flow
let oauthToken       = null;
let oauthTokenExp    = 0;
let oauthRefreshToken = process.env.SPOTIFY_REFRESH_TOKEN || null;

async function refreshOAuthToken() {
  if (!oauthRefreshToken) return null;
  if (oauthToken && Date.now() < oauthTokenExp - 30000) return oauthToken;
  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(oauthRefreshToken)}`,
  });
  if (!resp.ok) { console.error('OAuth refresh failed:', resp.status); return null; }
  const data = await resp.json();
  oauthToken    = data.access_token;
  oauthTokenExp = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) oauthRefreshToken = data.refresh_token; // rotating token
  return oauthToken;
}

// Returns best available token — OAuth if set up, else Client Credentials
async function getSpotifyToken() {
  const ot = await refreshOAuthToken();
  if (ot) return ot;
  return getClientCredToken();
}

async function spotifyFetch(path, ttl = CACHE_1H) {
  const url = path.startsWith('http') ? path : `https://api.spotify.com/v1${path}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  const token = await getSpotifyToken();
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Spotify ${res.status} for ${url}`);
  const data = await res.json();
  cache.set(url, { data, ts: Date.now() });
  return data;
}

// ── Spotify OAuth Setup (one-time, owner only) ──────────────
// Spotify editorial playlist IDs
const SP_PLAYLISTS = {
  trending:    '37i9dQZEVXbMDoHDwVN2tF', // Today's Top Hits
  'Hip-Hop':   '37i9dQZEVXbbd7dn65ioTE', // RapCaviar
  'Pop':       '37i9dQZEVXbNG2KDcFcKOF', // Pop Rising
  'R&B':       '37i9dQZEVXbKGcyg6TFGx6', // Most Necessary
  'Rock':      '37i9dQZEVXbepT6aZMCxlN', // Rock This
  'Country':   '37i9dQZEVXbdjFlu5O5E7r', // Hot Country
  'Electronic':'37i9dQZEVXbIQnj7RRhdSX', // Mint
  'Latin':     '37i9dQZEVXbIiRch01XQyj', // Viva Latino
  'Indie':     '37i9dQZEVXbqZVMVMEHJkK', // Indie Pop
  'Jazz':      '37i9dQZEVXbIiRch01XQyj', // Jazz Vibes (fallback to Latin for now; swap if desired)
  'Classical': '37i9dQZEVXbIVYVBNw9D5K', // Classical Essentials
  'K-Pop':     '37i9dQZEVXbJZyENOWUFo7', // K-Pop Daebak
  'Folk':      '37i9dQZEVXbpuMBjb99PqW', // Folk & Friends
  'Metal':     '37i9dQZEVXbIPWwFssbupI', // Metal Essentials
};

const SETUP_SECRET = process.env.SPOTIFY_SETUP_SECRET || 'soundbagd-setup-2026';

const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'https://soundbagd.up.railway.app/spotify-callback';

// One-time admin promotion route — protected by setup secret
// Usage: /make-admin?secret=soundbagd-setup-2026&username=yourname
app.get('/make-admin', (req, res) => {
  if (req.query.secret !== SETUP_SECRET) return res.status(403).send('Forbidden — wrong secret.');
  const username = (req.query.username || '').trim().toLowerCase();
  if (!username) return res.status(400).send('Missing ?username= parameter.');
  const user = db.prepare('SELECT id, username, role FROM users WHERE username=?').get(username);
  if (!user) return res.status(404).send(`User "${username}" not found. Make sure you've created your account first.`);
  db.prepare('UPDATE users SET role=? WHERE id=?').run('admin', user.id);
  res.send(`
    <div style="font-family:sans-serif;padding:48px;max-width:480px;margin:0 auto">
      <h2 style="color:#d4af37">✅ Done!</h2>
      <p><strong>@${user.username}</strong> is now an <strong>Admin</strong>.</p>
      <p style="color:#888;font-size:.9rem">Log out and back in on Soundbagd — the 🛡️ Admin link will appear in your nav.</p>
      <a href="/" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#d4af37;color:#000;border-radius:6px;text-decoration:none;font-weight:700">Go to Soundbagd</a>
    </div>
  `);
});

// Step 1 — redirect owner to Spotify login
app.get('/spotify-setup', (req, res) => {
  if (req.query.secret !== SETUP_SECRET) return res.status(403).send('Forbidden');
  const redirect = SPOTIFY_REDIRECT_URI;
  const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id:     SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri:  redirect,
    scope:         'user-read-private',
    show_dialog:   'true',
  });
  res.redirect(url);
});

// Step 2 — Spotify redirects back here with auth code
app.get('/spotify-callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.status(400).send(`Spotify auth error: ${error}`);
  const redirect = SPOTIFY_REDIRECT_URI;
  try {
    const resp = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect }),
    });
    const data = await resp.json();
    if (!data.refresh_token) return res.status(500).send('No refresh token returned: ' + JSON.stringify(data));
    // Store in memory for this session
    oauthRefreshToken = data.refresh_token;
    oauthToken        = data.access_token;
    oauthTokenExp     = Date.now() + data.expires_in * 1000;
    res.send(`
      <h2 style="font-family:sans-serif;padding:40px">✅ Spotify OAuth connected!</h2>
      <p style="font-family:sans-serif;padding:0 40px">
        Add this as a Railway environment variable to make it permanent:<br><br>
        <code style="background:#111;color:#1DB954;padding:12px 16px;border-radius:6px;display:inline-block;font-size:14px;user-select:all">
          SPOTIFY_REFRESH_TOKEN=${data.refresh_token}
        </code><br><br>
        Then redeploy on Railway. Playlist data will activate automatically.
      </p>
    `);
  } catch (err) {
    res.status(500).send('Token exchange failed: ' + err.message);
  }
});

// Generic cached fetch (kept for DSP oEmbed, YouTube, etc.)
async function cachedFetch(url, ttl = CACHE_1H) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Soundbagd/1.0 (music review app)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const data = await res.json();
  cache.set(url, { data, ts: Date.now() });
  return data;
}

// ── Spotify Helpers ────────────────────────────────────────
function formatAlbum(item) {
  // Handles both full album objects and simplified album objects from Spotify
  const images  = item.images || [];
  const artwork = images[0]?.url || '';           // largest image first
  const artists = (item.artists || []).map(a => a.name).join(', ');
  const releaseDate = item.release_date || '';
  const year = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : null;
  const genres = item.genres || [];

  return {
    itunesId:   item.id || '',                    // Spotify ID stored in itunesId field
    title:      item.name || '',
    artist:     artists,
    artwork,
    year,
    genre:      genres[0] || item.label || '',
    mediaType:  item.album_type === 'single' ? 'Single' : 'Album',
    trackCount: item.total_tracks || null,
    itunesUrl:  item.external_urls?.spotify || '', // Spotify URL stored in itunesUrl field
    popularity: item.popularity || null,
  };
}

// ── Auth Middleware ────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, _JWT_SECRET);
    // Refresh ban/role status from DB on every authenticated request
    const u = db.prepare('SELECT banned, ban_reason, role FROM users WHERE id=?').get(req.user.id);
    if (u?.banned) return res.status(403).json({ error: `Your account has been suspended${u.ban_reason ? ': ' + u.ban_reason : '.'}`, banned: true });
    if (u) req.user.role = u.role;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session — please sign in again' });
  }
}

// Require mod or admin role
function requireMod(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'mod' && req.user.role !== 'admin') return res.status(403).json({ error: 'Moderator access required' });
  next();
}

// Require admin role only
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── AUTH ROUTES ────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', authLimiter, async (req, res) => {
  let { username, email, password } = req.body || {};
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Username, email, and password are required' });

  username = username.trim().toLowerCase();
  email    = email.trim().toLowerCase();

  if (username.length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (username.length > 30)
    return res.status(400).json({ error: 'Username must be 30 characters or fewer' });
  if (!/^[a-z0-9_]+$/.test(username))
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (password.length > 72)
    return res.status(400).json({ error: 'Password must be 72 characters or fewer' });
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

    const token = jwt.sign({ id: result.lastInsertRowid, username, role: 'user' }, _JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: result.lastInsertRowid, username, email, initials, gradient, role: 'user' } });
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
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  // Reject absurdly long inputs before touching the DB or bcrypt
  if (typeof email    === 'string' && email.length    > 254) return res.status(400).json({ error: 'Invalid email or password' });
  if (typeof password === 'string' && password.length > 72)  return res.status(400).json({ error: 'Invalid email or password' });
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  if (user.banned) return res.status(403).json({ error: `Your account has been suspended${user.ban_reason ? ': ' + user.ban_reason : '.'}`, banned: true });

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role || 'user' }, _JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    user: { id: user.id, username: user.username, email: user.email, initials: user.initials, gradient: user.avatar_gradient, bio: user.bio, role: user.role || 'user' },
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

// ── MUSIC ROUTES ────────────────────────────────────────────
// Charts: multi-source aggregation (Apple + Deezer + Last.fm)
// Search + album detail: Spotify

const CACHE_6H = 6 * 60 * 60 * 1000;

// ── Last.fm ──────────────────────────────────────────────────
const LASTFM_KEY = process.env.LASTFM_API_KEY || null;
async function lastfmFetch(params, ttl = CACHE_1H) {
  if (!LASTFM_KEY) return null;
  const url = 'https://ws.audioscrobbler.com/2.0/?' + new URLSearchParams({ ...params, api_key: LASTFM_KEY, format: 'json' });
  try { return await cachedFetch(url, ttl); } catch { return null; }
}

// ── iTunes / Apple helpers ───────────────────────────────────
function artworkHQ(url, size = 600) {
  if (!url) return '';
  return url.replace(/\d+x\d+bb/, `${size}x${size}bb`).replace(/\d+x\d+/, `${size}x${size}`);
}
function formatAppleAlbum(item) {
  return {
    itunesId:   String(item.collectionId || item.id || ''),
    title:      item.collectionName || item.name || '',
    artist:     item.artistName     || '',
    artwork:    artworkHQ(item.artworkUrl100 || item.artworkUrl60 || ''),
    year:       item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
    genre:      item.primaryGenreName || item.genres?.[0]?.name || '',
    mediaType:  item.collectionType || 'Album',
    trackCount: item.trackCount || null,
    itunesUrl:  item.collectionViewUrl || item.url || '',
  };
}

// ── Deezer helpers ───────────────────────────────────────────
const DEEZER_GENRE_IDS = {
  'Hip-Hop': 116, 'Pop': 132, 'R&B': 165, 'Rock': 152,
  'Country': 84, 'Electronic': 106, 'Latin': 197, 'Indie': 85,
  'Jazz': 129, 'Classical': 98, 'Metal': 464, 'K-Pop': 113, 'Folk': 466,
};
const LASTFM_GENRE_TAGS = {
  'Hip-Hop': 'hip-hop', 'Pop': 'pop', 'R&B': 'rnb', 'Rock': 'rock',
  'Country': 'country', 'Electronic': 'electronic', 'Latin': 'latin',
  'Indie': 'indie', 'Jazz': 'jazz', 'Classical': 'classical',
  'Metal': 'metal', 'K-Pop': 'k-pop', 'Folk': 'folk',
};

function formatDeezerTrack(t) {
  return {
    itunesId:  String(t.album?.id || t.id),
    title:     t.album?.title || t.title,
    artist:    t.artist?.name || '',
    artwork:   t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || '',
    year:      null,
    genre:     '',
    mediaType: 'Album',
    itunesUrl: t.album?.link || t.link || '',
  };
}
async function deezerFetch(path, ttl = CACHE_1H) {
  return cachedFetch('https://api.deezer.com' + path, ttl);
}

// Last.fm's "no image" placeholder — ignore these
const LASTFM_PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';
function validArtwork(url) {
  return url && !url.includes(LASTFM_PLACEHOLDER) ? url : '';
}

// After aggregation, enrich albums that still have no artwork via iTunes
async function enrichArtwork(albums) {
  const missing = albums.filter(a => !a.artwork);
  if (!missing.length) return albums;

  await Promise.allSettled(missing.map(async a => {
    try {
      const url  = `https://itunes.apple.com/search?term=${encodeURIComponent(a.artist + ' ' + a.title)}&entity=album&limit=1`;
      const data = await cachedFetch(url, CACHE_6H);
      const hit  = data.results?.[0];
      if (hit?.artworkUrl100) a.artwork = artworkHQ(hit.artworkUrl100);
    } catch { /* leave empty */ }
  }));

  return albums;
}

// ── Chart aggregation core ───────────────────────────────────
// Normalise "Artist — Title" into a stable key for cross-source matching
function chartKey(artist, title) {
  const clean = s => s.toLowerCase()
    .replace(/\(.*?\)/g, '')          // remove parentheticals
    .replace(/[^a-z0-9 ]/g, '')       // strip punctuation
    .replace(/\s+/g, ' ').trim();
  return `${clean(artist)}||${clean(title)}`;
}

// Score-based merge: position 1 in a 50-item list = 50 pts, position 50 = 1 pt
function buildScoreMap() {
  const map = new Map(); // key → { album, score, sources[] }
  return {
    add(album, position, total, source) {
      const key = chartKey(album.artist, album.title);
      if (!key.includes('||')) return;
      const pts = Math.max(0, total - position);
      if (map.has(key)) {
        const e = map.get(key);
        e.score += pts;
        if (!e.sources.includes(source)) e.sources.push(source);
        // Prefer higher-res artwork
        if (!e.album.artwork && album.artwork) e.album.artwork = album.artwork;
      } else {
        map.set(key, { album: { ...album }, score: pts, sources: [source] });
      }
    },
    sorted(limit = 50) {
      return [...map.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(e => ({ ...e.album, sources: e.sources }));
    },
  };
}

// GET /api/music/trending — Apple + Deezer + Last.fm aggregated
app.get('/api/music/trending', async (req, res) => {
  const scores = buildScoreMap();

  await Promise.allSettled([

    // ── Source 1: Apple Music Top 50 ──
    cachedFetch('https://rss.applemarketingtools.com/api/v2/us/music/most-played/50/albums.json', CACHE_1H)
      .then(data => {
        (data.feed?.results || []).forEach((item, i) => scores.add({
          itunesId:  String(item.id),
          title:     item.name,
          artist:    item.artistName,
          artwork:   artworkHQ(item.artworkUrl100),
          year:      item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
          genre:     item.genres?.[0]?.name || '',
          mediaType: 'Album',
          itunesUrl: item.url || '',
        }, i, 50, 'Apple Music'));
      }).catch(e => console.error('Apple trending error:', e.message)),

    // ── Source 2: Deezer Global Top 50 ──
    deezerFetch('/chart/0/tracks?limit=50', CACHE_1H)
      .then(data => {
        const seen = new Set();
        let pos = 0;
        for (const t of (data.data || [])) {
          if (!t.album?.id || seen.has(t.album.id)) continue;
          seen.add(t.album.id);
          scores.add(formatDeezerTrack(t), pos++, 50, 'Deezer');
        }
      }).catch(e => console.error('Deezer trending error:', e.message)),

    // ── Source 3: Last.fm Top Tracks → albums (if key configured) ──
    lastfmFetch({ method: 'chart.getTopTracks', limit: 50 }, CACHE_1H)
      .then(data => {
        if (!data) return;
        (data.tracks?.track || []).forEach((t, i) => {
          if (!t.name || !t.artist?.name) return;
          scores.add({
            itunesId:  `lastfm-${t.mbid || i}`,
            title:     t.album?.title || t.name,
            artist:    t.artist.name,
            artwork:   validArtwork(t.image?.find(img => img.size === 'extralarge')?.['#text'] || ''),
            year:      null,
            genre:     '',
            mediaType: 'Album',
            itunesUrl: t.url || '',
          }, i, 50, 'Last.fm');
        });
      }).catch(e => console.error('Last.fm trending error:', e.message)),

  ]);

  const results = await enrichArtwork(scores.sorted(50));
  if (!results.length) return res.status(500).json({ error: 'Could not load trending' });
  res.json(results);
});

// GET /api/music/genre-chart?genre=Hip-Hop&limit=25
// Deezer genre chart + Last.fm tag albums + iTunes genreTerm, merged & scored
app.get('/api/music/genre-chart', async (req, res) => {
  const { genre, limit = 25 } = req.query;
  if (!genre?.trim()) return res.status(400).json({ error: 'genre required' });
  const lim = Math.min(Number(limit), 50);
  const scores = buildScoreMap();

  await Promise.allSettled([

    // ── Deezer genre chart ──
    (async () => {
      const genreId = DEEZER_GENRE_IDS[genre];
      if (!genreId) return;
      const data = await deezerFetch(`/chart/${genreId}/tracks?limit=50`);
      const seen = new Set(); let pos = 0;
      for (const t of (data.data || [])) {
        if (!t.album?.id || seen.has(t.album.id)) continue;
        seen.add(t.album.id);
        scores.add(formatDeezerTrack(t), pos++, 50, 'Deezer');
      }
    })().catch(e => console.error('Deezer genre error:', e.message)),

    // ── Last.fm tag top albums ──
    (async () => {
      const tag = LASTFM_GENRE_TAGS[genre];
      if (!tag) return;
      const data = await lastfmFetch({ method: 'tag.getTopAlbums', tag, limit: 50 });
      if (!data) return;
      (data.albums?.album || []).forEach((a, i) => {
        if (!a.name || !a.artist?.name) return;
        scores.add({
          itunesId:  `lastfm-${a.mbid || i}`,
          title:     a.name,
          artist:    a.artist.name,
          artwork:   validArtwork(a.image?.find(img => img.size === 'extralarge')?.['#text'] || ''),
          year:      null,
          genre,
          mediaType: 'Album',
          itunesUrl: a.url || '',
        }, i, 50, 'Last.fm');
      });
    })().catch(e => console.error('Last.fm genre error:', e.message)),

    // ── iTunes genreTerm ──
    (async () => {
      const genreTermMap = {
        'Country': 'Country', 'Hip-Hop': 'Hip-Hop/Rap', 'Pop': 'Pop',
        'R&B': 'R&B/Soul', 'Rock': 'Rock', 'Jazz': 'Jazz',
        'Electronic': 'Electronic', 'Indie': 'Alternative', 'Folk': 'Folk',
        'Latin': 'Latino', 'Classical': 'Classical', 'Metal': 'Metal', 'K-Pop': 'K-Pop',
      };
      const term = genreTermMap[genre] || genre;
      const url  = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&attribute=genreTerm&limit=50&country=us`;
      const data = await cachedFetch(url, CACHE_1H);
      (data.results || [])
        .filter(r => r.collectionType === 'Album' || r.wrapperType === 'collection')
        .forEach((r, i) => scores.add(formatAppleAlbum(r), i, 50, 'Apple Music'));
    })().catch(e => console.error('iTunes genre error:', e.message)),

  ]);

  const results = await enrichArtwork(scores.sorted(lim));
  if (!results.length) return res.status(500).json({ error: 'Could not load genre chart' });
  res.json(results);
});

// GET /api/music/artist-albums?artist=NAME — artist discography via Spotify search
app.get('/api/music/artist-albums', async (req, res) => {
  const { artist } = req.query;
  if (!artist?.trim()) return res.status(400).json({ error: 'artist required' });
  try {
    // Search Spotify for albums by this artist
    const data = await spotifyFetch(
      `/search?q=artist:${encodeURIComponent(artist)}&type=album&limit=50&market=US`,
      CACHE_1H
    );
    let albums = (data.albums?.items || [])
      .filter(a => a?.id && a.artists?.some(ar => ar.name.toLowerCase() === artist.toLowerCase()))
      .map(formatAlbum);

    // Fallback: looser artist match if strict match returns nothing
    if (!albums.length) {
      albums = (data.albums?.items || []).filter(a => a?.id).map(formatAlbum);
    }

    // Sort by release year descending (newest first)
    albums.sort((a, b) => (b.year || 0) - (a.year || 0));
    res.json(albums);
  } catch (err) {
    // iTunes fallback
    try {
      const url  = `https://itunes.apple.com/search?term=${encodeURIComponent(artist)}&entity=album&attribute=artistTerm&limit=50`;
      const data = await cachedFetch(url, CACHE_1H);
      const albums = (data.results || [])
        .filter(r => r.collectionType === 'Album')
        .sort((a, b) => new Date(b.releaseDate || 0) - new Date(a.releaseDate || 0))
        .map(formatAppleAlbum);
      res.json(albums);
    } catch {
      res.status(500).json({ error: 'Could not load discography' });
    }
  }
});

// GET /api/music/new-releases?limit=50 — Apple iTunes (date-sorted)
app.get('/api/music/new-releases', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 50);
  const year  = new Date().getFullYear();
  try {
    const url  = `https://itunes.apple.com/search?term=${year}+new+releases&entity=album&limit=${limit}&country=us`;
    const data = await cachedFetch(url, CACHE_1H);
    const albums = (data.results || [])
      .filter(r => r.collectionType === 'Album' && r.releaseDate)
      .sort((a, b) => new Date(b.releaseDate) - new Date(a.releaseDate))
      .map(formatAppleAlbum);
    res.json(albums);
  } catch (err) {
    console.error('New releases error:', err.message);
    res.status(500).json({ error: 'Could not load new releases' });
  }
});

// GET /api/music/search?q=…&type=album|track|artist&limit=20
app.get('/api/music/search', async (req, res) => {
  const { q, type = 'album', limit = 20 } = req.query;
  if (!q?.trim()) return res.status(400).json({ error: 'Query required' });

  const typeMap = { album: 'album', track: 'track', artist: 'artist' };
  const spType  = typeMap[type] || 'album';

  try {
    const data = await spotifyFetch(
      `/search?q=${encodeURIComponent(q)}&type=${spType}&limit=${Math.min(Number(limit), 50)}&market=US`,
      CACHE_5M
    );

    if (type === 'artist') {
      const results = (data.artists?.items || []).map(a => ({
        itunesId: a.id,
        name:     a.name,
        genre:    a.genres?.[0] || '',
        artwork:  a.images?.[0]?.url || '',
        url:      a.external_urls?.spotify || '',
        popularity: a.popularity,
      }));
      return res.json(results);
    }

    if (type === 'track') {
      const results = (data.tracks?.items || []).map(t => ({
        itunesId:  t.id,
        title:     t.name,
        artist:    t.artists?.map(a => a.name).join(', ') || '',
        album:     t.album?.name || '',
        albumId:   t.album?.id  || '',
        artwork:   t.album?.images?.[0]?.url || '',
        year:      t.album?.release_date ? parseInt(t.album.release_date.slice(0, 4), 10) : null,
        duration:  t.duration_ms || 0,
        itunesUrl: t.external_urls?.spotify || '',
      }));
      return res.json(results);
    }

    res.json((data.albums?.items || []).filter(a => a?.id).map(formatAlbum));
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed — please try again' });
  }
});

// Attach DB review stats to an album object
function attachStats(album, id) {
  const dbRow = db.prepare('SELECT id FROM albums WHERE itunes_id=?').get(id);
  if (dbRow) {
    album.stats = db.prepare(`
      SELECT COUNT(*) as total, ROUND(AVG(rating),2) as avg,
             SUM(CASE WHEN rating=5    THEN 1 ELSE 0 END) as r5,
             SUM(CASE WHEN rating=4.5  THEN 1 ELSE 0 END) as r4h,
             SUM(CASE WHEN rating=4    THEN 1 ELSE 0 END) as r4,
             SUM(CASE WHEN rating=3.5  THEN 1 ELSE 0 END) as r3h,
             SUM(CASE WHEN rating=3    THEN 1 ELSE 0 END) as r3,
             SUM(CASE WHEN rating<=2.5 THEN 1 ELSE 0 END) as rLow
      FROM reviews WHERE album_id=?
    `).get(dbRow.id);
  } else {
    album.stats = { total: 0, avg: null };
  }
  return album;
}

// GET /api/music/album/:id  — multi-source album detail
// ID types: Spotify (22-char alphanum) | Apple/iTunes (numeric) |
//           Deezer (numeric, prefixed dz-) | Last.fm (lastfm-X)
// Fallback: search by ?artist=&title= query params
app.get('/api/music/album/:id', async (req, res) => {
  const id     = req.params.id;
  const qTitle  = req.query.title  || '';
  const qArtist = req.query.artist || '';

  // ── 1. Check our own DB first ────────────────────────────
  const dbAlbum = db.prepare('SELECT * FROM albums WHERE itunes_id=?').get(id);
  if (dbAlbum) {
    const stats = db.prepare('SELECT COUNT(*) as total, ROUND(AVG(rating),2) as avg FROM reviews WHERE album_id=?').get(dbAlbum.id);
    return res.json({
      itunesId: dbAlbum.itunes_id, title: dbAlbum.title, artist: dbAlbum.artist,
      artwork: dbAlbum.artwork_url, year: dbAlbum.year, genre: dbAlbum.genre,
      mediaType: dbAlbum.media_type, trackCount: dbAlbum.track_count,
      itunesUrl: dbAlbum.itunes_url, tracks: [], stats,
    });
  }

  // ── 2. Spotify ID (22-char alphanumeric) ─────────────────
  if (/^[A-Za-z0-9]{22}$/.test(id)) {
    try {
      const sp = await spotifyFetch(`/albums/${id}`, CACHE_1H);
      if (sp?.id) {
        const album = formatAlbum(sp);
        album.tracks = (sp.tracks?.items || []).map((t, i) => ({
          number: t.track_number || i + 1, title: t.name,
          duration: t.duration_ms, itunesUrl: t.external_urls?.spotify || '',
        }));
        return res.json(attachStats(album, id));
      }
    } catch { /* fall through */ }
  }

  // ── 3. Numeric ID — try iTunes lookup ────────────────────
  if (/^\d+$/.test(id)) {
    try {
      const data = await cachedFetch(
        `https://itunes.apple.com/lookup?id=${id}&entity=song`, CACHE_1H
      );
      const results    = data.results || [];
      const collection = results.find(r => r.wrapperType === 'collection' || r.collectionType === 'Album');
      if (collection) {
        const album  = formatAppleAlbum(collection);
        album.tracks = results
          .filter(r => r.wrapperType === 'track' && r.kind === 'song')
          .map(t => ({ number: t.trackNumber, title: t.trackName, duration: t.trackTimeMillis, itunesUrl: t.trackViewUrl }));
        return res.json(attachStats(album, id));
      }
    } catch { /* fall through */ }
  }

  // ── 4. Search by title + artist (Last.fm IDs, Deezer IDs, any unknown) ──
  const searchTitle  = qTitle  || id.replace(/^(lastfm|deezer)-\d*/, '').trim();
  const searchArtist = qArtist || '';
  if (searchTitle || searchArtist) {
    const q = [searchArtist, searchTitle].filter(Boolean).join(' ');
    try {
      // Try Spotify search first
      const sp = await spotifyFetch(`/search?q=${encodeURIComponent(q)}&type=album&limit=1&market=US`, CACHE_1H);
      const hit = sp.albums?.items?.[0];
      if (hit?.id) {
        const full = await spotifyFetch(`/albums/${hit.id}`, CACHE_1H);
        const album = formatAlbum(full);
        album.tracks = (full.tracks?.items || []).map((t, i) => ({
          number: t.track_number || i + 1, title: t.name,
          duration: t.duration_ms, itunesUrl: t.external_urls?.spotify || '',
        }));
        return res.json(attachStats(album, id));
      }
    } catch { /* fall through */ }

    // iTunes search fallback
    try {
      const url  = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=album&limit=1`;
      const data = await cachedFetch(url, CACHE_1H);
      const hit  = data.results?.[0];
      if (hit) {
        const album = formatAppleAlbum(hit);
        album.tracks = [];
        return res.json(attachStats(album, id));
      }
    } catch { /* fall through */ }
  }

  res.status(404).json({ error: 'Album not found' });
});

// ── DSP IMPORT ─────────────────────────────────────────────

// POST /api/dsp/import   { url: "https://..." }
app.post('/api/dsp/import', async (req, res) => {
  const { url } = req.body || {};
  if (!url?.trim()) return res.status(400).json({ error: 'URL required' });

  try {
    // ── Spotify ──────────────────────────────────────────
    if (url.includes('open.spotify.com') || url.includes('spotify.com')) {
      // Extract type + ID from URL: open.spotify.com/{type}/{id}
      const spMatch = url.match(/open\.spotify\.com\/(album|track|playlist)\/([A-Za-z0-9]+)/);
      if (spMatch) {
        const [, spType, spId] = spMatch;
        try {
          const sp = await spotifyFetch(`/${spType}s/${spId}`, CACHE_1H);
          if (spType === 'album') {
            return res.json({ dsp: 'Spotify', ...formatAlbum(sp) });
          }
          if (spType === 'track') {
            return res.json({
              dsp:    'Spotify',
              itunesId: sp.id,
              title:  sp.name,
              artist: sp.artists?.map(a => a.name).join(', ') || '',
              artwork: sp.album?.images?.[0]?.url || '',
              year:   sp.album?.release_date ? parseInt(sp.album.release_date.slice(0,4),10) : null,
              itunesUrl: sp.external_urls?.spotify || '',
              mediaType: 'Track',
            });
          }
          // Playlist — just return title/artwork
          return res.json({
            dsp:    'Spotify',
            title:  sp.name,
            artist: sp.owner?.display_name || '',
            artwork: sp.images?.[0]?.url || '',
            year:   null,
            itunesUrl: sp.external_urls?.spotify || '',
          });
        } catch (e) {
          return res.status(422).json({ error: `Spotify lookup failed: ${e.message}` });
        }
      }
      return res.status(422).json({ error: 'Could not parse Spotify URL' });
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
// Validate dsp_url: must be a real http/https URL or empty
function sanitizeDspUrl(url) {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return trimmed.slice(0, 500);
  } catch {
    return null;
  }
}

app.post('/api/reviews', auth, writeLimiter, (req, res) => {
  const { itunesId, title, artist, artwork, year, genre, mediaType, trackCount, itunesUrl, rating, reviewText, dspUrl, tags, lastListened } = req.body || {};

  if (!title)   return res.status(400).json({ error: 'Album title is required' });
  if (!rating)  return res.status(400).json({ error: 'Rating is required' });
  const r = Number(rating);
  if (isNaN(r) || r < 0.5 || r > 5 || (r * 2) % 1 !== 0)
    return res.status(400).json({ error: 'Rating must be 0.5–5.0 in half-star steps' });

  const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
  const safeDspUrl = sanitizeDspUrl(dspUrl);
  // lastListened: expect "YYYY-MM-DD" or "YYYY-MM" or "YYYY" string, max 10 chars
  const safeLastListened = lastListened ? String(lastListened).slice(0, 10) : null;

  try {
    const albumId = upsertAlbum({ itunesId, title, artist, artwork, year, genre, mediaType, trackCount, itunesUrl });
    db.prepare(`
      INSERT INTO reviews (user_id, album_id, rating, review_text, dsp_url, tags, last_listened)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, album_id) DO UPDATE SET
        rating         = excluded.rating,
        review_text    = excluded.review_text,
        dsp_url        = excluded.dsp_url,
        tags           = excluded.tags,
        last_listened  = excluded.last_listened,
        created_at     = CURRENT_TIMESTAMP
    `).run(req.user.id, albumId, r, reviewText?.trim()?.slice(0, 4000) || null, safeDspUrl, tagsStr, safeLastListened);

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
app.put('/api/reviews/:itunesId', auth, writeLimiter, (req, res) => {
  const { rating, reviewText, dspUrl, tags, lastListened } = req.body || {};
  const r = Number(rating);
  if (!rating || isNaN(r) || r < 0.5 || r > 5 || (r * 2) % 1 !== 0)
    return res.status(400).json({ error: 'Rating must be 0.5–5.0 in half-star steps' });

  const album = db.prepare('SELECT id FROM albums WHERE itunes_id=?').get(req.params.itunesId);
  if (!album) return res.status(404).json({ error: 'Review not found' });

  const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
  const safeDspUrl = sanitizeDspUrl(dspUrl);
  const safeLastListened = lastListened ? String(lastListened).slice(0, 10) : null;

  const result = db.prepare(`
    UPDATE reviews SET rating=?, review_text=?, dsp_url=?, tags=?, last_listened=?, created_at=CURRENT_TIMESTAMP
    WHERE user_id=? AND album_id=?
  `).run(r, reviewText?.trim()?.slice(0, 4000) || null, safeDspUrl, tagsStr, safeLastListened, req.user.id, album.id);

  if (!result.changes) return res.status(404).json({ error: 'Review not found' });
  res.json({ success: true });
});

// GET /api/reviews/album/:itunesId
app.get('/api/reviews/album/:itunesId', (req, res) => {
  const album = db.prepare('SELECT id FROM albums WHERE itunes_id=?').get(req.params.itunesId);
  if (!album) return res.json([]);

  // Determine current user (optional auth)
  let currentUserId = null;
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (token) { const decoded = jwt.verify(token, _JWT_SECRET); currentUserId = decoded.id; }
  } catch {}

  const reviews = db.prepare(`
    SELECT r.id, r.rating, r.review_text, r.dsp_url, r.created_at, r.tags, r.last_listened,
           u.username, u.initials, u.avatar_gradient,
           (SELECT COUNT(*) FROM review_likes rl WHERE rl.review_id = r.id) AS like_count,
           (SELECT COUNT(*) FROM review_comments rc WHERE rc.review_id = r.id) AS comment_count
    FROM reviews r JOIN users u ON r.user_id = u.id
    WHERE r.album_id = ?
    ORDER BY r.created_at DESC
    LIMIT 100
  `).all(album.id);

  // Add is_liked per review if user is logged in
  if (currentUserId) {
    reviews.forEach(r => {
      r.is_liked = !!db.prepare('SELECT 1 FROM review_likes WHERE user_id=? AND review_id=?').get(currentUserId, r.id);
    });
  }

  res.json(reviews);
});

// GET /api/reviews/recent?limit=20
app.get('/api/reviews/recent', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const reviews = db.prepare(`
    SELECT r.id, r.rating, r.review_text, r.created_at, r.tags, r.last_listened,
           u.username, u.initials, u.avatar_gradient,
           a.title, a.artist, a.artwork_url, a.itunes_id, a.media_type,
           (SELECT COUNT(*) FROM review_likes rl WHERE rl.review_id = r.id) AS like_count,
           (SELECT COUNT(*) FROM review_comments rc WHERE rc.review_id = r.id) AS comment_count
    FROM reviews r
    JOIN users u ON r.user_id = u.id
    JOIN albums a ON r.album_id = a.id
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json(reviews);
});

// GET /api/reviews/acclaimed?type=album|track|ep&limit=20
// Recently highly-rated reviews (rating >= 4)
app.get('/api/reviews/acclaimed', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const type  = req.query.type || 'all'; // album | track | ep | all
  const typeFilter = type === 'all' ? '' :
    type === 'ep'    ? "AND LOWER(a.media_type) LIKE '%ep%'" :
    type === 'track' ? "AND LOWER(a.media_type) IN ('track','song','single')" :
                       "AND LOWER(a.media_type) = 'album'";

  const reviews = db.prepare(`
    SELECT r.id, r.rating, r.review_text, r.created_at, r.tags, r.last_listened,
           u.username, u.initials, u.avatar_gradient,
           a.title, a.artist, a.artwork_url, a.itunes_id, a.media_type,
           (SELECT COUNT(*) FROM review_likes rl WHERE rl.review_id = r.id) AS like_count,
           (SELECT COUNT(*) FROM review_comments rc WHERE rc.review_id = r.id) AS comment_count
    FROM reviews r
    JOIN users u ON r.user_id = u.id
    JOIN albums a ON r.album_id = a.id
    WHERE r.rating >= 4 ${typeFilter}
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json(reviews);
});

// GET /api/reviews/panned?type=album|track|ep&limit=20
// Recently low-rated reviews (rating <= 2)
app.get('/api/reviews/panned', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const type  = req.query.type || 'all';
  const typeFilter = type === 'all' ? '' :
    type === 'ep'    ? "AND LOWER(a.media_type) LIKE '%ep%'" :
    type === 'track' ? "AND LOWER(a.media_type) IN ('track','song','single')" :
                       "AND LOWER(a.media_type) = 'album'";

  const reviews = db.prepare(`
    SELECT r.id, r.rating, r.review_text, r.created_at, r.tags, r.last_listened,
           u.username, u.initials, u.avatar_gradient,
           a.title, a.artist, a.artwork_url, a.itunes_id, a.media_type,
           (SELECT COUNT(*) FROM review_likes rl WHERE rl.review_id = r.id) AS like_count,
           (SELECT COUNT(*) FROM review_comments rc WHERE rc.review_id = r.id) AS comment_count
    FROM reviews r
    JOIN users u ON r.user_id = u.id
    JOIN albums a ON r.album_id = a.id
    WHERE r.rating <= 2 ${typeFilter}
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json(reviews);
});

// GET /api/users/search?q=username&limit=20
app.get('/api/users/search', readLimiter, (req, res) => {
  const q     = (req.query.q || '').trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const viewerId = req.query.viewer ? Number(req.query.viewer) : null;

  const users = db.prepare(`
    SELECT u.id, u.username, u.bio, u.initials, u.avatar_gradient, u.created_at,
           (SELECT COUNT(*) FROM reviews r WHERE r.user_id = u.id) AS review_count,
           (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS follower_count
    FROM users u
    WHERE u.username LIKE ?
    ORDER BY review_count DESC, u.created_at ASC
    LIMIT ?
  `).all(`%${q}%`, limit);

  // Filter banned users in JS so the query works even if the column migration is pending
  const safe = users.filter(u => !u.banned);

  // Add isFollowing flag if viewer is logged in
  if (viewerId) {
    const followSet = new Set(
      db.prepare('SELECT following_id FROM follows WHERE follower_id=?').all(viewerId).map(r => r.following_id)
    );
    safe.forEach(u => { u.isFollowing = followSet.has(u.id); });
  }

  res.json(safe);
});

// GET /api/reviews/mine/:itunesId  — did the current user review this?
app.get('/api/reviews/mine/:itunesId', auth, (req, res) => {
  const album = db.prepare('SELECT id FROM albums WHERE itunes_id=?').get(req.params.itunesId);
  if (!album) return res.json(null);
  const review = db.prepare(
    'SELECT id, rating, review_text, dsp_url, tags, last_listened FROM reviews WHERE user_id=? AND album_id=?'
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

  const followerCount  = db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_id=?').get(u.id).c;
  const followingCount = db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_id=?').get(u.id).c;

  // Check if requesting user follows this user (optional auth)
  let isFollowing = false;
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (token) {
      const decoded = jwt.verify(token, _JWT_SECRET);
      isFollowing = !!db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?').get(decoded.id, u.id);
    }
  } catch {}

  res.json({ ...u, ...stats, followerCount, followingCount, isFollowing });
});

// GET /api/users/:username/reviews
app.get('/api/users/:username/reviews', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found' });

  const reviews = db.prepare(`
    SELECT r.id, r.rating, r.review_text, r.dsp_url, r.created_at, r.tags, r.last_listened,
           a.title, a.artist, a.artwork_url, a.itunes_id, a.media_type,
           (SELECT COUNT(*) FROM review_likes rl WHERE rl.review_id = r.id) AS like_count
    FROM reviews r JOIN albums a ON r.album_id = a.id
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC
  `).all(u.id);

  res.json(reviews);
});

// GET /api/users/:username/top5?type=current|alltime
app.get('/api/users/:username/top5', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found' });

  const suffix = req.query.type === 'alltime' ? '_alltime' : '';

  const albums  = db.prepare(`
    SELECT t.position, a.title, a.artist, a.artwork_url, a.itunes_id
    FROM top5_albums${suffix} t JOIN albums a ON t.album_id = a.id
    WHERE t.user_id=? ORDER BY t.position
  `).all(u.id);
  const songs   = db.prepare(`SELECT * FROM top5_songs${suffix}   WHERE user_id=? ORDER BY position`).all(u.id);
  const artists = db.prepare(`SELECT * FROM top5_artists${suffix} WHERE user_id=? ORDER BY position`).all(u.id);

  res.json({ albums, songs, artists });
});

// PUT /api/users/me/top5/albums?type=current|alltime   { entries: [{position,itunesId,title,artist,artwork,year,genre}] }
app.put('/api/users/me/top5/albums', auth, (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries array required' });
  const suffix = req.query.type === 'alltime' ? '_alltime' : '';

  const run = db.transaction(() => {
    db.prepare(`DELETE FROM top5_albums${suffix} WHERE user_id=?`).run(req.user.id);
    for (const e of entries.slice(0, 5)) {
      const albumId = upsertAlbum({ itunesId: e.itunesId, title: e.title, artist: e.artist, artwork: e.artwork, year: e.year, genre: e.genre, mediaType: 'Album' });
      db.prepare(`INSERT OR REPLACE INTO top5_albums${suffix} (user_id,album_id,position) VALUES (?,?,?)`).run(req.user.id, albumId, e.position);
    }
  });
  run();
  res.json({ success: true });
});

// PUT /api/users/me/top5/songs?type=current|alltime
app.put('/api/users/me/top5/songs', auth, (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries array required' });
  const suffix = req.query.type === 'alltime' ? '_alltime' : '';

  const run = db.transaction(() => {
    db.prepare(`DELETE FROM top5_songs${suffix} WHERE user_id=?`).run(req.user.id);
    for (const e of entries.slice(0, 5)) {
      db.prepare(
        `INSERT OR REPLACE INTO top5_songs${suffix} (user_id,song_title,artist,album_title,artwork_url,itunes_id,position) VALUES (?,?,?,?,?,?,?)`
      ).run(req.user.id, e.songTitle, e.artist, e.albumTitle || '', e.artwork || '', e.itunesId || null, e.position);
    }
  });
  run();
  res.json({ success: true });
});

// PUT /api/users/me/top5/artists?type=current|alltime
app.put('/api/users/me/top5/artists', auth, (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries array required' });
  const suffix = req.query.type === 'alltime' ? '_alltime' : '';

  const run = db.transaction(() => {
    db.prepare(`DELETE FROM top5_artists${suffix} WHERE user_id=?`).run(req.user.id);
    for (const e of entries.slice(0, 5)) {
      db.prepare(
        `INSERT OR REPLACE INTO top5_artists${suffix} (user_id,artist_name,artwork_url,genre,itunes_id,position) VALUES (?,?,?,?,?,?)`
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

// ── FOLLOW ROUTES ───────────────────────────────────────────

// POST /api/users/:username/follow
app.post('/api/users/:username/follow', auth, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot follow yourself' });
  try {
    db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?,?)').run(req.user.id, target.id);
    const count = db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_id=?').get(target.id).c;
    res.json({ success: true, followerCount: count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to follow' });
  }
});

// DELETE /api/users/:username/follow
app.delete('/api/users/:username/follow', auth, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').run(req.user.id, target.id);
  const count = db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_id=?').get(target.id).c;
  res.json({ success: true, followerCount: count });
});

// GET /api/users/:username/followers  — list everyone who follows this user
app.get('/api/users/:username/followers', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found' });
  const rows = db.prepare(`
    SELECT u.id, u.username, u.initials, u.avatar_gradient,
           (SELECT COUNT(*) FROM reviews r WHERE r.user_id = u.id) AS review_count
    FROM follows f JOIN users u ON u.id = f.follower_id
    WHERE f.following_id = ?
    ORDER BY f.created_at DESC
  `).all(u.id);
  res.json(rows);
});

// GET /api/users/:username/following  — list everyone this user follows
app.get('/api/users/:username/following', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found' });
  const rows = db.prepare(`
    SELECT u.id, u.username, u.initials, u.avatar_gradient,
           (SELECT COUNT(*) FROM reviews r WHERE r.user_id = u.id) AS review_count
    FROM follows f JOIN users u ON u.id = f.following_id
    WHERE f.follower_id = ?
    ORDER BY f.created_at DESC
  `).all(u.id);
  res.json(rows);
});

// DELETE /api/users/:username/followers/:followerUsername  — remove a follower (owner only)
app.delete('/api/users/:username/followers/:followerUsername', auth, (req, res) => {
  const owner    = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username.toLowerCase());
  const follower = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.followerUsername.toLowerCase());
  if (!owner || !follower) return res.status(404).json({ error: 'User not found' });
  if (owner.id !== req.user.id) return res.status(403).json({ error: 'You can only remove followers from your own account' });
  db.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').run(follower.id, owner.id);
  const count = db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_id=?').get(owner.id).c;
  res.json({ success: true, followerCount: count });
});

// ── LIKE ROUTES ────────────────────────────────────────────

// POST /api/reviews/:id/like  (toggle — likes if not liked, unlikes if liked)
app.post('/api/reviews/:id/like', auth, (req, res) => {
  const reviewId = Number(req.params.id);
  const review = db.prepare('SELECT id FROM reviews WHERE id=?').get(reviewId);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  const existing = db.prepare('SELECT id FROM review_likes WHERE user_id=? AND review_id=?').get(req.user.id, reviewId);
  if (existing) {
    db.prepare('DELETE FROM review_likes WHERE user_id=? AND review_id=?').run(req.user.id, reviewId);
  } else {
    db.prepare('INSERT INTO review_likes (user_id, review_id) VALUES (?,?)').run(req.user.id, reviewId);
  }
  const count = db.prepare('SELECT COUNT(*) as c FROM review_likes WHERE review_id=?').get(reviewId).c;
  res.json({ liked: !existing, count });
});

// ── COMMENT ROUTES ─────────────────────────────────────────

// GET /api/reviews/:id/comments
app.get('/api/reviews/:id/comments', (req, res) => {
  const comments = db.prepare(`
    SELECT c.id, c.text, c.created_at,
           u.username, u.initials, u.avatar_gradient
    FROM review_comments c JOIN users u ON c.user_id = u.id
    WHERE c.review_id = ?
    ORDER BY c.created_at ASC
    LIMIT 100
  `).all(req.params.id);
  res.json(comments);
});

// POST /api/reviews/:id/comments
app.post('/api/reviews/:id/comments', auth, writeLimiter, (req, res) => {
  const { text } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'Comment text required' });
  if (text.trim().length > 1000) return res.status(400).json({ error: 'Comment too long (max 1000 characters)' });

  const review = db.prepare('SELECT id FROM reviews WHERE id=?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });

  const result = db.prepare('INSERT INTO review_comments (review_id, user_id, text) VALUES (?,?,?)').run(
    req.params.id, req.user.id, text.trim()
  );

  const comment = db.prepare(`
    SELECT c.id, c.text, c.created_at, u.username, u.initials, u.avatar_gradient
    FROM review_comments c JOIN users u ON c.user_id = u.id
    WHERE c.id = ?
  `).get(result.lastInsertRowid);

  res.json(comment);
});

// DELETE /api/comments/:id
app.delete('/api/comments/:id', auth, (req, res) => {
  const result = db.prepare('DELETE FROM review_comments WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Comment not found or not yours' });
  res.json({ success: true });
});

// ── YEAR-END STATS ─────────────────────────────────────────

// GET /api/users/:username/yearstats/:year
app.get('/api/users/:username/yearstats/:year', (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found' });

  const year = req.params.year;

  const summary = db.prepare(`
    SELECT COUNT(*) as total, ROUND(AVG(rating),2) as avg_rating,
           MAX(rating) as max_rating
    FROM reviews
    WHERE user_id=? AND strftime('%Y', created_at)=?
  `).get(u.id, year);

  const topGenre = db.prepare(`
    SELECT a.genre, COUNT(*) as cnt
    FROM reviews r JOIN albums a ON r.album_id = a.id
    WHERE r.user_id=? AND strftime('%Y', r.created_at)=? AND a.genre != ''
    GROUP BY a.genre ORDER BY cnt DESC LIMIT 1
  `).get(u.id, year);

  const monthlyActivity = db.prepare(`
    SELECT strftime('%m', created_at) as month, COUNT(*) as cnt
    FROM reviews
    WHERE user_id=? AND strftime('%Y', created_at)=?
    GROUP BY month ORDER BY month
  `).all(u.id, year);

  const topRated = db.prepare(`
    SELECT r.rating, a.title, a.artist, a.artwork_url, a.itunes_id
    FROM reviews r JOIN albums a ON r.album_id = a.id
    WHERE r.user_id=? AND strftime('%Y', r.created_at)=?
    ORDER BY r.rating DESC, r.created_at DESC LIMIT 5
  `).all(u.id, year);

  const mediaBreakdown = db.prepare(`
    SELECT a.media_type, COUNT(*) as cnt
    FROM reviews r JOIN albums a ON r.album_id = a.id
    WHERE r.user_id=? AND strftime('%Y', r.created_at)=?
    GROUP BY a.media_type
  `).all(u.id, year);

  res.json({ year, summary, topGenre, monthlyActivity, topRated, mediaBreakdown });
});

// ── RECOMMENDATIONS ────────────────────────────────────────

// GET /api/recommendations/:username
app.get('/api/recommendations/:username', async (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE username=?').get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found' });

  // Get user's high-rated albums
  const highRated = db.prepare(`
    SELECT a.title, a.artist, a.genre, a.itunes_id, r.rating
    FROM reviews r JOIN albums a ON r.album_id = a.id
    WHERE r.user_id=? AND r.rating >= 3.5
    ORDER BY r.rating DESC LIMIT 20
  `).all(u.id);

  // Get all albums the user has already reviewed (to exclude)
  const reviewed = new Set(
    db.prepare('SELECT a.itunes_id FROM reviews r JOIN albums a ON r.album_id = a.id WHERE r.user_id=?')
      .all(u.id).map(r => r.itunes_id)
  );

  if (!highRated.length) {
    return res.json({ recommendations: [], message: 'Log more music to get personalized recommendations!' });
  }

  // Build genre and artist preferences
  const genreCounts = {};
  const artistCounts = {};
  for (const r of highRated) {
    if (r.genre) genreCounts[r.genre] = (genreCounts[r.genre] || 0) + 1;
    if (r.artist) artistCounts[r.artist] = (artistCounts[r.artist] || 0) + 1;
  }

  const topGenres  = Object.entries(genreCounts).sort((a,b) => b[1]-a[1]).slice(0,3).map(e => e[0]);
  const topArtists = Object.entries(artistCounts).sort((a,b) => b[1]-a[1]).slice(0,3).map(e => e[0]);

  const recommendations = [];
  const seen = new Set();

  // Recommend by top artists
  for (const artist of topArtists) {
    try {
      const data = await cachedFetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(artist)}&entity=album&limit=6`,
        CACHE_1H
      );
      const albums = (data.results || []).filter(r => r.collectionType && !reviewed.has(String(r.collectionId)));
      for (const a of albums.slice(0, 2)) {
        const id = String(a.collectionId);
        if (seen.has(id)) continue;
        seen.add(id);
        const sourceAlbum = highRated.find(h => h.artist.toLowerCase() === artist.toLowerCase());
        recommendations.push({
          ...formatAlbum(a),
          reason: `Because you loved music by ${artist}`,
          reasonDetail: sourceAlbum ? `You gave "${sourceAlbum.title}" ${sourceAlbum.rating}★` : '',
          type: 'artist',
        });
      }
    } catch {}
  }

  // Recommend by top genres
  const genreIdMap = { 'Country':6,'Hip-Hop':18,'Pop':14,'R&B/Soul':15,'Rock':21,'Jazz':11,'Electronic':7,'Indie':1222,'Folk':1219,'Latin':12,'Classical':5,'Metal':1203,'K-Pop':51 };
  for (const genre of topGenres) {
    try {
      const genreId = genreIdMap[genre];
      const url = genreId
        ? `https://itunes.apple.com/search?term=top+${encodeURIComponent(genre)}&entity=album&limit=8&genreId=${genreId}`
        : `https://itunes.apple.com/search?term=${encodeURIComponent(genre)}+music&entity=album&limit=8`;
      const data = await cachedFetch(url, CACHE_1H);
      const albums = (data.results || []).filter(r => r.collectionType && !reviewed.has(String(r.collectionId)));
      for (const a of albums.slice(0, 2)) {
        const id = String(a.collectionId);
        if (seen.has(id)) continue;
        seen.add(id);
        const sourceAlbum = highRated.find(h => h.genre === genre);
        recommendations.push({
          ...formatAlbum(a),
          reason: `Because you love ${genre} music`,
          reasonDetail: sourceAlbum ? `Similar to "${sourceAlbum.title}" which you rated ${sourceAlbum.rating}★` : '',
          type: 'genre',
        });
      }
    } catch {}
  }

  res.json({ recommendations: recommendations.slice(0, 12), topGenres, topArtists });
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  try {
    const members = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const reviews = db.prepare('SELECT COUNT(*) AS c FROM reviews').get().c;
    const albums  = db.prepare('SELECT COUNT(*) AS c FROM albums').get().c;
    res.json({ members, reviews, albums });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.json({ members: 0, reviews: 0, albums: 0 });
  }
});

// ── FLAG ROUTES ────────────────────────────────────────────

// POST /api/reviews/:id/flag  — any logged-in user can flag a review
app.post('/api/reviews/:id/flag', auth, writeLimiter, (req, res) => {
  const reviewId = Number(req.params.id);
  const review = db.prepare('SELECT id, user_id FROM reviews WHERE id=?').get(reviewId);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  if (review.user_id === req.user.id) return res.status(400).json({ error: "You can't flag your own review" });
  const { reason } = req.body || {};
  try {
    db.prepare('INSERT OR IGNORE INTO review_flags (review_id, reporter_id, reason) VALUES (?,?,?)').run(reviewId, req.user.id, (reason || '').trim().slice(0, 500));
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to flag review' });
  }
});

// ── ADMIN / MOD ROUTES ──────────────────────────────────────

// GET /api/admin/users?q=&limit=50  — list all users (mod+)
app.get('/api/admin/users', auth, requireMod, (req, res) => {
  const q     = (req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.banned, u.ban_reason, u.created_at,
           (SELECT COUNT(*) FROM reviews r WHERE r.user_id = u.id) AS review_count
    FROM users u
    WHERE u.username LIKE ?
    ORDER BY u.created_at DESC
    LIMIT ?
  `).all(`%${q}%`, limit);
  res.json(users);
});

// POST /api/admin/ban  — ban a user (mod+)
app.post('/api/admin/ban', auth, requireMod, (req, res) => {
  const { userId, reason } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const target = db.prepare('SELECT id, role FROM users WHERE id=?').get(Number(userId));
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Mods can't ban other mods or admins
  if ((target.role === 'mod' || target.role === 'admin') && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Only admins can ban moderators' });
  db.prepare('UPDATE users SET banned=1, ban_reason=? WHERE id=?').run((reason || '').trim().slice(0, 500), target.id);
  res.json({ success: true });
});

// POST /api/admin/unban  — restore a user (mod+)
app.post('/api/admin/unban', auth, requireMod, (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  db.prepare('UPDATE users SET banned=0, ban_reason="" WHERE id=?').run(Number(userId));
  res.json({ success: true });
});

// POST /api/admin/set-role  — promote/demote users (admin only)
app.post('/api/admin/set-role', auth, requireAdmin, (req, res) => {
  const { userId, role } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!['user', 'mod', 'admin'].includes(role)) return res.status(400).json({ error: 'role must be user, mod, or admin' });
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, Number(userId));
  res.json({ success: true });
});

// DELETE /api/admin/reviews/:id  — remove any review (mod+)
app.delete('/api/admin/reviews/:id', auth, requireMod, (req, res) => {
  const reviewId = Number(req.params.id);
  db.prepare('DELETE FROM reviews WHERE id=?').run(reviewId);
  // Clear all flags for this review too (cascades via FK but let's be explicit)
  res.json({ success: true });
});

// GET /api/admin/flags?limit=50  — get flagged reviews with context (mod+)
app.get('/api/admin/flags', auth, requireMod, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const flags = db.prepare(`
    SELECT
      rf.id AS flag_id,
      rf.reason AS flag_reason,
      rf.created_at AS flagged_at,
      rf.review_id,
      COUNT(rf2.id) AS total_flags,
      r.rating, r.review_text, r.created_at AS review_date,
      author.id AS author_id, author.username AS author_username,
      reporter.username AS reporter_username,
      a.title AS album_title, a.artist, a.artwork_url, a.itunes_id
    FROM review_flags rf
    JOIN review_flags rf2 ON rf2.review_id = rf.review_id
    JOIN reviews r       ON r.id = rf.review_id
    JOIN users author    ON author.id = r.user_id
    JOIN users reporter  ON reporter.id = rf.reporter_id
    JOIN albums a        ON a.id = r.album_id
    GROUP BY rf.review_id
    ORDER BY total_flags DESC, rf.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json(flags);
});

// POST /api/admin/flags/:reviewId/dismiss  — clear all flags for a review without deleting it (mod+)
app.post('/api/admin/flags/:reviewId/dismiss', auth, requireMod, (req, res) => {
  db.prepare('DELETE FROM review_flags WHERE review_id=?').run(Number(req.params.reviewId));
  res.json({ success: true });
});

// GET /api/admin/stats  — quick dashboard counts (mod+)
app.get('/api/admin/stats', auth, requireMod, (req, res) => {
  res.json({
    totalUsers:    db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    bannedUsers:   db.prepare('SELECT COUNT(*) as c FROM users WHERE banned=1').get().c,
    totalReviews:  db.prepare('SELECT COUNT(*) as c FROM reviews').get().c,
    flaggedReviews:db.prepare('SELECT COUNT(DISTINCT review_id) as c FROM review_flags').get().c,
    totalAlbums:   db.prepare('SELECT COUNT(*) as c FROM albums').get().c,
  });
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
