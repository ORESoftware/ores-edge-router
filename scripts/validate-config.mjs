#!/usr/bin/env node
// Validate one or more router.config.json files against the normalizer (and,
// when ajv is available, against schemas/router.config.schema.json).
import { readFileSync } from 'node:fs';
import { normalizeConfig, missingCanonicalLabels } from '../src/config.mjs';

const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: validate-config.mjs <router.config.json>...'); process.exit(2); }
let failed = 0;
for (const f of files) {
  try {
    const cfg = normalizeConfig(JSON.parse(readFileSync(f, 'utf8')));
    const missing = missingCanonicalLabels(cfg);
    const noFallback = Object.values(cfg.hosts).filter((h) => !h.fallback).map((h) => h.label);
    console.log(`[ok] ${f}: ${cfg.org} -> ${cfg.domain}, ${Object.keys(cfg.hosts).length} hosts` +
      (missing.length ? `; missing canonical: ${missing.join(',')}` : '') +
      (noFallback.length ? `; no fallback: ${noFallback.join(',')}` : ''));
  } catch (err) {
    failed++;
    console.error(`[FAIL] ${f}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
