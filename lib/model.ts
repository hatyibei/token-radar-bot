// lib/model.ts — the token launch radar's model: implied values and farm plans derived
// only from the sealed snapshot's own figures. No protocol name is ever special-cased:
// the same functions score every row, and every constant below is stated on the dashboard.
//
// THE VALUE MODEL
// A protocol that records no token has no price, so the model prices the launch it would
// have if its record stayed as it is, from the protocols whose tokens already trade:
//
//   implied = TVL x category ratio x growth multiplier x maturity multiplier
//
// - category ratio: for each category, the median market-cap/TVL ratio of the snapshot's
//   own token-bearing protocols in that category (at least 4 needed, else the overall
//   median), blended toward the overall median with a prior weight of 4 comps, so a
//   category priced off a handful of tokens cannot dominate the board on noise.
//   Ratios above 25 are dropped from the comp set: a token whose price is
//   decoupled from this protocol's TVL (a chain's coin counted against one small app)
//   says nothing about what a launch against this TVL would be worth.
// - growth multiplier: the week's TVL change, clamped to [-40%, +80%], weighted 1.6 and
//   clamped to [0.45, 2.30]. One hot week must not dominate, but a protocol compounding
//   at +20% a week is not worth the same as one shrinking at the same rate. An
//   unreported change is imputed with the snapshot's median reported change — the same
//   missing-data policy as age below, so "DefiLlama did not report it" never silently
//   becomes "nothing happened" for one input and "the typical case" for another.
// - maturity multiplier: 0.78 for a protocol listed today, rising linearly to 1.25 at
//   four years of tokenless operation. Surviving years with no token is evidence the
//   launch, when it comes, prices a real business. An unreported listing date is imputed
//   with the snapshot's own median age, never with a guess per protocol.
//
// Every row also carries the size of the evidence behind its price: ratio_comps is the
// number of trading protocols whose median priced the row (its category's comp count,
// or the whole comp set when the category has too few), so a reader can see which
// values rest on forty observations and which on four.
//
// Rows are the protocols that record no token and could plausibly issue one of their own:
// every watchlist protocol, plus every other no-token protocol except the categories that
// are inherently someone else's token in another form (canonical bridges, liquid staking
// and restaking wrappers, restaked BTC, exchange house products), names that mark a
// wrapped, staked or versioned copy of another product, and "bridges" the snapshot counts
// on a single chain — in the data those are one wrapped asset, not a bridge. Real bridges
// stay: a bridge can issue its own token, and several have. Token-bearing protocols are
// never ranked; they are the comp set, shown on the dashboard as the already-trading
// table the ratios came from.
//
// After sorting by implied value, a polish pass makes the ranking strict: when two raw
// values round to the same dollar, the lower-ranked row is written one dollar under its
// neighbour. Both numbers are carried on the row (implied_raw_usd is the model's output,
// implied_value_usd is the board's), so the adjustment is visible, never hidden.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  implied_raw_usd: number;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  ratio_used: number;
  ratio_comps: number;
  change_imputed: boolean;
  growth_mult: number;
  maturity_mult: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
}

export interface RadarData {
  meta: {
    as_of: string;
    source: string;
    floor_usd: number;
    protocol_count: number;
    watchlist_count: number;
    board_count: number;
    live_count: number;
    model_version: string;
    overall_ratio: number;
    median_age_days: number;
    median_change_7d: number;
    category_ratios: { category: string; comps: number; ratio: number }[];
  };
  rows: BoardRow[];
  live: LiveRow[];
}

export const MODEL_VERSION = 'radar-3';

/** Categories that are another token in another form, never a launch of their own. */
const DERIVATIVE_CATEGORIES = new Set(['Canonical Bridge', 'Liquid Restaking', 'Liquid Staking', 'Restaked BTC', 'CEX']);
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!raw || !Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist) || typeof raw.as_of !== 'string') {
    throw new Error('snapshot: expected {as_of, protocols[], watchlist[]}');
  }
  return raw;
}

/** Whole days from listed_at to the snapshot's as_of; null when the date is unreported. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const days = Math.round((Date.parse(asOf) - Date.parse(listedAt)) / 86_400_000);
  return Number.isFinite(days) ? Math.max(0, days) : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The comp set: token-bearing protocols whose mcap/TVL ratio can price a launch. */
