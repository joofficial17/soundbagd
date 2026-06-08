/**
 * SOUNDBAGD — Client Application
 * Handles: auth, search, music data, reviews, DSP import, dynamic rendering
 */

'use strict';

// ── Config ─────────────────────────────────────────────────
const API_BASE = '';   // same origin — Express serves both

// ── API Helper ─────────────────────────────────────────────
const api = {
  async request(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const token = auth.getToken();
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body)  opts.body = JSON.stringify(body);

    const res = await fetch(API_BASE + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  },
  get:    (path)        => api.request('GET',    path),
  post:   (path, body)  => api.request('POST',   path, body),
  put:    (path, body)  => api.request('PUT',    path, body),
  delete: (path)        => api.request('DELETE', path),
};

// ── Auth ───────────────────────────────────────────────────
const auth = {
  getToken:  ()    => localStorage.getItem('sb_token'),
  getUser:   ()    => JSON.parse(localStorage.getItem('sb_user') || 'null'),
  isLoggedIn:()    => !!auth.getToken(),

  save(token, user) {
    localStorage.setItem('sb_token', token);
    localStorage.setItem('sb_user',  JSON.stringify(user));
    this.updateNav();
  },

  logout() {
    localStorage.removeItem('sb_token');
    localStorage.removeItem('sb_user');
    this.updateNav();
  },

  updateNav() {
    const user = this.getUser();
    const signIn = document.getElementById('navSignIn');
    const join   = document.getElementById('navJoin');
    const profile= document.getElementById('navProfile');

    if (user) {
      if (signIn)  signIn.style.display  = 'none';
      if (join)    join.style.display    = 'none';
      if (profile) {
        profile.style.display = 'flex';
        const av = profile.querySelector('.nav-avatar');
        if (av) {
          av.textContent      = user.initials || user.username.slice(0,2).toUpperCase();
          av.style.background = user.gradient || 'linear-gradient(135deg,#d4af37,#7c5cbf)';
        }
        const name = profile.querySelector('.nav-username');
        if (name) name.textContent = user.username;
      }
      // Show Admin link for mods and admins
      const navLinks = document.querySelector('.nav__links');
      if (navLinks && (user.role === 'mod' || user.role === 'admin')) {
        if (!document.getElementById('navAdminLink')) {
          const li = document.createElement('li');
          li.innerHTML = '<a href="admin.html" id="navAdminLink" style="color:var(--gold)">🛡️ Admin</a>';
          navLinks.appendChild(li);
        }
      }
      // Swap hero "Start Your Journey" → "Browse Music to Review" when logged in
      const heroBtn = document.getElementById('heroMainBtn');
      if (heroBtn) {
        heroBtn.href = '#trending';
        heroBtn.removeAttribute('onclick');
        heroBtn.innerHTML =
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18V5l12-2v13"/><circle cx="7" cy="18" r="2"/><circle cx="19" cy="16" r="2"/></svg>'
          + ' Browse Music';
      }
    } else {
      if (signIn)  signIn.style.display  = '';
      if (join)    join.style.display    = '';
      if (profile) profile.style.display = 'none';
      // Remove admin link if logged out
      document.getElementById('navAdminLink')?.parentElement?.remove();
      // Restore hero button to sign-up state
      const heroBtn = document.getElementById('heroMainBtn');
      if (heroBtn) {
        heroBtn.href = '#';
        heroBtn.setAttribute('onclick', "event.preventDefault();openAuthModal('register')");
        heroBtn.innerHTML =
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>'
          + ' Start Your Journey';
      }
    }
  },
};

// ── Star Rating ────────────────────────────────────────────
function buildStars(containerId, opts = {}) {
  const { size = 22, interactive = false, value = 0, onChange } = opts;
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  container.dataset.rating = String(value);

  for (let i = 1; i <= 5; i++) {
    const star = document.createElement('span');
    star.style.cssText = `
      display:inline-block; font-size:${size}px; cursor:${interactive ? 'pointer' : 'default'};
      line-height:1; transition:transform 0.1s, color 0.1s; user-select:none;
      position:relative;
    `;
    star.dataset.i = i;
    star.textContent = '★';

    if (interactive) {
      // Left half → half star; right half → full star
      const left = document.createElement('span');
      left.style.cssText = 'position:absolute;left:0;top:0;width:50%;height:100%;cursor:pointer;';
      left.dataset.v = i - 0.5;
      const right = document.createElement('span');
      right.style.cssText = 'position:absolute;right:0;top:0;width:50%;height:100%;cursor:pointer;';
      right.dataset.v = i;

      const hoverFn = (v) => {
        renderStarRow(container, v);
        container.querySelector('#' + containerId + '-label') && updateRatingLabel(containerId, v);
      };
      const clickFn = (v) => {
        container.dataset.rating = String(v);
        renderStarRow(container, v);
        if (onChange) onChange(v);
        const lbl = document.getElementById(containerId + '-label');
        if (lbl) {
          lbl.textContent = `${v} — ${ratingLabel(v)}`;
          lbl.style.color = 'var(--gold)';
        }
      };

      left.onmouseenter  = () => hoverFn(i - 0.5);
      right.onmouseenter = () => hoverFn(i);
      left.onclick       = (e) => { e.stopPropagation(); clickFn(i - 0.5); };
      right.onclick      = (e) => { e.stopPropagation(); clickFn(i); };

      star.appendChild(left);
      star.appendChild(right);
      container.onmouseleave = () => renderStarRow(container, Number(container.dataset.rating));
    }

    container.appendChild(star);
  }
  renderStarRow(container, value);
}

function renderStarRow(container, value) {
  Array.from(container.children).forEach((star) => {
    const i = Number(star.dataset.i);
    if (!i) return;
    if (value >= i) {
      star.style.color = 'var(--gold)';
      star.style.background = '';
      star.style.webkitBackgroundClip = '';
      star.style.webkitTextFillColor = '';
    } else if (value >= i - 0.5) {
      star.style.background = 'linear-gradient(to right, var(--gold) 50%, var(--text-dim) 50%)';
      star.style.webkitBackgroundClip = 'text';
      star.style.webkitTextFillColor = 'transparent';
    } else {
      star.style.color = 'var(--text-dim)';
      star.style.background = '';
      star.style.webkitBackgroundClip = '';
      star.style.webkitTextFillColor = '';
    }
  });
}

function ratingLabel(v) {
  return {
    0.5:'Dreadful', 1:'Very Poor', 1.5:'Poor', 2:'Weak', 2.5:'Below Average',
    3:'Average', 3.5:'Decent', 4:'Good', 4.5:'Excellent', 5:'Masterpiece ✨'
  }[v] || '';
}

function updateRatingLabel(containerId, v) {
  const lbl = document.getElementById(containerId + '-label');
  if (!lbl) return;
  if (!v) { lbl.textContent = 'Tap to rate'; lbl.style.color = 'var(--text-muted)'; return; }
  lbl.textContent = `${v} — ${ratingLabel(v)}`;
  lbl.style.color = 'var(--gold)';
}

