// scripts/checkProgressions.js
import axios from 'axios';
import { google } from 'googleapis';
import { readFile, writeFile, access } from 'fs/promises';

// ==========================================
// CONFIGURATION
// ==========================================
const THRESHOLD = 2;
const DELAY_MS = 50;
const COOLDOWN_403_MS = 60000;
const CONCURRENCY = 8;          // simultaneous club requests
const MAX_RETRIES = 3;           // retries on transient errors
const RETRY_BASE_MS = 500;       // base delay for exponential backoff
const PROACTIVE_PAUSE_EVERY = 150; // requests between proactive pauses
const PROACTIVE_PAUSE_MS = 30000;
const CHECKPOINT_FILE = '.progression-checkpoint.json';
// ==========================================

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const GOOGLE_SHEETS_CREDS = process.env.GOOGLE_SHEETS_CREDENTIALS;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

const threshold = process.argv[2] ? parseInt(process.argv[2]) : THRESHOLD;

const LEADERBOARD_URLS = [
  'https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/leaderboards/clubs/global?division=10&sort=nbMflPoints&sortOrder=DESC&limit=20000',
  'https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/leaderboards/clubs/global?division=9&sort=nbMflPoints&sortOrder=DESC&limit=20000',
  'https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/leaderboards/clubs/global?division=8&sort=nbMflPoints&sortOrder=DESC&limit=20000',
];

const HEADER_SETS = [
  {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://app.playmfl.com/',
    'Origin': 'https://app.playmfl.com'
  },
  {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-GB,en;q=0.9',
    'Referer': 'https://app.playmfl.com/',
    'Origin': 'https://app.playmfl.com'
  },
  {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.8',
    'Referer': 'https://app.playmfl.com/',
    'Origin': 'https://app.playmfl.com'
  },
  {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://app.playmfl.com/',
    'Origin': 'https://app.playmfl.com'
  },
  {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-GB,en;q=0.9',
    'Referer': 'https://app.playmfl.com/',
    'Origin': 'https://app.playmfl.com'
  }
];

// ==========================================
// STATE
// ==========================================
const startTime = Date.now();
const highProgressionPlayers = [];
let clubsChecked = 0;
let clubsFailed = 0;
let requestCount = 0;
let playerDetailsFailed = 0;

// Shared rate-limit gate — when one worker hits 403, all workers wait
let rateLimitedUntil = 0;

async function waitIfRateLimited() {
  const now = Date.now();
  if (rateLimitedUntil > now) {
    const wait = rateLimitedUntil - now;
    console.log(`⏸️  Waiting ${(wait / 1000).toFixed(0)}s for shared cooldown...`);
    await sleep(wait);
  }
}

function triggerRateLimit() {
  const newUntil = Date.now() + COOLDOWN_403_MS;
  if (newUntil > rateLimitedUntil) {
    rateLimitedUntil = newUntil;
    console.log(`🚫 Rate limit triggered — all workers pausing for ${COOLDOWN_403_MS / 1000}s`);
  }
}

// ==========================================
// HELPERS
// ==========================================

function getRandomHeaders() {
  return HEADER_SETS[Math.floor(Math.random() * HEADER_SETS.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function withRetry(fn, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;

      // 403 — propagate immediately so caller can handle cooldown
      if (status === 403) throw err;

      if (attempt === MAX_RETRIES) {
        console.error(`⚠️  ${label} failed after ${MAX_RETRIES} attempts: ${err.message}`);
        return null;
      }

      const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`⚠️  ${label} attempt ${attempt} failed (${err.message}), retrying in ${backoff}ms...`);
      await sleep(backoff);
    }
  }
}

// Semaphore for concurrency control
function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  return {
    async acquire() {
      if (active < limit) { active++; return; }
      await new Promise(resolve => queue.push(resolve));
      active++;
    },
    release() {
      active--;
      if (queue.length > 0) queue.shift()();
    }
  };
}

// ==========================================
// CHECKPOINT
// ==========================================

