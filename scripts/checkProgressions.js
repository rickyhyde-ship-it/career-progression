// scripts/checkProgressions.js
import axios from 'axios';
import { readFile, writeFile, access, unlink } from 'fs/promises';
import { execSync } from 'child_process';

// ==========================================
// CONFIGURATION
// ==========================================
const DELAY_MS = 100;
const COOLDOWN_403_MS_BASE = 60000;
const COOLDOWN_403_MAX = 300000;
const CONCURRENCY = 3;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 50;
const GH_PAGES_DIR = './gh-pages';
const CHECKPOINT_FILE = `${GH_PAGES_DIR}/.progression-checkpoint.json`;
const PROGRESS_EVERY = 200;
// ==========================================

const LEADERBOARD_URLS = [
  { division: 1, url: 'https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/leaderboards/clubs/global?division=1&sort=nbMflPoints&sortOrder=DESC&limit=20000' },
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
const allPlayers = [];
const seenPlayerIds = new Set();
let clubsChecked = 0;
let clubsFailed = 0;
let playerDetailsFailed = 0;
let lastProgressPush = 0;

let rateLimitedUntil = 0;
let consecutive403s = 0;
let currentCooldownMs = COOLDOWN_403_MS_BASE;

// Global rate limiter — serialises DELAY_MS across all workers
let rateLimitChain = Promise.resolve();
function globalRateLimit() {
  rateLimitChain = rateLimitChain.then(() => sleep(DELAY_MS));
  return rateLimitChain;
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

async function waitIfRateLimited() {
  const now = Date.now();
  if (rateLimitedUntil > now) {
    const wait = rateLimitedUntil - now;
    console.log(`⏸️  Waiting ${(wait / 1000).toFixed(0)}s for shared cooldown...`);
    await sleep(wait);
    // Jitter so workers don't all resume and burst simultaneously
    await sleep(Math.random() * 3000);
    console.log(`▶️  Resuming...`);
  }
}

function triggerRateLimit() {
  consecutive403s++;
  successSinceLastError = 0;
  if (consecutive403s > 1) {
    currentCooldownMs = Math.min(currentCooldownMs * 2, COOLDOWN_403_MAX);
    console.log(`📈 Consecutive 403s: ${consecutive403s} — cooldown now ${currentCooldownMs / 1000}s`);
  }
  const newUntil = Date.now() + currentCooldownMs;
  if (newUntil > rateLimitedUntil) {
    rateLimitedUntil = newUntil;
    console.log(`🚫 Rate limit triggered — all workers pausing for ${currentCooldownMs / 1000}s`);
  }
}

let successSinceLastError = 0;
function clearRateLimit() {
  successSinceLastError++;
  // Only reset cooldown after 50 clean requests in a row
  if (successSinceLastError >= 50) {
    consecutive403s = 0;
    currentCooldownMs = COOLDOWN_403_MS_BASE;
    successSinceLastError = 0;
  }
}

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
  try { await unlink(CHECKPOINT_FILE); } catch { /* ignore if not found */ }
}

// ==========================================
// GH-PAGES OUTPUT
// ==========================================

function gitPushGhPages(message) {
  try {
    execSync(`git -C ${GH_PAGES_DIR} add -A`, { stdio: 'pipe' });
  } catch (err) {
    console.warn(`⚠️  git add failed: ${err.stderr?.toString() ?? err.message}`);
    return;
  }
  try {
    execSync(`git -C ${GH_PAGES_DIR} commit -m "${message}"`, { stdio: 'pipe' });
  } catch (err) {
    const out = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
    if (out.includes('nothing to commit')) return;
    console.warn(`⚠️  git commit failed: ${out || err.message}`);
    return;
  }
  try {
    execSync(`git -C ${GH_PAGES_DIR} push origin gh-pages`, { stdio: 'pipe' });
  } catch (err) {
    console.warn(`⚠️  git push failed: ${err.stderr?.toString() ?? err.message}`);
  }
}

async function pushProgress(scanned, total) {
  const elapsed = (Date.now() - startTime) / 1000;
  const rate = scanned / elapsed;
  const remaining = total - scanned;
  const etaSeconds = rate > 0 ? Math.round(remaining / rate) : 0;

  const progress = { scanned, total, etaSeconds, running: true };
  await writeFile(`${GH_PAGES_DIR}/progress.json`, JSON.stringify(progress), 'utf8');
  gitPushGhPages(`chore: progress ${scanned}/${total}`);
  console.log(`📊 Progress pushed: ${scanned}/${total} players (ETA ${etaSeconds}s)`);
}

async function pushData(players) {
  const data = { updatedAt: new Date().toISOString(), players };
  await writeFile(`${GH_PAGES_DIR}/data.json`, JSON.stringify(data), 'utf8');
  try { execSync(`rm -f ${GH_PAGES_DIR}/progress.json`); } catch { /* ignore */ }
  gitPushGhPages('chore: update player data');
  console.log(`✅ data.json pushed — ${players.length} players`);
}

// ==========================================
// API CALLS
// ==========================================

async function fetchWithRateLimitHandling(url, label) {
  const MAX_403_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_403_RETRIES; attempt++) {
    await waitIfRateLimited();
    await globalRateLimit();

    try {
      const { data } = await axios.get(url, { headers: getRandomHeaders(), timeout: 30000 });
      clearRateLimit();
      return data;
    } catch (err) {
      if (err.response?.status === 403) {
        console.warn(`⚠️  403 on ${label} (attempt ${attempt}/${MAX_403_RETRIES})`);
        triggerRateLimit();
        if (attempt === MAX_403_RETRIES) {
          console.error(`❌ ${label} gave up after ${MAX_403_RETRIES} 403s`);
          return null;
        }
      } else {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        if (attempt === MAX_403_RETRIES) {
          console.error(`⚠️  ${label} failed after ${MAX_403_RETRIES} attempts: ${err.message}`);
          return null;
        }
        console.warn(`⚠️  ${label} attempt ${attempt} failed (${err.message}), retrying in ${backoff}ms...`);
        await sleep(backoff);
      }
    }
  }
  return null;
}