function starsHtml(rating, size = 14) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    if (rating >= i) {
      html += `<span style="color:var(--gold);font-size:${size}px">★</span>`;
    } else if (rating >= i - 0.5) {
      html += `<span style="background:linear-gradient(to right,var(--gold) 50%,var(--text-dim) 50%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-size:${size}px">★</span>`;
    } else {
      html += `<span style="color:var(--text-dim);font-size:${size}px">★</span>`;
    }
  }
  return html;
}

// ── Formatters ─────────────────────────────────────────────
function ms(millis) {
  if (!millis) return '';
  const s = Math.round(millis / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function relativeTime(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)   return 'Just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)   return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function escHtml(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Album Card HTML ────────────────────────────────────────
function albumCardHtml(album) {
  // Pass title+artist alongside ID so the album page can search by them
  // if the ID is not a Spotify ID (e.g. Apple/Deezer numeric IDs)
  const params = new URLSearchParams({ id: album.itunesId });
  if (album.title)  params.set('title',  album.title);
  if (album.artist) params.set('artist', album.artist);
  const href = `album.html?${params.toString()}`;
  const tag  = album.mediaType && album.mediaType !== 'Album' ? `<span class="tag" style="font-size:0.65rem">${escHtml(album.mediaType)}</span>` : '';
  return `
    <div class="album-card" onclick="location.href='${href}'">
      <div class="album-card__art">
        <img src="${escHtml(album.artwork)}" alt="${escHtml(album.title)}" loading="lazy"
          onerror="this.src='data:image/svg+xml,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'1\\' height=\\'1\\'></svg>'">
        <div class="album-card__overlay">
          <button class="play-btn" onclick="event.stopPropagation();openReviewModal(${JSON.stringify(album).replace(/"/g,'&quot;')})">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          </button>
        </div>
      </div>
      <div class="album-card__title">${escHtml(album.title)}</div>
      <div class="album-card__artist">${escHtml(album.artist)}</div>
      <div class="album-card__meta">${tag}</div>
    </div>`;
}

// ── Review Card HTML ───────────────────────────────────────
function reviewCardHtml(r) {
  const hasText  = r.review_text?.trim();
  const tags     = r.tags ? r.tags.split(',').filter(Boolean) : [];
  const likeCnt  = r.like_count || 0;
  const isLiked  = r.is_liked || false;
  return `
    <div class="review-card">
      <div class="review-card__header">
        <div class="review-card__album-art" style="cursor:pointer" onclick="location.href='album.html?id=${escHtml(r.itunes_id)}'">
          <img src="${escHtml(r.artwork_url)}" alt="${escHtml(r.title)}" loading="lazy">
        </div>
        <div class="review-card__info">
          <div class="review-card__title" style="cursor:pointer" onclick="location.href='album.html?id=${escHtml(r.itunes_id)}'">${escHtml(r.title)}</div>
          <div class="review-card__artist">${escHtml(r.artist)} · ${escHtml(r.media_type || 'Album')}</div>
          <div style="display:flex;align-items:center;gap:4px">${starsHtml(r.rating)}<span style="font-size:0.75rem;color:var(--gold);font-weight:600;margin-left:4px">${r.rating}</span></div>
        </div>
      </div>
      <div class="review-card__user">
        <div class="avatar" style="width:28px;height:28px;font-size:0.7rem;background:${escHtml(r.avatar_gradient || 'linear-gradient(135deg,#d4af37,#7c5cbf)')}">${escHtml(r.initials || '?')}</div>
        <a href="profile.html?u=${encodeURIComponent(r.username)}" class="review-card__username" style="color:inherit">${escHtml(r.username)}</a>
        <span class="review-card__date">${relativeTime(r.created_at)}</span>
        <button class="like-btn${isLiked ? ' liked' : ''}" style="margin-left:auto" onclick="toggleLike(${r.id || 0},this)">
          ♥ <span class="like-count">${likeCnt}</span>
        </button>
        <button title="Flag this review" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:.85rem;padding:4px 6px;opacity:.5;transition:var(--transition)" onmouseover="this.style.opacity='1';this.style.color='#e05c5c'" onmouseout="this.style.opacity='.5';this.style.color='var(--text-muted)'" onclick="flagReview(${r.id || 0},this)">🚩</button>
      </div>
      ${hasText ? `<p class="review-card__text">${escHtml(r.review_text)}</p>` : '<p class="text-xs muted" style="font-style:italic">Rated without a written review</p>'}
      ${tags.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${tags.map(t => `<span class="mood-tag">#${escHtml(t)}</span>`).join('')}</div>` : ''}
    </div>`;
}

// ── Like toggle ────────────────────────────────────────────
async function toggleLike(reviewId, btn) {
  if (!auth.isLoggedIn()) { openAuthModal('login'); return; }
  if (!reviewId) return;
  try {
    const data = await api.post(`/api/reviews/${reviewId}/like`, {});
    const countEl = btn.querySelector('.like-count');
    if (countEl) countEl.textContent = data.count;
    btn.classList.toggle('liked', data.liked);
  } catch (err) {
    showToast('Could not update like: ' + err.message);
  }
}

// ── Flag review ────────────────────────────────────────────
async function flagReview(reviewId, btn) {
  if (!auth.isLoggedIn()) { openAuthModal('login'); return; }
  if (!reviewId) return;
  const reason = prompt('Why are you flagging this review? (optional — leave blank to submit)');
  if (reason === null) return; // user cancelled
  try {
    btn.disabled = true;
    await api.post(`/api/reviews/${reviewId}/flag`, { reason });
    btn.style.color = '#e05c5c'; btn.style.opacity = '1'; btn.title = 'Flagged — thank you';
    showToast('Review flagged. Our moderators will review it shortly.');
  } catch (err) {
    showToast(err.message.includes('already') ? 'You already flagged this review.' : 'Could not flag: ' + err.message);
    btn.disabled = false;
  }
}

// ── Skeleton Loader ────────────────────────────────────────
function skeletonAlbum() {
  return `<div class="album-card" style="pointer-events:none">
    <div class="album-card__art" style="background:var(--bg-raised);aspect-ratio:1;border-radius:var(--radius-md);animation:pulse 1.5s ease infinite"></div>
    <div style="height:12px;background:var(--bg-raised);border-radius:4px;margin:8px 0 4px;animation:pulse 1.5s ease infinite"></div>
    <div style="height:10px;background:var(--bg-raised);border-radius:4px;width:70%;animation:pulse 1.5s ease infinite"></div>
  </div>`;
}

// ── Auth Modal ─────────────────────────────────────────────
function injectAuthModal() {
  if (document.getElementById('authModal')) return;
  const el = document.createElement('div');
  el.id = 'authModal';
  el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
        <div>
          <div class="text-xs muted" id="authModalSub" style="margin-bottom:4px;letter-spacing:.06em;text-transform:uppercase;font-weight:600">Join Soundbagd</div>
          <h3 style="font-family:'Playfair Display',serif;font-size:1.4rem" id="authModalTitle">Create Your Account</h3>
        </div>
        <button class="modal__close" onclick="closeAuthModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <!-- Error banner -->
      <div id="authError" style="display:none;background:rgba(255,107,107,.12);border:1px solid rgba(255,107,107,.3);color:#ff6b6b;padding:10px 14px;border-radius:var(--radius-sm);font-size:.85rem;margin-bottom:16px"></div>

      <!-- Register form -->
      <div id="registerForm">
        <div style="margin-bottom:14px">
          <label class="modal__label">Username</label>
          <input id="reg_username" type="text" placeholder="e.g. vinyl_hunter" autocomplete="username"
            style="width:100%;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-md);padding:11px 14px;color:var(--text);font-size:.9rem;outline:none;transition:var(--transition)"
            onfocus="this.style.borderColor='var(--gold)'" onblur="this.style.borderColor=''" onkeydown="if(event.key==='Enter')registerUser()">
        </div>
        <div style="margin-bottom:14px">
          <label class="modal__label">Email</label>
          <input id="reg_email" type="email" placeholder="you@example.com" autocomplete="email"
            style="width:100%;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-md);padding:11px 14px;color:var(--text);font-size:.9rem;outline:none;transition:var(--transition)"
            onfocus="this.style.borderColor='var(--gold)'" onblur="this.style.borderColor=''" onkeydown="if(event.key==='Enter')registerUser()">
        </div>
        <div style="margin-bottom:20px">
          <label class="modal__label">Password <span class="text-xs muted">(min 6 characters)</span></label>
          <input id="reg_password" type="password" placeholder="••••••••" autocomplete="new-password"
            style="width:100%;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-md);padding:11px 14px;color:var(--text);font-size:.9rem;outline:none;transition:var(--transition)"
            onfocus="this.style.borderColor='var(--gold)'" onblur="this.style.borderColor=''" onkeydown="if(event.key==='Enter')registerUser()">
        </div>
        <button class="btn btn--gold" style="width:100%;justify-content:center;padding:12px" id="regSubmitBtn" onclick="registerUser()">Create Account</button>
        <div style="text-align:center;margin-top:16px;font-size:.85rem;color:var(--text-muted)">
          Already have an account? <button onclick="showLoginForm()" style="color:var(--gold);font-weight:600;background:none;border:none;cursor:pointer">Sign in</button>
        </div>
      </div>

      <!-- Login form -->
      <div id="loginForm" style="display:none">
        <div style="margin-bottom:14px">
          <label class="modal__label">Email</label>
          <input id="log_email" type="email" placeholder="you@example.com" autocomplete="email"
            style="width:100%;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-md);padding:11px 14px;color:var(--text);font-size:.9rem;outline:none;transition:var(--transition)"
            onfocus="this.style.borderColor='var(--gold)'" onblur="this.style.borderColor=''" onkeydown="if(event.key==='Enter')loginUser()">
        </div>
        <div style="margin-bottom:20px">
          <label class="modal__label">Password</label>
          <input id="log_password" type="password" placeholder="••••••••" autocomplete="current-password"
            style="width:100%;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-md);padding:11px 14px;color:var(--text);font-size:.9rem;outline:none;transition:var(--transition)"
            onfocus="this.style.borderColor='var(--gold)'" onblur="this.style.borderColor=''" onkeydown="if(event.key==='Enter')loginUser()">
        </div>
        <button class="btn btn--gold" style="width:100%;justify-content:center;padding:12px" id="logSubmitBtn" onclick="loginUser()">Sign In</button>
        <div style="text-align:center;margin-top:16px;font-size:.85rem;color:var(--text-muted)">
          No account yet? <button onclick="showRegisterForm()" style="color:var(--gold);font-weight:600;background:none;border:none;cursor:pointer">Join free</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => { if (e.target === el) closeAuthModal(); });
}

function openAuthModal(mode = 'register') {
  injectAuthModal();
  document.getElementById('authError').style.display = 'none';
  if (mode === 'login') showLoginForm(); else showRegisterForm();
  document.getElementById('authModal').classList.add('open');
}
function closeAuthModal() {
  document.getElementById('authModal')?.classList.remove('open');
}
function showLoginForm() {
  document.getElementById('registerForm').style.display = 'none';
  document.getElementById('loginForm').style.display    = '';
  document.getElementById('authModalSub').textContent   = 'Welcome back';
  document.getElementById('authModalTitle').textContent = 'Sign In';
}
function showRegisterForm() {
  document.getElementById('loginForm').style.display    = 'none';
  document.getElementById('registerForm').style.display = '';
  document.getElementById('authModalSub').textContent   = 'Join Soundbagd';
  document.getElementById('authModalTitle').textContent = 'Create Your Account';
}
function setAuthError(msg) {
  const el = document.getElementById('authError');
  el.textContent    = msg;
  el.style.display  = msg ? '' : 'none';
}
function setAuthLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled    = loading;
  btn.textContent = loading ? 'Please wait…' : (btnId === 'regSubmitBtn' ? 'Create Account' : 'Sign In');
}

async function registerUser() {
  setAuthError('');
  setAuthLoading('regSubmitBtn', true);
  try {
    const username = document.getElementById('reg_username').value.trim();
    const email    = document.getElementById('reg_email').value.trim();
    const password = document.getElementById('reg_password').value;
    const data = await api.post('/api/auth/register', { username, email, password });
    auth.save(data.token, data.user);
    closeAuthModal();
    // Redirect to profile
    setTimeout(() => { window.location.href = `profile.html?u=${encodeURIComponent(data.user.username)}`; }, 100);
  } catch (err) {
    setAuthError(err.message);
  } finally {
    setAuthLoading('regSubmitBtn', false);
  }
}

async function loginUser() {
  setAuthError('');
  setAuthLoading('logSubmitBtn', true);
  try {
    const email    = document.getElementById('log_email').value.trim();
    const password = document.getElementById('log_password').value;
    const data = await api.post('/api/auth/login', { email, password });
    auth.save(data.token, data.user);
    closeAuthModal();
    // Stay on page but refresh if needed
    if (typeof initPage === 'function') initPage();
    else location.reload();
  } catch (err) {
    setAuthError(err.message);
  } finally {
    setAuthLoading('logSubmitBtn', false);
  }
}

function logoutUser() {
  auth.logout();
  window.location.href = 'index.html';
}

// ── Review Modal ────────────────────────────────────────────
let _reviewAlbum = null;
let _reviewMode  = 'star';

function injectReviewModal() {
  if (document.getElementById('reviewModal')) return;
  const el = document.createElement('div');
  el.id = 'reviewModal';
  el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal">
      <!-- Header -->
      <div class="modal__header">
        <div class="modal__art" id="reviewModalArt" style="background:var(--bg-raised)">
          <img id="reviewModalImg" src="" alt="" style="display:none">
        </div>
        <div style="flex:1;min-width:0">
          <div class="text-xs muted" style="margin-bottom:2px" id="reviewModalType">Album</div>
          <div style="font-weight:700;font-size:1rem" id="reviewModalTitle">—</div>
          <div class="text-sm muted" id="reviewModalArtist">—</div>
        </div>
        <button class="modal__close" onclick="closeReviewModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <!-- Stars -->
      <span class="modal__label">Your Rating</span>
      <div class="modal__stars" id="modalStars"></div>
      <div id="modalStars-label" style="text-align:center;font-size:.85rem;color:var(--text-muted);margin-top:-12px;margin-bottom:20px;min-height:20px">Tap to rate</div>

      <!-- Mode toggle -->
      <div class="modal__toggle">
        <button id="modeStarBtn" class="active" onclick="setReviewMode('star')">⭐ Star Only</button>
        <button id="modeWriteBtn" onclick="setReviewMode('written')">✍️ Write a Review</button>
      </div>

      <!-- Written section -->
      <div id="writtenSection" style="display:none">
        <span class="modal__label">Your Review</span>
        <textarea id="reviewText" class="modal__textarea" placeholder="What did this album make you feel? What stood out?" maxlength="2000"></textarea>
        <div style="display:flex;justify-content:space-between;margin-top:4px">
          <div></div>
          <span id="charCount" class="text-xs muted">0 / 2000</span>
        </div>
      </div>

      <!-- Mood Tags -->
      <div style="margin-top:16px">
        <span class="modal__label">Mood Tags <span class="text-xs muted">(optional — pick any that fit)</span></span>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px" id="reviewMoodTags">
          ${['rainy-day','late-night','road-trip','heartbreak','chill','workout','focus','party','study','motivation','nostalgic','ethereal'].map(t =>
            `<button type="button" class="mood-tag" data-tag="${t}" onclick="toggleMoodTag(this)">#${t}</button>`
          ).join('')}
        </div>
      </div>

      <!-- DSP Link -->
      <div style="margin-top:16px">
        <span class="modal__label" style="display:flex;align-items:center;gap:6px">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          Reference Link <span class="text-xs muted">(optional)</span>
        </span>
        <input id="dspRefUrl" type="url" placeholder="Paste Spotify, Apple Music, TIDAL, YouTube link…"
          style="width:100%;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-md);padding:9px 14px;color:var(--text);font-size:.85rem;outline:none;transition:var(--transition)"
          onfocus="this.style.borderColor='var(--gold)'" onblur="this.style.borderColor=''">
      </div>

      <!-- Error -->
      <div id="reviewError" style="display:none;color:var(--coral);font-size:.82rem;margin-top:8px"></div>

      <!-- Footer -->
      <div class="modal__footer">
        <button class="btn btn--ghost" onclick="closeReviewModal()">Cancel</button>
        <button class="btn btn--gold" onclick="submitReview()" id="reviewSubmitBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>
          Submit
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => { if (e.target === el) closeReviewModal(); });

  // Char counter
  document.getElementById('reviewText').addEventListener('input', (e) => {
    const len = e.target.value.length;
    const counter = document.getElementById('charCount');
    counter.textContent = `${len} / 2000`;
    counter.style.color = len > 1800 ? 'var(--coral)' : 'var(--text-muted)';
  });
}

