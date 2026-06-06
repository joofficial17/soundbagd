/* ============================================================
   SOUNDBAGD — Main JavaScript
   ============================================================ */

/* ── State ────────────────────────────────────────────────── */
let currentRating = 0;
let reviewMode = 'star'; // 'star' | 'written'

/* ── Rating Labels ────────────────────────────────────────── */
const ratingLabels = {
  0.5: 'Dreadful',
  1:   'Very Poor',
  1.5: 'Poor',
  2:   'Weak',
  2.5: 'Below Average',
  3:   'Average',
  3.5: 'Decent',
  4:   'Good',
  4.5: 'Excellent',
  5:   'Masterpiece ✨'
};

/* ── Build a Static Stars Display ─────────────────────────── */
function buildStarsDisplay(containerId, rating, sizeClass = '') {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement('span');
    if (rating >= i) {
      star.textContent = '★';
      star.style.color = 'var(--gold)';
    } else if (rating >= i - 0.5) {
      // Half star using gradient trick
      star.innerHTML = '<span style="background:linear-gradient(to right,var(--gold) 50%,var(--text-dim) 50%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">★</span>';
    } else {
      star.textContent = '★';
      star.style.color = 'var(--text-dim)';
    }
    star.style.fontSize = sizeClass === 'star--lg' ? '26px' : sizeClass === 'star--sm' ? '13px' : '18px';
    star.style.lineHeight = '1';
    container.appendChild(star);
  }
}

/* ── Build Interactive Stars ──────────────────────────────── */
function buildInteractiveStars(containerId, initialRating = 0, sizeClass = '') {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  for (let i = 1; i <= 5; i++) {
    const starEl = document.createElement('div');
    starEl.className = 'star-interactive';
    starEl.style.cssText = `
      position: relative;
      display: inline-block;
      font-size: ${sizeClass === 'star--lg' ? '36px' : '22px'};
      cursor: pointer;
      line-height: 1;
      transition: transform 0.1s;
    `;
    starEl.dataset.index = i;

    const leftHalf = document.createElement('span');
    leftHalf.style.cssText = 'position:absolute;left:0;top:0;width:50%;height:100%;overflow:hidden;';
    leftHalf.dataset.value = i - 0.5;

    const rightHalf = document.createElement('span');
    rightHalf.style.cssText = 'position:absolute;right:0;top:0;width:50%;height:100%;overflow:hidden;display:flex;justify-content:flex-end;';
    rightHalf.dataset.value = i;

    starEl.textContent = '★';
    starEl.style.color = 'var(--text-dim)';
    starEl.appendChild(leftHalf);
    starEl.appendChild(rightHalf);

    // Events
    leftHalf.addEventListener('mousemove', (e) => hoverStars(containerId, i - 0.5));
    rightHalf.addEventListener('mousemove', (e) => hoverStars(containerId, i));
    leftHalf.addEventListener('click', () => selectRating(containerId, i - 0.5));
    rightHalf.addEventListener('click', () => selectRating(containerId, i));

    container.appendChild(starEl);
  }

  container.addEventListener('mouseleave', () => {
    renderStars(containerId, currentRating);
  });

  renderStars(containerId, initialRating);
}

function hoverStars(containerId, value) {
  renderStars(containerId, value, true);
  updateRatingLabel(value);
}

function selectRating(containerId, value) {
  currentRating = value;
  renderStars(containerId, value);
  updateRatingLabel(value);
}

function renderStars(containerId, value, isHover = false) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const stars = container.querySelectorAll('.star-interactive');
  stars.forEach((star, idx) => {
    const starNum = idx + 1;
    if (value >= starNum) {
      star.style.color = 'var(--gold)';
      star.style.textShadow = isHover ? '0 0 8px rgba(212,175,55,0.6)' : 'none';
      star.style.transform = isHover ? 'scale(1.15)' : 'scale(1)';
    } else if (value >= starNum - 0.5) {
      // Half star
      star.style.background = 'linear-gradient(to right, var(--gold) 50%, var(--text-dim) 50%)';
      star.style.webkitBackgroundClip = 'text';
      star.style.webkitTextFillColor = 'transparent';
      star.style.backgroundClip = 'text';
      star.style.transform = isHover ? 'scale(1.15)' : 'scale(1)';
    } else {
      star.style.color = 'var(--text-dim)';
      star.style.background = 'none';
      star.style.webkitBackgroundClip = 'unset';
      star.style.webkitTextFillColor = 'unset';
      star.style.backgroundClip = 'unset';
      star.style.textShadow = 'none';
      star.style.transform = 'scale(1)';
    }
  });
}

function updateRatingLabel(value) {
  const el = document.getElementById('ratingLabel');
  if (el) {
    el.textContent = value ? `${value} — ${ratingLabels[value] || ''}` : 'Click to rate';
    el.style.color = value ? 'var(--gold)' : 'var(--text-muted)';
  }
}

