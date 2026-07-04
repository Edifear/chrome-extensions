#!/usr/bin/env node
// Prepare a minted md session's storageState for recording. Currently:
// pre-dismiss Medallion one-time onboarding hints (MedallionHintPopover /
// useOneTimeTooltip) so they never appear in recordings or spec replays.
// The hints read `medallion.<key>` localStorage flags; seeding them as "true"
// in the Playwright storageState suppresses the popovers before first paint.
// Add further pre-recording state fixups here as they come up.
//
// Usage: node prepare-session.mjs <auth-dir> [extra-hint-key ...]
//   <auth-dir>  md session dir holding storageState.json + session.json
//   extra keys are localStorage names (with the medallion. prefix) for hints
//   not yet in KNOWN_HINT_KEYS.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const KNOWN_HINT_KEYS = [
  'medallion.medallionV2StaffMenuHintDismissed', // "The staff menu has moved"
  'medallion.group-filters-tooltip-v1',          // "You can now filter by groups"
];

const authDir = process.argv[2];
if (!authDir) {
  console.error('usage: prepare-session.mjs <auth-dir> [extra-hint-key ...]');
  process.exit(2);
}

const statePath = path.join(authDir, 'storageState.json');
const manifestPath = path.join(authDir, 'session.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const origin = JSON.parse(readFileSync(manifestPath, 'utf8')).baseUrl.replace(/\/$/, '');

const keys = [...KNOWN_HINT_KEYS, ...process.argv.slice(3)];
state.origins ??= [];
let entry = state.origins.find((o) => o.origin === origin);
if (!entry) {
  entry = { origin, localStorage: [] };
  state.origins.push(entry);
}
entry.localStorage ??= [];
for (const name of keys) {
  const existing = entry.localStorage.find((i) => i.name === name);
  if (existing) existing.value = 'true';
  else entry.localStorage.push({ name, value: 'true' });
}

writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
console.log(`pre-dismissed ${keys.length} hint(s) for ${origin} in ${statePath}`);