function toggleMoodTag(btn) {
  btn.classList.toggle('selected');
}

function getSelectedMoodTags(containerId = 'reviewMoodTags') {
  const el = document.getElementById(containerId);
  if (!el) return [];
  return Array.from(el.querySelectorAll('.mood-tag.selected')).map(b => b.dataset.tag);
}

function openReviewModal(album) {
  if (!auth.isLoggedIn()) { openAuthModal('login'); return; }
  injectReviewModal();
  _reviewAlbum = typeof album === 'string' ? JSON.parse(album) : album;

  // Populate header
  document.getElementById('reviewModalTitle').textContent  = _reviewAlbum.title  || '—';
  document.getElementById('reviewModalArtist').textContent = _reviewAlbum.artist || '—';
  document.getElementById('reviewModalType').textContent   = _reviewAlbum.mediaType || 'Album';
  const img = document.getElementById('reviewModalImg');
  if (_reviewAlbum.artwork) {
    img.src = _reviewAlbum.artwork;
    img.style.display = '';
  } else {
    img.style.display = 'none';
  }

  // Reset
  document.getElementById('reviewText').value   = '';
  document.getElementById('dspRefUrl').value    = '';
  document.getElementById('charCount').textContent = '0 / 2000';
  document.getElementById('reviewError').style.display = 'none';
  // Reset mood tags
  document.querySelectorAll('#reviewMoodTags .mood-tag').forEach(t => t.classList.remove('selected'));
  setReviewMode('star');

  buildStars('modalStars', { size: 32, interactive: true, value: 0 });

  document.getElementById('reviewModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeReviewModal() {
  document.getElementById('reviewModal')?.classList.remove('open');
  document.body.style.overflow = '';
}

function setReviewMode(mode) {
  _reviewMode = mode;
  const ws  = document.getElementById('writtenSection');
  const sb  = document.getElementById('modeStarBtn');
  const wb  = document.getElementById('modeWriteBtn');
  if (!ws) return;
  ws.style.display = mode === 'written' ? '' : 'none';
  sb.classList.toggle('active', mode === 'star');
  wb.classList.toggle('active', mode === 'written');
}

async function submitReview() {
  const stars   = document.getElementById('modalStars');
  const rating  = stars ? Number(stars.dataset.rating) : 0;
  const errEl   = document.getElementById('reviewError');

  if (!rating) {
    errEl.textContent = '⚠ Please select a star rating first.';
    errEl.style.display = '';
    return;
  }

  const btn = document.getElementById('reviewSubmitBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const album = _reviewAlbum || {};
    await api.post('/api/reviews', {
      itunesId:   album.itunesId || '',
      title:      album.title    || '',
      artist:     album.artist   || '',
      artwork:    album.artwork  || '',
      year:       album.year     || null,
      genre:      album.genre    || '',
      mediaType:  album.mediaType|| 'Album',
      trackCount: album.trackCount || null,
      itunesUrl:  album.itunesUrl  || '',
      rating,
      reviewText: _reviewMode === 'written' ? document.getElementById('reviewText').value.trim() : '',
      dspUrl:     document.getElementById('dspRefUrl').value.trim() || '',
      tags:       getSelectedMoodTags('reviewMoodTags'),
    });

    closeReviewModal();

    // Refresh reviews section if on album page
    if (typeof loadAlbumReviews === 'function') loadAlbumReviews();
    // Refresh feed on home page
    if (typeof loadRecentReviews === 'function') loadRecentReviews();

    // Toast
    showToast('Review saved! 🎵');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = '';
  } finally {
    btn.disabled = false; btn.textContent = 'Submit';
  }
}

// ── DSP Import Modal ────────────────────────────────────────
let _dspAlbum = null;

function injectDspModal() {
  if (document.getElementById('dspModal')) return;
  const el = document.createElement('div');
  el.id = 'dspModal';
  el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal" style="max-width:500px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px">
        <div>
          <div class="text-xs muted" style="text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:4px">Add Music</div>
          <h3 style="font-family:'Playfair Display',serif;font-size:1.3rem">Import from a Streaming Link</h3>
        </div>
        <button class="modal__close" onclick="closeDspModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <!-- Supported DSPs -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <span class="tag">Spotify</span>
        <span class="tag">Apple Music</span>
        <span class="tag">TIDAL</span>
        <span class="tag">YouTube Music</span>
        <span class="tag">Amazon Music</span>
        <span class="tag">Deezer</span>
      </div>

      <!-- URL Input -->
      <div style="position:relative;margin-bottom:16px">
        <svg style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-dim);pointer-events:none" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        <input id="dspUrl" type="url" placeholder="Paste album/track link here…"
          style="width:100%;background:var(--bg-raised);border:1px solid var(--border);border-radius:40px;padding:10px 16px 10px 38px;color:var(--text);font-size:.875rem;outline:none;transition:var(--transition)"
          onfocus="this.style.borderColor='var(--gold)'" onblur="this.style.borderColor=''" onkeydown="if(event.key==='Enter')fetchDspMeta()">
      </div>
      <button class="btn btn--gold btn--sm" style="width:100%;justify-content:center;margin-bottom:20px" id="dspFetchBtn" onclick="fetchDspMeta()">
        Fetch Details
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </button>

      <!-- Error -->
      <div id="dspError" style="display:none;background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.3);color:#ff6b6b;padding:10px 14px;border-radius:var(--radius-sm);font-size:.82rem;margin-bottom:16px"></div>

      <!-- Preview -->
      <div id="dspPreview" style="display:none;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;margin-bottom:20px">
        <div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">
          <img id="dspArtwork" src="" alt="" style="width:60px;height:60px;border-radius:8px;object-fit:cover;flex-shrink:0">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700" id="dspTitleEl">—</div>
            <div class="text-sm muted" id="dspArtistEl">—</div>
            <div class="text-xs muted" id="dspYearEl"></div>
          </div>
          <span class="tag tag--gold" id="dspBadge">DSP</span>
        </div>
        <!-- Editable fields in case metadata is partial -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label class="modal__label" style="font-size:.72rem">Title</label>
            <input id="dspEditTitle" type="text"
              style="width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:7px 10px;color:var(--text);font-size:.85rem;outline:none"
              onfocus="this.style.borderColor='var(--gold)'" onblur="this.style.borderColor=''">
          </div>
          <div>
            <label class="modal__label" style="font-size:.72rem">Artist</label>
            <input id="dspEditArtist" type="text"
              style="width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:7px 10px;color:var(--text);font-size:.85rem;outline:none"
              onfocus="this.style.borderColor='var(--gold)'" onblur="this.style.borderColor=''">
          </div>
        </div>
      </div>

      <div class="modal__footer">
        <button class="btn btn--ghost" onclick="closeDspModal()">Cancel</button>
        <button class="btn btn--gold" id="dspReviewBtn" style="display:none" onclick="openReviewFromDsp()">
          Rate This Album
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => { if (e.target === el) closeDspModal(); });
}

