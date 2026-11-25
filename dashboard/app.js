// Token Launch Radar dashboard. Reads window.RADAR (data.js, written by main.ts beside
// this page) and renders the ranked board, its filters, a per-protocol detail view with
// the model's own arithmetic, the method, and the already-trading comps the model's
// ratios came from. No network: every byte shown ships in data.js. State lives in the
// URL hash (#p=slug opens a protocol, #cat=, #chain=, #q=, #watch=1 filter the board),
// so any view can be linked — or screenshotted — exactly as it stands.
(function () {
  'use strict';
  var DATA = window.RADAR;
  var rowsEl = document.getElementById('rows');
  if (!DATA || !rowsEl) {
    rowsEl.innerHTML = '<tr><td colspan="8">No data: run main.ts first — it writes data.js beside this page.</td></tr>';
    return;
  }
  var META = DATA.meta, ROWS = DATA.rows, LIVE = DATA.live;
  var bySlug = {};
  ROWS.forEach(function (r) { bySlug[r.slug] = r; });
  var TOPV = ROWS.length ? ROWS[0].implied_value_usd : 1;

  // ------------------------------------------------------------ formatting
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtFull(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function fmtPct(n) {
    if (n === null || n === undefined) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    if (days >= 30) return Math.round(days / 30.4) + 'mo';
    return days + 'd';
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ------------------------------------------------------------ state
  var state = { q: '', cat: 'all', chain: 'all', watch: false, sort: 'rank', dir: 1, selected: null };
  function readHash() {
    state.q = ''; state.cat = 'all'; state.chain = 'all'; state.watch = false; state.selected = null;
    var h = location.hash.replace(/^#/, '');
    h.split('&').forEach(function (pair) {
      var kv = pair.split('=');
      if (kv.length !== 2) return;
      var k = kv[0], v = decodeURIComponent(kv[1]);
      if (k === 'p') state.selected = v;
      else if (k === 'cat') state.cat = v;
      else if (k === 'chain') state.chain = v;
      else if (k === 'q') state.q = v;
      else if (k === 'watch') state.watch = v === '1';
      else if (k === 'sort') state.sort = v;
      else if (k === 'dir') state.dir = v === '-1' ? -1 : 1;
    });
  }
  function writeHash() {
    var parts = [];
    if (state.selected) parts.push('p=' + encodeURIComponent(state.selected));
    if (state.cat !== 'all') parts.push('cat=' + encodeURIComponent(state.cat));
    if (state.chain !== 'all') parts.push('chain=' + encodeURIComponent(state.chain));
    if (state.q) parts.push('q=' + encodeURIComponent(state.q));
    if (state.watch) parts.push('watch=1');
    if (state.sort !== 'rank') parts.push('sort=' + state.sort, 'dir=' + state.dir);
    history.replaceState(null, '', '#' + parts.join('&'));
  }
  readHash();

  // ------------------------------------------------------------ header stats
  var totalImplied = ROWS.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
  var stats = document.getElementById('stats');
  [
    [String(ROWS.length), 'protocols ranked'],
    [String(META.watchlist_count) + ' / ' + String(META.watchlist_count), 'watchlist covered'],
    [fmtUsd(totalImplied), 'total implied value'],
    [META.as_of, 'snapshot date'],
  ].forEach(function (pair) {
    var box = el('div', 'stat');
    box.appendChild(el('b', null, pair[0]));
    box.appendChild(el('span', null, pair[1]));
    stats.appendChild(box);
  });

  // ------------------------------------------------------------ controls
  var controls = document.getElementById('controls');
  var search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search name or slug…';
  search.value = state.q;
  search.setAttribute('aria-label', 'Search protocols');
  var catSel = document.createElement('select');
  catSel.setAttribute('aria-label', 'Filter by category');
  var chainSel = document.createElement('select');
  chainSel.setAttribute('aria-label', 'Filter by chain');
  function fillSelect(sel, values, allLabel, current) {
    sel.appendChild(new Option(allLabel, 'all'));
    values.forEach(function (v) { sel.appendChild(new Option(v, v)); });
    sel.value = current;
    if (sel.value !== current) sel.value = 'all';
  }
  var cats = Array.from(new Set(ROWS.map(function (r) { return r.category; }).filter(Boolean))).sort();
  var chains = Array.from(new Set(ROWS.reduce(function (acc, r) { return acc.concat(r.chains); }, []))).sort();
  fillSelect(catSel, cats, 'All categories', state.cat);
  fillSelect(chainSel, chains, 'All chains', state.chain);
  var toggle = el('label', 'toggle');
  var watchBox = document.createElement('input');
  watchBox.type = 'checkbox';
  watchBox.checked = state.watch;
  toggle.appendChild(watchBox);
  toggle.appendChild(document.createTextNode('Watchlist only'));
  var count = el('span', 'count');
  controls.append(search, catSel, chainSel, toggle, count);

  search.addEventListener('input', function () { state.q = search.value; render(); });
  catSel.addEventListener('change', function () { state.cat = catSel.value; render(); });
  chainSel.addEventListener('change', function () { state.chain = chainSel.value; render(); });
  watchBox.addEventListener('change', function () { state.watch = watchBox.checked; render(); });

  // ------------------------------------------------------------ sorting
  var SORTS = {
    rank: function (r) { return r.rank; },
    name: function (r) { return r.name.toLowerCase(); },
    tvl: function (r) { return r.tvl_usd; },
    change: function (r) { return r.change_7d === null ? -Infinity : r.change_7d; },
    age: function (r) { return r.age_days === null ? -1 : r.age_days; },
    value: function (r) { return r.implied_value_usd; },
  };
  document.querySelectorAll('th.sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = key === 'name' ? 1 : -1; if (key === 'rank') state.dir = 1; }
      render();
    });
  });
  function markSortHeaders() {
    document.querySelectorAll('th.sortable').forEach(function (th) {
      var arrow = th.querySelector('.arrow');
      if (arrow) arrow.remove();
      if (th.getAttribute('data-sort') === state.sort) {
        th.appendChild(el('span', 'arrow', state.dir === 1 ? ' ▲' : ' ▼'));
      }
    });
  }

  // ------------------------------------------------------------ the board
  function visible() {
    var q = state.q.trim().toLowerCase();
    var list = ROWS.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.cat !== 'all' && r.category !== state.cat) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) === -1) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.indexOf(q) === -1) return false;
      return true;
    });
    var key = SORTS[state.sort] || SORTS.rank;
    list.sort(function (a, b) {
      var ka = key(a), kb = key(b);
      var cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
      if (cmp === 0) cmp = a.rank - b.rank;
      return cmp * state.dir;
    });
    return list;
  }

  function renderBoard() {
    var list = visible();
    count.textContent = 'Showing ' + list.length + ' of ' + ROWS.length;
    document.getElementById('empty').hidden = list.length > 0;
    var frag = document.createDocumentFragment();
    list.forEach(function (r) {
      var tr = el('tr', r.slug === state.selected ? 'selected' : null);
      tr.addEventListener('click', function () {
        state.selected = state.selected === r.slug ? null : r.slug;
        render();
      });
      var rank = el('td', 'num rank', String(r.rank));
      var name = el('td');
      name.appendChild(el('span', 'pname', r.name));
      if (r.watchlist) name.appendChild(el('span', 'badge', 'WATCHLIST'));
      name.appendChild(el('span', 'slug', r.slug));
      var cat = el('td', 'cat', r.category || 'Uncategorised');
      var ch = el('td', 'chains', r.chains.length <= 2 ? r.chains.join(', ') : r.chains.slice(0, 2).join(', ') + ' +' + (r.chains.length - 2));
      var tvl = el('td', 'num', fmtUsd(r.tvl_usd));
      var chg = el('td', 'num ' + (r.change_7d === null ? 'flat' : r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : 'flat'), fmtPct(r.change_7d));
      var age = el('td', 'num', fmtAge(r.age_days));
      var val = el('td', 'num value');
      val.appendChild(el('span', null, fmtUsd(r.implied_value_usd)));
      var vbar = el('div', 'vbar');
      vbar.style.width = Math.max(3, Math.round(100 * Math.log10(Math.max(10, r.implied_value_usd)) / Math.log10(Math.max(10, TOPV)))) + '%';
      val.appendChild(vbar);
      tr.append(rank, name, cat, ch, tvl, chg, age, val);
      frag.appendChild(tr);
    });
    rowsEl.replaceChildren(frag);
    markSortHeaders();
  }

  // ------------------------------------------------------------ detail view
  var detail = document.getElementById('detail');
  function fact(label, value, hl) {
    var wrap = document.createDocumentFragment();
    wrap.appendChild(el('dt', null, label));
    wrap.appendChild(el('dd', hl ? 'hl' : null, value));
    return wrap;
  }
  function renderDetail() {
    var r = state.selected ? bySlug[state.selected] : null;
    detail.hidden = !r;
    if (!r) { detail.replaceChildren(); return; }
    var head = el('header');
    var titleBox = el('div');
    var h2 = el('h2', null, r.name);
    if (r.watchlist) h2.appendChild(el('span', 'badge', 'WATCHLIST'));
    titleBox.appendChild(h2);
    titleBox.appendChild(el('p', 'sub',
      (r.category || 'Uncategorised') + ' · ' + r.chains.join(', ') + ' · rank #' + r.rank + ' of ' + ROWS.length +
      ' · records no token in the snapshot' + (r.listed_at ? ' · tracked since ' + r.listed_at : '')));
    var close = el('button', 'close', 'Close ✕');
    close.addEventListener('click', function () { state.selected = null; render(); });
    head.append(titleBox, close);

    var grid = el('div', 'detail-grid');
    var left = el('div');
    left.appendChild(el('h3', null, 'The model, on this protocol'));
    var facts = el('dl', 'facts');
    facts.append(
      fact('TVL (snapshot)', fmtFull(r.tvl_usd)),
      fact('Category ratio (mcap/TVL)', r.ratio_used.toFixed(4) + '× — median of ' + r.ratio_comps + ' trading comps'),
      fact('7-day TVL change', r.change_imputed ? 'unreported — snapshot median ' + fmtPct(META.median_change_7d) + ' used' : fmtPct(r.change_7d)),
      fact('Growth multiplier', r.growth_mult.toFixed(4) + '×'),
      fact('Age with no token', r.age_days === null ? 'unreported — median used' : fmtAge(r.age_days) + ' (' + r.age_days + ' days)'),
      fact('Maturity multiplier', r.maturity_mult.toFixed(4) + '×'),
      fact('Model value (raw)', fmtFull(r.implied_raw_usd)),
      fact('Board value (ranked)', fmtFull(r.implied_value_usd), true),
    );
    if (r.implied_value_usd !== r.implied_raw_usd) {
      facts.append(fact('Rank tie-break', '−$' + (r.implied_raw_usd - r.implied_value_usd).toLocaleString('en-US') + ' so no two ranks tie'));
    }
    left.appendChild(facts);
    // The value bridge: the model's four stages as bars on one log scale, so a
    // reader sees which stage does the work — TVL itself, the comp ratio, the
    // week's growth, or the years with no token — before reading a single figure.
    var stages = [
      ['TVL', r.tvl_usd],
      ['× ratio ' + r.ratio_used.toFixed(3), r.tvl_usd * r.ratio_used],
      ['× growth ' + r.growth_mult.toFixed(3), r.tvl_usd * r.ratio_used * r.growth_mult],
      ['× maturity ' + r.maturity_mult.toFixed(3), r.implied_raw_usd],
    ];
    var topLog = Math.log10(Math.max.apply(null, stages.map(function (s) { return s[1]; })));
    var bridge = el('div', 'bridge');
    bridge.appendChild(el('h4', null, 'How the value builds'));
    stages.forEach(function (s, i) {
      var rowEl = el('div', 'bstage');
      var w = Math.max(5, Math.round(100 * Math.log10(Math.max(10, s[1])) / topLog));
      var bar = el('div', 'bbar' + (i === stages.length - 1 ? ' last' : ''));
      bar.style.width = w + '%';
      rowEl.append(el('span', 'blabel', s[0]), bar, el('span', 'bval', fmtUsd(s[1])));
      bridge.appendChild(rowEl);
    });
    left.appendChild(bridge);
    var right = el('div');
    right.appendChild(el('h3', null, 'How to farm it'));
    var steps = el('ol', 'steps');
    r.farm_steps.forEach(function (s) { steps.appendChild(el('li', null, s)); });
    right.appendChild(steps);
    grid.append(left, right);
    detail.replaceChildren(head, grid);
    detail.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------ method + live comps
  function renderMethod() {
    var m = document.getElementById('method');
    var h = el('h2', null, 'How the implied value is derived');
    var p1 = el('p');
    p1.innerHTML = 'Every value on this board is <code>TVL × category ratio × growth multiplier × maturity multiplier</code>, computed from the snapshot alone — no protocol is priced by name. The category ratio is the median market-cap/TVL of the snapshot\'s own token-bearing protocols in that category, blended toward the overall median (<b>' + META.overall_ratio.toFixed(4) + '×</b>) with a prior weight of four comps, so a category priced off a handful of tokens cannot dominate the board on noise; a category with fewer than four trading comps uses the overall median outright. The growth multiplier weights the week\'s TVL change at 1.6×, clamped so one hot week cannot dominate; the maturity multiplier rises from 0.78× to 1.25× across four years of operating with no token, because a launch that prices years of real usage is a different claim from one that prices a month of it.';
    var p2 = el('p', null, 'The board ranks only protocols that record no token and could plausibly issue one of their own: the whole 40-protocol watchlist, plus every other no-token protocol except canonical bridges, liquid staking/restaking wrappers, restaked BTC, exchange house products and wrapped, staked or versioned copies of another product. Protocols whose token already trades are never ranked — they are the comp set below, and their ratios are the model\'s only input. Missing data is imputed one way for every input, never guessed per protocol: an unreported listing date takes the snapshot\'s median age (' + META.median_age_days + ' days), and an unreported 7-day change takes the snapshot\'s median reported change (' + fmtPct(META.median_change_7d) + '); each detail view says where an imputation was used, and how many trading comps priced its row. Where two raw values round to the same dollar, the lower rank is written $1 under its neighbour so the ranking is strict; both numbers are shown in each protocol\'s detail view.');
    m.append(h, p1, p2);
    var ratios = el('div', 'ratios');
    var table = el('table', 'mini');
    var thead = el('tr');
    thead.append(el('th', null, 'Category'), el('th', 'num', 'Comps'), el('th', 'num', 'Median mcap/TVL'));
    table.appendChild(thead);
    META.category_ratios.forEach(function (cr) {
      var tr = el('tr');
      tr.append(el('td', null, cr.category), el('td', 'num', String(cr.comps)), el('td', 'num', cr.ratio.toFixed(4) + '×'));
      table.appendChild(tr);
    });
    ratios.appendChild(table);
    m.appendChild(ratios);
  }
  function renderLive() {
    var box = document.getElementById('live');
    box.appendChild(el('h2', null, 'Already trading — the comps behind the ratios'));
    box.appendChild(el('p', null, 'These protocols\' tokens already trade, so they are never ranked on the board. Their market caps against their TVL are the entire evidence base for what a launch is worth: the model takes each category\'s median from records like these.'));
    var table = el('table', 'mini');
    var thead = el('tr');
    thead.append(el('th', null, 'Protocol'), el('th', null, 'Symbol'), el('th', 'num', 'Market cap'), el('th', 'num', 'TVL'), el('th', 'num', 'mcap/TVL'));
    table.appendChild(thead);
    LIVE.forEach(function (r) {
      var tr = el('tr');
      tr.append(
        el('td', null, r.name),
        el('td', null, r.symbol || '—'),
        el('td', 'num', fmtUsd(r.mcap_usd)),
        el('td', 'num', fmtUsd(r.tvl_usd)),
        el('td', 'num', r.ratio.toFixed(3) + '×'),
      );
      table.appendChild(tr);
    });
    box.appendChild(table);
  }
  var foot = document.getElementById('foot');
  foot.textContent = 'Data: ' + META.source + ' · ' + META.protocol_count + ' protocols in the snapshot, ' + META.board_count + ' ranked here, ' + META.live_count + ' already trading. An implied value is this radar\'s own claim about a launch that has not happened; it is not a prediction that a token will be issued. Model version ' + META.model_version + '.';

  function render() {
    renderBoard();
    renderDetail();
    writeHash();
  }
  // Deep links are live: pasting or following a #p= / #cat= / #watch= link re-renders
  // the board in that state, controls included, without a reload.
  window.addEventListener('hashchange', function () {
    readHash();
    search.value = state.q;
    catSel.value = state.cat;
    chainSel.value = state.chain;
    watchBox.checked = state.watch;
    render();
  });
  renderMethod();
  renderLive();
  render();
  if (state.selected) detail.scrollIntoView();
})();
