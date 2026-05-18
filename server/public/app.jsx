const { useState, useEffect, useCallback, useRef, useMemo } = React;

// Apply persisted theme as early as possible so first paint is correct.
(function applyInitialTheme() {
  try {
    const saved = localStorage.getItem('pm:theme');
    const theme = saved === 'light' || saved === 'dark' ? saved : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (_) { document.documentElement.setAttribute('data-theme', 'dark'); }
})();

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('pm:theme', theme); } catch (_) {}
  window.dispatchEvent(new CustomEvent('pm:theme-change', { detail: theme }));
}
function getTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

function ThemeToggle() {
  const [theme, setT] = useState(getTheme());
  useEffect(() => {
    const h = (e) => setT(e.detail);
    window.addEventListener('pm:theme-change', h);
    return () => window.removeEventListener('pm:theme-change', h);
  }, []);
  const choose = (t) => { setTheme(t); setT(t); };
  return (
    <div className="theme-toggle" role="tablist" aria-label="Theme">
      <button type="button" role="tab" aria-selected={theme==='dark'} className={theme==='dark' ? 'active' : ''} onClick={() => choose('dark')}>
        <Icon name="moon" size={14} /> Dark
      </button>
      <button type="button" role="tab" aria-selected={theme==='light'} className={theme==='light' ? 'active' : ''} onClick={() => choose('light')}>
        <Icon name="sun" size={14} /> Light
      </button>
    </div>
  );
}

const api = {
  get: (p) => fetch('/api' + p).then(r => { if (!r.ok) throw new Error('API ' + r.status + ' ' + p); return r.json(); }).catch(e => { console.error('API GET error:', p, e); throw e; }),
  post: (p, b) => fetch('/api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()),
  put: (p, b) => fetch('/api' + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()),
  del: (p) => fetch('/api' + p, { method: 'DELETE' }).then(r => r.json()),
};

const PAGES = ['Dashboard', 'Trends', 'Report', 'Feed', 'Releases', 'Matrix', 'Gaps', 'SPOC', 'Settings'];
// URL routing: page name <-> URL slug. Each top-level page gets its own pretty URL.
const PAGE_SLUGS = {
  Dashboard: 'dashboard', Trends: 'trends', Report: 'report', Feed: 'feed',
  Releases: 'releases', Matrix: 'matrix', Gaps: 'gaps', SPOC: 'spoc', Settings: 'settings',
};
const SLUG_TO_PAGE = Object.fromEntries(Object.entries(PAGE_SLUGS).map(([k, v]) => [v, k]));
const pageFromPath = () => {
  const seg = (window.location.pathname || '/').replace(/^\/+/, '').split('/')[0].toLowerCase();
  return SLUG_TO_PAGE[seg] || 'Dashboard';
};
const subFromPath = () => {
  const parts = (window.location.pathname || '/').replace(/^\/+/, '').split('/').filter(Boolean);
  return (parts[1] || '').toLowerCase();
};
// Hook: read 2nd path segment as sub-tab id and keep URL in sync when it changes.
// Usage:  const [tab, setTab] = useSubRoute('settings', ['ai','scheduler',...], 'ai');
function useSubRoute(parentSlug, validIds, defaultId) {
  const pick = () => {
    const s = subFromPath();
    return validIds.includes(s) ? s : defaultId;
  };
  const [tab, setTabState] = useState(pick);
  // React to back/forward and to top-level navigate() pushes.
  useEffect(() => {
    const onPop = () => setTabState(pick());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // If we landed on /<parent> with no sub, normalise URL to /<parent>/<tab>.
  useEffect(() => {
    const cur = window.location.pathname.replace(/\/+$/, '');
    const want = '/' + parentSlug + '/' + tab;
    if (cur === '/' + parentSlug) {
      window.history.replaceState({ page: parentSlug, sub: tab }, '', want);
    } else if (cur !== want && cur.startsWith('/' + parentSlug + '/')) {
      // sub changed via setTab
      window.history.replaceState({ page: parentSlug, sub: tab }, '', want);
    }
  }, [tab]);
  const setTab = (next) => {
    if (!validIds.includes(next)) return;
    setTabState(next);
    const want = '/' + parentSlug + '/' + next;
    if (window.location.pathname !== want) window.history.pushState({ page: parentSlug, sub: next }, '', want);
    window.scrollTo(0, 0);
  };
  return [tab, setTab];
}

// === Icon system: Lucide-style SVGs, all stroke-based, currentColor =========
const ICONS = {
  dashboard:  'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  trends:     'M3 17l6-6 4 4 8-8 M14 7h7v7',
  report:     'M4 4h16v16H4z M4 9h16 M9 4v16',
  catalog:    'M4 4h12a4 4 0 014 4v12H8a4 4 0 01-4-4V4z M4 4v14a2 2 0 002 2h2',
  feed:       'M5 19a14 14 0 0114-14 M5 13a8 8 0 018 8 M6 19a1 1 0 100-2 1 1 0 000 2z',
  analysts:   'M3 21h18 M5 21V9l7-5 7 5v12 M9 21v-6h6v6',
  releases:   'M4 13c0-7 8-10 8-10s8 3 8 10c0 4-2 7-4 7H8c-2 0-4-3-4-7z M9 21l3-3 3 3 M12 10a1 1 0 100-2 1 1 0 000 2z',
  matrix:     'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  gaps:       'M12 2v4 M12 18v4 M2 12h4 M18 12h4 M5 5l3 3 M16 16l3 3 M5 19l3-3 M16 8l3-3',
  settings:   'M12 8a4 4 0 100 8 4 4 0 000-8z M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3.8a7 7 0 00-2.1-1.2L14 3h-4l-.5 2.5a7 7 0 00-2.1 1.2L5.1 5.9l-2 3.4 2 1.5A7 7 0 005 12a7 7 0 00.1 1.2l-2 1.5 2 3.4 2.3-.8a7 7 0 002.1 1.2L10 21h4l.5-2.5a7 7 0 002.1-1.2l2.3.8 2-3.4-2-1.5c.05-.4.1-.8.1-1.2z',
  edit:       'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z M20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  refresh:    'M21 12a9 9 0 11-3-6.7L21 8 M21 3v5h-5',
  send:       'M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z',
  close:      'M18 6L6 18 M6 6l12 12',
  bot:        'M12 8V4 M9 4h6 M6 8h12a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2z M9 13h.01 M15 13h.01 M9 17h6',
  sun:        'M12 2v2 M12 20v2 M4.93 4.93l1.41 1.41 M17.66 17.66l1.41 1.41 M2 12h2 M20 12h2 M4.93 19.07l1.41-1.41 M17.66 6.34l1.41-1.41 M12 8a4 4 0 100 8 4 4 0 000-8z',
  moon:       'M21 13A9 9 0 1111 3a7 7 0 0010 10z',
  check:      'M20 6L9 17l-5-5',
  alert:      'M12 9v4 M12 17h.01 M10.3 3.86l-8.18 14.18A2 2 0 003.85 21h16.3a2 2 0 001.73-2.96L13.71 3.86a2 2 0 00-3.42 0z',
  arrowUp:    'M12 19V5 M5 12l7-7 7 7',
  arrowDown:  'M12 5v14 M19 12l-7 7-7-7',
  chevDown:   'M6 9l6 6 6-6',
  chevUp:     'M18 15l-6-6-6 6',
  chevLeft:   'M15 18l-6-6 6-6',
  chevRight:  'M9 18l6-6-6-6',
  calendar:   'M19 4H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2z M16 2v4 M8 2v4 M3 10h18',
  key:        'M21 2l-2 2 M15 7l4-4 M11.5 11.5a4 4 0 11-5.66 5.66 4 4 0 015.66-5.66z M14 9l3 3',
  shield:     'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  sparkles:   'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z M19 14l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z',
  clock:      'M12 22a10 10 0 100-20 10 10 0 000 20z M12 6v6l4 2',
  trash:      'M3 6h18 M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6 M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2 M10 11v6 M14 11v6',
  eye:        'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 100 6 3 3 0 000-6z',
  fileText:   'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M9 13h6 M9 17h6 M9 9h2',
  external:   'M15 3h6v6 M10 14L21 3 M21 14v5a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h5',
  download:   'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  package:    'M21 16V8a2 2 0 00-1-1.7l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.7l7 4a2 2 0 002 0l7-4a2 2 0 001-1.7z M3.27 6.96L12 12.01l8.73-5.05 M12 22.08V12',
  layers:     'M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5',
  target:     'M12 22a10 10 0 100-20 10 10 0 000 20z M12 18a6 6 0 100-12 6 6 0 000 12z M12 14a2 2 0 100-4 2 2 0 000 4z',
  zap:        'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  users:      'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75',
  rocket:     'M4.5 16.5L3 19l5-1.5 M5 14l5 5 M16 3a13 13 0 00-9.27 8.27L4 14l6 6 2.73-2.73A13 13 0 0021 8l-2-2-3-3z M16 8a2 2 0 11-4 0 2 2 0 014 0z',
  search:     'M11 19a8 8 0 100-16 8 8 0 000 16z M21 21l-4.35-4.35',
};

function Icon({ name, size = 16, className = '', strokeWidth = 2, ...rest }) {
  const d = ICONS[name];
  if (!d) return null;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size} height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`icon ${className}`}
      aria-hidden="true"
      {...rest}
    >
      {d.split(' M').map((seg, i) => <path key={i} d={(i === 0 ? '' : 'M') + seg} />)}
    </svg>
  );
}

const PAGE_ICONS = {
  Dashboard:  'dashboard',
  Trends:     'trends',
  Report:     'report',
  Catalog:    'catalog',
  Feed:       'feed',
  Analysts:   'analysts',
  News:       'feed',
  Releases:   'releases',
  Matrix:     'matrix',
  Gaps:       'gaps',
  SPOC:       'analysts',
  Settings:   'settings',
};

// Hook: re-runs `fn` when the global Refresh button is clicked
function useRefresh(fn) {
  useEffect(() => {
    const h = () => fn();
    window.addEventListener('pm:refresh', h);
    return () => window.removeEventListener('pm:refresh', h);
  }, [fn]);
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('React Error:', error, info); }
  render() {
    if (this.state.error) return React.createElement('div', {style:{padding:20,color:'#f87171'}}, 'Error: ' + this.state.error.message);
    return this.props.children;
  }
}