function openDspModal() {
  if (!auth.isLoggedIn()) { openAuthModal('login'); return; }
  injectDspModal();
  document.getElementById('dspUrl').value         = '';
  document.getElementById('dspPreview').style.display = 'none';
  document.getElementById('dspReviewBtn').style.display = 'none';
  document.getElementById('dspError').style.display   = 'none';
  _dspAlbum = null;
  document.getElementById('dspModal').classList.add('open');
}
function closeDspModal() {
  document.getElementById('dspModal')?.classList.remove('open');
}

async function fetchDspMeta() {
  const url = document.getElementById('dspUrl').value.trim();
  if (!url) return;

  const errEl  = document.getElementById('dspError');
  const btn    = document.getElementById('dspFetchBtn');
  errEl.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Fetching…';

  try {
    const data = await api.post('/api/dsp/import', { url });

    if (data.error) {
      errEl.textContent   = data.error;
      errEl.style.display = '';
    }

    _dspAlbum = { ...data, dspUrl: url };

    const preview = document.getElementById('dspPreview');
    preview.style.display = '';
    document.getElementById('dspArtwork').src       = data.artwork || '';
    document.getElementById('dspArtwork').style.display = data.artwork ? '' : 'none';
    document.getElementById('dspTitleEl').textContent  = data.title  || '(Unknown)';
    document.getElementById('dspArtistEl').textContent = data.artist || '(Unknown)';
    document.getElementById('dspYearEl').textContent   = data.year   || '';
    document.getElementById('dspBadge').textContent    = data.dsp    || 'DSP';
    document.getElementById('dspEditTitle').value      = data.title  || '';
    document.getElementById('dspEditArtist').value     = data.artist || '';
    document.getElementById('dspReviewBtn').style.display = '';

  } catch (err) {
    errEl.textContent   = err.message;
    errEl.style.display = '';
  } finally {
    btn.disabled = false; btn.textContent = 'Fetch Details';
  }
}

