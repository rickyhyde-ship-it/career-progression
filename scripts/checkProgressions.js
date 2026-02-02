// scripts/checkProgressions.js
import axios from 'axios';
import { readFile } from 'fs/promises';

// ==========================================
// CONFIGURATION - EDIT THESE VALUES
// ==========================================
const THRESHOLD = 5;  // Only alert on +5 or higher
const DELAY_MS = 100; // 100ms delay between requests
const COOLDOWN_403_MS = 300000; // 5 minutes cooldown on 403
const ROTATE_HEADERS_EVERY = 25; // Rotate headers every 25 requests
// ==========================================

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const CLUB_IDS = JSON.parse(await readFile('clubIds.json', 'utf8'));

const threshold = process.argv[2] ? parseInt(process.argv[2]) : THRESHOLD;

console.log(`🔍 Searching ${CLUB_IDS.length} clubs for players with +${threshold} or higher overall progression...\n`);

// Multiple browser header sets to rotate
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

const highProgressionPlayers = [];
let clubsChecked = 0;
let clubsFailed = 0;
let requestCount = 0;

function getCurrentHeaders() {
  const index = Math.floor(requestCount / ROTATE_HEADERS_EVERY) % HEADER_SETS.length;
  return HEADER_SETS[index];
}

async function checkClubProgressions(clubId) {
  const url = `https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/players/progressions`;
  
  try {
    requestCount++;
    const headers = getCurrentHeaders();
    
    const { data } = await axios.get(url, {
      params: {
        clubId: clubId,
        interval: 'CURRENT_SEASON'
      },
      headers: headers
    });

    // Check if data exists and is an object
    if (!data || typeof data !== 'object') {
      clubsChecked++;
      return;
    }

    for (const [playerId, stats] of Object.entries(data)) {
      // Check if stats and stats.overall exist before comparing
      if (stats && stats.overall && stats.overall >= threshold) {
        highProgressionPlayers.push({
          playerId: playerId,
          overall: stats.overall,
          clubId: clubId,
          url: `https://app.playmfl.com/players/${playerId}`,
          allStats: stats
        });
        console.log(`🔥 Player ${playerId}: +${stats.overall} overall (Club ${clubId})`);
      }
    }
    
    clubsChecked++;
  } catch (err) {
    clubsFailed++;
    
    // Special handling for 403 errors
    if (err.response?.status === 403) {
      console.error(`❌ Club ${clubId} failed: Request failed with status code 403`);
      console.log(`⏸️  RATE LIMITED! Cooling down for 5 minutes...`);
      await new Promise(r => setTimeout(r, COOLDOWN_403_MS));
      console.log(`✅ Cooldown complete, resuming...`);
    } else {
      console.error(`❌ Club ${clubId} failed: ${err.message}`);
    }
  }
}

async function sendDiscordAlert(players) {
  if (!DISCORD_WEBHOOK) {
    console.log('\n⚠️  No Discord webhook configured. Skipping alert.');
    return;
  }

  // Sort by progression (lowest first: 5, 6, 7, 8...)
  const sorted = [...players].sort((a, b) => a.overall - b.overall);
  
  // Group by progression level
  const grouped = {};
  sorted.forEach(p => {
    if (!grouped[p.overall]) grouped[p.overall] = [];
    grouped[p.overall].push(p);
  });
  
  const progressionLevels = Object.keys(grouped).sort((a, b) => a - b);
  
  // Send summary first
  const summary = `🔥 **${players.length} High Progression Players Found!**\n\n` +
    progressionLevels.map(level => `• **+${level} Overall**: ${grouped[level].length} player${grouped[level].length > 1 ? 's' : ''}`).join('\n');
  
  await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: summary })
  });
  
  // Wait 1 second to avoid rate limiting
  await new Promise(r => setTimeout(r, 1000));
  
  // Send separate message for each progression level
  for (const level of progressionLevels) {
    const playersAtLevel = grouped[level];
    
    let message = `**+${level} Overall (${playersAtLevel.length} player${playersAtLevel.length > 1 ? 's' : ''}):**\n\n`;
    
    for (const p of playersAtLevel) {
      // Wrap URL in <> to prevent Discord embeds
      message += `• Player ${p.playerId} → <${p.url}>\n`;
    }
    
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
    });
    
    // Wait 1 second between messages to avoid Discord rate limiting
    await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log(`\n✅ Discord alerts sent! (${progressionLevels.length + 1} messages)`);
}

// Main execution
const startTime = Date.now();

for (const clubId of CLUB_IDS) {
  await checkClubProgressions(clubId);
  await new Promise(r => setTimeout(r, DELAY_MS));
  
  // Progress indicator every 100 clubs
  if (clubsChecked % 100 === 0) {
    console.log(`📊 Progress: ${clubsChecked}/${CLUB_IDS.length} clubs checked (using header set ${Math.floor(requestCount / ROTATE_HEADERS_EVERY) % HEADER_SETS.length + 1}/${HEADER_SETS.length})...`);
  }
}

const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

console.log('\n' + '='.repeat(50));
console.log(`✅ Scan complete in ${duration} minutes`);
console.log(`📊 Clubs checked: ${clubsChecked}`);
console.log(`❌ Clubs failed: ${clubsFailed}`);
console.log(`🔥 High progression players: ${highProgressionPlayers.length}`);
console.log('='.repeat(50));

if (highProgressionPlayers.length > 0) {
  // Sort before displaying
  highProgressionPlayers.sort((a, b) => a.overall - b.overall);
  
  console.log('\n📋 Results (sorted by progression):');
  highProgressionPlayers.forEach(p => {
    console.log(`   +${p.overall} → ${p.url}`);
  });
  
  await sendDiscordAlert(highProgressionPlayers);
} else {
  console.log('\nℹ️  No high-progression players found today.');
}
