const db = require('../db');
const before = db.prepare('SELECT sheet, COUNT(*) n FROM spoc_entries GROUP BY sheet').all();
console.log('BEFORE:', before);
const r = db.prepare("DELETE FROM spoc_entries WHERE sheet NOT LIKE '%SPOC%' COLLATE NOCASE").run();
console.log('Deleted', r.changes, 'rows.');
const after = db.prepare('SELECT sheet, COUNT(*) n FROM spoc_entries GROUP BY sheet').all();
console.log('AFTER:', after);