function openReviewFromDsp() {
  if (!_dspAlbum) return;
  // Merge edited fields
  _dspAlbum.title  = document.getElementById('dspEditTitle').value.trim()  || _dspAlbum.title;
  _dspAlbum.artist = document.getElementById('dspEditArtist').value.trim() || _dspAlbum.artist;
  _dspAlbum.itunesId = _dspAlbum.itunesId || `dsp-${Date.now()}`;

  closeDspModal();
  openReviewModal(_dspAlbum);
  // Pre-fill DSP link
  setTimeout(() => {
    const el = document.getElementById('dspRefUrl');
    if (el) el.value = _dspAlbum.dspUrl || '';
  }, 100);
}

// ── Edit Review Modal ───────────────────────────────────────
let _editReviewItunesId = null;

function injectEditReviewModal() {
  if (document.getElementById('editReviewModal')) return;
  const el = document.createElement('div');
  el.id = 'editReviewModal';
  el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <h3 style="font-family:'Playfair Display',serif;font-size:1.3rem">Edit Review</h3>
        <button class="modal__close" onclick="closeEditReviewModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <span class="modal__label">Your Rating</span>
      <div class="modal__stars" id="editModalStars"></div>
      <div id="editModalStars-label" style="text-align:center;font-size:.85rem;color:var(--text-muted);margin-top:-12px;margin-bottom:20px;min-height:20px">Tap to rate</div>

      <div class="modal__toggle">
        <button id="editModeStarBtn" class="active" onclick="setEditReviewMode('star')">⭐ Star Only</button>
        <button id="editModeWriteBtn" onclick="setEditReviewMode('written')">✍️ Write a Review</button>
      </div>

      <div id="editWrittenSection" style="display:none">
        <span class="modal__label">Your Review</span>
        <textarea id="editReviewText" class="modal__textarea" placeholder="What did this album make you feel?" maxlength="2000"></textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:4px">
          <span id="editCharCount" class="text-xs muted">0 / 2000</span>
        </div>
      </div>

      <div style="margin-top:16px">
        <span class="modal__label">Reference Link <span class="text-xs muted">(optional)</span></span>
        <input id="editDspUrl" type="url" placeholder="Paste Spotify, Apple Music, TIDAL, YouTube link…"
          style="width:100%;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-md);padding:9px 14px;color:var(--text);font-size:.85rem;outline:none;transition:var(--transition)"
          onfocus="this.style.borderColor='var(--gold)'" onblur="this.style.borderColor=''">
      </div>

      <div id="editReviewError" style="display:none;color:var(--coral);font-size:.82rem;margin-top:8px"></div>

      <div class="modal__footer">
        <button class="btn btn--ghost" onclick="closeEditReviewModal()">Cancel</button>
        <button class="btn btn--gold" onclick="saveEditedReview()" id="editReviewSubmitBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg>
          Save Changes
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => { if (e.target === el) closeEditReviewModal(); });

  document.getElementById('editReviewText').addEventListener('input', (e) => {
    const len = e.target.value.length;
    const counter = document.getElementById('editCharCount');
    counter.textContent = `${len} / 2000`;
    counter.style.color = len > 1800 ? 'var(--coral)' : 'var(--text-muted)';
  });
}