function compRatios(snapshot: Snapshot): { overall: number; total: number; byCategory: Map<string, { n: number; ratio: number }> } {
  const all: number[] = [];
  const perCategory = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!(ratio > 0) || ratio > 25) continue;
    all.push(ratio);
    if (p.category !== null) {
      const list = perCategory.get(p.category) ?? [];
      list.push(ratio);
      perCategory.set(p.category, list);
    }
  }
  const overall = median(all);
  const byCategory = new Map<string, { n: number; ratio: number }>();
  for (const [category, list] of perCategory) {
    if (list.length >= 4) {
      // Shrinkage: a category's own median is blended with the market-wide median,
      // weighted by its comp count against a prior of 4 comps. A category priced off
      // 40 trading protocols keeps its own figure; one priced off 4 is pulled toward
      // the market's, because four observations cannot carry a ranking on their own.
      const n = list.length;
      byCategory.set(category, { n, ratio: (n * median(list) + 4 * overall) / (n + 4) });
    }
  }
  return { overall, total: all.length, byCategory };
}

/** True when the protocol records no token in the snapshot. */
export const recordsNoToken = (p: Protocol): boolean => p.gecko_id === null && p.symbol === null && p.mcap_usd === null;

/** True when a no-token protocol is a wrapped, staked or versioned copy of another product. */
function isDerivativeCopy(p: Protocol): boolean {
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) return true;
  // A "bridge" the snapshot counts on a single chain bridges nothing in the data: the
  // entry is one wrapped asset sitting on that chain (a wrapped BTC or bridged USDT
  // product), which is another token in another form, not a launch of its own.
  if ((p.category === 'Bridge' || p.category === 'Cross Chain Bridge') && p.chains.length < 2) return true;
  return VERSION_SUFFIX.test(p.name) || WRAPPED_WORD.test(p.name) || EXCHANGE_PREFIX.test(p.name);
}

export interface Scored {
  protocol: Protocol;
  age: number | null;
  ratio: number;
  ratioComps: number;
  changeImputed: boolean;
  growthMult: number;
  maturityMult: number;
  raw: number;
}

/** Score one protocol with the model stated at the top of this file. */
export function scoreProtocol(p: Protocol, asOf: string, overall: number, totalComps: number, byCategory: Map<string, { n: number; ratio: number }>, medianAge: number, medianChange: number): Scored {
  const age = ageDays(asOf, p.listed_at);
  const entry = p.category !== null ? byCategory.get(p.category) : undefined;
  const ratio = entry?.ratio ?? overall;
  const ratioComps = entry?.n ?? totalComps;
  const changeImputed = p.change_7d === null;
  const growthPct = clamp(p.change_7d ?? medianChange, -40, 80);
  const growthMult = clamp(1 + (growthPct / 100) * 1.6, 0.45, 2.3);
  const effectiveAge = age ?? medianAge;
  const maturityMult = 0.78 + 0.47 * (Math.min(effectiveAge, 1460) / 1460);
  return { protocol: p, age, ratio, ratioComps, changeImputed, growthMult, maturityMult, raw: p.tvl_usd * ratio * growthMult * maturityMult };
}

/** The snapshot's median reported 7-day change: the imputation for an unreported one. */
function medianChangeOf(snapshot: Snapshot): number {
  const reported = snapshot.protocols.map((p) => p.change_7d).filter((v): v is number => v !== null && Number.isFinite(v));
  return reported.length > 0 ? median(reported) : 0;
}

// ---------------------------------------------------------------- farm plans
//
// A row's farm plan is assembled from the protocol's own figures: a budget step that
// states the plan's whole cost and horizon up front, a setup step priced
// from its main chain's gas, one or two core steps from its category's playbook, a
// second-chain step when it runs on more than one chain, a weekly cadence step whose
// length follows its TVL tier, a points step for the categories that run points
// programs, a risk step for the leveraged categories, and a post-launch step. Amounts
// come from a capital tier read off TVL, never from the protocol's name. Wording
// variants are picked by a stable hash of the slug, so two runs — and two similar
// protocols — do not produce one verbatim template, and the output never changes.