async function fetchPlayerDetails(playerId) {
  return fetchWithRateLimitHandling(
    `https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/players/${playerId}`,
    `player details ${playerId}`
  );
}

async function fetchPlayerHistory(playerId) {
  return fetchWithRateLimitHandling(
    `https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/players/${playerId}/experiences/history`,
    `player history ${playerId}`
  );
}


async function fetchClubIds() {
  console.log('📡 Fetching club IDs from leaderboard endpoints...');
  const clubMap = new Map(); // clubId -> division

  for (const { division, url } of LEADERBOARD_URLS) {
    try {
      const { data } = await axios.get(url, { headers: getRandomHeaders(), timeout: 30000 });
      const clubs = data?.clubs ?? [];
      clubs.forEach(c => clubMap.set(c.id, division));
      console.log(`   ✅ D${division}: ${clubs.length} clubs`);
    } catch (err) {
      console.error(`   ❌ Failed to fetch D${division} leaderboard: ${err.message}`);
    }
  }

  if (clubMap.size === 0) throw new Error('No club IDs retrieved — all leaderboard endpoints failed.');
  console.log(`📋 Total unique clubs: ${clubMap.size}\n`);
  return clubMap;
}

let metaDebugLogged = false;

// ==========================================
// CLUB SCANNING
// ==========================================