let _editReviewMode = 'star';
function setEditReviewMode(mode) {
  _editReviewMode = mode;
  document.getElementById('editWrittenSection').style.display = mode === 'written' ? '' : 'none';
  document.getElementById('editModeStarBtn').classList.toggle('active', mode === 'star');
  document.getElementById('editModeWriteBtn').classList.toggle('active', mode === 'written');
}

async function openEditReviewModal(itunesId) {
  injectEditReviewModal();
  _editReviewItunesId = itunesId;

  // Load existing review
  try {
    const review = await api.get(`/api/reviews/mine/${encodeURIComponent(itunesId)}`);
    if (!review) { showToast('Review not found.'); return; }

    const mode = review.review_text ? 'written' : 'star';
    setEditReviewMode(mode);
    buildStars('editModalStars', { size: 32, interactive: true, value: review.rating });

    if (review.review_text) {
      document.getElementById('editReviewText').value = review.review_text;
      document.getElementById('editCharCount').textContent = `${review.review_text.length} / 2000`;
    } else {
      document.getElementById('editReviewText').value = '';
      document.getElementById('editCharCount').textContent = '0 / 2000';
    }
    document.getElementById('editDspUrl').value = review.dsp_url || '';
    document.getElementById('editReviewError').style.display = 'none';
  } catch (err) {
    showToast('Could not load review: ' + err.message);
    return;
  }

  document.getElementById('editReviewModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeEditReviewModal() {
  document.getElementById('editReviewModal')?.classList.remove('open');
  document.body.style.overflow = '';
}

async function saveEditedReview() {
  const stars  = document.getElementById('editModalStars');
  const rating = stars ? Number(stars.dataset.rating) : 0;
  const errEl  = document.getElementById('editReviewError');

  if (!rating) {
    errEl.textContent = '⚠ Please select a star rating first.';
    errEl.style.display = '';
    return;
  }

  const btn = document.getElementById('editReviewSubmitBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    await api.put(`/api/reviews/${encodeURIComponent(_editReviewItunesId)}`, {
      rating,
      reviewText: _editReviewMode === 'written' ? document.getElementById('editReviewText').value.trim() : '',
      dspUrl: document.getElementById('editDspUrl').value.trim() || '',
    });
    closeEditReviewModal();
    showToast('Review updated! 🎵');
    if (typeof loadAlbumReviews === 'function') loadAlbumReviews();
    if (typeof loadProfileReviews === 'function') loadProfileReviews(_profileUser?.username || auth.getUser()?.username || '');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = '';
  } finally {
    btn.disabled = false; btn.textContent = 'Save Changes';
  }
}

async function deleteReview(itunesId) {
  if (!confirm('Delete this review? This cannot be undone.')) return;
  try {
    await api.delete(`/api/reviews/${encodeURIComponent(itunesId)}`);
    showToast('Review deleted.');
    if (typeof loadAlbumReviews === 'function') loadAlbumReviews();
    if (typeof loadProfileReviews === 'function') loadProfileReviews(_profileUser?.username || auth.getUser()?.username || '');
  } catch (err) {
    showToast('Error: ' + err.message);
  }
}

// ── Toast ───────────────────────────────────────────────────
function showToast(msg) {
  let t = document.getElementById('sbToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'sbToast';
    t.style.cssText = `
      position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(20px);
      background:var(--bg-raised);border:1px solid var(--border-md);border-radius:40px;
      padding:10px 22px;font-size:.875rem;font-weight:600;color:var(--text);
      box-shadow:0 4px 24px rgba(0,0,0,.5);z-index:999;opacity:0;
      transition:opacity .25s,transform .25s;pointer-events:none;white-space:nowrap;
    `;
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity   = '1';
  t.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.style.opacity   = '0';
    t.style.transform = 'translateX(-50%) translateY(10px)';
  }, 2800);
}

// ── Search ─────────────────────────────────────────────────
let _searchTimeout;
function makeSearchDropdown(id, parentEl) {
  let dropdown = document.getElementById(id);
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = id;
    dropdown.style.cssText = 'position:absolute;top:calc(100% + 6px);left:0;right:0;background:var(--bg-card);border:1px solid var(--border-md);border-radius:var(--radius-lg);box-shadow:var(--shadow-hover);z-index:300;display:none;overflow:hidden;max-height:360px;overflow-y:auto;';
    parentEl.style.position = 'relative';
    parentEl.appendChild(dropdown);
  }
  return dropdown;
}

function wireSearchInput(input, dropdown) {
  input.addEventListener('input', () => {
    clearTimeout(_searchTimeout);
    const q = input.value.trim();
    if (!q) { dropdown.style.display = 'none'; return; }
    _searchTimeout = setTimeout(() => runSearch(q, dropdown), 300);
  });
  document.addEventListener('click', (e) => {
    if (!input.parentElement.contains(e.target)) dropdown.style.display = 'none';
  });
}

function initSearch() {
  // Desktop nav search
  const desktopInput = document.getElementById('searchInput');
  if (desktopInput) {
    const dropdown = makeSearchDropdown('searchDropdown', desktopInput.parentElement);
    wireSearchInput(desktopInput, dropdown);
  }

  // Mobile search bar (index.html only — may not exist on other pages)
  const mobileInput = document.getElementById('mobileSearchInput');
  if (mobileInput) {
    const dropdown = makeSearchDropdown('mobileSearchDropdown', mobileInput.parentElement);
    wireSearchInput(mobileInput, dropdown);
  }
}