/** FNV-1a over the slug: a stable, seedless pick between phrasings. */
function pick(slug: string, salt: string, options: string[]): string {
  let h = 2166136261;
  const text = `${slug}:${salt}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return options[Math.abs(h) % options.length]!;
}

const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/** Working capital the plan commits, read off the protocol's TVL tier. */
function capitalFor(tvl: number): number {
  if (tvl >= 250_000_000) return 10_000;
  if (tvl >= 100_000_000) return 5_000;
  if (tvl >= 50_000_000) return 2_500;
  if (tvl >= 20_000_000) return 1_000;
  if (tvl >= 10_000_000) return 500;
  return 250;
}

/** Weeks the plan runs for, read off the same tier. */
function weeksFor(tvl: number): number {
  if (tvl >= 100_000_000) return 12;
  if (tvl >= 25_000_000) return 10;
  return 8;
}

const L2_CHAINS = new Set(['Arbitrum', 'Base', 'Optimism', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Blast', 'Mode', 'Taiko', 'Zircuit', 'Starknet', 'Unichain', 'Ink', 'Soneium', 'Fraxtal', 'Lisk', 'Manta', 'Boba', 'Metis', 'World Chain', 'Abstract', 'ApeChain', 'Sophon', 'Katana', 'MegaETH', 'Monad', 'Berachain', 'Sonic', 'Plasma', 'X Layer', 'Op_Bnb', 'Cronos zkEVM', 'Polygon zkEVM', 'Fuel', 'Gravity', 'Lens', 'RISE', 'Fluent', 'Corn', 'Citrea', 'Hemi', 'BOB', 'Bitlayer', 'Mezo', 'TAC', 'Ethereal', 'Codex', 'Stable', 'Tempo', 'Arc', 'Elysium Kinetiq', 'Morph', 're.al', 'Mint', 'LightLink', 'Swellchain', 'Degen', 'Zora', 'Etherlink', 'Astar zkEVM', 'Silicon zkEVM']);

/** A realistic per-transaction gas estimate in dollars for a chain, by its class. */
function gasFor(chain: string): number {
  if (chain === 'Ethereum') return 12;
  if (chain === 'Solana') return 0.05;
  if (chain === 'Bitcoin') return 2.5;
  if (L2_CHAINS.has(chain)) return 0.35;
  if (['Sui', 'Aptos', 'Near', 'TON', 'Stellar', 'Algorand', 'Sei', 'Injective'].includes(chain)) return 0.1;
  return 1.2;
}

interface Ctx {
  name: string;
  chain: string;
  gas: string;
  cap: string;
  half: string;
  third: number;
  thirdUsd: string;
  weeks: number;
}

const fill = (template: string, c: Ctx): string =>
  template
    .replaceAll('{name}', c.name)
    .replaceAll('{chain}', c.chain)
    .replaceAll('{gas}', c.gas)
    .replaceAll('{cap}', c.cap)
    .replaceAll('{half}', c.half)
    .replaceAll('{third}', c.thirdUsd)
    .replaceAll('{weeks}', String(c.weeks));

/** The core loop for a category: what the farmer actually does on the protocol. */
function coreSteps(p: Protocol, c: Ctx): string[] {
  const cat = p.category ?? '';
  const two = (a: string[], b: string[]): string[] => [fill(pick(p.slug, 'core-a', a), c), fill(pick(p.slug, 'core-b', b), c)];
  switch (cat) {
    case 'Dexs':
      return two(
        [
          'Swap on {name} every week: trade about twice your {cap} position in volume across its main pairs (roughly {gas} of gas a swap on {chain}), split across different days so the activity reads as real usage, not one burst.',
          'Trade {name}\'s main pairs weekly until your cumulative volume passes ten times your {cap} stake; volume, distinct weeks and distinct pairs are the three numbers DEX snapshots have historically weighted.',
        ],
        [
          'Provide liquidity with about {half} in a top-three pool on {name} and hold it for the full {weeks} weeks; check the range every Monday, rebalance when it drifts out, and expect impermanent loss if the pair trends hard.',
          'Park {half} in one of {name}\'s core pools rather than a long-tail pair: core pools earn the fee share and are the positions liquidity programs count, while tail pairs mostly earn impermanent loss.',
        ],
      );
    case 'Lending':
    case 'Uncollateralized Lending':
      return two(
        [
          'Supply about {cap} of ETH or USDC to {name} on {chain} and leave it supplied: interest accrues on its own, and supplied balances held over time are what lending points programs snapshot.',
          'Deposit {cap} into {name}\'s main lending market on {chain} and resist moving it between markets; tenure on one position is worth more than the same dollars spread thin across five.',
        ],
        [
          'Borrow against the position conservatively — at most {third} in stablecoins with the health factor kept above 2.0 — redeposit what you borrow, and check the position every Monday: liquidation penalties run 5–10% and end a farm in one bad hour.',
          'Loop once, no more: borrow about {third} against your supply, redeposit it, and stop there. A single loop doubles your counted balance; a fifth loop mostly doubles your liquidation risk.',
        ],
      );
    case 'Derivatives':
    case 'Interest Rate Derivatives':
      return two(
        [
          'Trade perps on {name} from a small {cap} account: run hedged or delta-neutral positions to build genuine volume of about ten times the account a month, at taker fees near 0.05% plus roughly {gas} a trade on {chain}.',
          'Open a {cap} margin account on {name} and trade both directions across the week rather than in one session; consistent two-sided flow is what separates a market participant from a one-off speculator in its data.',
        ],
        [
          'Keep leverage at or below 3x and no single position above a quarter of the account: at 5x a 20% adverse move wipes the margin, and a liquidated account earns nothing whatever the launch terms turn out to be.',
          'Set a hard stop: if the account draws down 25%, close everything and restart the following week. Perp farms are a marathon of small fee-paying trades, not one heroic position.',
        ],
      );
    case 'CDP':
    case 'CDP Manager':
      return two(
        [
          'Open a vault on {name}: deposit about {cap} of ETH or a liquid staking token as collateral and mint its stablecoin at a collateral ratio above 200%, so even a 40% drawdown cannot trigger liquidation.',
          'Mint against {cap} of collateral on {name}, keeping the ratio at 200% or higher, and put the minted stablecoin in the protocol\'s own stability pool so both sides of the position are counted.',
        ],
        [
          'Check the vault every Monday and top up collateral before the ratio reaches 170% (about {gas} a top-up on {chain}); CDP liquidations auction collateral at a discount, which is the expensive way to learn the dashboard.',
          'Harvest any stability-pool rewards every two weeks instead of letting them idle, and keep the mint open for the full {weeks} weeks: an open, healthy vault is the balance this category\'s snapshots record.',
        ],
      );
    case 'Yield':
    case 'Yield Aggregator':
    case 'Liquidity Manager':
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Collateral Management':
    case 'Collateral Markets':
      return two(
        [
          'Deposit about {cap} of USDC or ETH into {name}\'s flagship vault on {chain} and stay deposited: vault shares are the balance curators and points programs measure, and churning between vaults resets most tenure counters.',
          'Put {cap} into {name}\'s main vault rather than its newest one: flagship vaults hold the TVL the team reports, and launches in this category have rewarded flagship depositors first.',
        ],
        [
          'Spread a second tranche of about {half} into one more vault or a second chain the protocol runs, and compound rewards every two weeks (about {gas} a transaction) instead of withdrawing them.',
          'Reinvest every payout for the full {weeks} weeks: compounding turns a static deposit into a growing balance history, which is exactly the curve a snapshot reads as conviction.',
        ],
      );
    case 'Bridge':
    case 'Cross Chain Bridge':
    case 'Canonical Bridge':
      return two(
        [
          'Bridge real funds through {name} weekly: move about {half} between {chain} and one other supported chain and back over {weeks} weeks, paying the bridge fee (usually 0.05–0.3%) plus about {gas} of destination gas each way.',
          'Route your ordinary cross-chain moves through {name} instead of an aggregator for {weeks} weeks: about {half} a trip, varied amounts, varied times of day, and never the same round trip twice in one day.',
        ],
        [
          'Use at least three distinct routes {name} supports: bridge snapshots have historically weighted distinct weeks and distinct routes over raw volume, so breadth beats one enormous transfer.',
          'Keep a log of every crossing with its hash and route; if a points or retroactive program opens, that log is how you prove the activity was yours and organic.',
        ],
      );
    case 'Restaking':
    case 'Liquid Restaking':
      return two(
        [
          'Restake about {cap} of ETH or a liquid staking token through {name} on {chain} and hold the receipt position untouched; restaking points accrue per day held, and withdrawing starts a 7–14 day unbonding clock.',
          'Deposit {cap} of ETH into {name} and delegate it rather than leaving it undelegated: delegated stake is the balance its operator network reports, and undelegated balances have earned nothing in past restaking launches.',
        ],
        [
          'Pick one of the protocol\'s established operators and check its slashing record monthly; the yield is small, so the position is really a claim on the launch, and operator risk is the main way to lose it.',
          'Do not stack a second restaking layer on top of this one: each extra layer adds a slashing surface, and no points program has yet paid enough to cover one slashing event.',
        ],
      );
    case 'RWA':
      return two(
        [
          'Complete {name}\'s onboarding (identity checks where the product requires them, about 20 minutes) and invest about {cap} in its shortest-duration treasury or credit product, so capital is not locked past a plausible launch window.',
          'Open an account on {name}, finish its compliance steps once, and place {cap} in the product with the shortest maturity it offers; RWA platforms track account age as well as volume, and age cannot be bought later.',
        ],
        [
          'Reinvest maturing proceeds instead of withdrawing, for at least {weeks} weeks: cumulative invested volume and an unbroken holding record are the two metrics this category can verify, and both compound quietly.',
          'Keep maturities laddered — no single product holding more than half the position — so a redemption delay in one product never freezes the whole farm.',
        ],
      );
    case 'Launchpad':
      return [
        fill(pick(p.slug, 'core-a', [
          'Register on {name} and complete its identity checks once (about 15 minutes), then commit about {half} to each public sale it runs; unsold allocations are refunded, so the real cost is gas (about {gas} a commitment on {chain}) and the lock-up days.',
          'Whitelist your farming wallet on {name} before its next sale opens: launchpad allocations go to wallets registered early, and registering after a sale is announced is usually too late to count.',
        ]), c),
        fill('Take part in at least three separate sales rather than one large one: participation count across sales is the record a launchpad can reward, and it costs only the refundable commitment each time.', c),
      ];
    case 'Leveraged Farming':
    case 'Basis Trading':
    case 'Farm':
      return two(
        [
          'Run the carry on {name} with about {cap}: hold the long leg and its hedge together so the position is delta-neutral, and rebalance whenever the funding rate flips sign for more than two days running.',
          'Open a hedged position of about {cap} on {name} — long the yield-bearing leg, short the perp — and let funding and farm rewards accrue; an unhedged "farm" in this category is just a leveraged long.',
        ],
        [
          'Cap leverage at 3x and check the hedge ratio every Monday: the strategy dies by drift, not by direction, and a position that has drifted 20% off neutral is a speculation, not a farm.',
          'Withdraw profits monthly rather than compounding them into the position: leveraged farms fail suddenly, and banked profit survives a liquidation that the position does not.',
        ],
      );
    case 'Options':
    case 'Options Vault':
      return [
        fill(pick(p.slug, 'core-a', [
          'Deposit about {cap} into {name}\'s flagship options vault and roll with it for {weeks} weeks; vault tenure and cumulative deposits are what its accounting remembers, and mid-week withdrawals usually forfeit that week\'s premium.',
          'Buy a small, regular options position on {name} every week — about {third} of premium a month — favouring liquid strikes near the money, where spreads are tightest and the activity is unmistakably real trading.',
        ]), c),
      ];
    case 'Synthetics':
    case 'Algo-Stables':
    case 'Dual-Token Stablecoin':
    case 'Stablecoin Issuer':
    case 'Stablecoin Wrapper':
      return [
        fill(pick(p.slug, 'core-a', [
          'Deposit about {cap} as collateral on {name} and mint a small synthetic or stable position against it, keeping collateralisation above 250% so oracle swings cannot liquidate the account mid-farm.',
          'Hold {name}\'s issued asset rather than swapping out of it immediately: holders of the synthetic itself are the users its accounting can identify, and about {cap} held for {weeks} weeks is a clear signal.',
        ]), c),
        fill('Check the collateral ratio every Monday and top up before it reaches 200% (about {gas} a transaction on {chain}); synthetic liquidations are mechanical and do not wait for you to notice.', c),
      ];
    case 'Prediction Market':
      return [
        fill(pick(p.slug, 'core-a', [
          'Trade both sides of liquid markets on {name} with a bankroll of about {cap}, a few markets a week at roughly {gas} a trade on {chain}; consistent two-sided traders and market makers are who prediction platforms have rewarded.',
          'Provide liquidity on {name}\'s busiest markets with about {half}: quote both sides, refresh quotes when news moves a price, and expect to be picked off occasionally — that cost is the tuition every real market maker pays.',
        ]), c),
      ];
    case 'Privacy':
      return [
        fill(pick(p.slug, 'core-a', [
          'Use {name} for genuine transfers of about {half} at a time rather than dust: deposit, wait at least a day, and withdraw to a fresh address, paying about {gas} a transaction, so the usage pattern is real rather than theatrical.',
          'Route a real payment through {name} every week or two for {weeks} weeks; privacy tools can only reward usage that exists, and a handful of honest transactions outweighs a hundred scripted ones.',
        ]), c),
      ];
    case 'Payments':
    case 'Crypto Card Issuer':
      return [
        fill(pick(p.slug, 'core-a', [
          'Route everyday spending through {name}: load about {half} a month and pay with it for {weeks} weeks; card and payments programs reward cumulative genuine spend, and manufactured spend is the one thing that reliably gets accounts flagged.',
          'Make {name} your default card for small daily purchases, aiming for steady spend across {weeks} weeks rather than one large load; consistency is the metric payments issuers can actually verify.',
        ]), c),
      ];
    case 'Indexes':
      return [
        fill(pick(p.slug, 'core-a', [
          'Buy and hold about {cap} of {name}\'s headline index and add a small amount monthly; index protocols can count holders and holding time, so an untouched position ages better than an actively traded one.',
          'Hold {cap} of {name}\'s main index product for the full {weeks} weeks without selling into strength: in this category the farm is simply being a holder of record when a snapshot is taken.',
        ]), c),
      ];
    case 'Insurance':
      return [
        fill(pick(p.slug, 'core-a', [
          'Stake about {cap} in {name}\'s capital pool for a full quarter, or buy cover on a position you actually hold; underwriting capital is locked while it earns, so size it as money you will not need before a plausible claim window.',
          'Provide {cap} of underwriting capital to {name} and leave it through at least one full cover period; insurance protocols can verify capital tenure precisely, and short stays earn little and count less.',
        ]), c),
      ];
    case 'Staking Pool':
    case 'Liquid Staking':
      return [
        fill(pick(p.slug, 'core-a', [
          'Stake about {cap} through {name} and leave the position for at least {weeks} weeks; staking tenure is the metric this category can verify exactly, and unstaking early usually means a 7–21 day exit queue.',
          'Delegate {cap} to one of {name}\'s established validators rather than the highest-yield one: validator tenure and uptime are recorded, and a slashing event costs more than the extra yield ever paid.',
        ]), c),
      ];
    case 'Chain':
      return two(
        [
          'Be an early user of the {name} network itself: bridge about {cap} onto it, then use its first-party apps weekly — a swap, a lending market, a mint — because a chain\'s own launch rewards its native users first (about {gas} a transaction).',
          'Move a working balance of about {cap} to {name}\'s chain and transact there weekly for {weeks} weeks; for a chain, the farm is simply being one of the wallets its own explorer shows as active before any token exists.',
        ],
        [
          'Hold a small balance of the chain\'s gas asset and never let the wallet sit empty for a full month: dormant wallets are the first thing activity snapshots filter out.',
          'Try each flagship app the chain launches within its first week; early-user lists for new apps are usually drawn from the chain\'s existing active wallets.',
        ],
      );
    default:
      return two(
        [
          'Use {name}\'s core product on {chain} with about {cap} of capital at least once a week for {weeks} weeks: genuine repeated usage is the one signal every points program and snapshot can measure, at about {gas} a transaction.',
          'Start with a {cap} position in {name}\'s main product on {chain} and use it the way a real user would — small, regular, varied transactions — rather than one large deposit that sits untouched.',
        ],
        [
          'Grow the position slowly, adding about 10% a month instead of depositing once: programs that weight time-in-protocol reward aged balances more than large new ones, and ageing cannot be rushed later.',
          'Keep the same wallet for the whole farm: splitting {cap} across five wallets makes each one look like a tourist, and sybil filters are built to find exactly that pattern.',
        ],
      );
  }
}

const POINTS_CATEGORIES = new Set(['Dexs', 'Lending', 'Derivatives', 'Restaking', 'Liquid Restaking', 'Bridge', 'Cross Chain Bridge', 'Yield', 'Yield Aggregator', 'CDP', 'Launchpad', 'Perps', 'Options', 'Basis Trading', 'Chain']);

/** Assemble one protocol's farm plan: setup, category core, extras, cadence, launch. */
export function farmSteps(p: Protocol, age: number | null): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const cap = capitalFor(p.tvl_usd);
  const c: Ctx = {
    name: p.name,
    chain,
    gas: `$${gasFor(chain)}`,
    cap: usd(cap),
    half: usd(cap / 2),
    third: Math.round(cap / 3),
    thirdUsd: usd(cap / 3),
    weeks: weeksFor(p.tvl_usd),
  };
  const steps: string[] = [];
  // The plan opens with its whole budget and horizon, priced from the same tiers and
  // gas table the steps below use: working capital, the weeks it stays committed, and
  // the running gas at the plan's own cadence — about two transactions a week on the
  // main chain, plus one a week on the second chain when the plan opens a position
  // there too, so the stated total is the plan's real total, not its first chain's.
  const runningGas = Math.max(1, Math.round(c.weeks * (2 * gasFor(chain) + (p.chains.length > 1 ? gasFor(p.chains[1]!) : 0))));
  steps.push(fill(pick(p.slug, 'budget', [
    `Budget and horizon for {name}: about {cap} of working capital committed for {weeks} weeks, plus roughly $${runningGas} of gas at the plan's weekly cadence — size the position so the capital can stay untouched for the whole run, because leaving early is what zeroes most farms.`,
    `What farming {name} costs, in full: about {cap} of capital held for {weeks} weeks and roughly $${runningGas} of gas across the plan's weekly cadence on every chain it uses; judge the farm on that total, not on the deposit alone.`,
  ]), c));
  // A protocol whose main chain is Ethereum needs no bridge in: funding is direct.
  const setupOptions = chain === 'Ethereum'
    ? [
        'Set up a dedicated wallet for {name} and fund it directly on Ethereum mainnet with about {cap} of working capital in ETH or a major stablecoin — no bridge needed, since {chain} is home — and keep a small ETH buffer untouched for later claims at roughly {gas} a transaction.',
        'Create a fresh farming wallet, label it for {name}, and deposit roughly {cap} straight onto Ethereum mainnet; at about {gas} a transaction, mainnet gas is the main running cost of this farm, so batch actions where the product allows it.',
      ]
    : [
        'Set up a dedicated wallet for {name} and fund it on {chain}: bridge about {cap} of working capital in ETH or a major stablecoin (bridge fee plus roughly {gas} of gas), and keep a small native-gas buffer untouched for later claims.',
        'Create a fresh farming wallet, label it for {name}, and move roughly {cap} to {chain} through the canonical bridge; budget about {gas} a transaction on this chain and never let the gas balance reach zero.',
      ];
  steps.push(fill(pick(p.slug, 'setup', setupOptions), c));
  steps.push(...coreSteps(p, c));
  if (p.chains.length > 1) {
    const second = p.chains[1]!;
    steps.push(fill(pick(p.slug, 'multi', [
      `Repeat the core loop on ${second} with about {third}: {name} runs on ${p.chains.length} chains, and multi-chain users are a small, easy-to-reward set in most snapshots; bridging there costs about $${gasFor(second)} of gas plus the bridge fee.`,
      `Open a second, smaller position of about {third} on ${second}: protocols that run on ${p.chains.length} chains can count cross-chain users exactly, and there are never many of them.`,
    ]), c));
  }
  if (p.category !== null && POINTS_CATEGORIES.has(p.category)) {
    steps.push(fill(pick(p.slug, 'points', [
      'Join {name}\'s points or quests program the week it opens and link this same wallet: points are non-transferable and tied to the address, so splitting activity across wallets dilutes the one balance that matters.',
      'If {name} runs a points season, earn points with the farming wallet only and check the leaderboard monthly; a mid-table position held for a whole season has historically beaten a top position held for a week.',
    ]), c));
  }
  steps.push(fill(pick(p.slug, 'cadence', [
    'Keep a weekly routine for {weeks} weeks: one or two genuine transactions on {name} every week, on different days, each logged with its transaction hash; consistency across weeks is what separates qualifying farmers from one-week tourists.',
    'Put {name} on a Monday checklist for {weeks} weeks — one real interaction, one balance check, one line in a tracking sheet. The routine costs minutes; missing three weeks in a row is what quietly zeroes a season.',
  ]), c));
  if (age !== null && age >= 730) {
    steps.push(`Note the track record before sizing up: ${p.name} has run for about ${(age / 365).toFixed(1)} years with no token recorded, so treat this position as a long hold rather than a trade, and size it so that another quiet year is acceptable.`);
  }
  steps.push(fill(pick(p.slug, 'launch', [
    'After any launch: claim to this same wallet inside the first claim window (claims are usually free but time-boxed to 30–90 days), then hold or stake at least half for the first month — post-launch staking has often been a second snapshot.',
    'When a token appears, claim promptly to the farming wallet and resist selling everything on day one: several launches have rewarded holders again at a second distribution, and an empty wallet cannot be on that list.',
  ]), c));
  return steps.slice(0, 10);
}

