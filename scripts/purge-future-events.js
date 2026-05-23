// Remove events and future-dated items already in raw_items.
const db = require('../db');

// Future-dated by more than 24h (keeps today's tomorrow-UTC items intact).
const future = db.prepare(`
  DELETE FROM raw_items
  WHERE published_at IS NOT NULL
    AND datetime(published_at) > datetime('now', '+1 day')
`).run();
console.log(`Deleted ${future.changes} future-dated raw_items.`);

// URL-pattern event/webinar listings, regardless of date.
const events = db.prepare(`
  DELETE FROM raw_items
  WHERE lower(url) GLOB '*/events/*'
     OR lower(url) GLOB '*/event/*'
     OR lower(url) GLOB '*/webinars/*'
     OR lower(url) GLOB '*/webinar/*'
     OR lower(url) GLOB '*/conferences/*'
`).run();
console.log(`Deleted ${events.changes} event/webinar raw_items.`);

// Show current max published date so we can confirm "no more time travel".
const maxRow = db.prepare(`SELECT MAX(published_at) m FROM raw_items WHERE published_at IS NOT NULL`).get();
console.log(`Latest published_at remaining: ${maxRow.m}`);