async function processClub(clubId, division, totalClubs) {
  const progressionsUrl = `https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/players/progressions?clubId=${clubId}&interval=CURRENT_SEASON`;
  const data = await fetchWithRateLimitHandling(progressionsUrl, `club ${clubId}`);

  if (!data) {
    clubsFailed++;
    clubsChecked++;
    console.log(`❌ Club ${clubId} (D${division}) failed — ${clubsChecked}/${totalClubs} clubs`);
    return;
  }

  if (typeof data !== 'object') { clubsChecked++; return; }

  let statsDebugLogged = false;
  for (const [playerId, stats] of Object.entries(data)) {
    if (seenPlayerIds.has(playerId)) continue;
    seenPlayerIds.add(playerId);

    if (!statsDebugLogged) {
      statsDebugLogged = true;
      console.log(`🔍 Progressions stats sample for player ${playerId}:`, JSON.stringify(stats, null, 2));
    }

    const [playerDetails, playerHistory] = await Promise.all([
      fetchPlayerDetails(playerId),
      fetchPlayerHistory(playerId),
    ]);

    if (!playerDetails) {
      playerDetailsFailed++;
      continue;
    }

    const metadata = playerDetails.player?.metadata ?? {};
    if (!metaDebugLogged) {
      metaDebugLogged = true;
      console.log('🔍 Player details sample:', JSON.stringify(playerDetails.player ?? playerDetails, null, 2).slice(0, 1000));
      console.log('🔍 Metadata keys:', Object.keys(metadata));
    }
    const currentOvr = metadata.overall ?? 0;
    const seasonGain = stats?.overall ?? stats?.nbOverallPoints ?? null;

    // Derive career start OVR and total growth from history
    const historyRecords = Array.isArray(playerHistory) ? playerHistory : [];
    const ovrValues = historyRecords.map(r => r.values?.overall).filter(v => v != null);
    const startOvr = ovrValues.length > 0 ? Math.min(...ovrValues) : currentOvr;
    const careerGrowth = currentOvr - startOvr;
    const mintAge = historyRecords.length > 0
      ? Math.min(...historyRecords.map(r => r.values?.age).filter(v => v != null))
      : null;

    allPlayers.push({
      playerId,
      name: metadata.name ?? metadata.fullName ?? metadata.firstName ?? metadata.lastName ?? `Player ${playerId}`,
      position: metadata.positions?.[0] ?? 'N/A',
      age: metadata.age ?? 'N/A',
      mintAge,
      division,
      startOvr,
      currentOvr,
      careerGrowth,
      seasonGain,
    });

    const newTotal = allPlayers.length;
    if (newTotal - lastProgressPush >= PROGRESS_EVERY) {
      lastProgressPush = newTotal;
      await pushProgress(newTotal, seenPlayerIds.size + (totalClubs - clubsChecked) * 5);
    }
  }

  clubsChecked++;
  console.log(`✅ Club ${clubId} (D${division}): ${Object.keys(data).length} players — ${clubsChecked}/${totalClubs} clubs, ${allPlayers.length} total players`);
}

// ==========================================
// MAIN
// ==========================================

let clubMap;
try {
  clubMap = await fetchClubIds();
} catch (err) {
  console.error(`💥 Fatal: ${err.message}`);
  process.exit(1);
}

const checkpoint = await loadCheckpoint();
const completedSet = new Set(checkpoint?.completedIds ?? []);
if (checkpoint?.players?.length) {
  checkpoint.players.forEach(p => {
    allPlayers.push(p);
    seenPlayerIds.add(p.playerId);
  });
  clubsChecked = completedSet.size;
}

const pendingClubs = [...clubMap.keys()].filter(id => !completedSet.has(id));
console.log(`🔍 ${pendingClubs.length} clubs remaining\n`);

await pushProgress(allPlayers.length, clubMap.size * 5);

const semaphore = createSemaphore(CONCURRENCY);

await Promise.all(pendingClubs.map(async (clubId) => {
  await semaphore.acquire();
  try {
    await processClub(clubId, clubMap.get(clubId), clubMap.size);
    completedSet.add(clubId);

    if (completedSet.size % 25 === 0) {
      await saveCheckpoint([...completedSet], allPlayers);
      console.log(`📊 ${clubsChecked}/${clubMap.size} clubs, ${allPlayers.length} unique players...`);
    }
  } finally {
    semaphore.release();
  }
}));

const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
console.log(`\n✅ Scan complete in ${duration} minutes`);
console.log(`📊 Clubs: ${clubsChecked} checked, ${clubsFailed} failed`);
console.log(`👥 Unique players: ${allPlayers.length}`);
console.log(`⚠️  Player detail failures: ${playerDetailsFailed}`);

allPlayers.sort((a, b) => (b.careerGrowth ?? 0) - (a.careerGrowth ?? 0));

await pushData(allPlayers);
await clearCheckpoint();