async function loadCheckpoint() {
  try {
    await access(CHECKPOINT_FILE);
    const raw = await readFile(CHECKPOINT_FILE, 'utf8');
    const cp = JSON.parse(raw);
    console.log(`♻️  Resuming from checkpoint: ${cp.completedIds.length} clubs already processed, ${cp.players.length} players found so far.`);
    return cp;
  } catch {
    return null;
  }
}

async function saveCheckpoint(completedIds, players) {
  await writeFile(CHECKPOINT_FILE, JSON.stringify({ completedIds, players }), 'utf8');
}

async function clearCheckpoint() {
  try { await writeFile(CHECKPOINT_FILE, '{}', 'utf8'); } catch { /* ignore */ }
}

// ==========================================
// CLUB ID FETCHING
// ==========================================

async function fetchClubIds() {
  console.log('📡 Fetching club IDs from leaderboard endpoints...');
  const allIds = new Set();

  for (const url of LEADERBOARD_URLS) {
    try {
      const { data } = await axios.get(url, { headers: getRandomHeaders() });
      const clubs = data?.clubs ?? [];
      clubs.forEach(c => allIds.add(c.id));
      console.log(`   ✅ Division endpoint returned ${clubs.length} clubs`);
    } catch (err) {
      console.error(`   ❌ Failed to fetch leaderboard: ${url}\n      ${err.message}`);
    }
  }

  const ids = [...allIds];
  if (ids.length === 0) throw new Error('No club IDs retrieved — all leaderboard endpoints failed.');
  console.log(`📋 Total unique clubs: ${ids.length}\n`);
  return ids;
}

// ==========================================
// API CALLS
// ==========================================

async function fetchPlayerDetails(playerId) {
  await waitIfRateLimited();
  requestCount++;
  return withRetry(async () => {
    const { data } = await axios.get(
      `https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/players/${playerId}`,
      { headers: getRandomHeaders() }
    );
    await sleep(DELAY_MS);
    return data;
  }, `player details ${playerId}`);
}

async function fetchPlayerHistory(playerId) {
  await waitIfRateLimited();
  requestCount++;
  return withRetry(async () => {
    const { data } = await axios.get(
      `https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/players/${playerId}/experiences/history`,
      { headers: getRandomHeaders() }
    );
    await sleep(DELAY_MS);
    return data;
  }, `player history ${playerId}`);
}

