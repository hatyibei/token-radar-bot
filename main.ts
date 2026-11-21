// Token Launch Radar (token-radar-01): a program that reads the sealed DefiLlama
// snapshot, ranks the protocols that record no token by the implied value of the
// launch they have not had yet, and hands in a static dashboard of the board.
//
//   node main.ts --input <snapshot.json|dir> [--output <dir>]
//
// The input defaults to /input/snapshot.json (a directory means the snapshot.json
// inside it). The output defaults to $MAKEFUN_OUTPUT_DIR, else /output. The run
// writes board.json and data.js at the output root, copies dashboard/ and
// screenshots/ from this repository into it, and writes dossier.json last, with
// buildDossier from vendor/makefun-board.ts — the scorer rebuilds that dossier
// from the same output and compares it byte for byte, so nothing may be written
// after it. Everything is derived from the snapshot's own figures: no clocks, no
// randomness, no network, so two runs write identical bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** --name <value> or --name=<value> out of the arguments, else the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory>\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const radar = buildRadar(snapshot);
const issue = boardIssue(radar.rows, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the board fails the gate: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: radar.rows })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy a directory's regular files (dotfiles skipped) into the output; returns the names. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

const pageFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3 or 4 (the board, a detail view, a filtered view)\n`);
  process.exit(1);
}

// Written last: the dossier summarises the dashboard and screenshots as they stand.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
}));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols read, ${snapshot.watchlist.length} on the watchlist, ${radar.rows.length} ranked, ${radar.live.length} trading comps shown\n` +
  `token radar: wrote board.json, data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shots.length} images) and dossier.json under ${out}\n`,
);