/* ── Review Modal ─────────────────────────────────────────── */
function openReviewModal() {
  const modal = document.getElementById('reviewModal');
  if (!modal) return;
  currentRating = 0;
  buildInteractiveStars('modalStars', 0, 'star--lg');
  updateRatingLabel(0);
  setReviewMode('star');
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeReviewModal() {
  const modal = document.getElementById('reviewModal');
  if (!modal) return;
  modal.classList.remove('open');
  document.body.style.overflow = '';
}

function setReviewMode(mode) {
  reviewMode = mode;
  const written = document.getElementById('writtenSection');
  const btnStar = document.getElementById('toggleStarOnly');
  const btnWritten = document.getElementById('toggleWritten');
  if (!written) return;

  if (mode === 'written') {
    written.style.display = 'block';
    btnStar && btnStar.classList.remove('active');
    btnWritten && btnWritten.classList.add('active');
  } else {
    written.style.display = 'none';
    btnStar && btnStar.classList.add('active');
    btnWritten && btnWritten.classList.remove('active');
  }
}

function submitReview() {
  if (!currentRating) {
    // Shake the stars
    const stars = document.getElementById('modalStars');
    if (stars) {
      stars.style.animation = 'none';
      stars.style.transform = 'translateX(-6px)';
      setTimeout(() => stars.style.transform = 'translateX(6px)', 80);
      setTimeout(() => stars.style.transform = 'translateX(-4px)', 160);
      setTimeout(() => stars.style.transform = 'translateX(4px)', 240);
      setTimeout(() => stars.style.transform = 'translateX(0)', 320);
    }
    updateRatingLabel(0);
    const label = document.getElementById('ratingLabel');
    if (label) {
      label.textContent = '⚠ Please select a rating first';
      label.style.color = 'var(--coral)';
    }
    return;
  }

  const text = document.getElementById('reviewText')?.value || '';
  const hasText = reviewMode === 'written' && text.trim().length > 0;

  // Build a new review card and inject it
  const feed = document.getElementById('albumReviews');
  if (feed) {
    const card = document.createElement('div');
    card.className = 'review-card fade-up';
    card.style.borderColor = 'var(--gold)';
    card.innerHTML = `
      <div class="review-card__user" style="margin-bottom:8px;">
        <div class="avatar" style="width:36px;height:36px;font-size:0.8rem;background:linear-gradient(135deg,#d4af37,#ff6b6b)">You</div>
        <div>
          <div class="review-card__username">marcjordan</div>
          <div class="review-card__date">Just now</div>
        </div>
        <div style="margin-left:auto;">
          <div class="rating-badge">${'★'.repeat(Math.floor(currentRating))}${currentRating % 1 === 0.5 ? '½' : ''} &nbsp;${currentRating}</div>
        </div>
      </div>
      ${hasText ? `<p class="review-card__text" style="-webkit-line-clamp:unset;display:block;">${escapeHtml(text)}</p>` : '<p class="text-xs muted" style="font-style:italic;">Rated without a written review</p>'}
      <div style="display:flex;gap:12px;margin-top:12px;">
        <span class="text-xs" style="color:var(--gold);">✓ Review submitted!</span>
      </div>
    `;
    // Insert at the top (after the prompt)
    const prompt = feed.querySelector('[onclick="openReviewModal()"]') || feed.firstChild;
    feed.insertBefore(card, feed.firstChild);
    setTimeout(() => { card.style.borderColor = ''; }, 3000);
  }

  closeReviewModal();
}

/* ── Char Counter ─────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const textarea = document.getElementById('reviewText');
  const counter = document.getElementById('charCount');
  if (textarea && counter) {
    textarea.addEventListener('input', () => {
      const len = textarea.value.length;
      counter.textContent = `${len} / 2000`;
      if (len > 1800) counter.style.color = 'var(--coral)';
      else counter.style.color = 'var(--text-muted)';
      if (len > 2000) textarea.value = textarea.value.slice(0, 2000);
    });
  }

  // Close modals on backdrop click
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        backdrop.classList.remove('open');
        document.body.style.overflow = '';
      }
    });
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop.open').forEach(m => {
        m.classList.remove('open');
        document.body.style.overflow = '';
      });
    }
  });

  // Search input effect
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && searchInput.value.trim()) {
        // Visual feedback
        searchInput.style.borderColor = 'var(--gold)';
        setTimeout(() => searchInput.style.borderColor = '', 1500);
      }
    });
  }

  // Smooth scroll animations on scroll
  const observerOptions = { threshold: 0.1, rootMargin: '0px 0px -40px 0px' };
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, observerOptions);

  document.querySelectorAll('.review-card, .album-card, .top5-item').forEach(el => {
    el.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    observer.observe(el);
  });
});

/* ── Helpers ──────────────────────────────────────────────── */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

/* ── Responsive: collapse sidebar grid on mobile ──────────── */
function adjustLayouts() {
  const mainGrid = document.querySelector('.main-grid');
  const albumGrid = document.querySelector('.album-main-grid');
  const profileGrid = document.querySelector('[style*="grid-template-columns:1fr 320px"]');

  const isMobile = window.innerWidth < 900;

  [mainGrid, albumGrid].forEach(grid => {
    if (grid) {
      grid.style.gridTemplateColumns = isMobile ? '1fr' : '';
    }
  });
}

window.addEventListener('resize', adjustLayouts);
adjustLayouts();