async function checkClubProgressions(clubId) {
  const url = `https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/players/progressions`;
  let data;

  await waitIfRateLimited();

  try {
    requestCount++;

    // Proactive pause check
    if (requestCount % PROACTIVE_PAUSE_EVERY === 0 && requestCount > 0) {
      console.log(`⏸️  Proactive pause at ${requestCount} requests (${clubsChecked} clubs checked)...`);
      await sleep(PROACTIVE_PAUSE_MS);
      console.log(`▶️  Resuming...`);
    }

    const response = await axios.get(url, {
      params: { clubId, interval: 'CURRENT_SEASON' },
      headers: getRandomHeaders()
    });
    data = response.data;
  } catch (err) {
    if (err.response?.status === 403) {
      clubsFailed++;
      console.error(`❌ Club ${clubId}: 403 after ${requestCount} total requests (${clubsChecked} clubs checked)`);
      console.error(`⏱️  Time elapsed: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`);
      triggerRateLimit();
      await waitIfRateLimited();

      // Retry once after cooldown
      try {
        requestCount++;
        const retry = await axios.get(url, {
          params: { clubId, interval: 'CURRENT_SEASON' },
          headers: getRandomHeaders()
        });
        data = retry.data;
        clubsFailed--;
        console.log(`✅ Club ${clubId} recovered after cooldown`);
      } catch (retryErr) {
        console.error(`❌ Club ${clubId} failed again after cooldown: ${retryErr.message}`);
        return;
      }
    } else {
      clubsFailed++;
      console.error(`❌ Club ${clubId} failed: ${err.message}`);
      return;
    }
  }

  if (!data || typeof data !== 'object') { clubsChecked++; return; }

  const qualifyingPlayers = Object.entries(data).filter(
    ([, stats]) => stats?.overall >= threshold
  );

  for (const [playerId, stats] of qualifyingPlayers) {
    console.log(`🔥 Player ${playerId}: +${stats.overall} overall (Club ${clubId}) - fetching details...`);

    // Fetch both in parallel
    const [playerDetails, playerHistory] = await Promise.all([
      fetchPlayerDetails(playerId),
      fetchPlayerHistory(playerId)
    ]);

    if (!playerDetails) {
      playerDetailsFailed++;
      console.log(`   ⚠️  Skipping ${playerId} - failed to fetch details`);
      continue;
    }

    const metadata = playerDetails.player?.metadata ?? {};
    const listing = playerDetails.listing ?? {};
    const owner = playerDetails.player?.ownedBy ?? {};

    let startingAge = null, startingOverall = null, seasonsInGame = null, careerProgression = null;
    if (Array.isArray(playerHistory) && playerHistory.length > 0) {
      const firstRecord = playerHistory[0];
      startingAge = firstRecord.values?.age ?? null;
      startingOverall = firstRecord.values?.overall ?? null;
      if (startingAge && metadata.age) seasonsInGame = metadata.age - startingAge;
      if (startingOverall && metadata.overall) careerProgression = metadata.overall - startingOverall;
    }

    highProgressionPlayers.push({
      playerId,
      seasonProgression: stats.overall,
      currentOverall: metadata.overall ?? 'N/A',
      age: metadata.age ?? 'N/A',
      seasonsInGame: seasonsInGame ?? 'N/A',
      careerProgression: careerProgression ?? 'N/A',
      positions: metadata.positions ? metadata.positions.join(', ') : 'N/A',
      pace: metadata.pace ?? 'N/A',
      shooting: metadata.shooting ?? 'N/A',
      passing: metadata.passing ?? 'N/A',
      dribbling: metadata.dribbling ?? 'N/A',
      defense: metadata.defense ?? 'N/A',
      physical: metadata.physical ?? 'N/A',
      goalkeeping: metadata.goalkeeping ?? 'N/A',
      owner: owner.name ?? 'N/A',
      price: listing.price ?? 'Not Listed',
      clubId,
      url: `https://app.playmfl.com/players/${playerId}`
    });
  }

  clubsChecked++;
}

// ==========================================
// GOOGLE SHEETS
// ==========================================

async function updateGoogleSheet(players) {
  if (!GOOGLE_SHEETS_CREDS || !GOOGLE_SHEET_ID) {
    console.log('\n⚠️  Google Sheets not configured. Skipping sheet update.');
    return { added: 0, updated: 0 };
  }
  try {
    const credentials = JSON.parse(GOOGLE_SHEETS_CREDS);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const today = new Date().toISOString().split('T')[0];

    // Fetch existing player IDs only (column B)
    const existingData = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'B2:B'
    });
    const existingIds = (existingData.data.values ?? []).flat();
    const playerIndex = {};
    existingIds.forEach((id, i) => { if (id) playerIndex[id] = i + 2; });

    let addedCount = 0, updatedCount = 0;
    const updates = [];
    const newRows = [];

    for (const player of players) {
      const rowData = [
        today, player.playerId, player.seasonProgression, player.currentOverall, player.age,
        player.seasonsInGame, player.careerProgression, player.positions, player.pace,
        player.shooting, player.passing, player.dribbling, player.defense, player.physical,
        player.goalkeeping, player.owner, player.price, player.clubId, player.url
      ];
      if (playerIndex[player.playerId]) {
        updates.push({ range: `A${playerIndex[player.playerId]}:S${playerIndex[player.playerId]}`, values: [rowData] });
        updatedCount++;
      } else {
        newRows.push(rowData);
        addedCount++;
      }
    }

    // Batch all writes into a single batchUpdate call where possible
    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: GOOGLE_SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: updates }
      });
    }
    if (newRows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: 'A:S',
        valueInputOption: 'RAW',
        requestBody: { values: newRows }
      });
    }

    console.log(`\n✅ Google Sheet updated: ${addedCount} added, ${updatedCount} updated`);
    return { added: addedCount, updated: updatedCount };
  } catch (err) {
    console.error(`\n❌ Failed to update Google Sheet: ${err.message}`);
    return { added: 0, updated: 0 };
  }
}