async function runSearch(q, dropdown) {
  dropdown.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:.875rem">Searching…</div>`;
  dropdown.style.display = '';
  try {
    const results = await api.get(`/api/music/search?q=${encodeURIComponent(q)}&type=album&limit=8`);
    if (!results.length) {
      dropdown.innerHTML = `
        <div style="padding:14px 16px">
          <div style="font-size:.875rem;color:var(--text-muted);margin-bottom:10px">No albums found for "<strong style="color:var(--text)">${escHtml(q)}</strong>"</div>
          <button class="btn btn--ghost btn--sm" onclick="openDspModal();document.getElementById('searchDropdown').style.display='none'">
            Import via streaming link instead
          </button>
        </div>`;
      return;
    }
    dropdown.innerHTML = results.map(a => `
      <div onclick="location.href='album.html?id=${encodeURIComponent(a.itunesId)}'"
        style="display:flex;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;transition:background .15s"
        onmouseenter="this.style.background='var(--bg-raised)'" onmouseleave="this.style.background=''">
        <img src="${escHtml(a.artwork)}" alt="" style="width:42px;height:42px;border-radius:6px;object-fit:cover;flex-shrink:0;background:var(--bg-raised)">
        <div style="flex:1;min-width:0">
          <div style="font-size:.875rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(a.title)}</div>
          <div style="font-size:.78rem;color:var(--text-muted)">${escHtml(a.artist)} · ${a.year || ''}</div>
        </div>
        <span class="tag" style="font-size:.65rem;flex-shrink:0">${escHtml(a.mediaType || 'Album')}</span>
      </div>`).join('') +
      `<div style="padding:10px 14px;border-top:1px solid var(--border)">
        <button class="btn btn--ghost btn--sm" style="font-size:.75rem" onclick="openDspModal();document.getElementById('searchDropdown').style.display='none'">
          + Add via streaming link
        </button>
      </div>`;
  } catch {
    dropdown.innerHTML = `<div style="padding:14px;color:var(--text-muted);font-size:.875rem">Search unavailable — is the server running?</div>`;
  }
}

// ── Song Review Modal ───────────────────────────────────────
let _songSearchTimeout;

function injectSongReviewModal() {
  if (document.getElementById('songReviewModal')) return;
  const el = document.createElement('div');
  el.id = 'songReviewModal';
  el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div>
          <div class="text-xs muted" style="text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:4px">Review a Song</div>
          <h3 style="font-family:'Playfair Display',serif;font-size:1.3rem">Find a Song</h3>
        </div>
        <button class="modal__close" onclick="closeSongReviewModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div style="position:relative;margin-bottom:8px">
        <svg style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-dim);pointer-events:none" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="songSearchInput" type="text" placeholder="Search for a song…" autocomplete="off"
          style="width:100%;background:var(--bg-raised);border:1px solid var(--border);border-radius:40px;padding:10px 16px 10px 38px;color:var(--text);font-size:.875rem;outline:none;transition:var(--transition)"
          onfocus="this.style.borderColor='var(--gold)'" onblur="this.style.borderColor=''">
      </div>
      <div id="songSearchResults" style="max-height:320px;overflow-y:auto"></div>
    </div>
  `;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el) closeSongReviewModal(); });

  document.getElementById('songSearchInput').addEventListener('input', e => {
    clearTimeout(_songSearchTimeout);
    const q = e.target.value.trim();
    const results = document.getElementById('songSearchResults');
    if (!q) { results.innerHTML = ''; return; }
    results.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:.875rem">Searching…</div>';
    _songSearchTimeout = setTimeout(async () => {
      try {
        const tracks = await api.get(`/api/music/search?q=${encodeURIComponent(q)}&type=track&limit=10`);
        if (!tracks.length) { results.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:.875rem">No songs found.</div>'; return; }
        results.innerHTML = tracks.map(t => `
          <div onclick='selectSongToReview(${JSON.stringify(t).replace(/'/g,"&#39;")})'
            style="display:flex;align-items:center;gap:12px;padding:10px 4px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .15s"
            onmouseenter="this.style.background='var(--bg-raised)'" onmouseleave="this.style.background=''">
            <img src="${escHtml(t.artwork)}" style="width:44px;height:44px;border-radius:6px;object-fit:cover;flex-shrink:0;background:var(--bg-raised)" alt="">
            <div style="flex:1;min-width:0">
              <div style="font-size:.875rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.title)}</div>
              <div style="font-size:.78rem;color:var(--text-muted)">${escHtml(t.artist)} · ${escHtml(t.album || '')}${t.year ? ' · ' + t.year : ''}</div>
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2.5" style="flex-shrink:0"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          </div>`).join('');
      } catch {
        results.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:.875rem">Search failed — is the server running?</div>';
      }
    }, 300);
  });
}

function openSongReviewModal() {
  if (!auth.isLoggedIn()) { openAuthModal('login'); return; }
  injectSongReviewModal();
  document.getElementById('songSearchInput').value = '';
  document.getElementById('songSearchResults').innerHTML = '';
  document.getElementById('songReviewModal').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('songSearchInput').focus(), 50);
}

function closeSongReviewModal() {
  document.getElementById('songReviewModal')?.classList.remove('open');
  document.body.style.overflow = '';
}

function selectSongToReview(track) {
  closeSongReviewModal();
  // Convert track to album-style object for the review modal
  openReviewModal({
    itunesId:  track.itunesId,
    title:     track.title,
    artist:    track.artist,
    artwork:   track.artwork,
    year:      track.year,
    genre:     track.genre || '',
    mediaType: 'Song',
    itunesUrl: track.itunesUrl || '',
  });
}

// ── Nav injection ───────────────────────────────────────────
function injectNav() {
  const nav = document.querySelector('.nav__actions');
  if (!nav) return;
  nav.innerHTML = `
    <a href="#" id="navSignIn" class="btn btn--ghost btn--sm" onclick="event.preventDefault();openAuthModal('login')">Sign In</a>
    <a href="#" id="navJoin"   class="btn btn--gold btn--sm"  onclick="event.preventDefault();openAuthModal('register')">Join Free</a>
    <div id="navProfile" style="display:none;align-items:center;gap:8px">
      <a href="#" id="navProfileLink" class="nav-profile-btn" style="display:flex;align-items:center;gap:8px;text-decoration:none">
        <div class="avatar nav-avatar" style="width:32px;height:32px;font-size:.75rem"></div>
        <span class="nav-username text-sm" style="font-weight:600"></span>
      </a>
      <button class="btn btn--ghost btn--sm" onclick="logoutUser()">Sign Out</button>
    </div>
  `;
  // Update profile link href when user is known
  const user = auth.getUser();
  if (user) {
    const link = document.getElementById('navProfileLink');
    if (link) link.href = `profile.html?u=${encodeURIComponent(user.username)}`;
  }
  auth.updateNav();
}

// ── Mobile Nav & View Toggle ────────────────────────────────