function ToastHost() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    window.toast = (message, kind = 'info', ttl = 3500) => {
      const id = Date.now() + Math.random();
      setToasts(t => [...t, { id, message, kind }]);
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), ttl);
    };
  }, []);
  return (
    <div className="toast-host">
      {toasts.map(t => (
        <div key={t.id} className={'toast ' + t.kind} onClick={() => setToasts(s => s.filter(x => x.id !== t.id))}>
          <span className="toast-icon">{t.kind === 'success' ? '✓' : t.kind === 'error' ? '⚠' : t.kind === 'warn' ? '⚠' : 'ℹ'}</span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [page, setPage] = useState(pageFromPath);
  const navigate = (p) => {
    // Accepts: a page name ('Feed'), or a path ('feed/analysts', '/settings/ai').
    let target, pageName;
    if (typeof p === 'string' && (p.startsWith('/') || p.includes('/'))) {
      target = '/' + p.replace(/^\/+/, '').replace(/\/+$/, '');
      const slug = target.replace(/^\/+/, '').split('/')[0].toLowerCase();
      pageName = SLUG_TO_PAGE[slug] || 'Dashboard';
    } else {
      if (!PAGE_SLUGS[p]) return;
      pageName = p;
      target = '/' + PAGE_SLUGS[p];
    }
    const cur = window.location.pathname.replace(/\/+$/, '');
    const hasExplicitSub = target.split('/').length > 2;
    if (cur !== target && !(cur.startsWith(target + '/') && !hasExplicitSub)) {
      window.history.pushState({ page: pageName }, '', target);
      // Fire popstate so any mounted useSubRoute hook re-reads the URL.
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    setPage(pageName);
    window.scrollTo(0, 0);
  };
  // Expose navigation globally so deep components (e.g. analysis modal) can jump tabs.
  useEffect(() => { window.pmNavigate = navigate; return () => { delete window.pmNavigate; }; }, []);
  // Browser back/forward.
  useEffect(() => {
    const onPop = () => setPage(pageFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // Normalise initial URL: if user landed on '/', rewrite to '/dashboard' (or whatever page resolved to).
  useEffect(() => {
    const slug = PAGE_SLUGS[page];
    if (slug && (window.location.pathname === '/' || window.location.pathname === '')) {
      window.history.replaceState({ page }, '', '/' + slug);
    }
  }, []);

  // Bookmarklet handler. The bookmarklet (see Settings → Bookmarklet) opens
  // this page with a #paste= hash containing base64(JSON{title,url,content}).
  // We surface it as a modal at App-level so the user can pick the firm and
  // submit without losing whichever tab they were on.
  const [bookmark, setBookmark] = useState(null);
  const [analystFirms, setAnalystFirms] = useState([]);
  useEffect(() => {
    const readHash = () => {
      const h = window.location.hash || '';
      const m = h.match(/paste=([^&]+)/);
      if (!m) return;
      try {
        const json = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
        setBookmark({
          title: json.title || '',
          url: json.url || '',
          content: json.content || '',
          product_id: '',
        });
        // clear hash so a refresh doesn't re-open
        history.replaceState(null, '', window.location.pathname + window.location.search);
        // load firms list (we need analyst firms to choose from)
        api.get('/products')
          .then(rows => setAnalystFirms(rows.filter(p => (p.kind || 'product') === 'analyst')))
          .catch(() => {});
      } catch (e) {
        console.error('Bookmarklet decode failed', e);
        window.toast && window.toast('Invalid bookmarklet payload', 'error');
      }
    };
    readHash();
    window.addEventListener('hashchange', readHash);
    return () => window.removeEventListener('hashchange', readHash);
  }, []);
  const saveBookmark = async (form) => {
    if (!form.product_id) { window.toast('Pick a firm first', 'error'); return; }
    try {
      const r = await api.post('/ingest/manual', { ...form, auto: true });
      window.toast(`Captured · ${r.inserted ? 'analyzing' : 'already exists'}`, 'success');
      setBookmark(null);
    } catch (e) { window.toast('Save failed: ' + e.message, 'error'); }
  };

  const refresh = () => {
    window.dispatchEvent(new CustomEvent('pm:refresh'));
    if (window.toast) window.toast('Refreshing…', 'info', 1200);
  };
  return (
    <>
      <ToastHost />
      <header>
        <h1><span className="logo-dot">PM</span> Panel</h1>
        <nav className="row">
          {PAGES.map(p => (
            <a key={p} href={'/' + PAGE_SLUGS[p]} className={page === p ? 'active' : ''} onClick={e => { e.preventDefault(); navigate(p); }}>
              <Icon name={PAGE_ICONS[p]} size={15} className="nav-icon" />
              {p}
            </a>
          ))}
        </nav>
        <div style={{marginLeft:'auto'}}>
          <button className="ghost" onClick={refresh} title="Reload data on the current page"><Icon name="refresh" size={14} /> Refresh</button>
        </div>
      </header>
      <main>
        <ErrorBoundary key={page}>
          {page === 'Dashboard' && <DashboardHub />}
          {page === 'Trends' && <Trends />}
          {page === 'Report' && <Report />}
          {page === 'Feed' && <FeedHub />}
          {page === 'Releases' && <Releases />}
          {page === 'Matrix' && <Matrix />}
          {page === 'Gaps' && <Gaps />}
          {page === 'SPOC' && <Spoc />}
          {page === 'Settings' && <Settings />}
        </ErrorBoundary>
      </main>
      <ChatBot />
      <AnalyzeProgressBar />
      {bookmark && analystFirms.length > 0 && (
        <PasteForm
          value={bookmark}
          products={analystFirms}
          onSave={saveBookmark}
          onClose={() => setBookmark(null)}
        />
      )}
    </>
  );
}

// === Reusable widgets =======================================================

// DatePill — single-day filter chip used by SPOC + Feed tabs.
// `value` is a YYYY-MM-DD string (or '') and `onChange(newValue)` fires when
// the user picks/clears a date. Visual: a pill showing either "Any date" or
// the formatted date; the native picker is invisibly overlaid for input.
function DatePill({ value, onChange, placeholder = 'Any date', title = 'Filter by date' }) {
  const label = (() => {
    if (!value) return placeholder;
    const [y, m, d] = value.split('-').map(Number);
    if (!y || !m || !d) return value;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  })();
  return (
    <label className={`date-pill${value ? ' active' : ''}`} title={title}>
      <span className="dp-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
      </span>
      <span className="dp-label">{label}</span>
      <input
        type="date" value={value || ''}
        onChange={e => onChange(e.target.value)}
        aria-label={title}
      />
      {value && (
        <button
          type="button" className="dp-clear"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(''); }}
          title="Clear date" aria-label="Clear date"
        >×</button>
      )}
    </label>
  );
}

function LoadingState({ label = 'Loading…', sub = '', size = 'md', variant = 'card' }) {
  return (
    <div className={`loader loader-${size} loader-${variant}`} role="status" aria-live="polite">
      <div className="loader-orb">
        <span className="loader-ring" />
        <span className="loader-ring loader-ring-2" />
        <span className="loader-core"><Icon name="sparkles" size={size === 'sm' ? 14 : 18} /></span>
      </div>
      <div className="loader-text">
        <div className="loader-label">{label}</div>
        {sub && <div className="loader-sub">{sub}</div>}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, delta, accent = 'indigo', onClick, hint }) {
  const trend = delta == null ? null : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const isText = typeof value === 'string' && value.length > 4;
  return (
    <button type="button" className={`stat-card stat-${accent} ${onClick ? 'clickable' : ''}`} onClick={onClick} title={hint ? `${typeof value === 'string' ? value + ' — ' : ''}${hint}` : ''}>
      <div className="stat-icon"><Icon name={icon} size={18} /></div>
      <div className="stat-body">
        <div className="stat-label">{label}</div>
        <div className={`stat-value${isText ? ' text-value' : ''}`}>{value}</div>
        {hint && isText && <div className="stat-hint">{hint}</div>}
        {trend && (
          <div className={`stat-delta stat-${trend}`}>
            <Icon name={trend === 'up' ? 'arrowUp' : trend === 'down' ? 'arrowDown' : 'check'} size={12} />
            {Math.abs(delta)}{typeof delta === 'number' ? '' : ''} {hint ? '' : 'vs last'}
          </div>
        )}
      </div>
    </button>
  );
}

function Sparkline({ values = [], color = 'var(--accent)', height = 36, width = 120 }) {
  if (!values.length) return <svg width={width} height={height} />;
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = width / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${i * step},${height - ((v - min) / span) * (height - 4) - 2}`).join(' ');
  const area = `0,${height} ${pts} ${width},${height}`;
  return (
    <svg width={width} height={height} className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`sg-${color.replace(/\W/g,'')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#sg-${color.replace(/\W/g,'')})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Donut({ segments = [], size = 120, thickness = 14 }) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let off = 0;
  return (
    <div className="donut-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--panel-3)" strokeWidth={thickness} />
        {segments.map((s, i) => {
          const len = (s.value / total) * c;
          const node = (
            <circle key={i}
              cx={size/2} cy={size/2} r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-off}
              transform={`rotate(-90 ${size/2} ${size/2})`}
              strokeLinecap="butt"
            />
          );
          off += len;
          return node;
        })}
      </svg>
      <div className="donut-center">
        <div className="donut-total">{total}</div>
        <div className="donut-label">total</div>
      </div>
    </div>
  );
}

// Searchable single-select dropdown. options: [{value, label, hint?}]
function SearchSelect({ value, onChange, options, placeholder = 'Select…', searchPlaceholder = 'Search…', allowClear = true, width = 220, icon }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    setTimeout(() => inputRef.current && inputRef.current.focus(), 30);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const selected = options.find(o => String(o.value) === String(value));
  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? options.filter(o => (o.label || '').toLowerCase().includes(ql) || (o.hint || '').toLowerCase().includes(ql))
    : options;
  return (
    <div className="search-select" ref={ref} style={{ width }}>
      <button
        type="button"
        className={'search-select-trigger' + (open ? ' open' : '')}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {icon && <Icon name={icon} size={14} />}
        <span className={'search-select-value' + (selected ? '' : ' placeholder')}>
          {selected ? selected.label : placeholder}
        </span>
        {allowClear && selected && (
          <span
            className="search-select-clear"
            onClick={(e) => { e.stopPropagation(); onChange(''); }}
            title="Clear"
            role="button"
          ><Icon name="close" size={12} /></span>
        )}
        <Icon name="chevDown" size={14} />
      </button>
      {open && (
        <div className="search-select-pop" role="listbox">
          <div className="search-select-search">
            <Icon name="search" size={14} />
            <input
              ref={inputRef}
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder={searchPlaceholder}
            />
            {q && <span className="search-select-clear" onClick={() => setQ('')} role="button"><Icon name="close" size={12} /></span>}
          </div>
          <div className="search-select-list">
            {filtered.length === 0 && <div className="search-select-empty muted">No matches</div>}
            {filtered.map(o => {
              const sel = String(o.value) === String(value);
              return (
                <button
                  key={String(o.value)}
                  type="button"
                  className={'search-select-option' + (sel ? ' active' : '')}
                  onClick={() => { onChange(o.value); setOpen(false); setQ(''); }}
                >
                  <span className="search-select-option-label">{o.label}</span>
                  {o.hint && <span className="search-select-option-hint muted">{o.hint}</span>}
                  {sel && <Icon name="check" size={14} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Hook + UI for paginating long row lists. Page size is user-controllable.
function usePaginated(items, opts = {}) {
  const { defaultSize = 10, sizes = [5, 10, 25, 50] } = opts;
  const total = items.length;
  const [pageSize, setPageSize] = useState(defaultSize);
  const [page, setPage] = useState(1);
  const effectiveSize = pageSize === 'all' ? Math.max(total, 1) : pageSize;
  const pages = Math.max(1, Math.ceil(total / effectiveSize));
  // Clamp current page when items shrink (e.g. after a filter change).
  useEffect(() => { if (page > pages) setPage(1); }, [pages, page]);
  const start = (page - 1) * effectiveSize;
  const end = Math.min(start + effectiveSize, total);
  const slice = items.slice(start, end);
  return { slice, total, page, pages, pageSize, setPage, setPageSize, sizes, start, end };
}

function Paginator({ ctl, label = 'rows' }) {
  const { total, page, pages, pageSize, setPage, setPageSize, sizes, start, end } = ctl;
  if (total === 0) return null;
  return (
    <div className="paginator">
      <div className="paginator-info">
        Showing <strong>{start + 1}</strong>–<strong>{end}</strong> of <strong>{total}</strong> {label}
      </div>
      <div className="paginator-controls">
        <div className="paginator-pagesize">
          <label className="muted" htmlFor="ps">Per page</label>
          <select id="ps" value={pageSize} onChange={e => { const v = e.target.value; setPageSize(v === 'all' ? 'all' : +v); setPage(1); }}>
            {sizes.map(s => <option key={s} value={s}>{s}</option>)}
            <option value="all">All</option>
          </select>
        </div>
        <div className="paginator-nav">
          <button type="button" className="ghost icon-btn" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1} aria-label="Previous"><Icon name="chevLeft" size={14} /></button>
          <span className="paginator-page">Page {page} / {pages}</span>
          <button type="button" className="ghost icon-btn" onClick={() => setPage(Math.min(pages, page + 1))} disabled={page === pages} aria-label="Next"><Icon name="chevRight" size={14} /></button>
        </div>
      </div>
    </div>
  );
}

function Dashboard() {
  const [data, setData] = useState(null);
  const [gaps, setGaps] = useState([]);
  const [trends, setTrends] = useState(null);
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    Promise.all([
      api.get('/analysis/summary'),
      api.get('/analysis/gaps'),
      api.get('/analysis/trends?months=6').catch(() => null),
      api.get('/raw-items').catch(() => []),
    ]).then(([d, g, t, r]) => { setData(d); setGaps(g); setTrends(t); setItems(r || []); })
      .catch(e => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useRefresh(load);

  if (error) return <div className="empty-state"><Icon name="alert" size={28} /><p>Error: {error}</p></div>;
  if (!data) return <LoadingState label="Loading dashboard…" sub="Crunching products, gaps and recent activity" />;

  // Latest activity = competitor entries from RSS / manual paste (matches Feed view).
  // Own-product items and HTML page snapshots are kept in raw_items for the analyzer
  // but are not "activity" worth surfacing here.
  const activityItems = items.filter(i => !i.is_own_product && i.source_kind !== 'html');
  const recentItems = activityItems.slice(0, 6);
  const pendingCount = items.filter(i => i.status === 'pending').length;
  const analyzedCount = items.filter(i => i.status === 'analyzed').length;

  // Build per-month release count for sparklines
  const releaseSpark = (() => {
    if (!trends?.release_velocity) return [];
    const totals = {};
    trends.release_velocity.forEach(v => v.by_quarter.forEach(q => { totals[q.quarter] = (totals[q.quarter]||0) + (q.count||0); }));
    return Object.values(totals);
  })();

  // Top categories by gap count (for donut)
  const catBuckets = {};
  gaps.forEach(g => { const k = g.category || 'Other'; catBuckets[k] = (catBuckets[k]||0)+1; });
  const palette = ['#6366f1', '#8b5cf6', '#22d3ee', '#f59e0b', '#10b981', '#ef4444', '#ec4899'];
  const donutSegs = Object.entries(catBuckets).slice(0, 6).map(([k,v], i) => ({ label: k, value: v, color: palette[i % palette.length] }));

  return (
    <>
      <div className="toolbar">
        <h2><Icon name="dashboard" size={22} /> Dashboard</h2>
        <div className="row meta" style={{fontSize:12}}>
          <Icon name="clock" size={12} /> Updated {new Date().toLocaleTimeString()}
        </div>
      </div>

      <div className="stat-grid">
        <StatCard icon="users"    label="Competitors"       value={data.counts.competitors}   accent="violet"  hint="Active rivals — open Report"               onClick={() => window.pmNavigate('Report')} />
        <StatCard icon="layers"   label="Features tracked"  value={data.counts.features}      accent="cyan"    hint="Distinct capabilities — open Matrix"       onClick={() => window.pmNavigate('Matrix')} />
        <StatCard icon="rocket"   label="Releases logged"   value={data.counts.releases}      accent="amber"   hint="All-time releases — open Releases"         onClick={() => window.pmNavigate('Releases')} />
        <StatCard icon="alert"    label="Competitive gaps"  value={gaps.length}               accent="rose"    hint="Features competitors support that our product doesn't — open Gaps" onClick={() => window.pmNavigate('Gaps')} />
      </div>

      <div className="dash-row">
        <div className="card dash-widget">
          <div className="widget-head">
            <div>
              <h3 style={{margin:'0 0 2px'}}>Feed pulse</h3>
              <div className="meta" style={{fontSize:12}}>{analyzedCount} analyzed · {pendingCount} pending</div>
            </div>
            <button className="ghost small" onClick={() => window.pmNavigate('Feed')}>
              Open feed <Icon name="chevRight" size={12} />
            </button>
          </div>
          <div className="row" style={{gap:18, alignItems:'center'}}>
            <Sparkline values={releaseSpark.length ? releaseSpark : [2,3,1,4,3,5,4,6]} color="#6366f1" width={200} height={64} />
            <div>
              <div className="big-stat">{items.length}</div>
              <div className="meta" style={{fontSize:12}}>raw items in last 30 days</div>
            </div>
          </div>
        </div>

        <div className="card dash-widget">
          <div className="widget-head">
            <div>
              <h3 style={{margin:'0 0 2px'}}>Gaps by category</h3>
              <div className="meta" style={{fontSize:12}}>{gaps.length} feature gaps detected</div>
            </div>
          </div>
          {donutSegs.length ? (
            <div className="row" style={{gap:18, alignItems:'center'}}>
              <Donut segments={donutSegs} size={120} thickness={16} />
              <div className="legend">
                {donutSegs.map(s => (
                  <div key={s.label} className="legend-item">
                    <span className="legend-dot" style={{background:s.color}} />
                    <span className="legend-label">{s.label}</span>
                    <span className="legend-value">{s.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : <div className="empty-inline">No gaps yet — you're ahead.</div>}
        </div>
      </div>

      <div className="dash-row">
        <div className="card dash-widget" style={{flex:'1 1 60%'}}>
          <div className="widget-head">
            <div>
              <h3 style={{margin:'0 0 2px'}}>Top gaps</h3>
              <div className="meta" style={{fontSize:12}}>Where competitors are ahead of us</div>
            </div>
            <button className="ghost small" onClick={() => window.pmNavigate('Gaps')}>
              See all <Icon name="chevRight" size={12} />
            </button>
          </div>
          {gaps.length === 0 ? (
            <div className="empty-inline"><Icon name="check" size={18}/> No gaps — you're ahead!</div>
          ) : (
            <ul className="gap-list">
              {gaps.slice(0, 5).map((g, i) => {
                const max = Math.max(1, ...gaps.slice(0,5).map(x => x.competitor_count));
                return (
                  <li key={g.feature_id}>
                    <div className="gap-rank">#{i+1}</div>
                    <div className="gap-main">
                      <div className="gap-title">{g.feature}</div>
                      <div className="meta" style={{fontSize:11}}>{g.category || 'Uncategorised'} · {g.competitors_supporting}</div>
                    </div>
                    <div className="gap-bar-wrap">
                      <div className="gap-bar" style={{width: (g.competitor_count/max)*100 + '%'}} />
                    </div>
                    <div className="gap-count">{g.competitor_count}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="card dash-widget" style={{flex:'1 1 40%'}}>
          <div className="widget-head">
            <div>
              <h3 style={{margin:'0 0 2px'}}>Latest activity</h3>
              <div className="meta" style={{fontSize:12}}>Most recent feed items</div>
            </div>
          </div>
          {recentItems.length === 0 ? (
            <div className="empty-inline">No recent items.</div>
          ) : (
            <ul className="activity-list">
              {recentItems.map(i => (
                <li key={i.id}>
                  <div className={`activity-dot ${i.status}`} />
                  <div className="activity-main">
                    <div className="activity-title">{i.title || '(untitled)'}</div>
                    <div className="meta" style={{fontSize:11}}>
                      <Icon name="clock" size={10} /> {new Date(i.fetched_at).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}
                      {' · '}<span className={`pill ${i.status}`}>{i.status}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card dash-widget">
        <div className="widget-head">
          <div>
            <h3 style={{margin:'0 0 2px'}}>Recent releases</h3>
            <div className="meta" style={{fontSize:12}}>Last shipped versions across the catalog</div>
          </div>
          <button className="ghost small" onClick={() => window.pmNavigate('Releases')}>
            All releases <Icon name="chevRight" size={12} />
          </button>
        </div>
        {data.recent_releases.length === 0 ? (
          <div className="empty-inline">No releases logged yet.</div>
        ) : (
          <table className="modern-table">
            <thead><tr><th>Date</th><th>Product</th><th>Version</th><th>Highlights</th></tr></thead>
            <tbody>
              {data.recent_releases.map(r => (
                <tr key={r.id}>
                  <td className="meta">{r.release_date || '—'}</td>
                  <td><strong>{r.product_name}</strong></td>
                  <td><code className="ver">{r.version}</code></td>
                  <td className="truncate">{r.highlights}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// DashboardHub: tabbed wrapper for Competitive / Analyst / News dashboards
function DashboardHub() {
  const TABS = [
    { id: 'competitive', label: 'Competitive' },
    { id: 'analysts',    label: 'Analyst' },
    { id: 'news',        label: 'News' },
    { id: 'spoc',        label: 'SPOC' },
  ];
  const [tab, setTab] = useSubRoute('dashboard', TABS.map(t => t.id), 'competitive');
  return (
    <>
      <div className="feed-tabs" style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border)' }}>
        {TABS.map(t => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="ghost"
              style={{
                padding: '10px 16px',
                borderRadius: 0,
                border: 'none',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                background: 'transparent',
                color: active ? 'var(--text)' : 'var(--muted)',
                fontWeight: active ? 600 : 400,
                cursor: 'pointer',
              }}
            >{t.label}</button>
          );
        })}
      </div>
      {tab === 'competitive' && <Dashboard />}
      {tab === 'analysts'    && <AnalystDashboard />}
      {tab === 'news'        && <NewsDashboard />}
      {tab === 'spoc'        && <SpocDashboard onOpenEntries={() => window.pmNavigate && window.pmNavigate('SPOC')} />}
    </>
  );
}

function Trends() {
  const [months, setMonths] = useState(12);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const [hotCat, setHotCat] = useState('All');
  const [hotSort, setHotSort] = useState('competitors'); // 'competitors' | 'recent' | 'name'
  const [adoptCat, setAdoptCat] = useState('All');
  const [kwMode, setKwMode] = useState('all'); // 'all' | 'rising' | 'falling'
  useRefresh(() => setTick(t => t + 1));
  useEffect(() => {
    setData(null); setError(null);
    api.get('/analysis/trends?months=' + months)
      .then(setData)
      .catch(e => setError(e.message));
  }, [months, tick]);

  // Build category chip lists from data
  const hotCategories = useMemo(() => {
    if (!data) return ['All'];
    const set = new Set(data.hot_features.map(f => f.category || 'Uncategorised'));
    return ['All', ...Array.from(set).sort()];
  }, [data]);
  const adoptCategories = useMemo(() => {
    if (!data) return ['All'];
    const set = new Set(data.adoption_signal.map(f => f.category || 'Uncategorised'));
    return ['All', ...Array.from(set).sort()];
  }, [data]);

  // Filter + sort hot features
  const hotFiltered = useMemo(() => {
    if (!data) return [];
    let arr = data.hot_features.filter(f =>
      hotCat === 'All' || (f.category || 'Uncategorised') === hotCat
    );
    arr = [...arr].sort((a, b) => {
      if (hotSort === 'name') return (a.name || '').localeCompare(b.name || '');
      if (hotSort === 'recent') return b.recent_requests - a.recent_requests;
      return b.competitor_count - a.competitor_count;
    });
    return arr;
  }, [data, hotCat, hotSort]);

  const adoption = useMemo(() => {
    if (!data) return [];
    return data.adoption_signal.filter(f =>
      adoptCat === 'All' || (f.category || 'Uncategorised') === adoptCat
    );
  }, [data, adoptCat]);
  const keywords = useMemo(() => {
    if (!data) return [];
    if (kwMode === 'rising')  return data.emerging_keywords.filter(k => k.delta > 0);
    if (kwMode === 'falling') return data.emerging_keywords.filter(k => k.delta < 0);
    return data.emerging_keywords;
  }, [data, kwMode]);
  const categories = data ? data.category_trends : [];
  const velocity = data ? data.release_velocity : [];

  const hotCtl = usePaginated(hotFiltered);
  const adoptCtl = usePaginated(adoption);
  const kwCtl = usePaginated(keywords);
  const catCtl = usePaginated(categories);
  const velCtl = usePaginated(velocity);

  if (error) return <p style={{color:'#f87171'}}>Error: {error}</p>;
  if (!data) return <LoadingState label="Analyzing trends…" sub="Computing hot features, gaps and emerging keywords" />;

  const maxCat = Math.max(1, ...categories.map(c => c.recent_requests + c.competitor_support_count));
  const maxKw  = Math.max(1, ...data.emerging_keywords.map(k => k.recent));
  const maxComp = Math.max(1, ...data.hot_features.map(x => x.competitor_count));

  // Tab-specific KPIs (computed from the trend payload itself)
  const totalCompetitorReleases = velocity
    .filter(v => !v.is_own)
    .reduce((sum, v) => sum + (v.total || 0), 0);
  const topHotFeature = data.hot_features[0] || null;
  const topRisingKw = [...data.emerging_keywords].sort((a, b) => b.delta - a.delta)[0] || null;
  const topCategory = [...categories].sort((a, b) =>
    (b.recent_requests + b.competitor_support_count) - (a.recent_requests + a.competitor_support_count)
  )[0] || null;

  return (
    <>
      <div className="toolbar">
        <h2><Icon name="trends" size={22} /> Trend Analysis</h2>
        <div className="row">
          <label className="muted" htmlFor="tr-range">Time range</label>
          <select id="tr-range" className="select-modern" value={months} onChange={e => setMonths(+e.target.value)} style={{width:170}}>
            <option value="3">Last 3 months</option>
            <option value="6">Last 6 months</option>
            <option value="12">Last 12 months</option>
            <option value="24">Last 24 months</option>
          </select>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard
          icon="rocket"
          label="Competitor releases"
          value={totalCompetitorReleases}
          accent="indigo"
          hint={`Total releases shipped by competitors in the last ${months} months — open Releases`}
          onClick={() => window.pmNavigate('Releases')}
        />
        <StatCard
          icon="zap"
          label="Hottest feature"
          value={topHotFeature ? topHotFeature.name : '—'}
          accent="rose"
          hint={topHotFeature ? `Adopted by ${topHotFeature.competitor_count} competitor${topHotFeature.competitor_count === 1 ? '' : 's'} — open Matrix` : 'No data yet'}
          onClick={topHotFeature ? () => window.pmNavigate('Matrix') : undefined}
        />
        <StatCard
          icon="sparkles"
          label="Top rising keyword"
          value={topRisingKw ? topRisingKw.keyword : '—'}
          accent="violet"
          hint={topRisingKw ? `${topRisingKw.delta >= 0 ? '+' : ''}${topRisingKw.delta} vs. prior period — open Feed` : 'No keyword data'}
          onClick={topRisingKw ? () => window.pmNavigate('Feed') : undefined}
        />
        <StatCard
          icon="layers"
          label="Most-active category"
          value={topCategory ? (topCategory.category || 'Uncategorised') : '—'}
          accent="cyan"
          hint={topCategory ? `${topCategory.recent_requests} recent requirements · ${topCategory.competitor_support_count} competitor adoptions — open Report` : 'No category activity'}
          onClick={topCategory ? () => window.pmNavigate('Report') : undefined}
        />
      </div>

      <div className="dash-widget" style={{marginTop:18}}>
        <div className="widget-head">
          <div className="widget-title"><Icon name="zap" size={16} /> Hot features <span className="muted">— most adopted by competitors</span></div>
          <div className="row">
            {hotCategories.length > 2 && (
              <select className="select-modern" value={hotCat} onChange={e => setHotCat(e.target.value)} style={{width:190}} title="Filter by category">
                {hotCategories.map(c => <option key={c} value={c}>{c === 'All' ? 'All categories' : c}</option>)}
              </select>
            )}
            <select className="select-modern" value={hotSort} onChange={e => setHotSort(e.target.value)} style={{width:200}} title="Sort by">
              <option value="competitors">Sort by · Competitors</option>
              <option value="recent">Sort by · Recent demand</option>
              <option value="name">Sort by · Name (A–Z)</option>
            </select>
          </div>
        </div>
        <Paginator ctl={hotCtl} label="features" />
        <table className="modern-table">
          <thead><tr><th>Feature</th><th>Category</th><th>Competitors</th><th>Recent demand</th><th>We support?</th></tr></thead>
          <tbody>
            {hotCtl.slice.map(f => (
              <tr key={f.id}>
                <td><strong>{f.name}</strong></td>
                <td><span className="badge">{f.category||'—'}</span></td>
                <td>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    <div className="bar-track" style={{flex:'0 0 90px'}}>
                      <div className="bar-fill" style={{width:(f.competitor_count/maxComp)*100+'%'}} />
                    </div>
                    <span>{f.competitor_count}</span>
                  </div>
                </td>
                <td>{f.recent_requests}</td>
                <td>{f.we_support ? <span className="pill analyzed"><Icon name="check" size={12}/> Yes</span> : <span className="pill pending"><Icon name="alert" size={12}/> No</span>}</td>
              </tr>
            ))}
            {hotFiltered.length===0 && <tr><td colSpan="5" className="muted">No matching features.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="dash-widget" style={{marginTop:18}}>
        <div className="widget-head">
          <div className="widget-title"><Icon name="alert" size={16} /> Adoption-signal gaps <span className="muted">— ≥2 competitors have it, we don't</span></div>
          {adoptCategories.length > 2 && (
            <div className="row">
              <select className="select-modern" value={adoptCat} onChange={e => setAdoptCat(e.target.value)} style={{width:190}} title="Filter by category">
                {adoptCategories.map(c => <option key={c} value={c}>{c === 'All' ? 'All categories' : c}</option>)}
              </select>
            </div>
          )}
        </div>
        <Paginator ctl={adoptCtl} label="gaps" />
        <table className="modern-table">
          <thead><tr><th>Feature</th><th>Category</th><th>Competitors</th></tr></thead>
          <tbody>
            {adoptCtl.slice.map(f => (
              <tr key={f.id}>
                <td><strong>{f.name}</strong></td>
                <td><span className="badge">{f.category||'—'}</span></td>
                <td>{f.competitor_count}</td>
              </tr>
            ))}
            {adoption.length===0 && <tr><td colSpan="3" className="muted">No critical gaps — nice work.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="dash-widget" style={{marginTop:18}}>
        <div className="widget-head">
          <div className="widget-title"><Icon name="layers" size={16} /> Category momentum</div>
        </div>
        <Paginator ctl={catCtl} label="categories" />
        <div className="meter-list">
          {catCtl.slice.map(c => (
            <div key={c.category||'_'} className="meter-row">
              <div className="meter-row-head">
                <span>{c.category || 'Uncategorised'}</span>
                <span className="muted">{c.recent_requests} recent · {c.competitor_support_count} competitor adoptions</span>
              </div>
              <div className="bar-track">
                <div className="bar-fill bar-grad" style={{width:((c.recent_requests + c.competitor_support_count)/maxCat)*100+'%'}} />
              </div>
            </div>
          ))}
          {categories.length===0 && <p className="muted" style={{margin:0}}>No category data.</p>}
        </div>
      </div>

      <div className="dash-widget" style={{marginTop:18}}>
        <div className="widget-head">
          <div className="widget-title"><Icon name="rocket" size={16} /> Release velocity <span className="muted">— last 4 quarters</span></div>
        </div>
        <Paginator ctl={velCtl} label="products" />
        <table className="modern-table">
          <thead>
            <tr>
              <th>Product</th>
              {data.quarters.map(q => <th key={q}>{q}</th>)}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {velCtl.slice.map(v => (
              <tr key={v.product_id}>
                <td>{v.product_name} {v.is_own ? <span className="badge own">OURS</span> : null}</td>
                {v.by_quarter.map(q => <td key={q.quarter}>{q.count || <span className="muted">·</span>}</td>)}
                <td><strong>{v.total}</strong></td>
              </tr>
            ))}
            {velocity.length===0 && <tr><td colSpan={data.quarters.length+2} className="muted">No releases logged in window.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="dash-widget" style={{marginTop:18}}>
        <div className="widget-head">
          <div className="widget-title"><Icon name="sparkles" size={16} /> Emerging keywords <span className="muted">— from release notes & ingested items</span></div>
          <div className="row">
            <select className="select-modern" value={kwMode} onChange={e => setKwMode(e.target.value)} style={{width:170}} title="Trend filter">
              <option value="all">All keywords</option>
              <option value="rising">Rising only</option>
              <option value="falling">Falling only</option>
            </select>
          </div>
        </div>
        <Paginator ctl={kwCtl} label="keywords" />
        <div className="meter-list">
          {kwCtl.slice.map(k => (
            <div key={k.keyword} className="meter-row">
              <div className="meter-row-head">
                <span>{k.keyword}</span>
                <span className="muted">recent {k.recent} · prior {k.older} · <span className={k.delta>=0?'pos':'neg'}>Δ {k.delta>=0?'+':''}{k.delta}</span></span>
              </div>
              <div className="bar-track sm">
                <div className="bar-fill" style={{width:(k.recent/maxKw)*100+'%', background: k.delta>0 ? 'var(--good)' : 'var(--accent)'}} />
              </div>
            </div>
          ))}
          {keywords.length===0 && <p className="muted" style={{margin:0}}>No keywords match this filter.</p>}
        </div>
      </div>
    </>
  );
}

function Report() {
  const [months, setMonths] = useState(6);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [releasesModal, setReleasesModal] = useState(null);
  const [tick, setTick] = useState(0);
  useRefresh(() => setTick(t => t + 1));
  useEffect(() => {
    setData(null); setError(null);
    api.get('/analysis/competitor-report?months=' + months)
      .then(setData).catch(e => setError(e.message));
  }, [months, tick]);
  if (error) return <p style={{color:'#f87171'}}>Error: {error}</p>;
  if (!data) return <p>Building report…</p>;

  const toggle = (id) => setExpanded(s => ({ ...s, [id]: !s[id] }));

  const exportMd = () => {
    const lines = [`# Competitor Activity Report`, `Window: last ${data.window.months} months (since ${data.window.since})`, ''];
    for (const c of data.competitors) {
      lines.push(`## ${c.product_name}${c.vendor ? ` — ${c.vendor}` : ''}`);
      lines.push(`- Latest release: ${c.latest_release_date || 'unknown'}`);
      lines.push(`- Releases in window: ${c.release_count_window} · New-feature signals: ${c.new_features_count} · Exclusive vs us: ${c.exclusive_features_count}`);
      if (c.themes.length) lines.push(`- Themes: ${c.themes.map(t=>`${t.category} (${t.count})`).join(', ')}`);
      if (c.keywords.length) lines.push(`- Keywords: ${c.keywords.map(k=>k.keyword).join(', ')}`);
      if (c.releases.length) {
        lines.push('', '**Recent releases**');
        for (const r of c.releases) lines.push(`- ${r.release_date||'—'} · v${r.version} — ${(r.highlights||'').replace(/\n/g,' ')}`);
      }
      if (c.exclusive_features.length) {
        lines.push('', '**Features they have, we don\'t**');
        for (const f of c.exclusive_features) lines.push(`- ${f.name} _(${f.category||'—'})_${f.since_version?` since v${f.since_version}`:''}`);
      }
      lines.push('');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `competitor-report-${new Date().toISOString().slice(0,10)}.md`;
    a.click();
  };

  return (
    <>
      <div className="toolbar">
        <h2><Icon name="report" size={22} /> Competitor Activity Report</h2>
        <div className="row">
          <label className="muted" htmlFor="rep-range">Time range</label>
          <select id="rep-range" className="select-modern" value={months} onChange={e=>setMonths(+e.target.value)} style={{width:170}}>
            <option value="3">Last 3 months</option>
            <option value="6">Last 6 months</option>
            <option value="12">Last 12 months</option>
            <option value="24">Last 24 months</option>
          </select>
          <button className="ghost" onClick={exportMd}><Icon name="download" size={14}/> Export Markdown</button>
        </div>
      </div>
      <p className="muted" style={{marginTop:-4}}>What each competitor has shipped since {data.window.since}. Sorted by activity (releases + exclusive features).</p>

      {data.competitors.length === 0 && <div className="empty-state"><Icon name="report" size={28}/><p>No competitors tracked yet.</p></div>}

      {data.competitors.map(c => {
        const open = expanded[c.product_id];
        return (
          <div key={c.product_id} className="dash-widget report-card">
            <div className="report-card-head">
              <div className="report-card-title">
                <div className="report-card-name">
                  <Icon name="package" size={18} />
                  <h3>{c.product_name}</h3>
                  {c.vendor && <span className="muted">{c.vendor}</span>}
                </div>
                <div className="report-card-meta muted">
                  Latest release: <strong>{c.latest_release_date || 'unknown'}</strong>
                  {c.latest_release_date && c.release_count_window === 0 && (
                    <span className="release-stale-hint" title={`The most recent release is older than the ${months}-month window. Increase the window above to include it.`}>
                      {' '}· stale (outside {months}mo window)
                    </span>
                  )}
                </div>
              </div>
              <button className="ghost" onClick={()=>toggle(c.product_id)}>
                {open ? <><Icon name="chevUp" size={14}/> Hide details</> : <><Icon name="chevDown" size={14}/> Show details</>}
              </button>
            </div>

            <div className="report-stats">
              <button
                type="button"
                className="report-stat clickable"
                title={`See the ${c.releases.length} release${c.releases.length===1?'':'s'} from ${c.product_name} in this window.`}
                onClick={() => setReleasesModal(c)}
                disabled={c.releases.length===0}
              >
                <span className="report-stat-icon"><Icon name="rocket" size={14}/></span>
                <div>
                  <div className="report-stat-value">{c.release_count_window}</div>
                  <div className="report-stat-label">Releases (last {months}mo)</div>
                </div>
              </button>
              <button
                type="button"
                className="report-stat clickable"
                title={`Open the Competitive Feed filtered by ${c.product_name}.`}
                onClick={() => { window.pmFeedFilterProduct = c.product_id; window.pmNavigate && window.pmNavigate('Feed'); }}
              >
                <span className="report-stat-icon"><Icon name="feed" size={14}/></span>
                <div>
                  <div className="report-stat-value">{c.raw_items_window}</div>
                  <div className="report-stat-label">Ingested (last {months}mo)</div>
                </div>
              </button>
              <button
                type="button"
                className="report-stat clickable"
                title="Expand details below to see this competitor's recent feature signals."
                onClick={() => { setExpanded(prev => ({ ...prev, [c.product_id]: true })); requestAnimationFrame(() => document.getElementById(`report-features-${c.product_id}`)?.scrollIntoView({behavior:'smooth', block:'start'})); }}
              >
                <span className="report-stat-icon"><Icon name="sparkles" size={14}/></span>
                <div>
                  <div className="report-stat-value">{c.new_features_count}</div>
                  <div className="report-stat-label">New-feature signals</div>
                </div>
              </button>
              <button
                type="button"
                className={`report-stat clickable ${c.exclusive_features_count>0 ? 'warn' : 'ok'}`}
                title={c.exclusive_features_count>0 ? "Expand details below to see features they have but we don't." : 'No exclusive features — we cover everything they ship.'}
                onClick={() => { setExpanded(prev => ({ ...prev, [c.product_id]: true })); requestAnimationFrame(() => document.getElementById(`report-exclusive-${c.product_id}`)?.scrollIntoView({behavior:'smooth', block:'start'})); }}
                disabled={c.exclusive_features_count===0}
              >
                <span className="report-stat-icon"><Icon name="alert" size={14}/></span>
                <div>
                  <div className="report-stat-value">{c.exclusive_features_count}</div>
                  <div className="report-stat-label">Exclusive vs us</div>
                </div>
              </button>
            </div>

            {(c.themes.length > 0 || c.keywords.length > 0) && (
              <div className="report-tags">
                {c.themes.length > 0 && (
                  <div className="report-tag-group">
                    <div className="report-tag-label">Themes</div>
                    <div className="report-tag-row">
                      {c.themes.map(t => <span key={t.category} className="badge">{t.category} · {t.count}</span>)}
                    </div>
                  </div>
                )}
                {c.keywords.length > 0 && (
                  <div className="report-tag-group">
                    <div className="report-tag-label">Keywords</div>
                    <div className="report-tag-row">
                      {c.keywords.map(k => <span key={k.keyword} className="kw-chip">{k.keyword} · {k.count}</span>)}
                    </div>
                  </div>
                )}
              </div>
            )}

            {open && (
              <div className="report-details">
                <div className="report-section">
                  <div className="report-section-head" id={`report-features-${c.product_id}`}><Icon name="rocket" size={14}/> Recent releases <span className="muted">({c.releases.length})</span></div>
                  {c.releases.length===0 && <p className="muted" style={{margin:0}}>No releases in window.</p>}
                  {c.releases.map(r => {
                    const ver = r.version && String(r.version).trim().toLowerCase() !== 'unknown' ? r.version : null;
                    const date = r.release_date && String(r.release_date).trim().toLowerCase() !== 'unknown' ? r.release_date : null;
                    const title = ver ? `v${ver}` : (r.highlights ? r.highlights.split(/[.\n]/)[0].trim().slice(0, 80) : 'Release');
                    return (
                      <div key={r.id} className="timeline-item">
                        <div className="row" style={{justifyContent:'space-between', alignItems:'flex-start', gap:12}}>
                          <strong>{title}</strong>
                          <span className="meta">{date || '—'} {r.auto_generated?<span className="badge">auto</span>:null}</span>
                        </div>
                        {r.highlights && <div style={{marginTop:4,fontSize:13}}>{r.highlights}</div>}
                        {r.url && /^https?:\/\//i.test(r.url) && <a href={r.url} target="_blank" rel="noreferrer" className="report-source-link"><Icon name="external" size={11}/> {r.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80)}</a>}
                      </div>
                    );
                  })}
                </div>

                {c.exclusive_features.length>0 && (
                  <div className="report-section">
                    <div className="report-section-head" id={`report-exclusive-${c.product_id}`}><Icon name="alert" size={14}/> Features they have, we don't <span className="muted">({c.exclusive_features_count})</span></div>
                    <table className="modern-table">
                      <thead><tr><th>Feature</th><th>Category</th><th>Since</th><th>Source</th></tr></thead>
                      <tbody>
                        {c.exclusive_features.map(f => {
                          const note = (f.notes || '').trim();
                          const isUrl = /^https?:\/\/[^\s]+$/i.test(note);
                          return (
                            <tr key={f.id}>
                              <td><strong>{f.name}</strong></td>
                              <td><span className="badge">{f.category||'—'}</span></td>
                              <td>{f.since_version && f.since_version.toLowerCase() !== 'unknown' ? f.since_version : <span className="muted">—</span>}</td>
                              <td className="muted">
                                {isUrl
                                  ? <a href={note} target="_blank" rel="noreferrer" className="report-source-link" title={note}><Icon name="external" size={11}/> {note.replace(/^https?:\/\/(www\.)?/, '').slice(0, 50)}</a>
                                  : (note || <span className="muted">—</span>)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {c.recent_requests.length>0 && (
                  <div className="report-section">
                    <div className="report-section-head"><Icon name="check" size={14}/> Linked requirements <span className="muted">({c.recent_requests.length})</span></div>
                    <table className="modern-table">
                      <thead><tr><th>Title</th><th>Category</th><th>Priority</th><th>Status</th><th>Confidence</th></tr></thead>
                      <tbody>
                        {c.recent_requests.map(r => (
                          <tr key={r.id}>
                            <td>{r.title}</td>
                            <td><span className="badge">{r.category||'—'}</span></td>
                            <td><span className={'badge '+r.priority}>{r.priority}</span></td>
                            <td><span className={'badge '+r.status}>{r.status}</span></td>
                            <td>{r.confidence ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {releasesModal && (
        <Modal onClose={() => setReleasesModal(null)}>
          <h3 style={{margin:'0 0 4px'}}>{releasesModal.product_name} · Releases</h3>
          <p className="muted" style={{margin:'0 0 16px'}}>
            {releasesModal.releases.length} release{releasesModal.releases.length===1?'':'s'} in the last {months} month{months===1?'':'s'}
            {releasesModal.latest_release_date ? ` · latest ${releasesModal.latest_release_date.slice(0,10)}` : ''}
          </p>
          <div className="release-modal-list">
            {releasesModal.releases.length===0 && <p className="muted">No releases in window.</p>}
            {releasesModal.releases.map(r => {
              const ver = r.version && String(r.version).trim().toLowerCase() !== 'unknown' ? r.version : null;
              const date = r.release_date && String(r.release_date).trim().toLowerCase() !== 'unknown' ? r.release_date : null;
              const title = ver ? `v${ver}` : (r.highlights ? r.highlights.split(/[.\n]/)[0].trim().slice(0, 80) : 'Release');
              return (
                <div key={r.id} className="release-modal-item">
                  <div className="row" style={{justifyContent:'space-between', alignItems:'flex-start', gap:12}}>
                    <strong style={{fontSize:15}}>{title}</strong>
                    <span className="meta">{date || '—'} {r.auto_generated?<span className="badge">auto</span>:null}</span>
                  </div>
                  {r.highlights && <div style={{marginTop:6, fontSize:13, lineHeight:1.5, whiteSpace:'pre-wrap'}}>{r.highlights}</div>}
                  {r.url && /^https?:\/\//i.test(r.url) && (
                    <a href={r.url} target="_blank" rel="noreferrer" className="report-source-link" style={{marginTop:6}}>
                      <Icon name="external" size={11}/> {r.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 100)}
                    </a>
                  )}
                </div>
              );
            })}
          </div>
          <div className="row" style={{justifyContent:'flex-end', marginTop:16, gap:8}}>
            <button
              type="button"
              className="ghost"
              onClick={() => { window.pmReleasesFilterProduct = releasesModal.product_id; setReleasesModal(null); window.pmNavigate && window.pmNavigate('Releases'); }}
            >
              Open in Releases tab →
            </button>
            <button type="button" className="primary" onClick={() => setReleasesModal(null)}>Close</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Analysts({ embedded = false }) {
  const [firms, setFirms] = useState([]);
  const [sources, setSources] = useState([]);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState({});
  const [editing, setEditing] = useState(null);
  const [pasting, setPasting] = useState(null);
  const load = useCallback(() => {
    Promise.all([api.get('/products'), api.get('/sources'), api.get('/raw-items')])
      .then(([p, s, it]) => {
        const ids = new Set(p.filter(x => (x.kind||'product') === 'analyst').map(x => x.id));
        setFirms(p.filter(x => (x.kind||'product') === 'analyst'));
        setSources(s.filter(src => ids.has(src.product_id)));
        setItems(it.filter(r => ids.has(r.product_id)));
      })
      .catch(e => window.toast && window.toast(e.message, 'error'));
  }, []);
  useEffect(() => { load(); }, [load]);
  useRefresh(load);

  const setBusyKey = (k, v) => setBusy(prev => ({ ...prev, [k]: v }));
  const saveFirm = async (form) => {
    if (form.id) await api.put('/products/' + form.id, { ...form, kind: 'analyst' });
    else await api.post('/products', { ...form, kind: 'analyst', is_own: 0 });
    setEditing(null); load();
  };
  const fetchAll = async () => {
    setBusyKey('all', true);
    try {
      // run only sources whose product is analyst
      const results = [];
      for (const s of sources) {
        try { const r = await api.post(`/sources/${s.id}/run?auto=0`); results.push(r); }
        catch (e) { results.push({ error: e.message }); }
      }
      const total = results.reduce((a, r) => a + (r.inserted || 0), 0);
      window.toast(`Refreshed ${sources.length} analyst feeds · ${total} new items`, 'success');
      load();
    } finally { setBusyKey('all', false); }
  };
  const fetchOne = async (s) => {
    setBusyKey('s' + s.id, true);
    try { const r = await api.post(`/sources/${s.id}/run?auto=0`); window.toast(`Fetched ${r.fetched} · new ${r.inserted}`, 'success'); load(); }
    catch (e) { window.toast(e.message, 'error'); }
    finally { setBusyKey('s' + s.id, false); }
  };
  const addSource = async (firm) => {
    const url = prompt(`RSS or HTML URL for ${firm.name} (leave blank to cancel)`);
    if (!url) return;
    const kind = url.match(/(rss|atom|feed|\.xml)/i) ? 'rss' : 'html';
    await api.post('/sources', { product_id: firm.id, kind, url, label: firm.name });
    load();
  };
  const savePaste = async (form) => {
    await api.post('/ingest/manual', { ...form, auto: false });
    setPasting(null);
    window.toast('Paste saved \u2014 use the Analyze button on the raw item if you want extraction.', 'info');
    load();
  };
  const itemsByFirm = (id) => items.filter(it => it.product_id === id);
  const sourcesByFirm = (id) => sources.filter(src => src.product_id === id);
  const firmsCtl = usePaginated(firms);

  return (
    <>
      <div className="toolbar">
        {!embedded && <h2><Icon name="analysts" size={22} /> Analyst Firms</h2>}
        {embedded && <h3 style={{margin:0, display:'flex', alignItems:'center', gap:8}}><Icon name="analysts" size={18} /> Analyst Firms</h3>}
        <div className="row">
          <button className="ghost" onClick={() => setEditing({ name: '', vendor: '', website: '', notes: '', pros: '', cons: '', roadmap: '' })}>+ Add firm</button>
          <button className="ghost" onClick={() => setPasting({ product_id: firms[0]?.id || '', title: '', content: '', url: '' })}>+ Paste report excerpt</button>
          <button onClick={fetchAll} disabled={busy.all || sources.length===0}>{busy.all ? 'Refreshing…' : <><Icon name="refresh" size={14}/> Refresh all analyst feeds</>}</button>
        </div>
      </div>
      <p className="muted">
        Most analyst content (Magic Quadrant, Wave, MarketScape, Universe, PEAK Matrix) is paywalled. Public blogs/press are polled via RSS/HTML;
        for paid reports use <strong>Paste report excerpt</strong> to feed text into the analyzer.
      </p>

      {firms.length > 0 && (
        <div className="dash-widget" style={{padding:0, background:'transparent', border:'none', boxShadow:'none'}}>
          <Paginator ctl={firmsCtl} label="firms" />
        </div>
      )}

      {firmsCtl.slice.map(firm => (
        <div key={firm.id} style={{background:'var(--panel)',border:'1px solid var(--border)',borderRadius:10,padding:14,marginBottom:12}}>
          <div className="row" style={{justifyContent:'space-between',alignItems:'flex-start'}}>
            <div>
              <h3 style={{margin:'0 0 4px 0'}}>{firm.name} <span className="muted" style={{fontSize:13,fontWeight:400}}>{firm.vendor}</span></h3>
              {firm.website && <a href={firm.website} target="_blank" style={{color:'var(--accent)',fontSize:12}}>{firm.website}</a>}
              {firm.notes && <div className="muted" style={{fontSize:12,marginTop:4}}>{firm.notes}</div>}
            </div>
            <div className="row">
              <button className="ghost" onClick={() => addSource(firm)}>+ Source</button>
              <button className="ghost" onClick={() => setEditing(firm)}>Edit</button>
            </div>
          </div>

          {(firm.pros || firm.cons || firm.roadmap) && (
            <div className="row" style={{gap:12,marginTop:10,alignItems:'stretch'}}>
              {firm.pros && <div style={{flex:1,background:'var(--panel-2)',padding:8,borderRadius:6,borderLeft:'3px solid var(--good)'}}><div className="label" style={{color:'var(--good)',fontSize:11}}>VIEW: STRENGTHS</div><div style={{fontSize:13,whiteSpace:'pre-wrap'}}>{firm.pros}</div></div>}
              {firm.cons && <div style={{flex:1,background:'var(--panel-2)',padding:8,borderRadius:6,borderLeft:'3px solid var(--bad)'}}><div className="label" style={{color:'#fca5a5',fontSize:11}}>VIEW: WEAKNESSES</div><div style={{fontSize:13,whiteSpace:'pre-wrap'}}>{firm.cons}</div></div>}
              {firm.roadmap && <div style={{flex:1,background:'var(--panel-2)',padding:8,borderRadius:6,borderLeft:'3px solid var(--accent)'}}><div className="label" style={{color:'var(--accent)',fontSize:11}}>OUTLOOK / PLANS</div><div style={{fontSize:13,whiteSpace:'pre-wrap'}}>{firm.roadmap}</div></div>}
            </div>
          )}

          <div style={{marginTop:10}}>
            <div className="label" style={{fontSize:11}}>Sources ({sourcesByFirm(firm.id).length})</div>
            {sourcesByFirm(firm.id).length === 0 && <div className="muted" style={{fontSize:12,marginTop:4}}>No source configured. Click <strong>+ Source</strong> to add an RSS/HTML feed.</div>}
            {sourcesByFirm(firm.id).map(s => (
              <div key={s.id} className="row" style={{justifyContent:'space-between',padding:'4px 0',borderBottom:'1px dashed var(--border)'}}>
                <span><span className="badge">{s.kind}</span> <a href={s.url} target="_blank" style={{color:'var(--accent)',fontSize:12}}>{s.label||s.url}</a></span>
                <span className="row">
                  <span className="meta" style={{fontSize:11}}>{s.last_polled||'never'}</span>
                  <button className="ghost" onClick={() => fetchOne(s)} disabled={busy['s'+s.id]}>{busy['s'+s.id]?'…':'Fetch'}</button>
                </span>
              </div>
            ))}
          </div>

          {itemsByFirm(firm.id).length > 0 && (
            <details style={{marginTop:10}}>
              <summary className="muted" style={{cursor:'pointer',fontSize:12}}>{itemsByFirm(firm.id).length} ingested items</summary>
              <ul style={{margin:'8px 0 0',paddingLeft:18,fontSize:12}}>
                {itemsByFirm(firm.id).slice(0, 10).map(it => (
                  <li key={it.id}>
                    {it.url ? <a href={it.url} target="_blank" style={{color:'var(--accent)'}}>{it.title}</a> : it.title}
                    <span className="muted"> · {(it.published_at||'').slice(0,10)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}

      {firms.length === 0 && <p className="muted">No analyst firms tracked yet.</p>}

      {editing && <ProductForm value={editing} onSave={saveFirm} onClose={() => setEditing(null)} />}
      {pasting && firms.length > 0 && <PasteForm value={pasting} products={firms} onSave={savePaste} onClose={() => setPasting(null)} />}
    </>
  );
}

// Top-level Analysts tab. Two-pane layout:
//   - Left sidebar: list of firms with item-count badges + "All firms" overview
//   - Right pane: when a firm is selected, shows that firm's profile (site,
//     notes, pros/cons/roadmap if set) and its published items in chronological
//     order. When "All firms" is selected, shows summary tiles + a unified
//     chronological feed across all firms.
// Editing firms / managing feeds stays in Catalog → Analysts.

// Conferences panel — lists upcoming (and recent) analyst-firm conferences.
// When firmId is null/undefined we show ALL firms; otherwise we filter to one.
function ConferencesPanel({ firmId, firmName, firms = [], compact = false }) {
  const [rows, setRows] = useState(null);
  const [showPast, setShowPast] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const q = firmId ? `?product_id=${firmId}` : '';
      setRows(await api.get(`/conferences/enriched${q}`));
    } catch (e) { window.toast && window.toast('Failed to load conferences: ' + e.message, 'error'); }
  };
  useEffect(() => { load(); }, [firmId]);

  if (!rows) return null;

  const today = new Date(); today.setHours(0,0,0,0);
  const todayMs = today.getTime();
  const isPast = (r) => r.end_date && Date.parse(r.end_date) < todayMs;
  const upcoming = rows.filter(r => !isPast(r));
  const past = rows.filter(r => isPast(r));
  const visible = showPast ? rows : upcoming;

  const fmtRange = (s, e) => {
    if (!s) return 'TBD';
    const sd = new Date(s);
    if (isNaN(sd)) return s;
    const sStr = sd.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    if (!e || e === s) return sStr;
    const ed = new Date(e);
    if (isNaN(ed)) return sStr;
    if (sd.getFullYear() === ed.getFullYear() && sd.getMonth() === ed.getMonth()) {
      return `${sd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}–${ed.getDate()}, ${ed.getFullYear()}`;
    }
    return `${sStr} – ${ed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  };
  const relTo = (s) => {
    if (!s) return '';
    const ms = Date.parse(s) - Date.now();
    const days = Math.round(ms / 86400000);
    if (Math.abs(days) < 1) return 'today';
    if (days > 0) return days < 30 ? `in ${days}d` : days < 365 ? `in ${Math.round(days/30)}mo` : `in ${Math.round(days/365)}y`;
    const ad = Math.abs(days);
    return ad < 30 ? `${ad}d ago` : ad < 365 ? `${Math.round(ad/30)}mo ago` : `${Math.round(ad/365)}y ago`;
  };

  const saveConf = async () => {
    if (!editing.product_id) { window.toast('Select a firm', 'error'); return; }
    if (!editing.name || !editing.name.trim()) { window.toast('Name is required', 'error'); return; }
    setBusy(true);
    try {
      const payload = {
        product_id: +editing.product_id,
        name: editing.name.trim(),
        region: editing.region || null,
        location: editing.location || null,
        start_date: editing.start_date || null,
        end_date: editing.end_date || null,
        url: editing.url || null,
        topics: editing.topics || null,
        notes: editing.notes || null,
      };
      if (editing.id) {
        await api.put(`/conferences/${editing.id}`, payload);
      } else {
        await api.post('/conferences', payload);
      }
      setEditing(null);
      load();
      window.toast('Conference saved', 'success');
    } catch (e) { window.toast('Save failed: ' + e.message, 'error'); }
    finally { setBusy(false); }
  };

  const deleteConf = async (id) => {
    if (!confirm('Delete this conference?')) return;
    try {
      await api.del(`/conferences/${id}`);
      load();
      window.toast('Deleted', 'success');
    } catch (e) { window.toast('Delete failed: ' + e.message, 'error'); }
  };

  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="calendar" size={16} />
          Upcoming conferences {firmName ? `· ${firmName}` : ''}
          <span className="badge" style={{ fontSize: 10 }}>{upcoming.length}</span>
        </h3>
        <div className="row" style={{ gap: 6 }}>
          {past.length > 0 && (
            <button className="ghost small" type="button" onClick={() => setShowPast(!showPast)}>
              {showPast ? 'Hide past' : `Show past (${past.length})`}
            </button>
          )}
          <button className="ghost small" type="button" onClick={() => setEditing({ product_id: firmId || '', name: '', region: '', location: '', start_date: '', end_date: '', url: '', topics: '', notes: '' })}>
            + Add
          </button>
        </div>
      </div>
      {visible.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5, padding: '6px 0' }}>
          No conferences listed yet{firmName ? ` for ${firmName}` : ''}. Click + Add to add one.
        </div>
      ) : (
        <table className="conferences-table">
          <thead>
            <tr>
              {!firmId && <th>Firm</th>}
              <th>Event</th>
              <th>Dates</th>
              <th>Location</th>
              <th>Topics</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map(r => (
              <tr key={r.id} className={isPast(r) ? 'conf-past' : ''}>
                {!firmId && <td>{r.firm_name}</td>}
                <td>
                  {r.url
                    ? <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text)', fontWeight: 500 }}>{r.name}</a>
                    : <strong>{r.name}</strong>}
                  {r.region && <span className="badge" style={{ fontSize: 10, marginLeft: 6 }}>{r.region}</span>}
                </td>
                <td>
                  <div>{fmtRange(r.start_date, r.end_date)}</div>
                  {r.start_date && <span className="muted" style={{ fontSize: 11 }}>{relTo(r.start_date)}</span>}
                </td>
                <td className="muted">{r.location || '—'}</td>
                <td className="muted" style={{ fontSize: 12 }}>{r.topics || '—'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="ghost small" type="button" onClick={() => setEditing(r)}>Edit</button>
                  <button className="ghost small" type="button" onClick={() => deleteConf(r.id)} style={{ color: 'var(--bad, #f87171)', marginLeft: 4 }}>Del</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div className="modal" style={{ maxWidth: 560 }}>
            <h3 style={{ marginTop: 0 }}>{editing.id ? 'Edit conference' : 'Add conference'}</h3>
            <div className="form-grid">
              <label>Firm
                <select value={editing.product_id || ''} onChange={e => setEditing({ ...editing, product_id: e.target.value })} disabled={!!editing.id}>
                  <option value="">— select —</option>
                  {firms.filter(f => (f.kind || 'product') === 'analyst' || (f.kind || 'product') === 'news').map(f => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </label>
              <label>Event name
                <input type="text" value={editing.name || ''} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="Security & Risk Management Summit" />
              </label>
              <label>Region
                <select value={editing.region || ''} onChange={e => setEditing({ ...editing, region: e.target.value })}>
                  <option value="">—</option>
                  <option value="NA">North America</option>
                  <option value="EMEA">EMEA</option>
                  <option value="APAC">APAC</option>
                  <option value="Global">Global</option>
                </select>
              </label>
              <label>Location
                <input type="text" value={editing.location || ''} onChange={e => setEditing({ ...editing, location: e.target.value })} placeholder="National Harbor, MD" />
              </label>
              <label>Start date
                <input type="date" value={editing.start_date || ''} onChange={e => setEditing({ ...editing, start_date: e.target.value })} />
              </label>
              <label>End date
                <input type="date" value={editing.end_date || ''} onChange={e => setEditing({ ...editing, end_date: e.target.value })} />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>URL
                <input type="url" value={editing.url || ''} onChange={e => setEditing({ ...editing, url: e.target.value })} placeholder="https://…" />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>Topics
                <input type="text" value={editing.topics || ''} onChange={e => setEditing({ ...editing, topics: e.target.value })} placeholder="SIEM, SOC, UEBA" />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>Notes
                <textarea rows={3} value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} />
              </label>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button className="ghost" type="button" onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" onClick={saveConf} disabled={busy}>{busy ? 'Saving…' : (editing.id ? 'Update' : 'Add')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AnalystsHub() {
  const [firms, setFirms] = useState([]);
  const [sources, setSources] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState('all'); // 'all' | firm.id (string)
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.get('/products'), api.get('/sources'), api.get('/raw-items')])
      .then(([p, s, it]) => {
        const analystIds = new Set(p.filter(x => (x.kind || 'product') === 'analyst').map(x => x.id));
        setFirms(p.filter(x => (x.kind || 'product') === 'analyst'));
        setSources(s.filter(src => analystIds.has(src.product_id)));
        setItems(it.filter(r => analystIds.has(r.product_id)));
      })
      .catch(e => window.toast && window.toast(e.message, 'error'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  useRefresh(load);

  // Per-firm rollup (used by sidebar + overview tiles)
  const firmStats = useMemo(() => {
    return firms.map(f => {
      const firmItems = items.filter(it => it.product_id === f.id);
      const firmSources = sources.filter(s => s.product_id === f.id);
      const sorted = [...firmItems].sort((a, b) => (b.published_at || b.fetched_at || '').localeCompare(a.published_at || a.fetched_at || ''));
      const last30 = firmItems.filter(it => {
        const d = it.published_at || it.fetched_at;
        return d && (Date.now() - new Date(d).getTime()) < 30 * 24 * 60 * 60 * 1000;
      }).length;
      return {
        ...f,
        sourceCount: firmSources.length,
        itemCount: firmItems.length,
        last30,
        latest: sorted[0] || null,
        items: sorted,
      };
    }).sort((a, b) => b.itemCount - a.itemCount || a.name.localeCompare(b.name));
  }, [firms, items, sources]);

  // Currently visible items based on left-sidebar selection + search
  const q = search.trim().toLowerCase();
  const matchSearch = (it) => !q ||
    (it.title || '').toLowerCase().includes(q) ||
    (it.content || '').toLowerCase().includes(q);
  const matchDate = (it) => !dateFilter || (it.published_at || it.fetched_at || '').slice(0, 10) === dateFilter;
  const visibleItems = useMemo(() => {
    const base = selected === 'all' ? items : items.filter(it => it.product_id === +selected);
    return base
      .filter(matchSearch)
      .filter(matchDate)
      .sort((a, b) => (b.published_at || b.fetched_at || '').localeCompare(a.published_at || a.fetched_at || ''));
  }, [selected, items, q, dateFilter]);
  const itemsCtl = usePaginated(visibleItems, { defaultSize: 25, sizes: [10, 25, 50, 100] });

  if (loading) return <LoadingState label="Loading analyst firms…" />;

  const fmtDate = (s) => {
    if (!s) return '—';
    const d = new Date(s);
    if (isNaN(d)) return s.slice(0, 10);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const relativeDate = (s) => {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d)) return '';
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  };

  const firmsByName = Object.fromEntries(firms.map(f => [f.id, f]));
  const totalItems = items.length;
  const totalRecent = items.filter(it => {
    const d = it.published_at || it.fetched_at;
    return d && (Date.now() - new Date(d).getTime()) < 30 * 24 * 60 * 60 * 1000;
  }).length;
  const selectedFirm = selected === 'all' ? null : firmStats.find(f => String(f.id) === selected);

  const ItemCard = ({ it, showFirm }) => {
    const firm = firmsByName[it.product_id];
    return (
      <div style={{
        padding: '14px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, lineHeight: 1.4, fontWeight: 500 }}>
              {it.url
                ? <a href={it.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text)' }}>{it.title}</a>
                : it.title}
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {showFirm && firm && (
                <span className="badge" style={{ background: 'var(--accent)', color: 'white' }}>{firm.name}</span>
              )}
              <span title={it.published_at || it.fetched_at}>{fmtDate(it.published_at || it.fetched_at)}</span>
              <span style={{ opacity: 0.7 }}>· {relativeDate(it.published_at || it.fetched_at)}</span>
              {it.status === 'analyzed' && <span style={{ color: 'var(--good)' }}>✓ analyzed</span>}
            </div>
          </div>
          {it.url && (
            <a href={it.url} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 4, textDecoration: 'none',
                       background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)' }}>
              Read ↗
            </a>
          )}
        </div>
        {it.content && (
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 2 }}>
            {it.content.replace(/\s+/g, ' ').slice(0, 280)}{it.content.length > 280 ? '…' : ''}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="toolbar">
        <h2><Icon name="analysts" size={22} /> Analyst Firms</h2>
        <div className="row">
          <span className="muted" style={{ fontSize: 12 }}>
            {firms.length} firm{firms.length === 1 ? '' : 's'} · {totalItems} item{totalItems === 1 ? '' : 's'} · {totalRecent} in last 30 days
          </span>
          <button className="ghost" onClick={() => window.pmNavigate && window.pmNavigate('settings/analysts')} title="Add firms or manage feeds">
            <Icon name="settings" size={14} /> Manage
          </button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: -4, marginBottom: 12 }}>
        What each industry analyst (Gartner, Forrester, IDC, KuppingerCole…) is publishing.
        Pick a firm on the left to see only their items. Most flagship reports are paywalled — what's tracked is the public blog/press feed.
      </p>

      <div className="analysts-layout">
        {/* === Left sidebar: firm picker === */}
        <aside className="analysts-sidebar">
          <button
            className={'analysts-firm-btn' + (selected === 'all' ? ' active' : '')}
            onClick={() => setSelected('all')}
            type="button"
          >
            <span className="analysts-firm-name">All firms</span>
            <span className="analysts-firm-count">{totalItems}</span>
          </button>
          <div className="analysts-firm-divider" />
          {firmStats.map(f => (
            <button
              key={f.id}
              className={'analysts-firm-btn' + (String(f.id) === selected ? ' active' : '')}
              onClick={() => setSelected(String(f.id))}
              type="button"
              title={f.itemCount === 0 ? 'No items ingested yet' : `${f.itemCount} items · ${f.last30} in last 30d`}
            >
              <span className="analysts-firm-name">
                {f.name}
                {f.itemCount === 0 && <span className="analysts-firm-empty"> empty</span>}
              </span>
              <span className="analysts-firm-count">{f.itemCount}</span>
            </button>
          ))}
        </aside>

        {/* === Right pane: details === */}
        <section className="analysts-content">
          {selected === 'all' ? (
            <>
              {/* Overview: compact firm chips (click to filter to that firm) */}
              <div className="firm-chip-row">
                {firmStats.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    className={`firm-chip${f.itemCount === 0 ? ' empty' : ''}`}
                    onClick={() => setSelected(String(f.id))}
                    title={`${f.itemCount} item${f.itemCount === 1 ? '' : 's'} · ${f.last30} in last 30d`}
                  >
                    <span className="firm-chip-name">{f.name}</span>
                    <span className="firm-chip-count">{f.itemCount}</span>
                    {f.last30 > 0 && <span className="firm-chip-badge">+{f.last30}</span>}
                  </button>
                ))}
              </div>

              <ConferencesPanel firms={firms} />

              {/* Unified chronological feed */}
              <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <input
                  type="text"
                  placeholder="Search title/content…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ width: 220 }}
                />
                <DatePill value={dateFilter} onChange={setDateFilter} title="Filter by published date" />
              </div>
              {visibleItems.length === 0 ? (
                <div className="muted" style={{ padding: 20, textAlign: 'center', background: 'var(--panel-2)', borderRadius: 10 }}>
                  {q ? `No items match "${search}"` : 'No items ingested yet. Add feeds in Catalog → Analysts and click "Refresh all".'}
                </div>
              ) : (
                <>
                  <Paginator ctl={itemsCtl} label="items" />
                  <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                    {itemsCtl.slice.map(it => <ItemCard key={it.id} it={it} showFirm />)}
                  </div>
                  <Paginator ctl={itemsCtl} label="items" />
                </>
              )}
            </>
          ) : selectedFirm ? (
            <>
              {/* Firm header */}
              <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 18, marginBottom: 16 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h2 style={{ margin: '0 0 4px 0', fontSize: 22 }}>{selectedFirm.name}</h2>
                    {selectedFirm.vendor && selectedFirm.vendor !== selectedFirm.name && (
                      <div className="muted" style={{ fontSize: 13 }}>{selectedFirm.vendor}</div>
                    )}
                    {selectedFirm.website && (
                      <a href={selectedFirm.website} target="_blank" rel="noopener noreferrer"
                         style={{ color: 'var(--accent)', fontSize: 12, display: 'inline-block', marginTop: 6 }}>
                        {selectedFirm.website} ↗
                      </a>
                    )}
                    {selectedFirm.notes && (
                      <p style={{ marginTop: 10, marginBottom: 0, fontSize: 13, lineHeight: 1.5 }}>{selectedFirm.notes}</p>
                    )}
                  </div>
                  <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ textAlign: 'center', minWidth: 60 }}>
                      <div style={{ fontSize: 22, fontWeight: 600 }}>{selectedFirm.itemCount}</div>
                      <div className="muted" style={{ fontSize: 11 }}>items</div>
                    </div>
                    <div style={{ textAlign: 'center', minWidth: 60 }}>
                      <div style={{ fontSize: 22, fontWeight: 600, color: selectedFirm.last30 > 0 ? 'var(--good)' : 'var(--muted)' }}>{selectedFirm.last30}</div>
                      <div className="muted" style={{ fontSize: 11 }}>last 30d</div>
                    </div>
                    <div style={{ textAlign: 'center', minWidth: 60 }}>
                      <div style={{ fontSize: 22, fontWeight: 600 }}>{selectedFirm.sourceCount}</div>
                      <div className="muted" style={{ fontSize: 11 }}>feed{selectedFirm.sourceCount === 1 ? '' : 's'}</div>
                    </div>
                  </div>
                </div>
                {(selectedFirm.pros || selectedFirm.cons || selectedFirm.roadmap) && (
                  <div className="row" style={{ gap: 12, marginTop: 14, alignItems: 'stretch' }}>
                    {selectedFirm.pros && <div style={{ flex: 1, background: 'var(--panel-2)', padding: 10, borderRadius: 6, borderLeft: '3px solid var(--good)' }}>
                      <div className="label" style={{ color: 'var(--good)', fontSize: 11 }}>VIEW: STRENGTHS</div>
                      <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 4 }}>{selectedFirm.pros}</div>
                    </div>}
                    {selectedFirm.cons && <div style={{ flex: 1, background: 'var(--panel-2)', padding: 10, borderRadius: 6, borderLeft: '3px solid var(--bad)' }}>
                      <div className="label" style={{ color: '#fca5a5', fontSize: 11 }}>VIEW: WEAKNESSES</div>
                      <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 4 }}>{selectedFirm.cons}</div>
                    </div>}
                    {selectedFirm.roadmap && <div style={{ flex: 1, background: 'var(--panel-2)', padding: 10, borderRadius: 6, borderLeft: '3px solid var(--accent)' }}>
                      <div className="label" style={{ color: 'var(--accent)', fontSize: 11 }}>OUTLOOK</div>
                      <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 4 }}>{selectedFirm.roadmap}</div>
                    </div>}
                  </div>
                )}
              </div>

              <ConferencesPanel firmId={selectedFirm.id} firmName={selectedFirm.name} firms={firms} />

              {/* This firm's published items */}
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <h3 style={{ margin: 0, fontSize: 15 }}>What {selectedFirm.name} has published</h3>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder={`Search ${selectedFirm.name} items…`}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    style={{ width: 220 }}
                  />
                  <DatePill value={dateFilter} onChange={setDateFilter} title="Filter by published date" />
                </div>
              </div>
              {visibleItems.length === 0 ? (
                <div className="muted" style={{ padding: 20, textAlign: 'center', background: 'var(--panel-2)', borderRadius: 10 }}>
                  {q
                    ? `No items match "${search}"`
                    : selectedFirm.sourceCount === 0
                      ? 'No feeds configured for this firm. Add an RSS source in Catalog → Analysts, or paste a report excerpt.'
                      : 'No items ingested yet. Click "Refresh all analyst feeds" in Catalog → Analysts.'}
                </div>
              ) : (
                <>
                  <Paginator ctl={itemsCtl} label="items" />
                  <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                    {itemsCtl.slice.map(it => <ItemCard key={it.id} it={it} showFirm={false} />)}
                  </div>
                  <Paginator ctl={itemsCtl} label="items" />
                </>
              )}
            </>
          ) : (
            <p className="muted">Firm not found.</p>
          )}
        </section>
      </div>
    </>
  );
}

// ============================================================================
// Industry News  ------------------------------------------------------------
// "News" kind products (e.g. "Industry News") aggregate security press wire
// feeds — Dark Reading, SecurityWeek, etc. Kept separate from analyst firms
// (research) and from competitor products (Feed).
// ============================================================================
function IndustryNewsHub() {
  const [firms, setFirms] = useState([]);
  const [sources, setSources] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [outlet, setOutlet] = useState('all'); // source.id or 'all'
  const [dateFilter, setDateFilter] = useState('');

  const load = useCallback(() => {
    Promise.all([api.get('/products'), api.get('/sources'), api.get('/raw-items')])
      .then(([p, s, it]) => {
        const newsIds = new Set(p.filter(x => (x.kind || 'product') === 'news').map(x => x.id));
        setFirms(p.filter(x => (x.kind || 'product') === 'news'));
        setSources(s.filter(src => newsIds.has(src.product_id)));
        setItems(it.filter(r => newsIds.has(r.product_id)));
      })
      .catch(e => window.toast && window.toast(e.message, 'error'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  useRefresh(load);

  const outletStats = useMemo(() => {
    return sources.map(s => {
      const sItems = items.filter(it => it.source_id === s.id);
      const last30 = sItems.filter(it => {
        const d = new Date(it.published_at || it.fetched_at);
        return !isNaN(d) && (Date.now() - d.getTime()) < 30 * 86400000;
      }).length;
      const latest = sItems.sort((a, b) => new Date(b.published_at || b.fetched_at) - new Date(a.published_at || a.fetched_at))[0];
      return { ...s, itemCount: sItems.length, last30, latest };
    }).sort((a, b) => b.last30 - a.last30);
  }, [sources, items]);

  const q = search.trim().toLowerCase();
  const visibleItems = useMemo(() => {
    let arr = items;
    if (outlet !== 'all') arr = arr.filter(it => String(it.source_id) === outlet);
    if (q) arr = arr.filter(it => (it.title || '').toLowerCase().includes(q) || (it.content || '').toLowerCase().includes(q));
    if (dateFilter) arr = arr.filter(it => (it.published_at || it.fetched_at || '').slice(0, 10) === dateFilter);
    return arr.sort((a, b) => new Date(b.published_at || b.fetched_at) - new Date(a.published_at || a.fetched_at));
  }, [items, outlet, q, dateFilter]);

  const itemsCtl = usePaginated(visibleItems, { defaultPageSize: 25 });
  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const results = [];
      for (const s of sources) {
        try { const r = await api.post(`/sources/${s.id}/run?auto=0`); results.push(r); }
        catch (e) { results.push({ error: e.message }); }
      }
      const total = results.reduce((a, r) => a + (r.inserted || 0), 0);
      window.toast(`Refreshed ${sources.length} news feeds · ${total} new items`, 'success');
      load();
    } finally { setRefreshing(false); }
  };

  if (loading) return <LoadingState label="Loading industry news…" />;

  const fmtDate = (s) => {
    if (!s) return '—';
    const d = new Date(s);
    if (isNaN(d)) return s.slice(0, 10);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const relativeDate = (s) => {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d)) return '';
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  };

  if (firms.length === 0) {
    return (
      <>
        <div className="toolbar"><h2><Icon name="feed" size={22} /> Industry News</h2></div>
        <div className="muted" style={{ padding: 24, textAlign: 'center', background: 'var(--panel-2)', borderRadius: 10 }}>
          No news outlets configured. Add a "news" product and feeds in Settings → Industry News.
        </div>
      </>
    );
  }

  const ItemCard = ({ it }) => {
    const src = sources.find(s => s.id === it.source_id);
    return (
      <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 4 }}>
              {src && <span className="badge" style={{ fontSize: 10 }}>{src.label || (src.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}</span>}
              <span className="muted" style={{ fontSize: 11 }}>{fmtDate(it.published_at || it.fetched_at)} · {relativeDate(it.published_at || it.fetched_at)}</span>
              {it.status === 'analyzed' && <span className="muted" style={{ fontSize: 11, color: 'var(--ok)' }}>✓ analyzed</span>}
            </div>
            <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.4 }}>
              {it.url
                ? <a href={it.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text)' }}>{it.title || '(untitled)'}</a>
                : (it.title || '(untitled)')}
            </div>
            {it.content && (
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
                {String(it.content).slice(0, 280)}{it.content.length > 280 ? '…' : ''}
              </div>
            )}
          </div>
          {it.url && (
            <a href={it.url} target="_blank" rel="noopener noreferrer" className="ghost" style={{ fontSize: 11, padding: '4px 8px', whiteSpace: 'nowrap' }}>Read ↗</a>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="toolbar">
        <h2><Icon name="feed" size={22} /> Industry News</h2>
        <div className="row">
          <button onClick={refreshAll} disabled={refreshing || sources.length === 0}>
            {refreshing ? 'Refreshing…' : <><Icon name="refresh" size={14} /> Refresh all</>}
          </button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: -4 }}>
        Security press wire feeds — independent of competitor product news and analyst research.
      </p>

      <div className="analysts-layout">
        <aside className="analysts-sidebar">
          <button
            className={'analysts-firm-btn' + (outlet === 'all' ? ' active' : '')}
            onClick={() => setOutlet('all')}
          >
            <span>All outlets</span>
            <span className="analysts-firm-count">{items.length}</span>
          </button>
          <div style={{ height: 8 }} />
          {outletStats.map(s => (
            <button
              key={s.id}
              className={'analysts-firm-btn' + (outlet === String(s.id) ? ' active' : '') + (s.itemCount === 0 ? ' analysts-firm-empty' : '')}
              onClick={() => setOutlet(String(s.id))}
              title={s.url}
            >
              <span>{s.label || (s.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}</span>
              <span className="analysts-firm-count">{s.itemCount}</span>
            </button>
          ))}
        </aside>

        <section className="analysts-content">
          {outlet === 'all' ? (
            <>
              <div className="firm-chip-row">
                {outletStats.map(s => {
                  const label = s.label || (s.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`firm-chip${s.itemCount === 0 ? ' empty' : ''}`}
                      onClick={() => setOutlet(String(s.id))}
                      title={`${s.itemCount} item${s.itemCount === 1 ? '' : 's'} · ${s.last30} in last 30d`}
                    >
                      <span className="firm-chip-name">{label}</span>
                      <span className="firm-chip-count">{s.itemCount}</span>
                      {s.last30 > 0 && <span className="firm-chip-badge">+{s.last30}</span>}
                    </button>
                  );
                })}
              </div>
              <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <input type="text" placeholder="Search title/content…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 220 }} />
                <DatePill value={dateFilter} onChange={setDateFilter} title="Filter by published date" />
              </div>
            </>
          ) : (() => {
            const s = sources.find(x => String(x.id) === outlet);
            return (
              <>
                <div className="dash-widget" style={{ marginBottom: 16 }}>
                  <h2 style={{ margin: '0 0 4px' }}>{s ? (s.label || (s.url || '')) : 'Outlet'}</h2>
                  {s && s.url && <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontSize: 12 }}>{s.url}</a>}
                </div>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <h3 style={{ margin: 0, fontSize: 15 }}>Recent stories</h3>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <input type="text" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200 }} />
                    <DatePill value={dateFilter} onChange={setDateFilter} title="Filter by published date" />
                  </div>
                </div>
              </>
            );
          })()}

          {visibleItems.length === 0 ? (
            <div className="muted" style={{ padding: 20, textAlign: 'center', background: 'var(--panel-2)', borderRadius: 10 }}>
              {q ? `No items match "${search}"` : 'No items yet — click Refresh all.'}
            </div>
          ) : (
            <>
              <Paginator ctl={itemsCtl} label="items" />
              <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                {itemsCtl.slice.map(it => <ItemCard key={it.id} it={it} />)}
              </div>
              <Paginator ctl={itemsCtl} label="items" />
            </>
          )}
        </section>
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------
// IndustryNewsAdmin — slim Catalog-style management for news outlets/feeds.
// Used in Settings → Industry News.
// ----------------------------------------------------------------------------
function IndustryNewsAdmin({ embedded = false }) {
  const [firms, setFirms] = useState([]);
  const [sources, setSources] = useState([]);
  const [busy, setBusy] = useState({});
  const [editing, setEditing] = useState(null);
  const load = useCallback(() => {
    Promise.all([api.get('/products'), api.get('/sources')])
      .then(([p, s]) => {
        const ids = new Set(p.filter(x => (x.kind || 'product') === 'news').map(x => x.id));
        setFirms(p.filter(x => (x.kind || 'product') === 'news'));
        setSources(s.filter(src => ids.has(src.product_id)));
      }).catch(e => window.toast && window.toast(e.message, 'error'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const setBusyKey = (k, v) => setBusy(prev => ({ ...prev, [k]: v }));
  const saveFirm = async (form) => {
    if (form.id) await api.put('/products/' + form.id, { ...form, kind: 'news' });
    else await api.post('/products', { ...form, kind: 'news', is_own: 0 });
    setEditing(null); load();
  };
  const fetchOne = async (s) => {
    setBusyKey('s' + s.id, true);
    try { const r = await api.post(`/sources/${s.id}/run?auto=0`); window.toast(`Fetched ${r.fetched} · new ${r.inserted}`, 'success'); load(); }
    catch (e) { window.toast(e.message, 'error'); }
    finally { setBusyKey('s' + s.id, false); }
  };
  const fetchAll = async () => {
    setBusyKey('all', true);
    try {
      let totalInserted = 0, errs = 0;
      for (const s of sources) {
        try { const r = await api.post(`/sources/${s.id}/run?auto=0`); totalInserted += r.inserted || 0; }
        catch (e) { errs++; }
      }
      window.toast(`Refreshed ${sources.length} news feeds · ${totalInserted} new${errs ? ` · ${errs} error${errs === 1 ? '' : 's'}` : ''}`, errs ? 'error' : 'success');
      load();
    } finally { setBusyKey('all', false); }
  };
  const fetchFirm = async (firmId) => {
    setBusyKey('f' + firmId, true);
    try {
      const firmSources = sources.filter(s => s.product_id === firmId);
      let totalInserted = 0, errs = 0;
      for (const s of firmSources) {
        try { const r = await api.post(`/sources/${s.id}/run?auto=0`); totalInserted += r.inserted || 0; }
        catch (e) { errs++; }
      }
      window.toast(`Refreshed ${firmSources.length} feeds · ${totalInserted} new${errs ? ` · ${errs} error${errs === 1 ? '' : 's'}` : ''}`, errs ? 'error' : 'success');
      load();
    } finally { setBusyKey('f' + firmId, false); }
  };
  const addSource = async (firm) => {
    const url = prompt(`RSS URL for ${firm.name}`);
    if (!url) return;
    const label = prompt('Label (e.g. Dark Reading)') || '';
    const kind = url.match(/(rss|atom|feed|\.xml)/i) ? 'rss' : 'html';
    await api.post('/sources', { product_id: firm.id, kind, url, label });
    load();
  };
  const deleteSource = async (s) => {
    if (!confirm(`Delete source "${s.label || s.url}"?`)) return;
    await api.delete('/sources/' + s.id);
    load();
  };

  return (
    <>
      <div className="toolbar">
        {!embedded && <h2><Icon name="feed" size={22} /> Industry News</h2>}
        {embedded && <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="feed" size={18} /> Industry News</h3>}
        <div className="row">
          <button className="ghost" onClick={() => setEditing({ name: '', vendor: '', website: '', notes: '' })}>+ Add news firm</button>
          <button onClick={fetchAll} disabled={busy.all || sources.length === 0}>{busy.all ? 'Fetching…' : <><Icon name="refresh" size={14} /> Fetch all</>}</button>
        </div>
      </div>
      <p className="muted">
        Group multiple security press feeds (Dark Reading, SecurityWeek, CSO Online…) under one "news firm" entry. Items appear in the Industry News tab — separate from competitor product news.
      </p>

      {firms.map(firm => {
        const firmSources = sources.filter(s => s.product_id === firm.id);
        return (
          <div key={firm.id} style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ margin: '0 0 4px 0' }}>{firm.name}</h3>
                {firm.website && <a href={firm.website} target="_blank" style={{ color: 'var(--accent)', fontSize: 12 }}>{firm.website}</a>}
                {firm.notes && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{firm.notes}</div>}
              </div>
              <div className="row">
                <button className="ghost" onClick={() => setEditing(firm)}>Edit</button>
                <button className="ghost" onClick={() => addSource(firm)}>+ Source</button>
                <button className="ghost" disabled={busy['f' + firm.id] || firmSources.length === 0} onClick={() => fetchFirm(firm.id)}>{busy['f' + firm.id] ? 'Fetching…' : 'Fetch all'}</button>
              </div>
            </div>
            {firmSources.length > 0 && (
              <table style={{ width: '100%', marginTop: 12, fontSize: 13 }}>
                <thead>
                  <tr><th style={{ textAlign: 'left' }}>Outlet</th><th style={{ textAlign: 'left' }}>URL</th><th>Kind</th><th></th></tr>
                </thead>
                <tbody>
                  {firmSources.map(s => (
                    <tr key={s.id}>
                      <td>{s.label || '—'}</td>
                      <td style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <a href={s.url} target="_blank" style={{ color: 'var(--accent)' }}>{s.url}</a>
                      </td>
                      <td style={{ textAlign: 'center' }}><span className="badge">{s.kind}</span></td>
                      <td className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                        <button className="ghost" disabled={busy['s' + s.id]} onClick={() => fetchOne(s)}>{busy['s' + s.id] ? '…' : 'Fetch'}</button>
                        <button className="ghost" onClick={() => deleteSource(s)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {firmSources.length === 0 && <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>No feeds yet — click "+ Source".</div>}
          </div>
        );
      })}

      {editing && (
        <Modal onClose={() => setEditing(null)}>
          <h3 style={{ margin: '0 0 12px' }}>{editing.id ? 'Edit news firm' : 'New news firm'}</h3>
          <div style={{ display: 'grid', gap: 10 }}>
            <label>Name<input type="text" value={editing.name || ''} onChange={e => setEditing({ ...editing, name: e.target.value })} /></label>
            <label>Website<input type="text" value={editing.website || ''} onChange={e => setEditing({ ...editing, website: e.target.value })} /></label>
            <label>Notes<textarea rows={3} value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} /></label>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
            <button className="primary" onClick={() => saveFirm(editing)}>Save</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ============================================================================
// AnalystDashboard — at-a-glance view of analyst-firm activity.
// ============================================================================
function AnalystDashboard() {
  const [firms, setFirms] = useState([]);
  const [sources, setSources] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    Promise.all([api.get('/products'), api.get('/sources'), api.get('/raw-items')])
      .then(([p, s, it]) => {
        const ids = new Set(p.filter(x => (x.kind || 'product') === 'analyst').map(x => x.id));
        setFirms(p.filter(x => (x.kind || 'product') === 'analyst'));
        setSources(s.filter(src => ids.has(src.product_id)));
        setItems(it.filter(r => ids.has(r.product_id)));
      }).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  useRefresh(load);

  if (error) return <div className="empty-state"><Icon name="alert" size={28} /><p>Error: {error}</p></div>;
  if (loading) return <LoadingState label="Loading analyst dashboard…" />;

  const now = Date.now();
  const last30 = items.filter(i => { const d = new Date(i.published_at || i.fetched_at); return !isNaN(d) && (now - d.getTime()) < 30 * 86400000; });
  const last7  = items.filter(i => { const d = new Date(i.published_at || i.fetched_at); return !isNaN(d) && (now - d.getTime()) < 7  * 86400000; });
  const analyzedCount = items.filter(i => i.status === 'analyzed').length;

  const firmStats = firms.map(f => {
    const fItems = items.filter(it => it.product_id === f.id);
    const fLast30 = fItems.filter(it => { const d = new Date(it.published_at || it.fetched_at); return !isNaN(d) && (now - d.getTime()) < 30 * 86400000; }).length;
    const latest = fItems.sort((a, b) => new Date(b.published_at || b.fetched_at) - new Date(a.published_at || a.fetched_at))[0];
    return { ...f, itemCount: fItems.length, last30: fLast30, latest };
  }).sort((a, b) => b.last30 - a.last30);

  // Activity sparkline: items per day for last 14 days
  const days = 14;
  const buckets = new Array(days).fill(0);
  items.forEach(it => {
    const d = new Date(it.published_at || it.fetched_at);
    if (isNaN(d)) return;
    const ago = Math.floor((now - d.getTime()) / 86400000);
    if (ago >= 0 && ago < days) buckets[days - 1 - ago]++;
  });

  const recent = items
    .slice()
    .sort((a, b) => new Date(b.published_at || b.fetched_at) - new Date(a.published_at || a.fetched_at))
    .slice(0, 8);

  return (
    <>
      <div className="toolbar">
        <h2><Icon name="analysts" size={22} /> Analyst Dashboard</h2>
        <div className="row meta" style={{ fontSize: 12 }}><Icon name="clock" size={12} /> Updated {new Date().toLocaleTimeString()}</div>
      </div>

      <div className="stat-grid">
        <StatCard icon="analysts" label="Analyst firms"     value={firms.length}     accent="violet" hint="Configured analyst firms" onClick={() => window.pmNavigate('feed/analysts')} />
        <StatCard icon="feed"     label="Items (all-time)"  value={items.length}     accent="cyan"   hint="All ingested analyst items" />
        <StatCard icon="rocket"   label="Last 30 days"      value={last30.length}    accent="amber"  hint="Items published in last 30 days" />
        <StatCard icon="sparkles" label="Last 7 days"       value={last7.length}     accent="emerald" hint="Items published in last 7 days" />
      </div>

      <div className="dash-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <div className="dash-widget">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>14-day publishing activity</h3>
            <span className="muted" style={{ fontSize: 11 }}>{buckets.reduce((a, b) => a + b, 0)} items</span>
          </div>
          <Sparkline values={buckets} color="var(--accent)" height={80} width={340} />
        </div>
        <div className="dash-widget">
          <h3 style={{ margin: 0, fontSize: 15, marginBottom: 8 }}>Coverage</h3>
          <div className="row" style={{ gap: 16, fontSize: 13 }}>
            <span><strong>{sources.length}</strong> <span className="muted">feeds</span></span>
            <span><strong>{analyzedCount}</strong> <span className="muted">analyzed</span></span>
            <span><strong>{items.length - analyzedCount}</strong> <span className="muted">pending</span></span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {firms.filter(f => sources.some(s => s.product_id === f.id)).length} of {firms.length} firms have at least one feed configured.
          </div>
        </div>
      </div>

      <div className="dash-widget" style={{ marginTop: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15, marginBottom: 12 }}>Most active firms (last 30 days)</h3>
        {firmStats.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No firms configured.</div>
        ) : (
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead><tr><th style={{ textAlign: 'left' }}>Firm</th><th>Total</th><th>Last 30d</th><th style={{ textAlign: 'left' }}>Latest</th></tr></thead>
            <tbody>
              {firmStats.slice(0, 8).map(f => (
                <tr key={f.id}>
                  <td><strong>{f.name}</strong></td>
                  <td style={{ textAlign: 'center' }}>{f.itemCount}</td>
                  <td style={{ textAlign: 'center' }}>{f.last30}</td>
                  <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.latest ? (f.latest.url
                      ? <a href={f.latest.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{f.latest.title}</a>
                      : f.latest.title) : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="dash-widget" style={{ marginTop: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15, marginBottom: 12 }}>Recent items</h3>
        {recent.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No items yet.</div>
        ) : recent.map(it => {
          const firm = firms.find(f => f.id === it.product_id);
          return (
            <div key={it.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 2 }}>
                {firm && <span className="badge" style={{ fontSize: 10 }}>{firm.name}</span>}
                <span className="muted" style={{ fontSize: 11 }}>{new Date(it.published_at || it.fetched_at).toLocaleDateString()}</span>
              </div>
              <div style={{ fontSize: 13 }}>
                {it.url ? <a href={it.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text)' }}>{it.title}</a> : it.title}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ============================================================================
// NewsDashboard — at-a-glance view of industry news activity.
// ============================================================================
function NewsDashboard() {
  const [firms, setFirms] = useState([]);
  const [sources, setSources] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    Promise.all([api.get('/products'), api.get('/sources'), api.get('/raw-items')])
      .then(([p, s, it]) => {
        const ids = new Set(p.filter(x => (x.kind || 'product') === 'news').map(x => x.id));
        setFirms(p.filter(x => (x.kind || 'product') === 'news'));
        setSources(s.filter(src => ids.has(src.product_id)));
        setItems(it.filter(r => ids.has(r.product_id)));
      }).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  useRefresh(load);

  if (error) return <div className="empty-state"><Icon name="alert" size={28} /><p>Error: {error}</p></div>;
  if (loading) return <LoadingState label="Loading news dashboard…" />;

  const now = Date.now();
  const last24h = items.filter(i => { const d = new Date(i.published_at || i.fetched_at); return !isNaN(d) && (now - d.getTime()) < 86400000; });
  const last7   = items.filter(i => { const d = new Date(i.published_at || i.fetched_at); return !isNaN(d) && (now - d.getTime()) < 7 * 86400000; });
  const last30  = items.filter(i => { const d = new Date(i.published_at || i.fetched_at); return !isNaN(d) && (now - d.getTime()) < 30 * 86400000; });

  const outletStats = sources.map(s => {
    const sItems = items.filter(it => it.source_id === s.id);
    const sLast30 = sItems.filter(it => { const d = new Date(it.published_at || it.fetched_at); return !isNaN(d) && (now - d.getTime()) < 30 * 86400000; }).length;
    return { ...s, itemCount: sItems.length, last30: sLast30 };
  }).sort((a, b) => b.last30 - a.last30);

  const days = 14;
  const buckets = new Array(days).fill(0);
  items.forEach(it => {
    const d = new Date(it.published_at || it.fetched_at);
    if (isNaN(d)) return;
    const ago = Math.floor((now - d.getTime()) / 86400000);
    if (ago >= 0 && ago < days) buckets[days - 1 - ago]++;
  });

  const palette = ['#6366f1', '#8b5cf6', '#22d3ee', '#f59e0b', '#10b981', '#ef4444', '#ec4899'];
  const donutSegs = outletStats.slice(0, 6).map((s, i) => ({
    label: s.label || (s.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
    value: s.last30,
    color: palette[i % palette.length],
  })).filter(seg => seg.value > 0);

  const recent = items
    .slice()
    .sort((a, b) => new Date(b.published_at || b.fetched_at) - new Date(a.published_at || a.fetched_at))
    .slice(0, 10);

  return (
    <>
      <div className="toolbar">
        <h2><Icon name="feed" size={22} /> News Dashboard</h2>
        <div className="row meta" style={{ fontSize: 12 }}><Icon name="clock" size={12} /> Updated {new Date().toLocaleTimeString()}</div>
      </div>

      <div className="stat-grid">
        <StatCard icon="feed"     label="Outlets"      value={sources.length}  accent="violet"  hint="News feeds configured" onClick={() => window.pmNavigate('feed/news')} />
        <StatCard icon="layers"   label="All items"    value={items.length}    accent="cyan"    hint="Total ingested news items" />
        <StatCard icon="rocket"   label="Last 7 days"  value={last7.length}    accent="amber"   hint="Items published in last 7 days" />
        <StatCard icon="sparkles" label="Last 24h"     value={last24h.length}  accent="emerald" hint="Items published in last 24 hours" />
      </div>

      <div className="dash-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <div className="dash-widget">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>14-day news volume</h3>
            <span className="muted" style={{ fontSize: 11 }}>{buckets.reduce((a, b) => a + b, 0)} items</span>
          </div>
          <Sparkline values={buckets} color="var(--accent)" height={80} width={340} />
        </div>
        <div className="dash-widget">
          <h3 style={{ margin: 0, fontSize: 15, marginBottom: 8 }}>Share of voice (last 30d)</h3>
          {donutSegs.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>No items in the last 30 days.</div>
          ) : (
            <div className="row" style={{ gap: 16, alignItems: 'center' }}>
              <Donut segments={donutSegs} size={110} thickness={14} />
              <div style={{ flex: 1, fontSize: 12 }}>
                {donutSegs.map(s => (
                  <div key={s.label} className="row" style={{ gap: 6, marginBottom: 4 }}>
                    <span style={{ width: 10, height: 10, background: s.color, borderRadius: 2 }} />
                    <span style={{ flex: 1 }}>{s.label}</span>
                    <strong>{s.value}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="dash-widget" style={{ marginTop: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15, marginBottom: 12 }}>Outlets ranked by recent activity</h3>
        {outletStats.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No outlets configured.</div>
        ) : (
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead><tr><th style={{ textAlign: 'left' }}>Outlet</th><th>Total</th><th>Last 30d</th></tr></thead>
            <tbody>
              {outletStats.map(s => (
                <tr key={s.id}>
                  <td>{s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{s.label || s.url}</a> : (s.label || '—')}</td>
                  <td style={{ textAlign: 'center' }}>{s.itemCount}</td>
                  <td style={{ textAlign: 'center' }}>{s.last30}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="dash-widget" style={{ marginTop: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15, marginBottom: 12 }}>Latest headlines</h3>
        {recent.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No items yet.</div>
        ) : recent.map(it => {
          const src = sources.find(s => s.id === it.source_id);
          return (
            <div key={it.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 2 }}>
                {src && <span className="badge" style={{ fontSize: 10 }}>{src.label || (src.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}</span>}
                <span className="muted" style={{ fontSize: 11 }}>{new Date(it.published_at || it.fetched_at).toLocaleString()}</span>
              </div>
              <div style={{ fontSize: 13 }}>
                {it.url ? <a href={it.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text)' }}>{it.title}</a> : it.title}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Modal({ children, onClose }) {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        {onClose && (
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18 M6 6l12 12"/></svg>
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

// Themed confirm dialog. Use as: <ConfirmDialog ... /> rendered conditionally.
function ConfirmDialog({ icon = '⚠️', title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onConfirm, onCancel, busy = false }) {
  return (
    <Modal onClose={busy ? () => {} : onCancel}>
      <div className="confirm-dialog">
        <div className={`confirm-icon ${danger ? 'danger' : ''}`}>{icon}</div>
        <h3 style={{margin:'0 0 6px'}}>{title}</h3>
        {message && <p className="meta" style={{margin:'0 0 16px', fontSize:13, lineHeight:1.5}}>{message}</p>}
        <div className="row" style={{justifyContent:'flex-end', gap:8}}>
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button type="button" className={danger ? 'danger' : ''} onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </div>
    </Modal>
  );
}

function Products() {
  const [items, setItems] = useState([]);
  const [editing, setEditing] = useState(null);
  const load = () => api.get('/products').then(rows => setItems(rows.filter(p => (p.kind||'product') === 'product' || p.is_own))).catch(e => console.error('Products load:', e));
  useEffect(() => { load(); }, []);
  useRefresh(load);
  const save = async (form) => {
    if (form.id) await api.put('/products/' + form.id, form);
    else await api.post('/products', { ...form, kind: 'product' });
    setEditing(null); load();
  };
  const del = async (id) => { if (confirm('Delete?')) { await api.del('/products/' + id); load(); } };
  return (
    <>
      <div className="toolbar">
        <h2>Products & Competitors</h2>
        <button onClick={() => setEditing({ name: '', is_own: 0, vendor: '', website: '', notes: '', pros: '', cons: '', roadmap: '' })}>+ Add product</button>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Vendor</th><th>Pros</th><th>Cons</th><th>Roadmap / plans</th><th></th></tr></thead>
        <tbody>
          {items.map(p => (
            <tr key={p.id}>
              <td>
                <strong>{p.name}</strong> {p.is_own ? <span className="badge own">OURS</span> : null}
                {p.website && <div><a href={p.website} target="_blank" style={{color:'var(--accent)',fontSize:11}}>{p.website}</a></div>}
              </td>
              <td className="meta">{p.vendor}</td>
              <td style={{maxWidth:240,whiteSpace:'pre-wrap',color:'var(--good)'}}>{p.pros||<span className="muted">—</span>}</td>
              <td style={{maxWidth:240,whiteSpace:'pre-wrap',color:'#fca5a5'}}>{p.cons||<span className="muted">—</span>}</td>
              <td style={{maxWidth:240,whiteSpace:'pre-wrap'}}>{p.roadmap||<span className="muted">—</span>}</td>
              <td className="row">
                <button className="ghost" onClick={() => setEditing(p)}>Edit</button>
                <button className="danger" onClick={() => del(p.id)}>×</button>
              </td>
            </tr>
          ))}
          {items.length===0 && <tr><td colSpan="6" className="muted">No products yet.</td></tr>}
        </tbody>
      </table>
      {editing && <ProductForm value={editing} onSave={save} onClose={() => setEditing(null)} />}
    </>
  );
}

function ProductForm({ value, onSave, onClose }) {
  const [f, setF] = useState(value);
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.value }));
  return (
    <Modal onClose={onClose}>
      <h3>{f.id ? 'Edit product' : 'Add product'}</h3>
      <div className="field"><label>Name</label><input value={f.name||''} onChange={set('name')} /></div>
      <div className="field"><label>Vendor</label><input value={f.vendor||''} onChange={set('vendor')} /></div>
      <div className="field"><label>Website</label><input value={f.website||''} onChange={set('website')} /></div>
      <div className="field"><label>Notes</label><textarea value={f.notes||''} onChange={set('notes')} rows="2" /></div>
      <div className="field"><label>Pros (strengths)</label><textarea value={f.pros||''} onChange={set('pros')} rows="3" placeholder="e.g. Strong UEBA, mature MITRE coverage…" /></div>
      <div className="field"><label>Cons (weaknesses)</label><textarea value={f.cons||''} onChange={set('cons')} rows="3" placeholder="e.g. High TCO, limited cloud-native ingestion…" /></div>
      <div className="field"><label>Roadmap / planned</label><textarea value={f.roadmap||''} onChange={set('roadmap')} rows="3" placeholder="What they've announced or hinted at next…" /></div>
      <div className="field"><label><input type="checkbox" style={{width:'auto', marginRight:6}} checked={!!f.is_own} onChange={e => setF(prev => ({...prev, is_own: e.target.checked ? 1 : 0}))} /> This is our product</label></div>
      <div className="row" style={{justifyContent:'flex-end'}}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button onClick={() => onSave(f)}>Save</button>
      </div>
    </Modal>
  );
}

function Releases() {
  const [items, setItems] = useState([]);
  const [products, setProducts] = useState([]);
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState(() => {
    const v = window.pmReleasesFilterProduct;
    if (v) { delete window.pmReleasesFilterProduct; return String(v); }
    return '';
  });
  const [dateFilter, setDateFilter] = useState('');
  const [error, setError] = useState(null);
  const load = () => {
    Promise.all([api.get('/releases'), api.get('/products')])
      .then(([r, p]) => { setItems(r); setProducts(p); })
      .catch(e => { console.error('Releases load error:', e); setError(e.message); });
  };
  useEffect(() => { load(); }, []);
  useRefresh(load);
  const productName = (id) => (products.find(p => p.id === id) || {}).name || '?';
  const save = async (form) => {
    if (form.id) await api.put('/releases/' + form.id, form);
    else await api.post('/releases', form);
    setEditing(null); load();
  };
  const del = async (id) => { if (confirm('Delete?')) { await api.del('/releases/' + id); load(); } };
  const filtered = items.filter(r =>
    (!filter || r.product_id === +filter) &&
    (!dateFilter || (r.release_date || '').slice(0, 10) === dateFilter)
  );
  const ctl = usePaginated(filtered);
  return (
    <>
      <div className="toolbar">
        <h2>Releases</h2>
        <div className="row">
          <SearchSelect
            value={filter}
            onChange={setFilter}
            width={220}
            icon="package"
            placeholder="All products"
            searchPlaceholder="Search products…"
            options={products.map(p => ({ value: String(p.id), label: p.name, hint: p.vendor || (p.is_own ? 'Own product' : '') }))}
          />
          <DatePill value={dateFilter} onChange={setDateFilter} title="Filter by release date" />
          <button onClick={() => setEditing({ product_id: String(products[0]?.id || ''), version: '', release_date: '', highlights: '', url: '' })}>+ Add release</button>
        </div>
      </div>
      {error && <p style={{color:'#f87171'}}>Error loading releases: {error}</p>}
      {!error && items.length === 0 && <LoadingState label="Loading releases…" size="sm" variant="inline" />}
      {filtered.length > 0 && (
        <div className="dash-widget">
          <Paginator ctl={ctl} label="releases" />
          {ctl.slice.map(r => {
            const ver = r.version && String(r.version).trim().toLowerCase() !== 'unknown' ? r.version : null;
            const date = r.release_date && String(r.release_date).trim().toLowerCase() !== 'unknown' ? r.release_date : null;
            return (
              <div key={r.id} className="timeline-item">
                <div className="release-head">
                  <div className="release-title">
                    <strong>{productName(r.product_id)}</strong>
                    {ver && <span className="release-version">{ver}</span>}
                    {r.auto_generated ? <span className="badge">🤖 auto</span> : null}
                  </div>
                  <div className="row-actions">
                    {r.url && (
                      <a href={r.url} target="_blank" rel="noreferrer" className="icon-btn ghost-icon" title={`Open: ${r.url}`} aria-label="Open release page">
                        <Icon name="external" size={14}/>
                      </a>
                    )}
                    <button className="icon-btn ghost-icon" onClick={() => setEditing(r)} title="Edit release" aria-label="Edit">
                      <Icon name="edit" size={14}/>
                    </button>
                    <button className="icon-btn ghost-icon danger-hover" onClick={() => del(r.id)} title="Delete release" aria-label="Delete">
                      <Icon name="trash" size={14}/>
                    </button>
                  </div>
                </div>
                {date && <div className="meta release-date">{date}</div>}
                {r.highlights && <div className="release-highlights">{r.highlights}</div>}
              </div>
            );
          })}
        </div>
      )}
      {editing && <ReleaseForm value={editing} products={products} onSave={save} onClose={() => setEditing(null)} />}
    </>
  );
}

function ReleaseForm({ value, products, onSave, onClose }) {
  const [f, setF] = useState(value);
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.value }));
  return (
    <Modal onClose={onClose}>
      <h3>{f.id ? 'Edit release' : 'Add release'}</h3>
      <div className="field"><label>Product</label>
        <select value={f.product_id||''} onChange={set('product_id')}>
          {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="field"><label>Version</label><input value={f.version||''} onChange={set('version')} /></div>
      <div className="field"><label>Release date</label><input type="date" value={f.release_date||''} onChange={set('release_date')} /></div>
      <div className="field"><label>Highlights</label><textarea value={f.highlights||''} onChange={set('highlights')} /></div>
      <div className="field"><label>URL</label><input value={f.url||''} onChange={set('url')} /></div>
      <div className="row" style={{justifyContent:'flex-end'}}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button onClick={() => onSave(f)}>Save</button>
      </div>
    </Modal>
  );
}

function Matrix() {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [features, setFeatures] = useState([]);
  const [showAddFeature, setShowAddFeature] = useState(false);
  const load = () => api.get('/analysis/matrix').then(d => { setData(d); setFeatures(d.features); }).catch(e => console.error('Matrix load:', e));
  useEffect(() => { load(); }, []);
  useRefresh(load);
  const matrixCtl = usePaginated(data?.features || [], { defaultSize: 25, sizes: [10, 25, 50, 100] });
  if (!data) return <LoadingState label="Building report…" />;
  const toggle = async (product_id, feature_id) => {
    const cur = data.support[`${product_id}:${feature_id}`];
    await api.put('/product-features', { product_id, feature_id, supported: cur ? !cur.supported : 1, since_version: cur?.since_version, notes: cur?.notes });
    load();
  };
  const editCell = (product_id, feature_id) => {
    const cur = data.support[`${product_id}:${feature_id}`] || { product_id, feature_id, supported: 0, since_version: '', notes: '' };
    setEditing({ ...cur, product_id, feature_id });
  };
  const saveCell = async (form) => { await api.put('/product-features', form); setEditing(null); load(); };
  const addFeature = async (form) => { await api.post('/features', form); setShowAddFeature(false); load(); };
  return (
    <>
      <div className="toolbar">
        <h2>Compatibility Matrix</h2>
        <div className="row">
          <span className="muted" style={{fontSize:12}}>Auto-built from analyzed feed entries · {data.features.length} features × {data.products.length} products</span>
        </div>
      </div>
      <div className="dash-widget matrix-widget">
        <div className="matrix-widget-head">
          <Paginator ctl={matrixCtl} label="features" />
        </div>
        <div className="matrix-scroll">
          <table className="matrix">
            <thead>
              <tr>
                <th className="matrix-col-feature">Feature</th>
                <th className="matrix-col-cat">Category</th>
                {data.products.map(p => <th key={p.id}>{p.name}{p.is_own ? ' ⭐' : ''}</th>)}
              </tr>
            </thead>
            <tbody>
              {matrixCtl.slice.map(f => (
                <tr key={f.id}>
                  <td className="matrix-col-feature">{f.name}</td>
                  <td className="matrix-col-cat"><span className="badge">{f.category}</span></td>
                  {data.products.map(p => {
                    const s = data.support[`${p.id}:${f.id}`];
                    const supp = s && s.supported;
                    return (
                      <td key={p.id} className="cell" title={s?.notes || ''}>
                        {supp ? <span className="yes">✓ {s.since_version || ''}</span> : <span className="no">✗</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {editing && <CellForm value={editing} onSave={saveCell} onClose={() => setEditing(null)} />}
      {showAddFeature && <FeatureForm onSave={addFeature} onClose={() => setShowAddFeature(false)} />}
    </>
  );
}

function CellForm({ value, onSave, onClose }) {
  const [f, setF] = useState(value);
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.value }));
  return (
    <Modal onClose={onClose}>
      <h3>Edit support</h3>
      <div className="field"><label><input type="checkbox" style={{width:'auto', marginRight:6}} checked={!!f.supported} onChange={e => setF(prev => ({...prev, supported: e.target.checked ? 1 : 0}))} /> Supported</label></div>
      <div className="field"><label>Since version</label><input value={f.since_version||''} onChange={e => setF(prev => ({...prev, since_version: e.target.value}))} /></div>
      <div className="field"><label>Notes</label><textarea value={f.notes||''} onChange={e => setF(prev => ({...prev, notes: e.target.value}))} /></div>
      <div className="row" style={{justifyContent:'flex-end'}}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button onClick={() => onSave(f)}>Save</button>
      </div>
    </Modal>
  );
}

function FeatureForm({ onSave, onClose }) {
  const [f, setF] = useState({ name: '', category: '', description: '' });
  return (
    <Modal onClose={onClose}>
      <h3>Add feature</h3>
      <div className="field"><label>Name</label><input value={f.name} onChange={e => setF(prev => ({...prev, name: e.target.value}))} /></div>
      <div className="field"><label>Category</label><input value={f.category} onChange={e => setF(prev => ({...prev, category: e.target.value}))} /></div>
      <div className="field"><label>Description</label><textarea value={f.description} onChange={e => setF(prev => ({...prev, description: e.target.value}))} /></div>
      <div className="row" style={{justifyContent:'flex-end'}}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button onClick={() => onSave(f)}>Save</button>
      </div>
    </Modal>
  );
}

function Gaps() {
  const [gaps, setGaps] = useState([]);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [search, setSearch] = useState('');
  const [evidenceCache, setEvidenceCache] = useState({}); // featureId -> {loading, data, error}
  useEffect(() => {
    api.get('/analysis/gaps')
      .then(setGaps)
      .catch(e => { console.error('Gaps load error:', e); setError(e.message); });
  }, []);
  const q = search.trim().toLowerCase();
  const filtered = !q ? gaps : gaps.filter(g => {
    const hay = [g.feature, g.category, g.competitors_supporting]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
  const ctl = usePaginated(filtered);
  const toggle = async (fid) => {
    const next = openId === fid ? null : fid;
    setOpenId(next);
    if (next && !evidenceCache[fid]) {
      setEvidenceCache(c => ({ ...c, [fid]: { loading: true } }));
      try {
        const data = await api.get('/analysis/feature-evidence/' + fid);
        setEvidenceCache(c => ({ ...c, [fid]: { data } }));
      } catch (e) {
        setEvidenceCache(c => ({ ...c, [fid]: { error: e.message } }));
      }
    }
  };
  const shortUrl = (u) => (u || '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 70);
  return (
    <>
      <h2>Gap Analysis</h2>
      <p className="muted">Features competitors support but our product does not. Click a row to see the source links each competitor used to introduce it.</p>
      {error && <p style={{color:'#f87171'}}>Error loading gaps: {error}</p>}
      <div className="dash-widget">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
          <div className="muted" style={{fontSize:12}}>
            {q ? `${filtered.length} of ${gaps.length} gaps` : `${gaps.length} gaps`}
          </div>
          <input
            type="text"
            placeholder="Search feature, category, competitor…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 280 }}
          />
        </div>
        {filtered.length > 0 && <Paginator ctl={ctl} label="gaps" />}
        <table className="modern-table">
          <thead><tr><th style={{width:24}}></th><th>Feature</th><th>Category</th><th>Competitors with it</th><th>Pressure</th></tr></thead>
          <tbody>
            {ctl.slice.map(g => {
              const open = openId === g.feature_id;
              const ev = evidenceCache[g.feature_id];
              return (
                <React.Fragment key={g.feature_id}>
                  <tr style={{cursor:'pointer'}} onClick={() => toggle(g.feature_id)}>
                    <td><Icon name={open ? 'chevDown' : 'chevRight'} size={12}/></td>
                    <td><strong>{g.feature}</strong></td>
                    <td><span className="badge">{g.category}</span></td>
                    <td>{g.competitors_supporting}</td>
                    <td><span className={'badge ' + (g.competitor_count >= 2 ? 'high' : 'medium')}>{g.competitor_count}</span></td>
                  </tr>
                  {open && (
                    <tr className="gap-evidence-row">
                      <td></td>
                      <td colSpan="4">
                        {!ev || ev.loading ? <span className="muted">Loading evidence…</span>
                          : ev.error ? <span style={{color:'#f87171'}}>Error: {ev.error}</span>
                          : (
                            <div className="gap-evidence">
                              {ev.data.supporters.length === 0 && <span className="muted">No supporting evidence found.</span>}
                              {ev.data.supporters.map(s => (
                                <div key={s.product_id} className="gap-evidence-card">
                                  <div className="gap-evidence-head">
                                    <strong>{s.product_name}</strong>
                                    {s.since_version && s.since_version.toLowerCase() !== 'unknown' && <span className="badge">since {s.since_version}</span>}
                                  </div>
                                  {s.notes && <div className="meta" style={{margin:'4px 0 6px', fontSize:12}}>{s.notes}</div>}
                                  {s.evidence.length === 0
                                    ? <div className="muted" style={{fontSize:12}}>No links captured yet.</div>
                                    : (
                                      <ul className="gap-evidence-links">
                                        {s.evidence.map((e, i) => (
                                          <li key={i}>
                                            <a href={e.url} target="_blank" rel="noreferrer" className="report-source-link">
                                              <Icon name="external" size={11}/>
                                              <span>{e.title || shortUrl(e.url)}</span>
                                              {e.date && <span className="muted" style={{fontSize:11}}> · {e.date}</span>}
                                            </a>
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                </div>
                              ))}
                            </div>
                          )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {!error && gaps.length === 0 && <tr><td colSpan="5"><LoadingState label="Loading gaps…" size="sm" variant="inline" /></td></tr>}
            {!error && gaps.length > 0 && filtered.length === 0 && <tr><td colSpan="5" className="muted" style={{textAlign:'center', padding:16}}>No gaps match "{search}"</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Requests() {
  const [items, setItems] = useState([]);
  const [products, setProducts] = useState([]);
  const [features, setFeatures] = useState([]);
  const [editing, setEditing] = useState(null);
  const load = () => Promise.all([api.get('/feature-requests'), api.get('/products'), api.get('/features')])
    .then(([r, p, f]) => { setItems(r); setProducts(p); setFeatures(f); })
    .catch(e => console.error('Requests load:', e));
  useEffect(() => { load(); }, []);
  useRefresh(load);
  const productName = (id) => (products.find(p => p.id === id) || {}).name || '—';
  const featureName = (id) => (features.find(f => f.id === id) || {}).name || '—';
  const save = async (form) => {
    if (form.id) await api.put('/feature-requests/' + form.id, form);
    else await api.post('/feature-requests', form);
    setEditing(null); load();
  };
  const del = async (id) => { if (confirm('Delete?')) { await api.del('/feature-requests/' + id); load(); } };
  return (
    <>
      <div className="toolbar">
        <h2>Requirements</h2>
        <button onClick={() => setEditing({ title: '', priority: 'medium', status: 'open' })}>+ Add requirement</button>
      </div>
      <table>
        <thead><tr><th>Title</th><th>Linked feature</th><th>Source</th><th>Priority</th><th>Status</th><th>AI Confidence</th><th>Effort</th><th>Notes / Rationale</th><th></th></tr></thead>
        <tbody>
          {items.map(r => (
            <tr key={r.id}>
              <td>
                <strong>{r.title}</strong>
                {r.auto_generated ? <span className="badge" style={{marginLeft:6}}>🤖 auto</span> : null}
              </td>
              <td>{featureName(r.feature_id)}</td>
              <td>{productName(r.source_product_id)}</td>
              <td><span className={'badge ' + r.priority}>{r.priority}</span></td>
              <td><span className={'badge ' + r.status}>{r.status}</span></td>
              <td>
                {r.confidence != null
                  ? <span className={'badge ' + (r.confidence >= 70 ? 'high' : r.confidence >= 40 ? 'medium' : 'low')}>{r.confidence}%</span>
                  : <span className="muted">—</span>}
              </td>
              <td>{r.effort ? <span className="badge">{r.effort}</span> : <span className="muted">—</span>}</td>
              <td>{r.rationale || r.notes}</td>
              <td className="row">
                <button className="ghost" onClick={() => setEditing(r)}>Edit</button>
                <button className="danger" onClick={() => del(r.id)}>×</button>
              </td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan="9" className="muted">No requirements yet.</td></tr>}
        </tbody>
      </table>
      {editing && <RequestForm value={editing} products={products} features={features} onSave={save} onClose={() => setEditing(null)} />}
    </>
  );
}

function RequestForm({ value, products, features, onSave, onClose }) {
  const [f, setF] = useState(value);
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.value }));
  return (
    <Modal onClose={onClose}>
      <h3>{f.id ? 'Edit requirement' : 'Add requirement'}</h3>
      <div className="field"><label>Title</label><input value={f.title||''} onChange={set('title')} /></div>
      <div className="field"><label>Linked feature</label>
        <select value={f.feature_id||''} onChange={set('feature_id')}>
          <option value="">— none —</option>
          {features.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </div>
      <div className="field"><label>Source product</label>
        <select value={f.source_product_id||''} onChange={set('source_product_id')}>
          <option value="">— none —</option>
          {products.filter(p => !p.is_own).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </div>
      <div className="field"><label>Priority</label>
        <select value={f.priority||'medium'} onChange={set('priority')}>
          <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
        </select>
      </div>
      <div className="field"><label>Status</label>
        <select value={f.status||'open'} onChange={set('status')}>
          <option value="open">open</option><option value="in_progress">in_progress</option><option value="done">done</option>
        </select>
      </div>
      <div className="field"><label>Notes</label><textarea value={f.notes||''} onChange={set('notes')} /></div>
      <div className="row" style={{justifyContent:'flex-end'}}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button onClick={() => onSave(f)}>Save</button>
      </div>
    </Modal>
  );
}

// AI status pill — adapts color/text based on enabled + expiry urgency.
function AIStatusBadge({ llm }) {
  if (!llm.enabled) return <span className="badge low" title="No GitHub token saved. Open the AI Settings card below to paste one.">AI: ⚠ disabled</span>;
  const d = llm.daysLeft;
  if (d != null && d < 0)  return <span className="badge low"    title={`Token expired on ${llm.expiresAt}. Generate a new one.`}>AI: ⚠ token expired</span>;
  if (d != null && d <= 7) return <span className="badge medium" title={`Token expires on ${llm.expiresAt} (${d} day${d===1?'':'s'} left)`}>AI: {llm.model} · ⏳ {d}d left</span>;
  return <span className="badge high" title={`Live model used for analysis: ${llm.model}${llm.expiresAt ? ` · token expires ${llm.expiresAt}` : ''}`}>AI: {llm.model}{d != null ? ` · ${d}d` : ''}</span>;
}

// Custom themed date picker. Expands inline below the trigger so the host card grows
// to fit it (no overlap, no popover).
function DatePicker({ value, onChange, min, placeholder = 'Pick a date' }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const today = new Date(); today.setHours(0,0,0,0);
  const minDate = min ? new Date(min + 'T00:00:00') : null;
  const parsed = value ? new Date(value + 'T00:00:00') : null;
  const [view, setView] = useState(() => parsed || today);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const fmt = (d) => d ? d.toLocaleDateString(undefined, { day:'2-digit', month:'short', year:'numeric' }) : '';
  const ym = view.toLocaleDateString(undefined, { month:'long', year:'numeric' });
  const firstOfMonth = new Date(view.getFullYear(), view.getMonth(), 1);
  const startOffset = firstOfMonth.getDay();
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(view.getFullYear(), view.getMonth(), d));
  while (cells.length % 7 !== 0) cells.push(null);

  const sameDay = (a,b) => a && b && a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const isDisabled = (d) => minDate && d < minDate;
  const pick = (d) => { if (isDisabled(d)) return; onChange(iso(d)); setOpen(false); };
  const shift = (n) => setView(new Date(view.getFullYear(), view.getMonth() + n, 1));

  return (
    <div className={`datepicker ${open ? 'is-open' : ''}`} ref={wrapRef}>
      <button type="button" className={`datepicker-trigger ${parsed ? 'has-value' : ''}`} onClick={() => setOpen(o => !o)}>
        <span className="datepicker-icon" aria-hidden>📅</span>
        <span className="datepicker-text">{parsed ? fmt(parsed) : <span className="meta">{placeholder}</span>}</span>
        <span className="datepicker-caret" aria-hidden>{open ? '▴' : '▾'}</span>
        {parsed && <span className="datepicker-clear" title="Clear" onClick={(e)=>{ e.stopPropagation(); onChange(''); }}>×</span>}
      </button>
      {open && (
        <div className="datepicker-inline" role="dialog">
          <div className="datepicker-head">
            <button type="button" className="datepicker-nav" onClick={() => shift(-1)} title="Previous month">‹</button>
            <div className="datepicker-title">{ym}</div>
            <button type="button" className="datepicker-nav" onClick={() => shift(1)} title="Next month">›</button>
          </div>
          <div className="datepicker-grid datepicker-dows">
            {['S','M','T','W','T','F','S'].map((d, i) => <div key={i} className="datepicker-dow">{d}</div>)}
          </div>
          <div className="datepicker-grid">
            {cells.map((d, i) => d == null
              ? <div key={i} className="datepicker-cell empty" />
              : <button
                  key={i}
                  type="button"
                  className={`datepicker-cell ${sameDay(d, parsed) ? 'selected' : ''} ${sameDay(d, today) ? 'today' : ''} ${isDisabled(d) ? 'disabled' : ''}`}
                  disabled={isDisabled(d)}
                  onClick={() => pick(d)}
                >{d.getDate()}</button>
            )}
          </div>
          <div className="datepicker-foot">
            <button type="button" className="ghost small" onClick={() => { onChange(''); setOpen(false); }}>No expiry</button>
            <button type="button" className="ghost small" onClick={() => { const t = new Date(); if (!isDisabled(t)) { onChange(iso(t)); setOpen(false); } }}>Today</button>
            <button type="button" className="small" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Rich dropdown for the model picker — native <select> can only show plain text
// per option, so we render our own popover with vendor / name / tier badge / note.
function ModelDropdown({ presets, value, onChange, activeId }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const current = presets.find(p => p.id === value);
  const isCustom = !current && !!value;
  const tierLabel = (t) => t === 'pro' ? 'PRO' : 'FAST';

  return (
    <div className="model-dd" ref={wrapRef}>
      <button
        type="button"
        className={'model-dd-trigger' + (open ? ' open' : '')}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current ? (
          <>
            <span className="model-card-vendor">{current.vendor}</span>
            <span className="model-dd-trigger-name">{current.name}</span>
            <span className={'model-card-tier model-card-tier-' + current.tier}>{tierLabel(current.tier)}</span>
            {activeId === current.id ? <span className="model-dd-row-pill">In use</span> : <span />}
            <span className="model-dd-trigger-chev"><Icon name="chevRight" size={12} /></span>
          </>
        ) : (
          <>
            <span className="model-card-vendor">Custom</span>
            <span className="model-dd-trigger-name">{value || 'Pick a model'}</span>
            <span /><span />
            <span className="model-dd-trigger-chev"><Icon name="chevRight" size={12} /></span>
          </>
        )}
      </button>
      {open && (
        <div className="model-dd-menu" role="listbox">
          {presets.map(p => {
            const selected = value === p.id;
            const active   = activeId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={selected}
                className={'model-dd-row' + (selected ? ' selected' : '') + (active ? ' active' : '')}
                onClick={() => { onChange(p.id); setOpen(false); }}
                title={p.id}
              >
                <span className="model-card-vendor">{p.vendor}</span>
                <span className="model-dd-row-name">{p.name}</span>
                <span className="model-card-note">{p.note}</span>
                <span className={'model-card-tier model-card-tier-' + p.tier}>{tierLabel(p.tier)}</span>
                {active && <span className="model-dd-row-pill">In use</span>}
              </button>
            );
          })}
          {isCustom && (
            <div className="model-dd-row model-dd-row-custom" aria-disabled="true">
              <span className="model-card-vendor">Custom</span>
              <span className="model-dd-row-name">{value}</span>
              <span className="model-card-note">edit below</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// AI Settings card — paste GitHub PAT, choose model, set expiry. Token never returned by API.
function AISettingsPanel({ llm, onChange, forceOpen = false }) {
  const [model, setModel] = useState(llm.model || 'openai/gpt-4o-mini');
  const [modelInput, setModelInput] = useState(llm.model || 'openai/gpt-4o-mini');
  const [savingModel, setSavingModel] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null); // token row being edited
  const [confirmDel, setConfirmDel] = useState(null);
  useEffect(() => { setModel(llm.model || 'openai/gpt-4o-mini'); setModelInput(llm.model || 'openai/gpt-4o-mini'); }, [llm.model]);

  // Popular model presets, with display metadata so the picker can render
  // pretty cards (vendor / name / tier hint) instead of a plain dropdown.
  const PRESETS = [
    { id: 'openai/gpt-4o-mini',           vendor: 'OpenAI',  name: 'GPT-4o mini',     tier: 'fast', note: 'Cheap, ~15 req/min'    },
    { id: 'openai/gpt-4.1-mini',          vendor: 'OpenAI',  name: 'GPT-4.1 mini',    tier: 'fast', note: 'Balanced, fast'        },
    { id: 'openai/gpt-4.1-nano',          vendor: 'OpenAI',  name: 'GPT-4.1 nano',    tier: 'fast', note: 'Cheapest tier'         },
    { id: 'openai/gpt-4o',                vendor: 'OpenAI',  name: 'GPT-4o',          tier: 'pro',  note: '~50 req/day'           },
    { id: 'openai/gpt-4.1',               vendor: 'OpenAI',  name: 'GPT-4.1',         tier: 'pro',  note: '~50 req/day'           },
    { id: 'mistral-ai/mistral-small-2503',vendor: 'Mistral', name: 'Mistral Small',   tier: 'fast', note: 'Open-weights'          },
    { id: 'cohere/cohere-command-r-08-2024', vendor: 'Cohere', name: 'Command R',     tier: 'fast', note: 'Strong RAG'            },
  ];

  const tokens = llm.tokens || [];
  const activeId = llm.activeTokenId;

  const saveModel = async () => {
    setSavingModel(true);
    try {
      const r = await fetch('/api/llm/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: modelInput.trim() }) });
      if (!r.ok) throw new Error((await r.json()).error || 'Save failed');
      window.toast('Model saved', 'success');
      onChange && onChange();
    } catch (e) { window.toast(e.message, 'error'); }
    finally { setSavingModel(false); }
  };

  const testConnection = async () => {
    setTesting(true); setTestResult(null);
    try {
      const r = await fetch('/api/llm/test', { method: 'POST' });
      const data = await r.json();
      setTestResult(data);
    } catch (e) {
      setTestResult({ ok: false, error: e.message, kind: 'network' });
    } finally { setTesting(false); }
  };

  const moveToken = async (id, direction) => {
    try {
      await fetch(`/api/llm/tokens/${id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }) });
      onChange && onChange();
    } catch (e) { window.toast(e.message, 'error'); }
  };
  const resetToken = async (id) => {
    try {
      await fetch(`/api/llm/tokens/${id}/reset`, { method: 'POST' });
      window.toast('Token reset — back in rotation', 'success');
      onChange && onChange();
    } catch (e) { window.toast(e.message, 'error'); }
  };
  const useToken = async (id) => {
    try {
      const r = await fetch(`/api/llm/tokens/${id}/use`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      window.toast('Token promoted — now active', 'success');
      onChange && onChange();
    } catch (e) { window.toast(e.message, 'error'); }
  };
  const testTokenRow = async (id, label) => {
    setTestResult({ ok: true, pending: true, label });
    try {
      const r = await fetch(`/api/llm/tokens/${id}/test`, { method: 'POST' });
      const data = await r.json();
      setTestResult({ ...data, label });
      onChange && onChange();
    } catch (e) {
      setTestResult({ ok: false, kind: 'network', error: e.message, label });
    }
  };
  const deleteToken = async (id) => {
    try {
      await fetch(`/api/llm/tokens/${id}`, { method: 'DELETE' });
      window.toast('Token deleted', 'success');
      setConfirmDel(null);
      onChange && onChange();
    } catch (e) { window.toast(e.message, 'error'); }
  };

  // === Status hero ============================================================
  const hasAny = tokens.length > 0;
  const activeToken = tokens.find(t => t.id === activeId);
  let statusDot = '#9ca3af', statusLabel = 'No tokens';
  if (hasAny && activeToken) { statusDot = '#10b981'; statusLabel = `Active · ${activeToken.label}`; }
  else if (hasAny && !activeToken) { statusDot = '#ef4444'; statusLabel = 'All tokens unavailable'; }

  const formatExhaustedUntil = (iso) => {
    if (!iso) return '';
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return iso;
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="ai-settings-v2">
      {/* === Status hero ====================================================== */}
      <div className="ai-hero">
        <div className="ai-hero-status">
          <span className="ai-hero-dot" style={{ background: statusDot, boxShadow: `0 0 0 4px ${statusDot}33` }} />
          <div>
            <div className="ai-hero-label">{statusLabel}</div>
            <div className="ai-hero-sub">
              {hasAny
                ? <>Model <code>{llm.model}</code> · {tokens.length} token{tokens.length === 1 ? '' : 's'} configured · auto-fallback enabled</>
                : <>Add at least one GitHub PAT below to enable AI extraction.</>}
            </div>
          </div>
        </div>
        <div className="ai-hero-actions">
          {hasAny && (
            <button className="ghost" onClick={testConnection} disabled={testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
          )}
        </div>
      </div>

      {/* === Test result ====================================================== */}
      {testResult && (
        <div className={`ai-test-result ai-test-${testResult.ok ? 'ok' : (testResult.kind || 'error')}`}>
          {testResult.pending ? (
            <><strong>Testing{testResult.label ? ` "${testResult.label}"` : ''}…</strong></>
          ) : testResult.ok ? (
            <><strong>✓ {testResult.label ? `"${testResult.label}" OK` : 'Connection OK'}</strong> · {testResult.latency_ms}ms · model replied: <code>{testResult.sample || '(empty)'}</code></>
          ) : (
            <>
              <strong>✗ {testResult.label ? `"${testResult.label}" — ` : ''}{testResult.kind === 'rate_limit' ? 'Rate limit' : testResult.kind === 'auth' ? 'Auth error' : testResult.kind === 'network' ? 'Network error' : 'Error'}</strong>
              <span style={{ marginLeft: 8 }}>{testResult.error}</span>
              {testResult.kind === 'rate_limit' && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Token marked exhausted; will retry next token. Free tier is ~15 req/min.</div>}
              {testResult.kind === 'auth' && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Token may be expired or not onboarded — visit <a href="https://github.com/marketplace/models" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>marketplace/models</a>.</div>}
            </>
          )}
          <button className="ai-test-dismiss" onClick={() => setTestResult(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* === Tokens table ===================================================== */}
      <div className="ai-config">
        <div className="ai-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>API Tokens · fallback chain</span>
          <button className="primary" onClick={() => setAdding(true)}>+ Add token</button>
        </div>
        {tokens.length === 0 ? (
          <div className="muted" style={{ padding: '24px 8px', textAlign: 'center', fontSize: 13 }}>
            No tokens yet. Click <strong>+ Add token</strong> to paste your first GitHub PAT.
          </div>
        ) : (
          <table className="ai-token-table">
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th>Label</th>
                <th>Token</th>
                <th>Expires</th>
                <th>State</th>
                <th>Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t, idx) => {
                const isActive = t.id === activeId;
                return (
                  <tr key={t.id} className={isActive ? 'ai-token-active' : ''}>
                    <td>
                      <div className="ai-token-priority">
                        <button className="ghost" disabled={idx === 0} title="Move up" onClick={() => moveToken(t.id, 'up')}>▲</button>
                        <button className="ghost" disabled={idx === tokens.length - 1} title="Move down" onClick={() => moveToken(t.id, 'down')}>▼</button>
                      </div>
                    </td>
                    <td>
                      <strong>{t.label}</strong>
                      {isActive && <span className="badge high" style={{ fontSize: 10, marginLeft: 6 }}>ACTIVE</span>}
                      {idx === 0 && !isActive && <span className="badge" style={{ fontSize: 10, marginLeft: 6 }}>PRIMARY</span>}
                    </td>
                    <td><code>{t.tokenMasked}</code></td>
                    <td style={{ fontSize: 12 }}>
                      {t.expiresAt
                        ? <>{t.expiresAt} {t.daysLeft != null && (t.daysLeft < 0 ? <span style={{ color: '#ef4444' }}>(expired)</span> : t.daysLeft <= 7 ? <span style={{ color: '#f59e0b' }}>({t.daysLeft}d)</span> : <span className="muted">({t.daysLeft}d)</span>)}</>
                        : <span className="muted">—</span>}
                    </td>
                    <td>
                      {t.state === 'active' && <span className="badge high" style={{ fontSize: 10 }}>ACTIVE</span>}
                      {t.state === 'exhausted' && <span className="badge medium" style={{ fontSize: 10 }} title={t.lastError || ''}>EXHAUSTED · until {formatExhaustedUntil(t.exhaustedUntil)}</span>}
                      {t.state === 'expired' && <span className="badge low" style={{ fontSize: 10 }}>EXPIRED</span>}
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--muted)' }}>{t.lastUsedAt ? new Date(t.lastUsedAt.replace(' ', 'T') + 'Z').toLocaleString() : '—'}</td>
                    <td className="ai-token-actions">
                      <button className="ghost" onClick={() => testTokenRow(t.id, t.label)} title="Send one ping with just this token">Test</button>
                      {!isActive && t.state === 'active' && (
                        <button className="ghost" onClick={() => useToken(t.id)} title="Promote to top of fallback chain">Use</button>
                      )}
                      {t.state === 'exhausted' && <button className="ghost" onClick={() => resetToken(t.id)} title="Clear exhausted flag">Reset</button>}
                      <button className="ghost" onClick={() => setEditing(t)}>Edit</button>
                      <button className="ghost" onClick={() => setConfirmDel(t)}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="muted" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>
          Tokens are tried in priority order (top first). On a rate-limit or auth failure the failing token is marked <strong>exhausted</strong> until midnight server-local time, and the next token is used automatically. Exhausted tokens re-enter rotation after midnight, or click <em>Reset</em> to release one early.
        </div>
      </div>

      {/* === Model ============================================================ */}
      <div className="ai-config" style={{ marginTop: 14 }}>
        <div className="ai-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Model</span>
          <button
            className="primary"
            onClick={saveModel}
            disabled={savingModel || !modelInput || modelInput.trim() === (llm.model || '')}
          >
            {savingModel ? 'Saving…' : 'Save model'}
          </button>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            className="select-modern"
            value={PRESETS.some(p => p.id === modelInput) ? modelInput : '__custom__'}
            onChange={e => {
              const v = e.target.value;
              if (v === '__custom__') return;
              setModelInput(v);
            }}
            style={{ minWidth: 280 }}
          >
            {PRESETS.map(p => (
              <option key={p.id} value={p.id}>
                {p.vendor} · {p.name} — {p.tier === 'pro' ? 'PRO' : 'FAST'} · {p.note}
              </option>
            ))}
            {!PRESETS.some(p => p.id === modelInput) && modelInput && (
              <option value="__custom__">Custom · {modelInput}</option>
            )}
          </select>
          {(llm.model || '') === modelInput && PRESETS.some(p => p.id === modelInput) && (
            <span className="model-dd-row-pill">In use</span>
          )}
        </div>
        <details style={{ marginTop: 10 }}>
          <summary className="muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>Use a custom model id…</summary>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <input
              type="text"
              placeholder="e.g. meta/llama-3.3-70b-instruct"
              value={PRESETS.some(p => p.id === modelInput) ? '' : modelInput}
              onChange={e => setModelInput(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
        </details>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.55 }}>
          Full catalogue at <a href="https://github.com/marketplace/models" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>github.com/marketplace/models</a>. <strong>FAST</strong> models (mini / nano) have higher per-minute rate limits; <strong>PRO</strong> models (gpt-4o, gpt-4.1) are capped at ~50 requests/day on the free tier.
        </div>
      </div>

      {/* === Add / Edit modal ================================================= */}
      {(adding || editing) && (
        <TokenForm
          value={editing || { label: '', token: '', expiresAt: '' }}
          isNew={!editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); onChange && onChange(); }}
        />
      )}

      {confirmDel && (
        <ConfirmDialog
          icon="🗑️"
          title={`Delete token "${confirmDel.label}"?`}
          message="This removes it from the fallback chain. Items already analyzed are kept."
          confirmLabel="Delete"
          danger
          onConfirm={() => deleteToken(confirmDel.id)}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </div>
  );
}

// Small form used for both Add and Edit. For Add the token field is required;
// for Edit, leaving it blank keeps the existing value (server-side default).
function TokenForm({ value, isNew, onClose, onSaved }) {
  const [label, setLabel] = useState(value.label || '');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [expiresAt, setExpiresAt] = useState(value.expiresAt || '');
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const body = { label: label.trim() || 'Token', expiresAt: expiresAt || null };
      if (token.trim()) body.token = token.trim();
      let r;
      if (isNew) {
        if (!token.trim()) throw new Error('Token is required for a new entry.');
        r = await fetch('/api/llm/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } else {
        r = await fetch(`/api/llm/tokens/${value.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      }
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      window.toast(isNew ? 'Token added' : 'Token updated', 'success');
      onSaved();
    } catch (e) { window.toast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const today = new Date().toISOString().slice(0, 10);
  const tokenOk  = isNew ? token.trim().length > 0 : true;
  const looksLikePat = !token.trim() || /^(ghp_|github_pat_)/.test(token.trim());

  return (
    <Modal onClose={onClose}>
      <div className="token-modal">
        <div className="token-modal-head">
          <div className="token-modal-icon"><Icon name="key" size={20} /></div>
          <div>
            <h3 style={{ margin: 0 }}>{isNew ? 'Add GitHub PAT' : `Edit ${value.label || 'token'}`}</h3>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {isNew
                ? 'Paste a Personal Access Token to enable AI extraction. Stored only on this server.'
                : 'Update the label, expiry, or replace the underlying PAT. Leave token blank to keep the existing one.'}
            </div>
          </div>
        </div>

        <div className="token-modal-grid">
          <div className="field">
            <label htmlFor="tf-label">Label</label>
            <input id="tf-label" type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Primary, Work, Personal-Backup" />
            <div className="field-hint">Shown next to ACTIVE / PRIMARY in the chain. Pick something memorable.</div>
          </div>

          <div className="field">
            <label htmlFor="tf-token">{isNew ? 'GitHub Personal Access Token' : 'Replace token'} {!isNew && <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>(optional)</span>}</label>
            <div className="input-with-action">
              <input
                id="tf-token"
                type={showToken ? 'text' : 'password'}
                autoComplete="off"
                spellCheck="false"
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder={isNew ? 'ghp_… or github_pat_…' : 'leave blank to keep existing'}
              />
              <button type="button" className="input-action" onClick={() => setShowToken(s => !s)} title={showToken ? 'Hide' : 'Show'}>
                {showToken ? 'Hide' : 'Show'}
              </button>
            </div>
            {!looksLikePat && (
              <div className="field-hint" style={{ color: '#f59e0b' }}>
                Doesn't look like a GitHub PAT — expected to start with <code>ghp_</code> or <code>github_pat_</code>.
              </div>
            )}
            {!isNew && (
              <div className="field-hint">
                Current token on file: <code>{value.tokenMasked || '—'}</code>
              </div>
            )}
          </div>

          <div className="field">
            <label>Expiry date <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>(optional)</span></label>
            <DatePicker value={expiresAt} onChange={setExpiresAt} min={today} placeholder="No expiry" />
            <div className="field-hint">We'll warn you when this date is within 7 days, and stop using it after it passes.</div>
          </div>
        </div>

        <button type="button" className="token-help-toggle" onClick={() => setShowHelp(s => !s)}>
          <Icon name={showHelp ? 'chevDown' : 'chevRight'} size={12} />
          <span>How do I create a PAT?</span>
        </button>
        {showHelp && (
          <div className="token-help">
            <ol>
              <li>Open <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer">github.com/settings/tokens</a> → <strong>Generate new token (classic)</strong>.</li>
              <li>Leave all scopes unchecked, set an expiry, click Generate, copy the <code>ghp_…</code> value.</li>
              <li>If your first request returns 403, visit <a href="https://github.com/marketplace/models" target="_blank" rel="noreferrer">marketplace/models</a> once to onboard your account.</li>
            </ol>
          </div>
        )}

        <div className="token-modal-foot">
          <div className="muted" style={{ fontSize: 11.5 }}>
            <Icon name="shield" size={12} /> Token is stored on your local server only.
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary" onClick={save} disabled={busy || !tokenOk}>
              {busy ? 'Saving…' : isNew ? 'Add token' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}


// Settings tab — central place for AI keys, model, expiry, etc.
// Bookmarklet generator for capturing analyst-firm content from sites that
// block server-side scraping (Gartner, KuppingerCole, IDC, etc.). The user
// drags the link to their bookmarks bar; clicking it on any analyst page
// opens the panel with the page's title/URL/text pre-filled in the paste
// modal so they only need to pick the firm and confirm.
function BookmarkletPanel() {
  const panelOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000';
  // The bookmarklet code. Captures: document.title, location.href, and the
  // current selection (or first 20k chars of body innerText if no selection).
  // Encodes as base64 JSON and opens the panel with #paste=<payload>.
  const code = `(function(){var s=window.getSelection&&window.getSelection().toString();var t=(s&&s.length>50)?s:(document.body.innerText||'').slice(0,20000);var p={title:document.title||'',url:location.href||'',content:t};var b=btoa(unescape(encodeURIComponent(JSON.stringify(p))));window.open('${panelOrigin}/#paste='+encodeURIComponent(b),'pm_panel_paste','width=720,height=720');})();`;
  const href = 'javascript:' + code;
  const copyCode = () => {
    navigator.clipboard.writeText(href).then(
      () => window.toast && window.toast('Bookmarklet code copied', 'success'),
      () => window.toast && window.toast('Copy failed — drag the link instead', 'error'),
    );
  };
  return (
    <>
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="sparkles" size={18} /> Capture Bookmarklet
      </h3>
      <p className="meta" style={{ fontSize: 12, marginTop: -6 }}>
        For analyst content on sites that block automated fetching (Gartner, KuppingerCole, IDC, paywalled press releases),
        use this bookmarklet. It captures the current page's title, URL, and visible text
        (or your selection, if any) and opens the panel pre-filled so you can save it under the right firm.
      </p>

      <div style={{ background: 'var(--panel-2)', padding: 16, borderRadius: 10, border: '1px solid var(--border)', marginBottom: 16 }}>
        <div className="label" style={{ marginBottom: 8 }}>1. Drag this to your browser's bookmarks bar:</div>
        <a
          href={href}
          onClick={(e) => { e.preventDefault(); window.toast && window.toast('Drag this link to your bookmarks bar — do not click', 'info'); }}
          style={{
            display: 'inline-block',
            padding: '10px 18px',
            background: 'var(--accent)',
            color: 'white',
            borderRadius: 8,
            textDecoration: 'none',
            fontWeight: 600,
            cursor: 'grab',
          }}
          title="Drag me to your bookmarks bar"
        >
          📎 Send to PM Panel
        </a>
        <button className="ghost" onClick={copyCode} style={{ marginLeft: 12, fontSize: 12 }}>
          Copy bookmarklet code
        </button>
      </div>

      <div style={{ background: 'var(--panel-2)', padding: 16, borderRadius: 10, border: '1px solid var(--border)', marginBottom: 16 }}>
        <div className="label" style={{ marginBottom: 8 }}>2. How to use it:</div>
        <ol style={{ lineHeight: 1.7, margin: 0, paddingLeft: 22, fontSize: 13 }}>
          <li>Visit any analyst page in your browser (e.g. a Gartner Magic Quadrant press release, a KuppingerCole Leadership Compass summary, a vendor's MQ reprint landing page).</li>
          <li>Optionally <strong>select</strong> the specific text you want to capture (the executive summary, a vendor verdict). If you select nothing, the whole page text is captured.</li>
          <li>Click the <strong>📎 Send to PM Panel</strong> bookmark in your bookmarks bar.</li>
          <li>The panel opens in a new window with the title, URL, and content pre-filled. Pick the analyst firm (Gartner / KuppingerCole / etc.) and click <strong>Save & analyze</strong>.</li>
          <li>The AI will extract competitor names, capability claims, and any positioning language for your gap/feature analysis.</li>
        </ol>
      </div>

      <div style={{ background: 'var(--panel-2)', padding: 16, borderRadius: 10, border: '1px solid var(--border)' }}>
        <div className="label" style={{ marginBottom: 8 }}>Why a bookmarklet?</div>
        <p style={{ fontSize: 12, lineHeight: 1.6, margin: 0 }}>
          Gartner, KuppingerCole, IDC, and Omdia block server-side fetches at the CDN layer (Cloudflare/Akamai bot detection),
          so the panel can't poll them via RSS. Your browser is already authenticated and trusted — the bookmarklet uses
          <em> your</em> session, sidestepping the block legally and reliably. Recommended for one-off captures of paywalled or bot-blocked content.
        </p>
      </div>
    </>
  );
}

// =================================================================
// SPOC tab — read-only table with per-person read tracker
// -----------------------------------------------------------------
// Single-machine deployment, no auth. Anyone using the panel can
// toggle any person's read marker — there's no login to bind a click
// to an identity. The "me" picker (Settings → SPOC) is just a visual
// hint so each person can spot their own chip quickly.
// =================================================================

// SPOC dashboard — aggregate metrics over the whole spoc_entries table.
// Kept fully client-rendered (no charting lib) so it stays in the existing
// React-UMD bundle. Uses the same accent colours as the rest of the app.
function SpocDashboard({ onOpenEntries }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const reload = () => api.get('/spoc/summary').then(setS).catch(e => setErr(e.message));
  useEffect(() => { reload(); }, []);
  useRefresh(reload);

  if (err) return <div className="error-banner">{err}</div>;
  if (!s) return <div className="muted" style={{padding:24}}>Loading SPOC summary…</div>;
  if (s.total === 0) {
    return (
      <div className="spoc-empty">
        <p>No SPOC entries yet.</p>
        <p style={{fontSize:12}}>
          Configure the download URL in <em>Settings → SPOC</em> and click <em>Import now</em>,
          or wait for the daily 00:10 sync.
        </p>
      </div>
    );
  }

  const PRIORITY_COLOR = { p1: '#ef4444', p2: '#f59e0b', p3: '#22d3ee', p4: '#8b5cf6' };
  const priorityColor = (label) => PRIORITY_COLOR[String(label).toLowerCase().replace(/\s+/g, '')] || 'var(--accent)';

  // Reusable horizontal bar list. Top-N pattern shared by Priority / Module / etc.
  const TopList = ({ title, items, max = 8, colorFor }) => {
    const top = items.slice(0, max);
    const totalCount = items.reduce((n, i) => n + i.count, 0) || 1;
    return (
      <div className="spoc-card">
        <h3>{title}</h3>
        {top.length === 0 ? <p className="muted small">No data.</p> : (
          <div className="bar-list">
            {top.map(it => {
              const pct = Math.round((it.count / totalCount) * 100);
              const color = colorFor ? colorFor(it.label) : 'var(--accent)';
              return (
                <div key={it.label} className="bar-row">
                  <div className="bar-label" title={it.label}>{it.label}</div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
                  </div>
                  <div className="bar-count">{it.count}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const readPct = s.totalReadSlots ? Math.round((s.totalReadEvents / s.totalReadSlots) * 100) : 0;

  return (
    <div className="spoc-dash">
      <div className="toolbar">
        <h2><Icon name="analysts" size={22} /> SPOC Dashboard</h2>
        <div className="row meta" style={{ fontSize: 12 }}><Icon name="clock" size={12} /> Updated {new Date().toLocaleTimeString()}</div>
      </div>

      {/* KPI strip ----------------------------------------------------- */}
      <div className="spoc-kpis">
        <div className="kpi">
          <div className="kpi-label">Total entries</div>
          <div className="kpi-value">{s.total}</div>
          <div className="kpi-sub">{s.bySheet.length} sheet{s.bySheet.length === 1 ? '' : 's'}</div>
        </div>
      </div>

      {/* Aggregations grid -------------------------------------------- */}
      <div className="spoc-grid-3">
        {[
          { title: 'By Priority', items: s.byPriority, colorFor: priorityColor },
          { title: 'By Module',   items: s.byModule },
          { title: 'By Product',  items: s.byProduct },
          { title: 'By Cx Type',  items: s.byCxType },
          // Hide "By Sheet" when only one sheet is present — it's noise.
          ...(s.bySheet.length > 1 ? [{ title: 'By Sheet', items: s.bySheet }] : []),
        ]
          // Drop cards with no data so the grid stays balanced.
          .filter(c => c.items && c.items.length > 0)
          .map(c => <TopList key={c.title} title={c.title} items={c.items} colorFor={c.colorFor} />)}
      </div>

      {/* Recent activity feed ----------------------------------------- */}
      <div className="spoc-card">
        <div className="row" style={{justifyContent:'space-between', alignItems:'center', marginBottom:8}}>
          <h3 style={{margin:0}}>Recently added</h3>
          <button className="ghost small" onClick={onOpenEntries}>Open all entries →</button>
        </div>
        <div className="spoc-recent-list">
          {s.recent.map(r => (
            <div key={r.ackKey} className="spoc-recent-row">
              {r.messageLink
                ? <a className="r-link" href={r.messageLink} target="_blank" rel="noopener noreferrer" title={r.messageLink}>Open chat ↗</a>
                : <span className="muted small">no link</span>}
              <span className="r-summary" title={r.summary}>{r.summary || <em className="muted">(no summary)</em>}</span>
              <span className="muted small">{r.module || ''}{r.module && r.product ? ' · ' : ''}{r.product || ''}</span>
              <span className="muted small time-cell">{r.time || ''}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Spoc() {
  // SPOC top-tab now shows just the data table; the dashboard view lives in
  // Dashboard → SPOC sub-tab so all aggregate views are in one place.
  return <SpocEntries />;
}

function SpocEntries() {
  const [data, setData] = useState({ items: [], total: 0, fixedColumns: [], trackerColumns: [], sheets: [], me: '' });
  const [q, setQ] = useState('');
  const [sheet, setSheet] = useState('');
  const [date, setDate] = useState('');
  const [page, setPage] = useState(1);          // 1-based to match Paginator
  const [pageSize, setPageSize] = useState(25); // user-configurable via Paginator
  const [err, setErr] = useState('');
  const sizes = [10, 25, 50, 100];

  const effectiveSize = pageSize === 'all' ? Math.max(data.total, 1) : pageSize;

  const reload = () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (sheet) params.set('sheet', sheet);
    if (date) { params.set('from', date); params.set('to', date); }
    params.set('limit', effectiveSize);
    params.set('offset', (page - 1) * effectiveSize);
    api.get('/spoc?' + params.toString()).then(setData).catch(e => setErr(e.message));
  };
  useEffect(() => { reload(); }, [q, sheet, date, page, pageSize]);
  useRefresh(reload);

  const pages = Math.max(1, Math.ceil(data.total / effectiveSize));
  // Clamp page when filter shrinks the result set.
  useEffect(() => { if (page > pages) setPage(1); }, [pages, page]);
  const start = (page - 1) * effectiveSize;
  const end = Math.min(start + effectiveSize, data.total);
  // Synthetic ctl matching the shape consumed by <Paginator/>.
  const ctl = { total: data.total, page, pages, pageSize, setPage, setPageSize, sizes, start, end };
  const fixed = data.fixedColumns || [];

  return (
    <>
      <div className="spoc-toolbar">
        <div>
          <h2>SPOC</h2>
        </div>
        <div className="controls">
          <input
            type="text" placeholder="Search any field…"
            value={q} onChange={e => { setPage(1); setQ(e.target.value); }}
          />
          {data.sheets && data.sheets.length > 1 && (
            <select value={sheet} onChange={e => { setPage(1); setSheet(e.target.value); }}>
              <option value="">All sheets</option>
              {data.sheets.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <DatePill value={date} onChange={v => { setPage(1); setDate(v); }} title="Filter by Time column" />
        </div>
      </div>

      {err && <div className="error-banner" style={{marginBottom:12}}>{err}</div>}

      <Paginator ctl={ctl} label="entries" />

      {data.items.length === 0 ? (
        <div className="spoc-empty">
          <p>No SPOC entries yet.</p>
          <p style={{fontSize:12}}>
            Configure the download URL in <em>Settings → SPOC</em> and click <em>Import now</em>,
            or wait for the daily 00:10 sync.
          </p>
        </div>
      ) : (
        <div className="spoc-table-wrap">
          <table className="spoc-table">
            <thead>
              <tr>
                {fixed.map(c => <th key={c.label}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.items.map(r => (
                <tr key={r.id}>
                  {fixed.map(c => {
                    const isClip = c.label === 'Query Summary' || c.label === 'Query / Description';
                    const isTime = c.label === 'Time';
                    const isTicket = c.label === 'Ticket ID';
                    const cls = isClip ? 'spoc-clip' : (isTime ? 'time-cell' : '');
                    return (
                      <td key={c.label} className={cls} title={isClip ? String(r.data[c.key] || '') : undefined}>
                        {isTicket ? <span className="ticket-id">{r.data[c.key] || ''}</span> : formatCell(r.data[c.key])}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Paginator ctl={ctl} label="entries" />
    </>
  );
}

// Friendly labels for the SPOC import job stages emitted by spoc.runImport.
const SPOC_STAGE_LABELS = {
  start:    'Starting…',
  download: 'Downloading from Zoho…',
  scan:     'Scanning inbox…',
  hash:     'Hashing file…',
  parse:    'Parsing spreadsheet…',
  write:    'Writing to database…',
  done:     'Done',
  error:    'Failed',
};
function stageLabel(s) { return SPOC_STAGE_LABELS[s] || s || '…'; }

// SPOC admin panel — embedded inside the Settings tab. All the import config,
// download URL, manual import, history and inbox listing live here.
function SpocSettingsPanel() {
  const [inbox, setInbox] = useState({ dir: '', files: [], downloadUrl: '' });
  const [imports, setImports] = useState([]);
  const [people, setPeople] = useState([]);
  const [me, setMe] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Live progress for the SPOC import job. While running we poll
  // /spoc/import-status/:jobId every 500ms and render a progress bar.
  const [progress, setProgress] = useState(null); // { stage, pct, detail, status }

  const reload = () => {
    api.get('/spoc/inbox').then(r => { setInbox(r); setUrlDraft(r.downloadUrl || ''); }).catch(()=>{});
    api.get('/spoc/imports').then(r => setImports(r.items || [])).catch(()=>{});
    api.get('/spoc?limit=1').then(r => { setPeople(r.trackerColumns || []); setMe(r.me || ''); }).catch(()=>{});
  };
  useEffect(() => { reload(); }, []);
  useRefresh(reload);

  const saveUrl = async () => {
    setBusy(true); setErr('');
    try {
      await api.post('/spoc/url', { url: urlDraft });
      window.toast && window.toast('Download URL saved', 'success');
      reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const saveMe = async (val) => {
    setMe(val);
    try { await api.post('/spoc/me', { me: val }); }
    catch (e) { window.toast && window.toast(e.message, 'error'); }
  };

  const importNow = async (force = false) => {
    setBusy(true); setErr('');
    setProgress({ stage: 'start', pct: 0, detail: 'starting…', status: 'running' });
    try {
      const r = await api.post('/spoc/import-now', { force });
      const jobId = r && r.jobId;
      if (!jobId) {
        // Server fell back to legacy synchronous response.
        setProgress(null);
        if (r.error) { setErr(r.error); window.toast && window.toast(r.error, 'error'); }
        else if (r.skipped) { window.toast && window.toast(`Skipped: ${r.reason}`, 'info', 6000); }
        else { window.toast && window.toast(`Imported ${r.rowsNew}/${r.rowsTotal} new rows from ${r.file}`, 'success'); }
        reload();
        return;
      }
      // Poll until the job finishes.
      let final = null;
      while (true) {
        await new Promise(res => setTimeout(res, 500));
        let s;
        try { s = await api.get('/spoc/import-status/' + jobId); }
        catch (e) { setErr(e.message); break; }
        setProgress({ stage: s.stage, pct: s.pct, detail: s.detail, status: s.status });
        if (s.status !== 'running') { final = s; break; }
      }
      if (final) {
        const result = final.result || {};
        if (final.status === 'error' || result.error) {
          const msg = final.error || result.error;
          setErr(msg);
          window.toast && window.toast(msg, 'error');
        } else if (result.skipped) {
          window.toast && window.toast(`Skipped: ${result.reason}`, 'info', 6000);
        } else {
          window.toast && window.toast(`Imported ${result.rowsNew}/${result.rowsTotal} new rows from ${result.file}`, 'success');
        }
        if (result.download && result.download.attempted && !result.download.ok) {
          window.toast && window.toast(`Remote download: ${result.download.error}`, 'warn', 6000);
        }
      }
      reload();
    } catch (e) { setErr(e.message); }
    finally {
      setBusy(false);
      // Keep the bar visible briefly at 100% so the user sees "done".
      setTimeout(() => setProgress(null), 1500);
    }
  };

  return (
    <>
      <h3 style={{marginTop:0, display:'flex', alignItems:'center', gap:8}}><Icon name="analysts" size={18} /> SPOC</h3>
      <p className="meta" style={{fontSize:12, marginTop:-6}}>
        The SPOC tab pulls a daily ticket sheet from Zoho WorkDrive, dedupes by Ticket ID and lets each
        person mark which rows they've read. The fetcher uses headless Chromium to click the public-share
        Download button, so the URL just needs to be the external-share link.
      </p>

      {err && <div className="error-banner" style={{margin:'8px 0'}}>{err}</div>}

      <div style={{marginBottom:18}}>
        <label style={{display:'block', fontSize:12, fontWeight:600, marginBottom:4}}>Download URL</label>
        <div className="row" style={{gap:8, flexWrap:'wrap'}}>
          <input
            type="url" value={urlDraft} onChange={e => setUrlDraft(e.target.value)}
            placeholder="https://workdrive.zohoexternal.in/external/.../download"
            style={{flex:'1 1 360px', minWidth:280, padding:'6px 10px', fontFamily:'monospace', fontSize:12}}
          />
          <button className="ghost small" disabled={busy || urlDraft === (inbox.downloadUrl || '')} onClick={saveUrl}>Save URL</button>
        </div>
        <div className="muted" style={{fontSize:11, marginTop:4}}>
          Stored in <code>settings.spoc_download_url</code>. The scheduler runs daily at 00:10.
        </div>
      </div>

      <div style={{marginBottom:18}}>
        <label style={{display:'block', fontSize:12, fontWeight:600, marginBottom:4}}>Manual import</label>
        <div className="row" style={{gap:8}}>
          <button className="ghost" disabled={busy} onClick={() => importNow(false)}>{busy ? 'Importing…' : 'Import now'}</button>
          <button className="ghost small" disabled={busy} onClick={() => importNow(true)} title="Re-parse even if the file's sha256 was already imported">Force re-import</button>
        </div>
        {progress && (
          <div className="spoc-progress" style={{marginTop:10}}>
            <div className="spoc-progress-head">
              <span className="spoc-progress-stage">{stageLabel(progress.stage)}</span>
              <span className="spoc-progress-pct">{progress.pct || 0}%</span>
            </div>
            <div className="spoc-progress-bar">
              <div
                className={'spoc-progress-fill' + (progress.status === 'error' ? ' err' : '') + (progress.status === 'done' ? ' ok' : '')}
                style={{width: `${Math.max(2, progress.pct || 0)}%`}}
              />
            </div>
            <div className="spoc-progress-detail" title={progress.detail || ''}>{progress.detail || ''}</div>
          </div>
        )}
        <div className="muted" style={{fontSize:11, marginTop:4}}>
          Watched folder: <code>{inbox.dir}</code>. Manually-dropped XLSX/CSV files are picked up too — newest wins.
        </div>
      </div>

      <details style={{marginTop:12}}>
        <summary style={{cursor:'pointer', fontWeight:600}}>Import history ({imports.length})</summary>
        <table className="data-table" style={{width:'100%', marginTop:8, fontSize:12, borderCollapse:'collapse'}}>
          <thead>
            <tr>
              <th style={thStyle}>When</th>
              <th style={thStyle}>File</th>
              <th style={thStyle}>Rows (total / new)</th>
              <th style={thStyle}>Sheets</th>
              <th style={thStyle}>SHA-256</th>
            </tr>
          </thead>
          <tbody>
            {imports.map(i => (
              <tr key={i.id}>
                <td style={tdStyle}>{i.imported_at}</td>
                <td style={tdStyle}>{i.file_name}</td>
                <td style={tdStyle}>{i.rows_total} / <strong>{i.rows_new}</strong></td>
                <td style={tdStyle}>{(i.sheets || []).map(s => `${s.sheet}(${s.rows})`).join(', ')}</td>
                <td style={{...tdStyle, fontFamily:'monospace', fontSize:11}}>{(i.file_sha256 || '').slice(0, 12)}…</td>
              </tr>
            ))}
            {imports.length === 0 && (
              <tr><td colSpan={5} style={{...tdStyle, textAlign:'center', color:'#888'}}>No imports yet.</td></tr>
            )}
          </tbody>
        </table>
      </details>
    </>
  );
}

const thStyle = { textAlign:'left', padding:'8px 10px', borderBottom:'2px solid #2a2f3a', position:'sticky', top:0, background:'#1a1f2a', whiteSpace:'nowrap' };
const tdStyle = { padding:'6px 10px', borderBottom:'1px solid #222831', verticalAlign:'top' };
function formatCell(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  // Render emails / URLs as-is; otherwise return text.
  if (/^https?:\/\//i.test(s)) return <a href={s} target="_blank" rel="noopener noreferrer">{s}</a>;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return <a href={`mailto:${s}`}>{s}</a>;
  return s;
}

function MailDigestSettingsPanel() {
  const [status, setStatus] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [draft, setDraft] = useState('');
  const [timeDraft, setTimeDraft] = useState('00:15');
  const [busy, setBusy] = useState(false);
  const [savingTime, setSavingTime] = useState(false);
  const [sending, setSending] = useState(false);
  const [scheduler, setScheduler] = useState(null);

  const load = () => {
    api.get('/mail/status').then(s => {
      setStatus(s);
      setRecipients(s.recipients || []);
      if (s.digestTime) setTimeDraft(s.digestTime);
    }).catch(()=>{});
    api.get('/scheduler/status').then(setScheduler).catch(()=>{});
  };
  useEffect(() => { load(); }, []);

  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());

  const addRecipient = async (raw) => {
    const list = String(raw || '').split(/[,\s;]+/).map(s => s.trim()).filter(Boolean);
    if (!list.length) return;
    const bad = list.filter(e => !isEmail(e));
    if (bad.length) { window.toast && window.toast('Invalid email: ' + bad.join(', '), 'error'); return; }
    const next = Array.from(new Set([...recipients, ...list]));
    await save(next);
  };
  const removeRecipient = async (e) => {
    const next = recipients.filter(r => r !== e);
    await save(next);
  };
  const save = async (next) => {
    setBusy(true);
    try {
      const r = await api.put('/mail/settings', { recipients: next });
      if (r.error) { window.toast && window.toast(r.error, 'error'); return; }
      setRecipients(r.recipients || []);
      setDraft('');
      window.toast && window.toast('Saved', 'success');
    } finally { setBusy(false); }
  };
  const sendNow = async (overrideTo) => {
    setSending(true);
    try {
      const body = overrideTo ? { to: overrideTo } : {};
      const r = await api.post('/mail/digest/send-now', body);
      if (r.error) { window.toast && window.toast(r.error, 'error'); return; }
      window.toast && window.toast(`Sent to ${r.to}`, 'success');
      load();
    } finally { setSending(false); }
  };

  const digestJob = scheduler && (scheduler.jobs || []).find(j => j.key === 'digest');
  const nextRunStr = digestJob && digestJob.nextRun ? new Date(digestJob.nextRun).toLocaleString() : '—';
  const lastRunStr = digestJob && digestJob.lastRun ? new Date(digestJob.lastRun).toLocaleString() : 'never';

  const saveTime = async () => {
    if (!/^\d{1,2}:\d{2}$/.test(timeDraft)) { window.toast && window.toast('Time must be HH:MM', 'error'); return; }
    setSavingTime(true);
    try {
      const r = await api.put('/mail/settings', { digestTime: timeDraft });
      if (r.error) { window.toast && window.toast(r.error, 'error'); return; }
      setStatus(s => ({ ...(s||{}), digestTime: r.digestTime, digestHour: r.digestHour, digestMinute: r.digestMinute }));
      window.toast && window.toast(`Digest time saved (${r.digestTime})`, 'success');
      // Refresh scheduler card so nextRun reflects the new slot.
      api.get('/scheduler/status').then(setScheduler).catch(()=>{});
    } finally { setSavingTime(false); }
  };

  return (
    <>
      <h3 style={{marginTop:0, display:'flex', alignItems:'center', gap:8}}>
        <Icon name="feed" size={18} /> Email digest
      </h3>
      <p className="meta" style={{fontSize:12, marginTop:-6}}>
        Daily digest sent at <strong>{status && status.digestTime ? `${status.digestTime} IST` : '—'}</strong>.
        Includes SPOC tickets from the last 24h (with chat links) and competitive / analyst / industry-news feed activity.
        SPOC sync runs at 00:10 IST — pick a digest time after that so the latest sheet data is included.
      </p>

      {status && !status.configured && (
        <div className="callout" style={{padding:10, border:'1px solid #f59e0b', borderRadius:6, background:'rgba(245,158,11,0.08)', marginBottom:12}}>
          <strong>Not configured.</strong> Set <code>ZOHO_MAIL_CLIENT_ID</code>, <code>ZOHO_MAIL_CLIENT_SECRET</code>,
          <code> ZOHO_MAIL_REFRESH_TOKEN</code>, <code>ZOHO_MAIL_ACCOUNT_ID</code> and <code>ZOHO_MAIL_FROM</code>
          in <code>server/.env</code>, then restart pm-panel.
        </div>
      )}

      {status && status.configured && (
        <div style={{display:'grid', gridTemplateColumns:'160px 1fr', rowGap:6, fontSize:13, marginBottom:14}}>
          <div className="meta">From</div><div><code>{status.from}</code></div>
          <div className="meta">Account ID</div><div><code>{status.accountId}</code></div>
          <div className="meta">Scheduler</div>
          <div>
            {scheduler && scheduler.enabled ? <span className="badge success">enabled</span>
                                            : <span className="badge low">disabled</span>}
            {' '}<span className="meta" style={{fontSize:12}}>
              · next run {nextRunStr} · last run {lastRunStr}
            </span>
          </div>
          {digestJob && digestJob.lastResult && (
            <>
              <div className="meta">Last result</div>
              <div style={{fontSize:12}}>
                {digestJob.lastResult.error
                  ? <span style={{color:'#ef4444'}}>error: {digestJob.lastResult.error}</span>
                  : digestJob.lastResult.skipped
                    ? <span className="meta">skipped: {digestJob.lastResult.reason}</span>
                    : <>sent · messageId <code>{digestJob.lastResult.messageId || '?'}</code></>}
              </div>
            </>
          )}
        </div>
      )}

      <h4 style={{marginBottom:6}}>Send time</h4>
      <p className="meta" style={{fontSize:12, marginTop:-4, marginBottom:8}}>
        Server clock is Asia/Kolkata, so this is the local IST time the digest fires every day.
      </p>
      <form
        onSubmit={(e) => { e.preventDefault(); saveTime(); }}
        style={{display:'flex', gap:6, marginBottom:18, alignItems:'center'}}
      >
        <input
          type="time"
          value={timeDraft}
          onChange={e => setTimeDraft(e.target.value)}
          disabled={savingTime}
          style={{padding:'6px 10px', border:'1px solid var(--border)', borderRadius:4, background:'var(--bg)', color:'var(--text)'}}
        />
        <button type="submit" className="primary" disabled={savingTime || !timeDraft || (status && timeDraft === status.digestTime)}>
          {savingTime ? 'Saving…' : 'Save time'}
        </button>
        {status && status.digestTime && (
          <span className="meta" style={{fontSize:12}}>
            current: <code>{status.digestTime}</code>
          </span>
        )}
      </form>

      <h4 style={{marginBottom:6}}>Recipients</h4>
      <div style={{display:'flex', flexWrap:'wrap', gap:6, marginBottom:8}}>
        {recipients.length === 0 && <span className="meta" style={{fontSize:12}}>No recipients saved — daily digest will be skipped.</span>}
        {recipients.map(r => (
          <span key={r} className="chip" style={{display:'inline-flex', alignItems:'center', gap:6, padding:'3px 8px', border:'1px solid var(--border)', borderRadius:12, fontSize:12, background:'var(--bg-soft)'}}>
            {r}
            <button
              type="button"
              onClick={() => removeRecipient(r)}
              disabled={busy}
              title="Remove"
              style={{background:'transparent', border:'none', color:'var(--muted)', cursor:'pointer', padding:0, fontSize:14, lineHeight:1}}
            >×</button>
          </span>
        ))}
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); addRecipient(draft); }}
        style={{display:'flex', gap:6, marginBottom:18}}
      >
        <input
          type="text"
          placeholder="someone@example.com (comma- or space-separated)"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          disabled={busy}
          style={{flex:1, padding:'6px 10px', border:'1px solid var(--border)', borderRadius:4, background:'var(--bg)', color:'var(--text)'}}
        />
        <button type="submit" className="primary" disabled={busy || !draft.trim()}>Add</button>
      </form>

      <div style={{display:'flex', gap:8, flexWrap:'wrap', marginBottom:8}}>
        <button
          type="button"
          className="primary"
          onClick={() => sendNow()}
          disabled={!status || !status.configured || sending || recipients.length === 0}
          title={recipients.length === 0 ? 'Add at least one recipient' : `Send digest now to ${recipients.length} recipient(s)`}
        >
          {sending ? 'Sending…' : `Send digest now${recipients.length ? ` (${recipients.length})` : ''}`}
        </button>
        <a href="/api/mail/digest/preview" target="_blank" rel="noreferrer">
          <button type="button" className="ghost">Preview HTML</button>
        </a>
        <SendToOther onSend={(addr) => sendNow(addr)} disabled={!status || !status.configured || sending} />
      </div>
      <p className="meta" style={{fontSize:11, marginTop:8}}>
        The digest scheduler runs at 21:00 IST daily. Click "Send digest now" to fire it immediately
        to the saved recipients, or use "Send to other…" for a one-off test.
      </p>
    </>
  );
}

function SendToOther({ onSend, disabled }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState('');
  if (!open) return <button type="button" className="ghost" disabled={disabled} onClick={() => setOpen(true)}>Send to other…</button>;
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (val.trim()) { onSend(val.trim()); setOpen(false); setVal(''); } }}
      style={{display:'flex', gap:6}}
    >
      <input
        autoFocus
        type="email"
        placeholder="address@domain.com"
        value={val}
        onChange={e => setVal(e.target.value)}
        style={{padding:'6px 10px', border:'1px solid var(--border)', borderRadius:4, background:'var(--bg)', color:'var(--text)', minWidth:240}}
      />
      <button type="submit" className="primary" disabled={!val.trim()}>Send</button>
      <button type="button" className="ghost" onClick={() => { setOpen(false); setVal(''); }}>Cancel</button>
    </form>
  );
}

function Settings() {
  const [llm, setLlm] = useState({ enabled: false, model: '' });
  const SECTIONS = [
    { id: 'ai',         label: 'AI & Tokens',  icon: 'key',      desc: 'GitHub Models token, default model, expiry reminders.' },
    { id: 'scheduler',  label: 'Scheduler',    icon: 'clock',    desc: 'Hourly automatic ingestion for catalog, analysts, industry.' },
    { id: 'catalog',    label: 'Catalog',      icon: 'catalog',  desc: 'Products, competitors and ingestion sources.' },
    { id: 'analysts',   label: 'Analysts',     icon: 'analysts', desc: 'Industry analyst firms and feeds.' },
    { id: 'news',       label: 'Industry News',icon: 'feed',     desc: 'Security press outlets (Dark Reading, SecurityWeek…).' },
    { id: 'spoc',       label: 'SPOC',         icon: 'analysts', desc: 'Daily ticket sheet sync, download URL and read-tracker identity.' },
    { id: 'email',      label: 'Email digest', icon: 'feed',     desc: 'Daily 21:00 IST mail \u2014 recipients, preview, send-now.' },
    { id: 'appearance', label: 'Appearance',   icon: 'sparkles', desc: 'Light or dark theme — applied instantly.' },
    { id: 'about',      label: 'About',        icon: 'shield',   desc: 'Build info and helpful links.' },
  ];
  const [section, setSection] = useSubRoute('settings', SECTIONS.map(s => s.id), 'ai');
  const load = () => api.get('/llm/status').then(setLlm).catch(()=>{});
  useEffect(() => { load(); }, []);
  useRefresh(load);

  return (
    <>
      <div className="toolbar">
        <h2><Icon name="settings" size={22} /> Settings</h2>
      </div>
      <p className="meta" style={{margin:'-4px 0 14px', fontSize:12}}>
        Configure how the panel connects to AI services and your daily competitive feed.
      </p>

      <div className="settings-layout">
        <aside className="settings-nav">
          {SECTIONS.map(s => (
            <button
              key={s.id}
              className={'settings-nav-item' + (section === s.id ? ' active' : '')}
              onClick={() => setSection(s.id)}
              type="button"
            >
              <span className="settings-nav-icon"><Icon name={s.icon} size={18} /></span>
              <span>
                <strong>{s.label}</strong>
                <div className="meta" style={{fontSize:11, marginTop:2}}>{s.desc}</div>
              </span>
            </button>
          ))}
        </aside>

        <section className="settings-body">
          {section === 'ai' && (
            <>
              <h3 style={{marginTop:0, display:'flex', alignItems:'center', gap:8}}><Icon name="key" size={18} /> AI & Tokens</h3>
              <p className="meta" style={{fontSize:12, marginTop:-6}}>
                The panel uses <strong>GitHub Models</strong> to extract features and score gaps from every fetched item. You need a GitHub Personal Access Token (PAT) to enable this.
              </p>
              <AISettingsPanel llm={llm} onChange={load} forceOpen />
            </>
          )}
          {section === 'scheduler' && (
            <>
              <h3 style={{marginTop:0, display:'flex', alignItems:'center', gap:8}}><Icon name="clock" size={18} /> Scheduler</h3>
              <p className="meta" style={{fontSize:12, marginTop:-6}}>
                Run ingestion automatically every hour. Catalog jobs fire at :00, analyst feeds at :20, industry news at :40.
              </p>
              <SchedulerCard onChange={load} />
            </>
          )}
          {section === 'catalog' && (
            <div className="settings-embed">
              <Catalog embedded />
            </div>
          )}
          {section === 'analysts' && (
            <div className="settings-embed">
              <Analysts embedded />
            </div>
          )}
          {section === 'news' && (
            <div className="settings-embed">
              <IndustryNewsAdmin embedded />
            </div>
          )}
          {section === 'spoc' && <SpocSettingsPanel />}
          {section === 'email' && <MailDigestSettingsPanel />}
          {section === 'appearance' && (
            <>
              <h3 style={{marginTop:0, display:'flex', alignItems:'center', gap:8}}><Icon name="sparkles" size={18} /> Appearance</h3>
              <p className="meta" style={{fontSize:12, marginTop:-6}}>
                Switch between dark and light themes. Your choice is saved in this browser.
              </p>
              <ThemeToggle />
            </>
          )}
          {section === 'about' && (
            <>
              <h3 style={{marginTop:0, display:'flex', alignItems:'center', gap:8}}><Icon name="shield" size={18} /> About</h3>
              <ul style={{lineHeight:1.8, paddingLeft:18}}>
                <li><strong>Backend:</strong> Node.js + Express + SQLite (<code>pm-panel.db</code>).</li>
                <li><strong>AI provider:</strong> <a href="https://github.com/marketplace/models" target="_blank" rel="noreferrer" style={{color:'var(--accent)'}}>GitHub Models</a> (OpenAI, Mistral, Cohere, Llama, etc.).</li>
                <li><strong>Where data lives:</strong> everything (raw feed items, gaps, releases, your token) stays in the local SQLite file under <code>pm-panel/server/</code>.</li>
                <li><strong>Privacy:</strong> raw item titles + content are sent to GitHub Models for analysis. Don't ingest confidential data.</li>
              </ul>
              <div className="muted" style={{marginTop:16, fontSize:12, textAlign:'center', borderTop:'1px solid var(--border)', paddingTop:12}}>
                © {new Date().getFullYear()} VJ Saairam. All rights reserved.
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}

// Catalog: merged Products + Sources management (no raw items, no analyze controls).
function Catalog({ embedded = false }) {
  const [sources, setSources] = useState([]);
  const [products, setProducts] = useState([]);
  const [llm, setLlm] = useState({ enabled: false, model: '' });
  const [editingSource, setEditingSource] = useState(null);
  const [editingProduct, setEditingProduct] = useState(null);
  const [busy, setBusy] = useState({});
  const [error, setError] = useState(null);
  const [productsOpen, setProductsOpen] = useState(true);
  const [expanded, setExpanded] = useState({}); // { [productId]: bool }
  const [bulkImport, setBulkImport] = useState(null); // { product_id }
  const [pending, setPending] = useState(0);
  const load = () => {
    Promise.all([api.get('/sources'), api.get('/products'), api.get('/llm/status'), api.get('/raw-items/pending-count').catch(()=>({count:0}))])
      .then(([s, p, l, pend]) => {
        setSources(s);
        setProducts(p.filter(x => (x.kind||'product') === 'product'));
        setLlm(l);
        setPending(pend?.count || 0);
      })
      .catch(e => setError(e.message));
  };
  useEffect(() => { load(); }, []);
  useRefresh(load);
  const productName = (id) => (products.find(p => p.id === id) || {}).name || '?';
  const setBusyKey = (k, v) => setBusy(prev => ({ ...prev, [k]: v }));
  const productsCtl = usePaginated(products);
  const sourcesCtl = usePaginated(sources, { defaultSize: 25, sizes: [10, 25, 50, 100] });

  const saveProduct = async (form) => {
    if (form.id) await api.put('/products/' + form.id, form);
    else await api.post('/products', { ...form, kind: 'product' });
    setEditingProduct(null); load();
  };
  const delProduct = async (id) => { if (confirm('Delete product? Its sources & raw items will be orphaned.')) { await api.del('/products/' + id); load(); } };
  const saveSource = async (form) => {
    if (form.id) await api.put('/sources/' + form.id, form);
    else await api.post('/sources', form);
    setEditingSource(null); load();
  };
  const delSource = async (id) => { if (confirm('Delete source?')) { await api.del('/sources/' + id); load(); } };
  const runSource = async (s) => {
    setBusyKey('src' + s.id, true);
    try {
      const r = await api.post(`/sources/${s.id}/run?auto=1`);
      const a = r.analysis;
      const extra = a ? ` — analyzed ${a.analyzed} · ${a.requirements} gap${a.requirements===1?'':'s'} · ${a.releases} rel${a.errors?` · ${a.errors} err`:''}` : '';
      window.toast(`Fetched ${r.fetched} · ${r.inserted} new${extra}`, 'success');
      load();
    }
    catch (e) { window.toast('Fetch failed: ' + e.message, 'error'); }
    finally { setBusyKey('src' + s.id, false); }
  };
  const runAll = async () => {
    setBusyKey('all', true);
    try {
      const r = await api.post('/ingest/run-all', { auto: true });
      const a = r.analysis;
      const pollMsg = `Polled ${r.results.length} source${r.results.length === 1 ? '' : 's'}`;
      if (!a || a.analyzed + a.errors === 0) {
        // Nothing new to analyze
        window.toast(`${pollMsg} — no new items`, 'success');
      } else if (a.lastErrorKind === 'no_token') {
        window.toast(`${pollMsg}. AI is disabled — items saved as pending. Add a token in Settings → AI to analyze.`, 'warn');
      } else if (a.lastErrorKind === 'rate_limit') {
        const stopped = a.aborted ? ' — stopped early after repeated rate-limits' : '';
        window.toast(`${pollMsg}. AI tokens exhausted${stopped}. Analyzed ${a.analyzed} before hitting limits; ${a.errors} skipped — will retry once a token recovers.`, 'warn');
      } else if (a.lastErrorKind === 'auth') {
        window.toast(`${pollMsg}. AI authentication failed — ${a.analyzed} analyzed, ${a.errors} skipped. Check tokens in Settings → AI.`, 'error');
      } else if (a.errors > 0) {
        window.toast(`${pollMsg} — analyzed ${a.analyzed} · ${a.requirements} gap${a.requirements === 1 ? '' : 's'} · ${a.releases} rel · ${a.errors} err`, 'warn');
      } else {
        window.toast(`${pollMsg} — analyzed ${a.analyzed} · ${a.requirements} gap${a.requirements === 1 ? '' : 's'} · ${a.releases} rel`, 'success');
      }
      load();
    }
    catch (e) { window.toast(e.message, 'error'); }
    finally { setBusyKey('all', false); }
  };

  const analyzePending = async () => {
    setBusyKey('pending', true);
    try {
      const r = await api.post('/ingest/analyze-pending', { limit: 200 });
      window.toast(`Analyzed ${r.analyzed} · ${r.releases} release${r.releases===1?'':'s'} · ${r.requirements} gap${r.requirements===1?'':'s'}${r.errors?` · ${r.errors} err`:''}${r.pending?` · ${r.pending} still pending`:''}`, 'success');
      load();
    }
    catch (e) { window.toast('Analyze failed: ' + e.message, 'error'); }
    finally { setBusyKey('pending', false); }
  };

  const productSources = (id) => sources.filter(s => s.product_id === id);

  return (
    <>
      <div className="toolbar">
        {!embedded && <h2><Icon name="catalog" size={22} /> Catalog</h2>}
        {embedded && <h3 style={{margin:0, display:'flex', alignItems:'center', gap:8}}><Icon name="catalog" size={18} /> Catalog</h3>}
      </div>
      {error && <p style={{color:'#f87171'}}>Error: {error}</p>}

      {!llm.enabled && (
        <div className="ai-warn ai-warn-error" style={{marginTop:8}}>
          ⚠ AI is disabled — no GitHub token saved. Open <a href="#" onClick={(e)=>{e.preventDefault(); window.pmNavigate && window.pmNavigate('settings/ai');}} style={{color:'var(--accent)'}}>⚙️ Settings → AI</a> to paste one. Until then, fetched items stay <em>pending</em>.
        </div>
      )}

      {/* === Products & ingestion sources (merged, collapsible) ============== */}
      <div className={'dash-widget collapsible' + (productsOpen ? ' open' : '')}>
        <div className="collapsible-head">
          <div
            className="collapsible-toggle"
            role="button"
            tabIndex={0}
            onClick={() => setProductsOpen(o => !o)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setProductsOpen(o => !o); } }}
            aria-expanded={productsOpen}
          >
            <Icon name={productsOpen ? 'chevDown' : 'chevRight'} size={14} className="collapsible-chev"/>
            <Icon name="package" size={16}/>
            <h3>Products &amp; ingestion sources</h3>
            <span className="badge">{products.length} prod · {sources.length} src</span>
            <span className="muted collapsible-sub">Expand a row to see / manage its RSS &amp; HTML feeds</span>
          </div>
          <div className="collapsible-actions">
            <button className="ghost small" onClick={() => setBulkImport({ product_id: products.find(p=>p.is_own)?.id || products[0]?.id || '', text: '' })} title="Paste a feature list to seed an own-product matrix row without scraping">
              <Icon name="layers" size={12}/> Bulk-import
            </button>
            <button className="ghost small" onClick={() => setEditingProduct({ name: '', is_own: 0, vendor: '', website: '', notes: '', pros: '', cons: '', roadmap: '' })}>+ Add product</button>
            <button className="ghost small" onClick={() => setEditingSource({ product_id: products.find(p=>!p.is_own)?.id || '', kind: 'rss', url: '', label: '' })}>+ Add source</button>
            {pending > 0 && (
              <button className="ghost small" onClick={analyzePending} disabled={busy.pending} title={`${pending} ingested item${pending===1?'':'s'} not yet AI-analyzed. Click to extract features/releases.`}>
                {busy.pending ? 'Analyzing…' : <><Icon name="sparkles" size={12}/> Analyze pending ({pending})</>}
              </button>
            )}
            <button className="small" onClick={runAll} disabled={busy.all || sources.length === 0} title="Fetch every source URL now and auto-analyze new items">
              {busy.all ? 'Polling…' : <><Icon name="refresh" size={12}/> Poll all</>}
            </button>
          </div>
        </div>
        {productsOpen && (
          <div className="collapsible-body">
            {products.length > 0 && <Paginator ctl={productsCtl} label="products" />}
            <table className="modern-table">
              <thead><tr><th style={{width:28}}></th><th>Name</th><th>Vendor</th><th>Pros</th><th>Cons</th><th>Roadmap / plans</th><th>Sources</th><th></th></tr></thead>
              <tbody>
                {productsCtl.slice.map(p => {
                  const srcs = productSources(p.id);
                  const isOpen = !!expanded[p.id];
                  return (
                    <React.Fragment key={p.id}>
                      <tr className={isOpen ? 'expanded-row' : ''}>
                        <td>
                          <button
                            className="icon-btn ghost-icon"
                            onClick={() => setExpanded(prev => ({ ...prev, [p.id]: !prev[p.id] }))}
                            title={isOpen ? 'Hide sources' : 'Show sources'}
                            aria-label="Toggle sources"
                          >
                            <Icon name={isOpen ? 'chevDown' : 'chevRight'} size={14}/>
                          </button>
                        </td>
                        <td>
                          <strong>{p.name}</strong> {p.is_own ? <span className="badge own">OURS</span> : null}
                          {p.website && <div><a href={p.website} target="_blank" style={{color:'var(--accent)',fontSize:11}}>{p.website}</a></div>}
                        </td>
                        <td className="meta">{p.vendor||'—'}</td>
                        <td style={{maxWidth:220,whiteSpace:'pre-wrap',color:'var(--good)'}}>{p.pros||<span className="muted">—</span>}</td>
                        <td style={{maxWidth:220,whiteSpace:'pre-wrap',color:'#fca5a5'}}>{p.cons||<span className="muted">—</span>}</td>
                        <td style={{maxWidth:220,whiteSpace:'pre-wrap'}}>{p.roadmap||<span className="muted">—</span>}</td>
                        <td className="meta">
                          {srcs.length === 0
                            ? <span className="muted" title="No ingestion sources — Poll all won't fetch anything for this product">0 ⚠</span>
                            : srcs.length}
                        </td>
                        <td>
                          <div className="row-actions">
                            <button className="icon-btn ghost-icon" onClick={() => setEditingSource({ product_id: p.id, kind: 'rss', url: '', label: '' })} title="Add source for this product" aria-label="Add source"><Icon name="feed" size={14}/></button>
                            <button className="icon-btn ghost-icon" onClick={() => setEditingProduct(p)} title="Edit product" aria-label="Edit product"><Icon name="edit" size={14}/></button>
                            {!p.is_own && <button className="icon-btn ghost-icon danger-hover" onClick={() => delProduct(p.id)} title="Delete" aria-label="Delete"><Icon name="trash" size={14}/></button>}
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="nested-row">
                          <td></td>
                          <td colSpan="7" style={{padding:'8px 12px 12px'}}>
                            {srcs.length === 0 ? (
                              <div className="muted" style={{fontSize:12, padding:'6px 0'}}>
                                No ingestion sources yet.
                                <button className="ghost small" style={{marginLeft:10}} onClick={() => setEditingSource({ product_id: p.id, kind: 'rss', url: '', label: '' })}>+ Add source</button>
                              </div>
                            ) : (
                              <table className="modern-table nested-table">
                                <thead><tr><th>Kind</th><th>URL / label</th><th>Last polled</th><th></th></tr></thead>
                                <tbody>
                                  {srcs.map(s => (
                                    <tr key={s.id}>
                                      <td><span className="badge">{s.kind}</span></td>
                                      <td><a href={s.url} target="_blank" style={{color:'var(--accent)'}}>{s.label || s.url}</a></td>
                                      <td className="meta">{s.last_polled || '—'}</td>
                                      <td>
                                        <div className="row-actions">
                                          <button className="icon-btn ghost-icon" onClick={() => runSource(s)} disabled={busy['src'+s.id]} title="Fetch this source now" aria-label="Fetch"><Icon name="download" size={14}/></button>
                                          <button className="icon-btn ghost-icon" onClick={() => setEditingSource(s)} title="Edit source" aria-label="Edit source"><Icon name="edit" size={14}/></button>
                                          <button className="icon-btn ghost-icon danger-hover" onClick={() => delSource(s.id)} title="Delete" aria-label="Delete"><Icon name="trash" size={14}/></button>
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {products.length===0 && <tr><td colSpan="8" className="muted">No products yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editingProduct && <ProductForm value={editingProduct} onSave={saveProduct} onClose={() => setEditingProduct(null)} />}
      {editingSource && <SourceForm value={editingSource} products={products} onSave={saveSource} onClose={() => setEditingSource(null)} />}
      {bulkImport && <BulkImportFeaturesForm
        value={bulkImport}
        products={products}
        onSave={async (form) => {
          try {
            const r = await api.post('/product-features/bulk', form);
            window.toast(`Imported · ${r.inserted} new, ${r.updated} updated, ${r.createdFeatures} new feature${r.createdFeatures===1?'':'s'} created`, 'success');
            setBulkImport(null);
          } catch (e) { window.toast('Import failed: ' + e.message, 'error'); }
        }}
        onClose={() => setBulkImport(null)}
      />}
    </>
  );
}

// FeedHub: tabbed wrapper merging Competitive Feed, Analyst Firms, and Industry News.
function FeedHub() {
  const TABS = [
    { id: 'competitive', label: 'Competitive Feed' },
    { id: 'analysts',    label: 'Analyst Firms' },
    { id: 'news',        label: 'Industry News' },
  ];
  const [tab, setTab] = useSubRoute('feed', TABS.map(t => t.id), 'competitive');
  return (
    <>
      <div className="feed-tabs" style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border)' }}>
        {TABS.map(t => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="ghost"
              style={{
                padding: '10px 16px',
                borderRadius: 0,
                border: 'none',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                background: 'transparent',
                color: active ? 'var(--text)' : 'var(--muted)',
                fontWeight: active ? 600 : 400,
                display: 'inline-flex', alignItems: 'center', gap: 6,
                cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tab === 'competitive' && <Feed />}
      {tab === 'analysts' && <AnalystsHub />}
      {tab === 'news' && <IndustryNewsHub />}
    </>
  );
}

// Feed: daily stream of raw items captured from sources. Auto-analyzed on ingest.
function Feed() {
  const [products, setProducts] = useState([]);
  const [sources, setSources] = useState([]);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState({});
  const [error, setError] = useState(null);
  const [pasting, setPasting] = useState(null);
  const [analysisView, setAnalysisView] = useState(null);
  const [productFilter, setProductFilter] = useState(() => {
    const v = window.pmFeedFilterProduct;
    if (v) { delete window.pmFeedFilterProduct; return String(v); }
    return '';
  });
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const load = () => {
    Promise.all([api.get('/products'), api.get('/raw-items'), api.get('/sources')])
      .then(([p, it, s]) => { setProducts(p); setItems(it); setSources(s); })
      .catch(e => setError(e.message));
  };
  useEffect(() => { load(); }, []);
  useRefresh(load);
  const productName = (id) => (products.find(p => p.id === id) || {}).name || '?';
  const setBusyKey = (k, v) => setBusy(prev => ({ ...prev, [k]: v }));

  const pollAll = async () => {
    setBusyKey('all', true);
    try {
      const r = await api.post('/ingest/run-all', { auto: true });
      const a = r.analysis;
      const extra = a ? ` — analyzed ${a.analyzed} · ${a.requirements} gap${a.requirements===1?'':'s'}${a.errors?` · ${a.errors} err`:''}` : '';
      window.toast(`Polled ${r.results.length} source${r.results.length===1?'':'s'} · ${r.results.reduce((n,x)=>n+(x.inserted||0),0)} new${extra}`, 'success');
      load();
    } catch (e) { window.toast(e.message, 'error'); }
    finally { setBusyKey('all', false); }
  };
  const pollOneSource = async (srcId) => {
    if (!srcId) return;
    setBusyKey('src' + srcId, true);
    try {
      const r = await api.post(`/sources/${srcId}/run?auto=1`);
      const a = r.analysis;
      const extra = a ? ` — analyzed ${a.analyzed} · ${a.requirements} gap${a.requirements===1?'':'s'} · ${a.releases} rel${a.errors?` · ${a.errors} err`:''}` : '';
      window.toast(`Fetched ${r.fetched} · ${r.inserted} new${extra}`, 'success');
      load();
    } catch (e) { window.toast('Poll failed: ' + e.message, 'error'); }
    finally { setBusyKey('src' + srcId, false); }
  };
  const reanalyzeItem = async (it) => {
    setBusyKey('it' + it.id, true);
    try {
      const r = await api.post(`/raw-items/${it.id}/analyze`);
      const gaps = (r.created_requests || []).length;
      window.toast(`Analyzed · ${gaps} gap${gaps===1?'':'s'} · ${r.release_id ? '1 release' : 'no release'}`, 'success');
      load();
    } catch (e) { window.toast('Analyze failed: ' + e.message, 'error'); }
    finally { setBusyKey('it' + it.id, false); }
  };
  const viewAnalysis = async (it) => {
    setBusyKey('it' + it.id, true);
    try {
      const full = await api.get('/raw-items/' + it.id);
      if (!full.analysis) { window.toast('Analysis still pending for this item.', 'info'); return; }
      setAnalysisView({ item: it, analysis: full.analysis });
    } catch (e) { window.toast('Could not load analysis: ' + e.message, 'error'); }
    finally { setBusyKey('it' + it.id, false); }
  };
  const delItem = async (id) => { if (confirm('Delete this entry from the feed?')) { await api.del('/raw-items/' + id); load(); } };
  const savePaste = async (form) => {
    const r = await api.post('/ingest/manual', { ...form, auto: true });
    setPasting(null);
    const a = r.analysis;
    if (a && a.analyzed) {
      const reqN = a.requirements || 0;
      window.toast(`Added & analyzed — ${reqN} gap${reqN===1?'':'s'} created`, 'success');
    } else {
      window.toast('Saved to feed', 'success');
    }
    load();
  };

  const competitorItems = items.filter(it => {
    const p = products.find(pp => pp.id === it.product_id);
    if (p && p.is_own) return false; // hide own products from Competitive Feed
    if (p && (p.kind || 'product') !== 'product') return false; // analyst + news live in their own tabs
    if (it.source_kind === 'html') return false; // HTML sources produce a page snapshot for the analyzer, not a per-article entry
    return true;
  });
  const filtered = competitorItems.filter(it =>
    (!productFilter || it.product_id === +productFilter) &&
    (!statusFilter || it.status === statusFilter) &&
    (!dateFilter || (it.published_at || it.fetched_at || '').slice(0, 10) === dateFilter)
  );
  const feedCtl = usePaginated(filtered, { defaultSize: 25, sizes: [10, 25, 50, 100] });
  const newCount = competitorItems.filter(i => i.status !== 'analyzed').length;

  const analyzePending = async () => {
    // Feed page only shows competitor items (own-product items are excluded
    // upstream). Pass explicit ids so the server analyzes EXACTLY what the
    // user sees pending here, not every status='new' item in the DB.
    const pending = competitorItems.filter(i => i.status !== 'analyzed');
    if (!pending.length) { window.toast('Nothing pending', 'info'); return; }
    setBusyKey('pending', true);
    try {
      // Use the bulk endpoint so the server-side analyzeJob tracker fires and
      // the global AnalyzeProgressBar shows live progress (same as Catalog).
      const r = await api.post('/ingest/analyze-pending', { limit: 500, ids: pending.map(p => p.id) });
      const gaps = r.requirements || 0;
      const ok = r.analyzed || 0;
      const err = r.errors || 0;
      window.toast(`Analyzed ${ok}/${pending.length} pending — ${gaps} gap${gaps===1?'':'s'} created${err?` · ${err} error${err===1?'':'s'}`:''}`, err ? 'error' : 'success');
    } catch (e) {
      if (/already running/i.test(e.message)) {
        window.toast('Analysis already running — see progress bar', 'info');
      } else {
        window.toast('Analyze failed: ' + e.message, 'error');
      }
    } finally {
      setBusyKey('pending', false);
      load();
    }
  };

  return (
    <>
      <div className="toolbar">
        <h2>📡 Competitive Feed</h2>
        <div className="row">
          <span className="badge" title="Competitor entries in the feed (own-product items are ingested for trends/matrix but hidden here)">{competitorItems.length} total</span>
          {newCount > 0 && <span className="badge medium" title="Items still pending analysis (e.g. ingested before auto-analyze, or analysis failed)">{newCount} pending</span>}
          {newCount > 0 && <button className="ghost" onClick={analyzePending} disabled={busy.pending} title="Run analysis on every pending item">{busy.pending ? `Analyzing…` : `🤖 Analyze ${newCount} pending`}</button>}
          <button className="ghost" onClick={() => setPasting({ product_id: products.find(p=>!p.is_own)?.id || '', title:'', content:'', url:'' })} title="Paste a release note or article that isn't on a feed">+ Paste entry</button>
          <button onClick={pollAll} disabled={busy.all} title="Poll every configured source and auto-analyze new items">{busy.all ? 'Polling…' : '↻ Poll all'}</button>
        </div>
      </div>
      <p className="meta" style={{margin:'-4px 0 12px', fontSize:12}}>
        Live stream of competitor announcements. Every new entry is analyzed automatically — no extra clicks needed.
      </p>
      {error && <p style={{color:'#f87171'}}>Error: {error}</p>}

      <div className="row" style={{gap:10, marginBottom:10, flexWrap:'wrap'}}>
        <SearchSelect
          value={productFilter}
          onChange={setProductFilter}
          width={240}
          icon="package"
          placeholder="All products"
          searchPlaceholder="Search products…"
          options={products.filter(p => (p.kind||'product') === 'product' && !p.is_own).map(p => ({
            value: String(p.id),
            label: p.name,
            hint: p.vendor || '',
          }))}
        />
        <SearchSelect
          value={statusFilter}
          onChange={setStatusFilter}
          width={180}
          icon="check"
          placeholder="Any status"
          options={[
            { value: 'analyzed', label: 'Analyzed', hint: 'Already processed by AI' },
            { value: 'new',      label: 'Pending',  hint: 'Awaiting analysis' },
          ]}
        />
        <DatePill value={dateFilter} onChange={setDateFilter} title="Filter by published date" />
        {(productFilter || statusFilter || dateFilter) && <button className="ghost" onClick={()=>{setProductFilter('');setStatusFilter('');setDateFilter('');}}>Clear filters</button>}
      </div>

      <div className="dash-widget">
        {filtered.length > 0 && <Paginator ctl={feedCtl} label="entries" />}
        <table className="modern-table">
          <thead><tr><th>Product</th><th>Title</th><th>Published</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {feedCtl.slice.map(it => (
              <tr key={it.id}>
                <td>{productName(it.product_id)}</td>
                <td>{it.url ? <a href={it.url} target="_blank" style={{color:'var(--accent)'}}>{it.title}</a> : it.title}</td>
                <td className="meta">{(it.published_at || '').slice(0,10) || '—'}</td>
                <td>
                  {it.status === 'analyzed'
                    ? <span className="status-chip status-ok"><Icon name="check" size={12}/> Analyzed</span>
                    : <span className="status-chip status-pending" title="Auto-analysis pending or failed — try ↻ Poll all again"><Icon name="clock" size={12}/> Pending</span>}
                </td>
                <td>
                  <div className="row-actions">
                    {it.status === 'analyzed' && (
                      <button className="icon-btn ghost-icon" onClick={() => viewAnalysis(it)} disabled={busy['it'+it.id]} title="View extracted details (release version, features, gaps)" aria-label="View details">
                        <Icon name="fileText" size={14}/>
                      </button>
                    )}
                    {it.status !== 'analyzed' ? (
                      <button className="icon-btn ghost-icon" onClick={() => reanalyzeItem(it)} disabled={busy['it'+it.id]} title="Run AI analysis on this entry now (extracts release / features / gaps)" aria-label="Analyze this entry">
                        <Icon name={busy['it'+it.id] ? 'clock' : 'sparkles'} size={14}/>
                      </button>
                    ) : it.source_id && (
                      <button className="icon-btn ghost-icon" onClick={() => pollOneSource(it.source_id)} disabled={busy['src'+it.source_id]} title="Re-poll this entry's source for new content" aria-label="Poll source">
                        <Icon name={busy['src'+it.source_id] ? 'clock' : 'refresh'} size={14}/>
                      </button>
                    )}
                    <button className="icon-btn ghost-icon danger-hover" onClick={() => delItem(it.id)} title="Delete this entry" aria-label="Delete">
                      <Icon name="trash" size={14}/>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan="5" className="muted">{items.length === 0 ? 'No entries yet — add a source in Catalog or paste one here.' : 'No entries match the current filters.'}</td></tr>}
          </tbody>
        </table>
      </div>

      {pasting && <PasteForm value={pasting} products={products} onSave={savePaste} onClose={() => setPasting(null)} />}
      {analysisView && <AnalysisResultModal item={analysisView.item} analysis={analysisView.analysis} productName={productName(analysisView.item.product_id)} onClose={() => setAnalysisView(null)} />}
    </>
  );
}

function AnalysisResultModal({ item, analysis, productName, onClose }) {
  const ex = analysis.extracted || {};
  const features = ex.features || [];
  const reqs = analysis.created_requests || [];
  const reqByName = {};
  reqs.forEach(r => { reqByName[(r.name || '').toLowerCase()] = r; });
  const jump = (page) => { onClose(); if (window.pmNavigate) window.pmNavigate(page); };
  return (
    <Modal onClose={onClose}>
      <div style={{maxWidth:720}}>
        <div>
          <h3 style={{margin:'0 0 4px'}}>🤖 Analysis result</h3>
          <div className="meta" style={{fontSize:12}}>{productName} · {item.title}</div>
        </div>

        <div className="row" style={{gap:8, marginTop:14, flexWrap:'wrap'}}>
          {ex.version && <span className="badge high" title="Detected version">v{ex.version}</span>}
          {ex.release_date && <span className="badge" title="Release date">📅 {ex.release_date}</span>}
          <span className="badge">{features.length} feature{features.length===1?'':'s'} extracted</span>
          <span className={'badge ' + (reqs.length ? 'high' : 'low')}>{reqs.length} gap{reqs.length===1?'':'s'} created</span>
          {analysis.release_id && <span className="badge medium">🚀 release row added</span>}
        </div>

        {ex.release_summary && (
          <div style={{marginTop:14}}>
            <div className="meta" style={{fontSize:11, textTransform:'uppercase', letterSpacing:0.5}}>Summary</div>
            <div style={{marginTop:4}}>{ex.release_summary}</div>
          </div>
        )}

        <div style={{marginTop:18}}>
          <div className="meta" style={{fontSize:11, textTransform:'uppercase', letterSpacing:0.5}}>Extracted features</div>
          {features.length === 0 && <div className="muted" style={{marginTop:6}}>No features extracted from this item.</div>}
          {features.length > 0 && (
            <table style={{marginTop:6}}>
              <thead><tr><th>Feature</th><th>Category</th><th>Status</th><th>Confidence</th></tr></thead>
              <tbody>
                {features.map((f, i) => {
                  const r = reqByName[(f.name || '').toLowerCase()];
                  const isGap = !!r;
                  const conf = r?.confidence;
                  const prio = conf == null ? null : conf >= 70 ? 'high' : conf >= 40 ? 'medium' : 'low';
                  return (
                    <tr key={i}>
                      <td>{f.name}</td>
                      <td className="meta">{f.category || '—'}</td>
                      <td><span className={'badge ' + (isGap ? (prio||'medium') : 'low')}>{isGap ? '🎯 gap' : '✓ we have it'}</span></td>
                      <td className="meta">{conf != null ? conf + '%' : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="row" style={{gap:8, marginTop:18, flexWrap:'wrap'}}>
          <span className="meta" style={{fontSize:12, marginRight:'auto'}}>Jump to results:</span>
          {reqs.length > 0 && <button onClick={() => jump('Gaps')} title="See the new gap requirements">🎯 View gaps</button>}
          {analysis.release_id && <button onClick={() => jump('Releases')} title="See the new release entry">🚀 View release</button>}
          {features.length > 0 && <button className="ghost" onClick={() => jump('Matrix')} title="See the updated feature matrix">🔀 View matrix</button>}
          {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="ghost" style={{textDecoration:'none', display:'inline-flex', alignItems:'center', padding:'8px 14px', borderRadius:8, border:'1px solid var(--border)', color:'var(--text)'}}>↗ Open source</a>}
        </div>
      </div>
    </Modal>
  );
}

function SourceForm({ value, products, onSave, onClose }) {
  const [f, setF] = useState(value);
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.value }));
  return (
    <Modal onClose={onClose}>
      <h3>{f.id ? 'Edit source' : 'Add source'}</h3>
      <div className="field"><label>Product</label>
        <select value={f.product_id||''} onChange={set('product_id')}>
          <option value="" disabled>Select a product…</option>
          {products.map(p => <option key={p.id} value={p.id}>{p.name}{p.is_own ? ' ⭐' : ''}</option>)}
        </select>
      </div>
      <div className="field"><label>Kind</label>
        <select value={f.kind||'rss'} onChange={set('kind')}>
          <option value="rss">RSS / Atom feed</option>
          <option value="html">HTML page</option>
        </select>
      </div>
      <div className="field"><label>URL</label><input value={f.url||''} onChange={set('url')} placeholder="https://example.com/feed.xml" /></div>
      <div className="field"><label>Label</label><input value={f.label||''} onChange={set('label')} placeholder="e.g. Vendor blog" /></div>
      <div className="row" style={{justifyContent:'flex-end'}}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button onClick={() => onSave(f)} disabled={!f.product_id || !f.url}>Save</button>
      </div>
    </Modal>
  );
}

function BulkImportFeaturesForm({ value, products, onSave, onClose }) {
  const [f, setF] = useState(value);
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.value }));
  const placeholder = `Log Management | Core SIEM | v5.0 | Supports 750+ log sources
UEBA | Threat Detection | v5.2 | Integrated UEBA module
Compliance Reporting | Compliance | v3.0 | PCI, HIPAA, GDPR

# One feature per line. Format: Name | Category | Version | Notes
# (Category, Version, Notes are optional. You can also use commas instead of pipes.)`;
  const lineCount = (f.text || '').split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#')).length;
  return (
    <Modal onClose={onClose}>
      <div style={{maxWidth:640}}>
        <h3 style={{margin:'0 0 4px', display:'flex', alignItems:'center', gap:8}}>
          <Icon name="layers" size={18}/> Bulk-import features
        </h3>
        <p className="muted" style={{fontSize:12.5, margin:'0 0 14px'}}>
          Paste a feature list to seed a product's matrix row without scraping. Best used for your <strong>own product</strong> when there's no public release-notes feed. Existing rows are updated; new features are auto-created.
        </p>
        <div className="field">
          <label>Product</label>
          <select value={f.product_id||''} onChange={set('product_id')}>
            {products.map(p => <option key={p.id} value={p.id}>{p.name}{p.is_own ? ' ⭐' : ''}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Features <span className="muted" style={{fontWeight:400, fontSize:11}}>· {lineCount} line{lineCount===1?'':'s'} parsed</span></label>
          <textarea
            value={f.text||''}
            onChange={set('text')}
            placeholder={placeholder}
            rows={12}
            style={{fontFamily:'ui-monospace, "SF Mono", Menlo, monospace', fontSize:12.5, lineHeight:1.5}}
          />
        </div>
        <div className="row" style={{justifyContent:'space-between', alignItems:'center'}}>
          <span className="muted" style={{fontSize:11}}>Lines starting with <code>#</code> are ignored.</span>
          <div className="row">
            <button className="ghost" onClick={onClose}>Cancel</button>
            <button onClick={() => onSave({ product_id: f.product_id, text: (f.text||'').split(/\r?\n/).filter(l => !l.trim().startsWith('#')).join('\n') })} disabled={!f.product_id || lineCount === 0}>
              Import {lineCount || ''}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function PasteForm({ value, products, onSave, onClose }) {
  const [f, setF] = useState(value);
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.value }));
  return (
    <Modal onClose={onClose}>
      <h3>Paste release notes</h3>
      <p className="muted">Drop release-note text from any source — the AI will extract features and score them.</p>
      <div className="field"><label>Competitor</label>
        <select value={f.product_id||''} onChange={set('product_id')}>
          {products.filter(p => !p.is_own).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="field"><label>Title</label><input value={f.title||''} onChange={set('title')} placeholder="e.g. Splunk ES 8.0 release notes" /></div>
      <div className="field"><label>Source URL (optional)</label><input value={f.url||''} onChange={set('url')} /></div>
      <div className="field"><label>Content</label><textarea value={f.content||''} onChange={set('content')} rows="10" placeholder="Paste release notes / blog post / changelog here…" /></div>
      <div className="row" style={{justifyContent:'flex-end'}}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button onClick={() => onSave(f)}>Save & analyze</button>
      </div>
    </Modal>
  );
}

// Tiny safe Markdown renderer for chat bubbles. Handles headings, bold, italic,
// inline code, fenced code, links, ordered/unordered lists, blockquotes, line
// breaks. Escapes HTML first so model output cannot inject markup.
function renderChatMarkdown(src) {
  if (!src) return null;
  const escHtml = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  // Pull out fenced code blocks first so their contents aren't touched by inline rules.
  const fences = [];
  let text = src.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, lang, body) => {
    fences.push({ lang, body });
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });
  text = escHtml(text);
  // Inline replacements: code, bold, italic, links.
  const inline = (s) => s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  const lines = text.split('\n');
  const out = [];
  let listType = null;        // 'ul' | 'ol' | null
  let inQuote = false;
  // Cross-list OL counter: when an OL is closed by a UL (sub-bullets) without
  // an intervening blank line / heading / code block, the next OL continues
  // counting from where we left off. This stops the LLM's "1. ... - sub
  // 1. ... - sub 1. ..." pattern from rendering as 1, 1, 1.
  let olRunning = 0;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };
  const resetOl = () => { olRunning = 0; };

  for (let raw of lines) {
    const line = raw.replace(/\s+$/, '');
    // Restore fenced code blocks.
    const fenceMatch = line.match(/^\u0000FENCE(\d+)\u0000$/);
    if (fenceMatch) {
      closeList(); closeQuote(); resetOl();
      const f = fences[+fenceMatch[1]];
      out.push(`<pre><code${f.lang ? ` class="lang-${f.lang}"` : ''}>${escHtml(f.body.replace(/\n$/, ''))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { closeList(); closeQuote(); continue; }
    // Headings.
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeList(); closeQuote(); resetOl(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    // Blockquote.
    if (/^>\s?/.test(line)) {
      closeList(); resetOl();
      if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
      out.push(`<p>${inline(line.replace(/^>\s?/, ''))}</p>`);
      continue;
    } else { closeQuote(); }
    // Ordered list (allow leading spaces from sub-bullets).
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== 'ol') {
        closeList();
        const startAttr = olRunning > 0 ? ` start="${olRunning + 1}"` : '';
        out.push(`<ol${startAttr}>`);
        listType = 'ol';
      }
      olRunning += 1;
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    // Unordered list.
    const ul = line.match(/^\s*[-*\u2022]\s+(.*)$/);
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      // NB: do NOT reset olRunning — we want the next OL to continue numbering.
      out.push(`<li>${inline(ul[1])}</li>`); continue;
    }
    // Plain paragraph line.
    closeList(); resetOl();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); closeQuote();
  return { __html: out.join('') };
}

// Sticky bottom-of-screen job progress strip. Shows live progress for both
// ingest (RSS/HTML poll) and AI analysis. Polls /api/ingest/all-progress
// every 1.5s while a job is running, every 4s otherwise (so it picks up jobs
// kicked off elsewhere — chatbot, terminal, other tabs). On completion shows
// a summary that auto-dismisses after 6s if no errors, or stays visible
// (dismissible) if there were errors so the user can see what went wrong.
function AnalyzeProgressBar() {
  const [snap, setSnap] = useState({ ingest: null, analyze: null });
  const [dismissed, setDismissed] = useState({ ingest: 0, analyze: 0 });
  const [showDoneFor, setShowDoneFor] = useState({ ingest: false, analyze: false });
  const lastFinishedRef = useRef({ ingest: 0, analyze: 0 });
  // First poll on mount establishes the baseline so completed jobs from a
  // previous browser session don't pop up as a fresh "done" flash on every
  // page reload. Only completions whose finishedAt is *newer* than the
  // baseline trigger the visible bar.
  const baselineSetRef = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer = null;
    const poll = async () => {
      try {
        const r = await fetch('/api/ingest/all-progress');
        if (!alive) return;
        const data = await r.json();
        setSnap(data);
        if (!baselineSetRef.current) {
          // Treat any already-completed job at mount-time as already-seen.
          for (const kind of ['ingest', 'analyze']) {
            const j = data[kind];
            if (j && !j.running && j.finishedAt) {
              lastFinishedRef.current[kind] = j.finishedAt;
              setDismissed(prev => ({ ...prev, [kind]: j.finishedAt }));
            }
          }
          baselineSetRef.current = true;
        } else {
          for (const kind of ['ingest', 'analyze']) {
            const j = data[kind];
            if (!j) continue;
            if (!j.running && j.finishedAt && j.finishedAt !== lastFinishedRef.current[kind] && j.total > 0) {
              lastFinishedRef.current[kind] = j.finishedAt;
              setShowDoneFor(prev => ({ ...prev, [kind]: true }));
              // Auto-dismiss only if no errors. Errors stay visible until user closes.
              if (!j.errors) {
                setTimeout(() => alive && setShowDoneFor(prev => ({ ...prev, [kind]: false })), 6000);
              }
            }
          }
        }
        const anyRunning = (data.ingest && data.ingest.running) || (data.analyze && data.analyze.running);
        timer = setTimeout(poll, anyRunning ? 1500 : 4000);
      } catch (_) {
        timer = setTimeout(poll, 5000);
      }
    };
    poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  // Pick what to render: ingest first if active or recently-done-with-errors,
  // analyze second. Both can render stacked.
  const cards = [];
  for (const kind of ['ingest', 'analyze']) {
    const j = snap[kind];
    if (!j) continue;
    const visible = j.running ||
      (showDoneFor[kind] && j.finishedAt && j.finishedAt !== dismissed[kind]);
    if (!visible) continue;
    cards.push({ kind, j });
  }
  if (cards.length === 0) return null;

  const fmtSec = (ms) => {
    if (ms == null || !isFinite(ms) || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), r = s % 60;
    return r === 0 ? `${m}m` : `${m}m ${r}s`;
  };

  const errorMessage = (kind, errorKind, raw) => {
    if (errorKind === 'aborted') return raw || 'Analysis stopped by user.';
    if (errorKind === 'rate_limit') return kind === 'analyze'
      ? 'GitHub Models rate limit hit. Wait a few minutes and click Analyze pending again — already-analyzed items are kept.'
      : 'GitHub Models rate limit hit while analyzing fetched items.';
    if (errorKind === 'auth' || errorKind === 'no_token')
      return 'AI token rejected or missing — check Catalog → AI Settings.';
    if (errorKind === 'network')
      return 'Network/timeout error. Some sources may be temporarily unreachable.';
    return raw ? `Last error: ${raw.slice(0, 200)}` : null;
  };

  const dismiss = (kind, finishedAt) => {
    setDismissed(prev => ({ ...prev, [kind]: finishedAt || Date.now() }));
    setShowDoneFor(prev => ({ ...prev, [kind]: false }));
  };

  return (
    <div className="job-progress-stack">
      {cards.map(({ kind, j }) => {
        const isIngest = kind === 'ingest';
        const title = j.running
          ? (isIngest
              ? <>Polling sources · <strong>{j.done}/{j.total}</strong> ({j.percent}%{j.eta_ms != null ? ` · ETA ${fmtSec(j.eta_ms)}` : ''})</>
              : <>AI analysis · <strong>{j.done}/{j.total}</strong> items ({j.percent}%{j.eta_ms != null ? ` · ETA ${fmtSec(j.eta_ms)}` : ''})</>)
          : (isIngest
              ? <>Poll complete · <strong>{j.inserted}</strong> new item{j.inserted===1?'':'s'} from {j.total} source{j.total===1?'':'s'}{j.errors ? <> · <strong>{j.errors}</strong> source error{j.errors===1?'':'s'}</> : null}</>
              : (j.lastErrorKind === 'aborted'
                  ? <>AI analysis stopped · <strong>{j.analyzed}</strong> analyzed{j.errors ? <> · <strong>{j.errors}</strong> error{j.errors===1?'':'s'}</> : null}</>
                  : <>AI analysis complete · <strong>{j.analyzed}</strong> analyzed{j.errors ? <> · <strong>{j.errors}</strong> error{j.errors===1?'':'s'}</> : null}</>));
        const meta = j.running
          ? (isIngest
              ? <>{j.currentSourceName ? `Now: ${j.currentSourceName}` : null}{j.currentSourceName ? ' · ' : ''}{j.fetched} fetched · {j.inserted} new{j.errors?` · ${j.errors} err`:''}</>
              : <>{j.currentTitle ? `Now: ${j.currentTitle}` : null}{j.currentTitle ? ' · ' : ''}{j.releases} release{j.releases===1?'':'s'} · {j.requirements} gap{j.requirements===1?'':'s'}{j.errors?` · ${j.errors} err`:''}</>)
          : (isIngest
              ? <>{j.fetched} fetched · {j.inserted} new · took {fmtSec(j.elapsed_ms)}</>
              : <>{j.releases} release{j.releases===1?'':'s'} · {j.requirements} gap{j.requirements===1?'':'s'} · took {fmtSec(j.elapsed_ms)}</>);
        const errMsg = (j.errors > 0 || j.lastErrorKind === 'aborted') ? errorMessage(kind, j.lastErrorKind, j.lastError) : null;
        const stateClass = j.running ? 'running' : (j.errors > 0 ? 'errored' : (j.lastErrorKind === 'aborted' ? 'aborted' : 'done'));
        return (
          <div key={kind} className={`analyze-progress ${stateClass}`} role="status" aria-live="polite">
            <div className="analyze-progress-row">
              <span className="analyze-progress-icon">
                {j.running
                  ? <span className="spinner-sm" />
                  : (j.errors > 0
                      ? <Icon name="alert" size={14} />
                      : <Icon name="check" size={14} />)}
              </span>
              <div className="analyze-progress-text">
                <div className="analyze-progress-title">{title}</div>
                <div className="analyze-progress-meta">{meta}</div>
              </div>
              {j.running && kind === 'analyze' && (
                <button
                  type="button"
                  className="analyze-progress-stop"
                  onClick={async () => {
                    if (j.abortRequested) return;
                    try {
                      await api.post('/ingest/analyze-abort', {});
                      window.toast('Stopping analysis after current item…', 'info');
                    } catch (e) {
                      window.toast('Failed to stop: ' + e.message, 'error');
                    }
                  }}
                  disabled={j.abortRequested}
                  aria-label="Stop analysis"
                  title={j.abortRequested ? 'Stopping…' : 'Stop analysis after current item'}
                >{j.abortRequested ? 'Stopping…' : 'Stop'}</button>
              )}
              {!j.running && (
                <button
                  type="button"
                  className="analyze-progress-close"
                  onClick={() => dismiss(kind, j.finishedAt)}
                  aria-label="Dismiss"
                  title="Dismiss"
                >×</button>
              )}
            </div>
            <div className="analyze-progress-bar">
              <div className="analyze-progress-bar-fill" style={{ width: `${Math.min(100, j.percent)}%` }} />
            </div>
            {errMsg && <div className="analyze-progress-error">{errMsg}</div>}
          </div>
        );
      })}
    </div>
  );
}

// Scheduler status card — shows last/next automatic poll for each category and
// lets the user toggle the scheduler on/off or fire a single job on demand.
function SchedulerCard({ onChange }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  const [errorsModal, setErrorsModal] = useState(null); // { jobLabel, details: [...] }

  const load = async () => {
    try { setStatus(await api.get('/scheduler/status')); } catch (_) {}
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 30 * 1000);
    return () => clearInterval(t);
  }, []);

  const toggle = async () => {
    if (!status) return;
    setBusy(true);
    try {
      await api.post('/scheduler/toggle', { enabled: !status.enabled });
      await load();
      window.toast(status.enabled ? 'Hourly scheduler paused' : 'Hourly scheduler enabled — runs at :00 / :20 / :40', 'success');
    } catch (e) { window.toast('Failed: ' + e.message, 'error'); }
    finally { setBusy(false); }
  };

  const runNow = async (key) => {
    setBusy(true);
    try {
      await api.post(`/scheduler/run-now/${key}`, {});
      window.toast(`Started ${key} poll — watch the progress bar`, 'info');
      setTimeout(load, 1500);
      onChange && onChange();
    } catch (e) {
      window.toast(e.message || 'Failed', 'error');
    } finally { setBusy(false); }
  };

  if (!status) return null;

  const fmtTime = (ms) => {
    if (!ms) return '—';
    const d = new Date(ms);
    const today = new Date(); today.setHours(0,0,0,0);
    const isToday = d.getTime() >= today.getTime() && d.getTime() < today.getTime() + 86400000;
    const hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return isToday ? `Today ${hhmm}` : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const fmtRelative = (ms) => {
    if (!ms) return '';
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const m = Math.round(abs / 60000);
    if (m < 1) return diff > 0 ? 'in <1m' : 'just now';
    if (m < 60) return diff > 0 ? `in ${m}m` : `${m}m ago`;
    const h = Math.round(m / 60);
    return diff > 0 ? `in ${h}h` : `${h}h ago`;
  };

  return (
    <div className={'dash-widget collapsible scheduler-card' + (open ? ' open' : '')} style={{marginBottom:12}}>
      <div className="collapsible-head">
        <div
          className="collapsible-toggle"
          role="button"
          tabIndex={0}
          onClick={() => setOpen(!open)}
          onKeyDown={(e)=>{ if (e.key==='Enter'||e.key===' ') { e.preventDefault(); setOpen(!open); }}}
          aria-expanded={open}
        >
          <Icon name={open ? 'chevDown' : 'chevRight'} size={14} className="collapsible-chev"/>
          <Icon name="clock" size={16}/>
          <h3>Hourly scheduler</h3>
          <span className={'badge ' + (status.enabled ? 'medium' : '')}>{status.enabled ? 'ON' : 'paused'}</span>
          <span className="muted collapsible-sub">Polls each category at a different minute slot to avoid token contention</span>
        </div>
        <div className="collapsible-actions">
          <button className="ghost small" onClick={toggle} disabled={busy}>
            {status.enabled ? 'Pause scheduler' : 'Enable scheduler'}
          </button>
        </div>
      </div>
      {open && (
        <div className="collapsible-body">
          <table className="scheduler-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Slot</th>
                <th>Last run</th>
                <th>Result</th>
                <th>Next run</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {status.jobs.map(j => {
                const r = j.lastResult || {};
                const errDetails = Array.isArray(r.errorDetails) ? r.errorDetails : [];
                const showErrors = () => setErrorsModal({
                  jobLabel: j.label,
                  details: errDetails.length ? errDetails : (r.error ? [{ source: '(scheduler)', product: '', message: String(r.error) }] : []),
                });
                let resultCell;
                if (r.skipped) resultCell = <span className="muted">skipped ({r.reason})</span>;
                else if (r.error) resultCell = (
                  <button className="link-danger" onClick={showErrors} title="Click to see the error">
                    err: {String(r.error).slice(0,60)}{String(r.error).length > 60 ? '…' : ''}
                  </button>
                );
                else if (j.lastRun) resultCell = (
                  <span>
                    <strong>{r.inserted ?? 0}</strong> new · <strong>{r.analyzed ?? 0}</strong> analyzed
                    {r.errors ? <> · {errDetails.length
                        ? <button className="link-danger" onClick={showErrors} title="Click to see what failed">{r.errors} err</button>
                        : <span style={{color:'#f59e0b'}}>{r.errors} err</span>}</> : null}
                  </span>
                );
                else resultCell = <span className="muted">—</span>;
                return (
                  <tr key={j.key}>
                    <td><strong>{j.label}</strong></td>
                    <td className="muted">:{String(j.minute).padStart(2,'0')}</td>
                    <td>{fmtTime(j.lastRun)} <span className="muted" style={{fontSize:11}}>{fmtRelative(j.lastRun)}</span></td>
                    <td>{resultCell}</td>
                    <td>{status.enabled ? <>{fmtTime(j.nextRun)} <span className="muted" style={{fontSize:11}}>{fmtRelative(j.nextRun)}</span></> : <span className="muted">—</span>}</td>
                    <td><button className="ghost small" onClick={() => runNow(j.key)} disabled={busy}>Run now</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {errorsModal && (
        <Modal onClose={() => setErrorsModal(null)}>
          <div style={{ maxWidth: 640 }}>
            <h3 style={{ margin: '0 0 4px' }}>Errors — {errorsModal.jobLabel}</h3>
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
              {errorsModal.details.length} source{errorsModal.details.length === 1 ? '' : 's'} failed in the last run.
            </p>
            {errorsModal.details.length === 0 ? (
              <p className="muted">No detailed error information was captured for this run.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto' }}>
                {errorsModal.details.map((d, i) => (
                  <div key={i} style={{
                    padding: 10, borderRadius: 8,
                    background: 'var(--panel-2)', border: '1px solid var(--border)',
                    borderLeft: '3px solid #f87171',
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>
                      {d.source}
                      {d.product ? <span className="muted" style={{ fontWeight: 400 }}> · {d.product}</span> : null}
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 4, color: '#fca5a5', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {d.message}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="ghost" onClick={() => setErrorsModal(null)}>Close</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Floating chat assistant — bottom-right bubble that opens an LLM chat panel.
function ChatBot() {
  const [open, setOpen] = useState(false);
  const [llmEnabled, setLlmEnabled] = useState(true);
  const [messages, setMessages] = useState(() => {
    try { return JSON.parse(localStorage.getItem('pm:chat') || '[]'); } catch (_) { return []; }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    api.get('/llm/status').then(s => setLlmEnabled(!!s.enabled)).catch(() => {});
  }, [open]);

  useEffect(() => {
    try { localStorage.setItem('pm:chat', JSON.stringify(messages.slice(-50))); } catch (_) {}
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.map(m => ({ role: m.role, content: m.content })) }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      setMessages([...next, { role: 'assistant', content: data.reply || '(empty reply)' }]);
    } catch (e) {
      setMessages([...next, { role: 'assistant', content: '⚠ ' + e.message, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const clear = () => { setMessages([]); try { localStorage.removeItem('pm:chat'); } catch(_){} };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const suggestions = [
    'Summarize the top 3 competitor gaps',
    'Which competitors released features this month?',
    "What's pending in the feed?",
    'Suggest 3 PM priorities for next sprint',
  ];

  return (
    <>
      <button
        className={`chatbot-fab ${open ? 'open' : ''}`}
        onClick={() => setOpen(o => !o)}
        title={open ? 'Close assistant' : 'Open AI assistant'}
        aria-label="AI assistant"
      >{open ? <Icon name="close" size={22} /> : <Icon name="bot" size={22} />}</button>
      {open && (
        <div className="chatbot-panel" role="dialog" aria-label="AI assistant">
          <div className="chatbot-head">
            <div className="row" style={{gap:8, alignItems:'center'}}>
              <span className="chatbot-avatar"><Icon name="bot" size={18} /></span>
              <div>
                <div style={{fontWeight:600}}>PM Assistant</div>
                <div className="meta" style={{fontSize:11}}>{llmEnabled ? 'Online · GitHub Models' : 'Offline · no token'}</div>
              </div>
            </div>
            <div className="row" style={{gap:6}}>
              {messages.length > 0 && <button className="ghost small" onClick={clear} title="Clear conversation">Clear</button>}
              <button className="ghost icon-btn small" onClick={() => setOpen(false)} title="Close"><Icon name="close" size={14} /></button>
            </div>
          </div>
          <div className="chatbot-body" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="chatbot-welcome">
                <div className="chatbot-welcome-icon"><Icon name="sparkles" size={26} /></div>
                <div style={{fontWeight:600, marginBottom:6}}>Hi! Ask me about your competitive data.</div>
                <div className="meta" style={{marginBottom:10}}>I know about your products, feed items, gaps and releases.</div>
                <div className="chatbot-suggestions">
                  {suggestions.map(s => (
                    <button key={s} className="chatbot-chip" onClick={() => { setInput(s); setTimeout(send, 0); }}>{s}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chatbot-msg ${m.role} ${m.error ? 'error' : ''}`}>
                {m.role === 'assistant' && !m.error
                  ? <div className="chatbot-bubble markdown" dangerouslySetInnerHTML={renderChatMarkdown(m.content)} />
                  : <div className="chatbot-bubble">{m.content}</div>}
              </div>
            ))}
            {busy && <div className="chatbot-msg assistant"><div className="chatbot-bubble typing"><span/><span/><span/></div></div>}
          </div>
          <div className="chatbot-input">
            <textarea
              rows="1"
              value={input}
              placeholder={llmEnabled ? 'Ask anything…' : 'Add a token in Settings to enable chat'}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKey}
              disabled={!llmEnabled || busy}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              data-gramm="false"
              data-gramm_editor="false"
              data-enable-grammarly="false"
              data-lt-active="false"
            />
            <button onClick={send} disabled={!llmEnabled || busy || !input.trim()} title="Send (Enter · Shift+Enter for newline)"><Icon name="send" size={16} /></button>
          </div>
        </div>
      )}
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