// ==========================================
// DISCORD
// ==========================================

async function sendDiscord(content) {
  if (!DISCORD_WEBHOOK) return;
  const MAX = 1990;
  const chunks = [];
  let current = '';
  for (const line of content.split('\n')) {
    if ((current + '\n' + line).length > MAX) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: chunk })
    });
  }
}

async function sendDiscordSummary(players, sheetStats, duration) {
  if (!DISCORD_WEBHOOK) { console.log('\n⚠️  No Discord webhook configured. Skipping alert.'); return; }

  const grouped = {};
  players.forEach(p => {
    grouped[p.seasonProgression] = (grouped[p.seasonProgression] ?? 0) + 1;
  });

  const breakdown = Object.keys(grouped)
    .sort((a, b) => b - a)
    .map(level => `• +${level} Overall: ${grouped[level]} player${grouped[level] > 1 ? 's' : ''}`)
    .join('\n');

  const summary = [
    `✅ **Progression Check Complete!**`,
    ``,
    `⏱️ Duration: ${duration} minutes`,
    `🔥 Found: ${players.length} high-progression players`,
    `📊 Google Sheet: ${sheetStats.added} new, ${sheetStats.updated} updated`,
    ``,
    `**Breakdown:**`,
    breakdown,
    ``,
    `📋 View full details: [Open Google Sheet](https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID})`
  ].join('\n');

  await sendDiscord(summary);
  console.log('\n✅ Discord summary sent!');
}

// ==========================================
// MAIN
// ==========================================

// Load club IDs from live API
let CLUB_IDS;
try {
  CLUB_IDS = await fetchClubIds();
} catch (err) {
  console.error(`💥 Fatal: ${err.message}`);
  process.exit(1);
}

console.log(`🔍 Searching ${CLUB_IDS.length} clubs for players with +${threshold} or higher overall progression...\n`);

// Load checkpoint if available
const checkpoint = await loadCheckpoint();
const completedSet = new Set(checkpoint?.completedIds ?? []);
if (checkpoint?.players?.length) {
  highProgressionPlayers.push(...checkpoint.players);
  clubsChecked = completedSet.size;
}

const pendingClubs = CLUB_IDS.filter(id => !completedSet.has(id));
console.log(`📋 ${pendingClubs.length} clubs remaining to check\n`);

const semaphore = createSemaphore(CONCURRENCY);

// Process clubs concurrently with semaphore control
await Promise.all(pendingClubs.map(async (clubId) => {
  await semaphore.acquire();
  try {
    await checkClubProgressions(clubId);
    completedSet.add(clubId);

    // Save checkpoint every 100 clubs
    if (completedSet.size % 100 === 0) {
      await saveCheckpoint([...completedSet], highProgressionPlayers);
      console.log(`📊 Progress: ${clubsChecked}/${CLUB_IDS.length} clubs checked (${highProgressionPlayers.length} players found)...`);
    }
  } finally {
    semaphore.release();
  }
}));

const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
console.log('\n' + '='.repeat(50));
console.log(`✅ Scan complete in ${duration} minutes`);
console.log(`📊 Clubs checked: ${clubsChecked}`);
console.log(`❌ Clubs failed: ${clubsFailed}`);
console.log(`⚠️  Player details failed: ${playerDetailsFailed}`);
console.log(`🔥 High progression players: ${highProgressionPlayers.length}`);
console.log('='.repeat(50));

if (highProgressionPlayers.length > 0) {
  highProgressionPlayers.sort((a, b) => b.seasonProgression - a.seasonProgression);
  console.log('\n📋 Updating Google Sheets...');
  const sheetStats = await updateGoogleSheet(highProgressionPlayers);
  console.log('\n📋 Sending Discord summary...');
  await sendDiscordSummary(highProgressionPlayers, sheetStats, duration);
} else {
  console.log('\nℹ️  No high-progression players found today.');
  await sendDiscord(`ℹ️ **Progression Check Complete**\n\nNo players with +${threshold} or higher progression found.`);
}

await clearCheckpoint();