function injectMobileUI() {
  // 1. Inject hamburger button into nav
  const navInner = document.querySelector('.nav__inner');
  if (navInner && !document.querySelector('.nav__hamburger')) {
    const burger = document.createElement('button');
    burger.className = 'nav__hamburger';
    burger.setAttribute('aria-label', 'Open menu');
    burger.innerHTML = '<span></span><span></span><span></span>';
    burger.addEventListener('click', toggleDrawer);
    navInner.appendChild(burger);
  }

  // 2. Inject slide-in drawer
  if (!document.getElementById('navDrawer')) {
    const page  = window.location.pathname.split('/').pop() || 'index.html';
    const user  = auth.getUser();
    const drawerEl = document.createElement('div');
    drawerEl.className = 'nav__drawer';
    drawerEl.id = 'navDrawer';
    drawerEl.innerHTML = `
      <div class="nav__drawer__backdrop" onclick="closeDrawer()"></div>
      <div class="nav__drawer__panel">
        <button class="nav__drawer__close" onclick="closeDrawer()">✕</button>
        <a href="index.html" class="nav__drawer__logo">Sound<span>bagd</span></a>
        <ul class="nav__drawer__links" id="drawerLinks">
          <li><a href="index.html"     ${page==='index.html'     ? 'class="active"':''}>🎵 Explore</a></li>
          <li><a href="community.html" ${page==='community.html' ? 'class="active"':''}>👥 Community</a></li>
          <li><a href="ratings.html"   ${page==='ratings.html'   ? 'class="active"':''}>⭐ Ratings</a></li>
          ${user ? `<li><a href="profile.html?u=${encodeURIComponent(user.username)}" ${page==='profile.html' ? 'class="active"':''}>👤 My Profile</a></li>` : ''}
          ${user?.role === 'admin' || user?.role === 'mod' ? `<li><a href="admin.html" ${page==='admin.html' ? 'class="active"':''} style="color:var(--gold)">🛡️ Admin</a></li>` : ''}
        </ul>
        <hr class="nav__drawer__divider">
        <ul class="nav__drawer__links" style="margin-bottom:0">
          <li><a href="#" onclick="event.preventDefault();closeDrawer();openDspModal()">🔗 Import Music</a></li>
          <li><a href="#" onclick="event.preventDefault();closeDrawer();openSongReviewModal()">🎤 Review a Song</a></li>
        </ul>
        <hr class="nav__drawer__divider">
        ${user ? `
          <div class="nav__drawer__user">
            <div class="avatar" style="width:36px;height:36px;font-size:.8rem;background:${user.gradient||'linear-gradient(135deg,#d4af37,#7c5cbf)'}">${user.initials||'?'}</div>
            <div>
              <div style="font-weight:700;font-size:.875rem">@${escHtml(user.username)}</div>
              <button onclick="logoutUser()" style="font-size:.75rem;color:var(--text-muted);background:none;border:none;cursor:pointer;padding:0">Sign Out</button>
            </div>
          </div>` : `
          <div style="display:flex;flex-direction:column;gap:8px">
            <button onclick="openAuthModal('login');closeDrawer()" class="btn btn--ghost" style="justify-content:center">Sign In</button>
            <button onclick="openAuthModal('register');closeDrawer()" class="btn btn--gold" style="justify-content:center">Join Free</button>
          </div>`}
      </div>
    `;
    document.body.appendChild(drawerEl);
  }

  // 3. Inject bottom tab bar
  if (!document.getElementById('mobileTabs')) {
    const page = window.location.pathname.split('/').pop() || 'index.html';
    const user = auth.getUser();
    const tabs = document.createElement('nav');
    tabs.className = 'mobile-tabs';
    tabs.id = 'mobileTabs';
    tabs.innerHTML = `
      <div class="mobile-tabs__inner">
        <a href="index.html" class="mobile-tab ${page==='index.html'?'active':''}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9,22 9,12 15,12 15,22"/></svg>
          Explore
        </a>
        <a href="community.html" class="mobile-tab ${page==='community.html'?'active':''}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          Community
        </a>
        <a href="ratings.html" class="mobile-tab ${page==='ratings.html'?'active':''}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          Ratings
        </a>
        <a href="${user ? `profile.html?u=${encodeURIComponent(user.username)}` : '#'}"
           class="mobile-tab ${page==='profile.html'?'active':''}"
           onclick="${user ? '' : "event.preventDefault();openAuthModal('login')"}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          ${user ? 'Profile' : 'Sign In'}
        </a>
      </div>
    `;
    document.body.appendChild(tabs);
  }

  // 4. Inject view toggle button
  if (!document.getElementById('viewToggle')) {
    const toggle = document.createElement('button');
    toggle.id = 'viewToggle';
    toggle.addEventListener('click', toggleViewMode);
    document.body.appendChild(toggle);
    updateToggleLabel();
  }
}

function toggleDrawer() {
  const drawer  = document.getElementById('navDrawer');
  const burger  = document.querySelector('.nav__hamburger');
  if (!drawer) return;
  drawer.classList.toggle('open');
  burger?.classList.toggle('open');
  document.body.style.overflow = drawer.classList.contains('open') ? 'hidden' : '';
}
function closeDrawer() {
  const drawer = document.getElementById('navDrawer');
  const burger = document.querySelector('.nav__hamburger');
  drawer?.classList.remove('open');
  burger?.classList.remove('open');
  document.body.style.overflow = '';
}

// ── View mode: 'auto' | 'mobile' | 'desktop' ────────────────
function getViewMode() {
  return localStorage.getItem('sb_view') || 'auto';
}

function applyViewMode(mode) {
  localStorage.setItem('sb_view', mode);
  document.body.classList.remove('mobile-view', 'force-desktop');
  document.documentElement.classList.remove('mobile-view-html');
  if (mode === 'mobile') {
    document.body.classList.add('mobile-view');
    document.documentElement.classList.add('mobile-view-html'); // lets CSS target <html> too
    document.querySelector('meta[name=viewport]').content = 'width=device-width, initial-scale=1.0';
  } else if (mode === 'desktop') {
    document.body.classList.add('force-desktop');
    document.querySelector('meta[name=viewport]').content = 'width=1200, initial-scale=0.4, minimum-scale=0.1, maximum-scale=5';
  } else {
    // auto — let media queries decide
    document.querySelector('meta[name=viewport]').content = 'width=device-width, initial-scale=1.0';
  }
  updateToggleLabel();
  document.dispatchEvent(new Event('viewModeChanged'));
}

function toggleViewMode() {
  const current = getViewMode();
  const isMobileScreen = window.innerWidth <= 768;
  // Cycle: auto → forced opposite → auto
  if (current === 'auto') {
    applyViewMode(isMobileScreen ? 'desktop' : 'mobile');
  } else {
    applyViewMode('auto');
  }
}

function updateToggleLabel() {
  const btn  = document.getElementById('viewToggle');
  if (!btn) return;
  const mode = getViewMode();
  const isMobileScreen = window.innerWidth <= 768;
  if (mode === 'desktop') {
    btn.innerHTML = '📱 Switch to Mobile View';
  } else if (mode === 'mobile') {
    btn.innerHTML = '🖥️ Switch to Desktop View';
  } else {
    // auto — show what switching WOULD do
    btn.innerHTML = isMobileScreen ? '🖥️ Desktop View' : '📱 Mobile View';
  }
}

// ── Keyboard shortcuts ──────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.open').forEach(m => {
      m.classList.remove('open');
      document.body.style.overflow = '';
    });
  }
});

// ── Init on load ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Apply saved view preference before anything renders
  const savedMode = localStorage.getItem('sb_view');
  if (savedMode && savedMode !== 'auto') applyViewMode(savedMode);

  injectNav();
  injectMobileUI();
  initSearch();
  if (typeof initPage === 'function') initPage();
});

// ── PWA: Register Service Worker ──────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        // Check for updates in background
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // New version available — show a subtle toast
              showToast('App updated! Refresh for the latest version. 🎵');
            }
          });
        });
      })
      .catch(err => console.warn('SW registration failed:', err));
  });
}
