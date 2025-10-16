const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const ora = require('ora');
const cliSpinners = require('cli-spinners');

const URL = 'https://earthquake.phivolcs.dost.gov.ph/';
const DATA_FILE = path.join(__dirname, 'last_quakes.json');

const buckets = [
  { name: 'Mg 1+', min: 1, max: 2, count: 0, color: '\x1b[37m' },
  { name: 'Mg 2+', min: 2, max: 3, count: 0, color: '\x1b[37m' },
  { name: 'Mg 3+', min: 3, max: 4, count: 0, color: '\x1b[36m' },
  { name: 'Mg 4+', min: 4, max: 5, count: 0, color: '\x1b[33m' },
  { name: 'Mg 5+', min: 5, max: 6, count: 0, color: '\x1b[31m' },
  { name: 'Mg 6+', min: 6, max: Infinity, count: 0, color: '\x1b[35m' }
];

function bucketForMag(mag) {
  return buckets.find(b => mag >= b.min && mag < b.max) || null;
}

function parseNumber(text) {
  if (!text) return NaN;
  const cleaned = text.replace(/[^\d.\-]/g, '').trim();
  return cleaned === '' ? NaN : Number(cleaned);
}

function loadPreviousData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    } catch {
      return [];
    }
  }
  return [];
}

function saveCurrentData(signatures) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(signatures, null, 2));
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

  try {
    const spinner = ora({
      text: 'Loading earthquake data...',
      color: 'cyan',
      spinner: 'earth'
    }).start();

    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const tableData = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'));

      if (!tables.length) return { headers: [], rows: [] };

      let best = tables[0];
      for (const t of tables) {
        if ((t.tBodies[0]?.rows.length || 0) > (best.tBodies[0]?.rows.length || 0)) best = t;
      }

      const headerCells = Array.from(best.querySelectorAll('thead th')).map(h => h.textContent.trim());
      const bodyRows = Array.from(best.querySelectorAll('tbody tr')).map(tr =>
        Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim())
      );

      let headers = headerCells;
      if (!headers.length && bodyRows.length && bodyRows[0].every(c => c && isNaN(Number(c)))) {
        headers = bodyRows.shift();
      }

      return { headers, rows: bodyRows };
    });

    process.stdout.write('\x1Bc');
    spinner.succeed();

    if (!tableData.rows?.length) {
      console.error('No table rows found on the page. The site may have changed.');
      await browser.close();
      process.exit(1);
    }

    const headers = tableData.headers.map(h => h.toLowerCase());
    let magColumn = headers.findIndex(h => h.includes('mag'));
    let locColumn = headers.findIndex(h => h.includes('location') || h.includes('epicenter'));
    let dateColumn = headers.findIndex(h => h.includes('date') || h.includes('time'));

    if (magColumn === -1) {
      const sample = tableData.rows[0] || [];
      for (let i = 0; i < sample.length; i++) {
        const val = parseFloat(sample[i].replace(/[^\d.]/g, ''));
        if (!isNaN(val) && val >= 0 && val <= 10) magColumn = i;
      }
    }

    if (locColumn === -1) locColumn = headers.findIndex(h => h.includes('area') || h.includes('province'));
    if (locColumn === -1) locColumn = 0;

    if (dateColumn === -1) dateColumn = 0;

    if (magColumn === -1) {
      console.error('Could not detect magnitude column.');
      await browser.close();
      process.exit(1);
    }

    const prevSignatures = loadPreviousData();
    const currentSignatures = [];

    const newCounts = new Map(buckets.map(b => [b.name, 0]));
    const strongQuakes = [];

    for (const r of tableData.rows) {
      const magRaw = r[magColumn] || '';
      let mag = parseNumber(magRaw);
      if (isNaN(mag)) {
        const m = magRaw.match(/(\d+(\.\d+)?)/);
        mag = m ? Number(m[0]) : NaN;
      }

      const locationSegments = (r[5] || '').split(' of ');
      const location = locationSegments.length > 1 ? locationSegments[1].trim() : 'Unknown';
      const datetime = r[dateColumn] || '';
      const signature = r.join('|');
      const depth = String(Number(r[3])).padStart(3, ' ');
      currentSignatures.push(signature);

      if (!isNaN(mag)) {
        const bucket = bucketForMag(mag);
        if (bucket) {
          bucket.count++;
          if (!prevSignatures.includes(signature)) {
            newCounts.set(bucket.name, newCounts.get(bucket.name) + 1);
          }
        }

        if (mag >= 4) {
          strongQuakes.push({ mag, location, datetime, depth });
        }
      }
    }

    // Sort by time (descending, recent first)
    strongQuakes.sort((a, b) => {
      const dateA = new Date(a.datetime).getTime();
      const dateB = new Date(b.datetime).getTime();
      return isNaN(dateB - dateA) ? 0 : dateB - dateA;
    });

    // Right-aligned formatting
    const maxLabelLength = Math.max(...buckets.map(b => b.name.length));
    const maxCountLength = Math.max(...buckets.map(b => b.count.toString().length)) + 2;

    console.log('\n');
    for (const b of buckets) {
      const increase = newCounts.get(b.name);
      const color = b.color || '';
      const reset = '\x1b[0m';
      const arrow = increase > 0 ? ` ↑${increase}` : '';
      const line =
        `${b.name.padEnd(maxLabelLength)}:` +
        `${String(b.count).padStart(maxCountLength)} quakes${arrow}`;
      console.log(color + line + reset);
    }

    // Recent strong quakes section
    if (strongQuakes.length) {
      console.log('\n');

      // Separate quakes into categories
      const major = strongQuakes.filter(q => q.mag >= 5);  // Mg 5+

      // Combine them, ensuring all Mg 5+ appear at the bottom (if not already in latest 10)
      const recent = strongQuakes.slice(0, 20); // top 20 recent quakes
      const additionalMajors = major.filter(q => !recent.includes(q));

      // Final list ensures Mg 5+ are shown
      const finalList = [...recent, ...additionalMajors]
        .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))
        .slice(0, 30); // limit output

      console.log('Recent strong quakes (Mg ≥4, always showing Mg ≥5):\n');
      finalList.forEach(q => {
        const bucket = bucketForMag(q.mag);
        const color = bucket?.color || '';
        const reset = '\x1b[0m';
        console.log(
          `${color}${q.datetime.padEnd(20)}  [ Mg ${q.mag.toFixed(1)} | Depth ${q.depth}km ]  -  ${q.location}${reset}`
        );
      });
    }

    console.log('\n');

    saveCurrentData(currentSignatures);
    await browser.close();
  } catch (err) {
    console.error('Error:', err);
    await browser.close();
    process.exit(1);
  }
})();

