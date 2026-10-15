// One-shot: drop repository/dataset deposits from the committed recent tier
// (data/recent.index.json) using the shared rule. Idempotent. Then re-run
// extract-construct-memberships.mjs + build-cooccurrence.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRepoVenue } from './repo-venue.mjs';
const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const file = join(DATA, 'recent.index.json');
const all = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
const keep = all.filter((p) => !isRepoVenue(p.journal || ''));
writeFileSync(file, JSON.stringify(keep));
console.log(`[purge] ${all.length} → ${keep.length} (dropped ${all.length - keep.length} repository/dataset deposits)`);
