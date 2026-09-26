// Gate for translation pull requests: en.json is the source of truth, every other
// locale file is checked against it.
//
// Fails on things that break the UI (bad JSON, unknown keys, dropped or invented
// {placeholders}, a half-filled plural). Untranslated keys are only reported --
// an unfinished translation is fine, it falls back to English key by key.
//
// Run: npm run check:locales   (from frontend/)
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Same definition of "this key is a plural" the app itself uses at runtime.
import { PLURAL_SUFFIX } from '../src/utils/translate.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');
const placeholders = (s) => new Set(String(s).match(/\{(\w+)\}/g) || []);

const read = (file) => {
  try {
    return JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  } catch (err) {
    console.error(`${file}: not valid JSON -- ${err.message}`);
    process.exit(1);
  }
};

const en = read('en.json');
// A plural key lives in the file as "<base>.<category>". The categories differ per
// language (Japanese needs one form, Russian three), so a translation is compared
// against the base, never against English's own set of categories.
const pluralBases = new Set(Object.keys(en).filter(k => PLURAL_SUFFIX.test(k)).map(k => k.replace(PLURAL_SUFFIX, '')));
const simpleKeys = Object.keys(en).filter(k => !PLURAL_SUFFIX.test(k));
const total = simpleKeys.length + pluralBases.size;

let errors = 0;
const files = readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'en.json');

for (const file of files) {
  const dict = read(file);
  const locale = file.replace(/\.json$/, '');
  const fail = (msg) => { console.error(`${file}: ${msg}`); errors++; };

  let categories;
  try {
    categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  } catch {
    fail(`"${locale}" is not a valid language tag -- name the file after a BCP-47 tag (de.json, pt-BR.json, zh-Hant.json)`);
    continue;
  }

  for (const [key, value] of Object.entries(dict)) {
    if (typeof value !== 'string') {
      fail(`"${key}" must be a string, got ${Array.isArray(value) ? 'array' : typeof value}`);
      continue;
    }
    const base = key.replace(PLURAL_SUFFIX, '');
    const source = en[key] ?? en[`${base}.other`] ?? en[base];
    if (source == null) {
      fail(`"${key}" is not a key in en.json (typo, or a key renamed upstream)`);
      continue;
    }
    const want = placeholders(source);
    const got = placeholders(value);
    for (const p of want) if (!got.has(p)) fail(`"${key}" is missing the placeholder ${p} -- the app needs it to inject a value`);
    for (const p of got) if (!want.has(p)) fail(`"${key}" has an unknown placeholder ${p}; en.json only uses ${[...want].join(' ') || '(none)'}`);
  }

  // A plural that was started has to be finished: a missing category would fall
  // back to English for only some counts, which reads as a bug rather than as an
  // untranslated string.
  let translatedPlurals = 0;
  for (const base of pluralBases) {
    if (!categories.some(cat => `${base}.${cat}` in dict)) continue;
    translatedPlurals++;
    for (const cat of categories) {
      if (!(`${base}.${cat}` in dict)) {
        fail(`plural "${base}" is missing "${base}.${cat}" -- ${locale} needs the ${categories.join(', ')} form${categories.length > 1 ? 's' : ''}`);
      }
    }
  }

  const done = simpleKeys.filter(k => k in dict).length + translatedPlurals;
  console.log(`${file} (${locale}): ${done}/${total} translated${done < total ? ` -- ${total - done} fall back to English` : ''}`);
}

if (errors) {
  console.error(`\n${errors} problem${errors > 1 ? 's' : ''} found. See docs/TRANSLATING.md.`);
  process.exit(1);
}
console.log(files.length ? '\nAll locale files OK.' : 'No translations yet -- see docs/TRANSLATING.md.');