// ---------------------------------------------------------------- the board

/** Build the ranked board: every watchlist protocol plus the other rankable ones. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const { overall, total, byCategory } = compRatios(snapshot);
  const ages = snapshot.protocols.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((a): a is number => a !== null);
  const medianAge = ages.length > 0 ? median(ages) : 365;
  const medianChange = medianChangeOf(snapshot);
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => recordsNoToken(p) && (watch.has(p.slug) || !isDerivativeCopy(p)));
  const scored = chosen.map((p) => scoreProtocol(p, snapshot.as_of, overall, total, byCategory, medianAge, medianChange));
  scored.sort((a, b) => b.raw - a.raw || (a.protocol.slug < b.protocol.slug ? -1 : 1));
  const rows: BoardRow[] = [];
  let previous = Number.POSITIVE_INFINITY;
  for (const [i, s] of scored.entries()) {
    let value = Math.max(1, Math.round(s.raw));
    if (value >= previous) value = previous - 1;
    previous = value;
    rows.push({
      slug: s.protocol.slug,
      name: s.protocol.name,
      rank: i + 1,
      implied_value_usd: value,
      implied_raw_usd: Math.max(1, Math.round(s.raw)),
      category: s.protocol.category,
      chains: s.protocol.chains,
      tvl_usd: s.protocol.tvl_usd,
      change_7d: s.protocol.change_7d,
      listed_at: s.protocol.listed_at,
      age_days: s.age,
      watchlist: watch.has(s.protocol.slug),
      ratio_used: round4(s.ratio),
      ratio_comps: s.ratioComps,
      change_imputed: s.changeImputed,
      growth_mult: round4(s.growthMult),
      maturity_mult: round4(s.maturityMult),
      farm_steps: farmSteps(s.protocol, s.age),
    });
  }
  return rows;
}

/** The already-trading comp set the ratios came from, largest first. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || (a.slug < b.slug ? -1 : 1))
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: round4(p.mcap_usd! / p.tvl_usd),
    }));
}

/** Everything the dashboard needs, in one deterministic object. */
export function buildRadar(snapshot: Snapshot): RadarData {
  const { overall, byCategory } = compRatios(snapshot);
  const medianChange = medianChangeOf(snapshot);
  const ages = snapshot.protocols.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((a): a is number => a !== null);
  const rows = buildBoard(snapshot);
  const live = liveRows(snapshot);
  return {
    meta: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      protocol_count: snapshot.protocols.length,
      watchlist_count: snapshot.watchlist.length,
      board_count: rows.length,
      live_count: snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length,
      model_version: MODEL_VERSION,
      overall_ratio: round4(overall),
      median_age_days: Math.round(ages.length > 0 ? median(ages) : 365),
      median_change_7d: round4(medianChange),
      category_ratios: [...byCategory.entries()]
        .map(([category, v]) => ({ category, comps: v.n, ratio: round4(v.ratio) }))
        .sort((a, b) => (a.category < b.category ? -1 : 1)),
    },
    rows,
    live,
  };
}

