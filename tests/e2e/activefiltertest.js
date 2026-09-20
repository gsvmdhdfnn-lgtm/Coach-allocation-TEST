// Reproduces activeSorted() from the deployed hub-content edge function
// (v14) against the real Public Pages records, to prove: (a) October
// Camps (Active never ticked) is now excluded, (b) every record that
// should still be visible (Active explicitly ticked true) still is.
function activeSorted(rows, primaryField) {
  return rows
    .filter((record) => record.fields.Active === true && record.fields[primaryField])
    .sort((a, b) => {
      const sa = a.fields['Sort Order'];
      const sb = b.fields['Sort Order'];
      if (sa == null && sb == null) return 0;
      if (sa == null) return 1;
      if (sb == null) return -1;
      return sa - sb;
    });
}

const rows = [
  { fields: { Title: 'Upcoming Events — Example', Active: true, 'Sort Order': 4 } },
  { fields: {} }, // blank stray row
  { fields: { Title: 'Academy Trials', Active: true, 'Sort Order': 2 } },
  { fields: { Title: 'Welcome to Josh Evans Soccer School', Active: true, 'Sort Order': 0 } },
  { fields: { Title: 'Jets Trials', Active: true, 'Sort Order': 1 } },
  { fields: { Title: 'Tours', Active: true, 'Sort Order': 3 } },
  { fields: { Title: 'October Camps', 'Sort Order': 5 } }, // Active never ticked - real record shape
];

const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

const result = activeSorted(rows, 'Title');
const titles = result.map(r => r.fields.Title);

ck('October Camps (Active never ticked) is excluded', !titles.includes('October Camps'), titles.join(', '));
ck('All 5 explicitly-active records still show, in Sort Order', titles.join('|') === 'Welcome to Josh Evans Soccer School|Jets Trials|Academy Trials|Tours|Upcoming Events — Example', titles.join('|'));
ck('Blank stray row is still excluded', result.length === 5, String(result.length));

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
process.exit(process.exitCode || 0);