/** data.js: the dashboard's whole data, as one script assigning window.RADAR. */
export function dataScript(data: RadarData): string {
  return `window.RADAR = ${JSON.stringify(data)};\n`;
}

/** The gate's board rules, checked before anything is written: null when the board passes. */
export function boardIssue(rows: BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `board holds ${rows.length} rows, outside 100..4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  let allEqual = rows.length > 1;
  for (const [i, row] of rows.entries()) {
    if (!slugs.has(row.slug)) return `row ${i + 1}: slug ${row.slug} is not in the snapshot`;
    if (seen.has(row.slug)) return `row ${i + 1}: slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (row.rank !== i + 1) return `row ${i + 1}: rank is ${row.rank}, expected ${i + 1}`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 1e14) return `row ${i + 1}: implied value ${row.implied_value_usd} is not a positive whole dollar amount within the cap`;
    if (row.implied_value_usd > previous) return `row ${i + 1}: implied value rises with rank`;
    if (row.implied_value_usd !== rows[0]!.implied_value_usd) allEqual = false;
    previous = row.implied_value_usd;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${i + 1}: ${row.farm_steps.length} farm steps, outside 3..12`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${i + 1}: a farm step is ${len} characters once trimmed, outside 20..600`;
    }
  }
  if (allEqual) return 'every implied value is the same: not a ranking';
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  return null;
}
