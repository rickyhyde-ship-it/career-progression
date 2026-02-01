// scripts/checkProgressions.js
import axios from 'axios';
import { readFile } from 'fs/promises';

// ==========================================
// CONFIGURATION - EDIT THESE VALUES
// ==========================================
const THRESHOLD = 5;  // ← Changed from 3 to 5
const DELAY_MS = 250; // ← Changed from 100 to 250ms
const COOLDOWN_403_MS = 300000; // 5 minutes cooldown on 403
const ROTATE_HEADERS_EVERY = 25; // Rotate headers every 25 requests
// ==========================================

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const CLUB_IDS = JSON.parse(await readFile('clubIds.json', 'utf8'));

// Allow command-line override
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

    for (const [playerId, stats] of Object.entries(data)) {
      if (stats.overall && stats.overall >= threshold) {
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

  const message = players.length === 1
    ? `🔥 **High Progression Alert!**\n\nPlayer ${players[0].playerId} gained **+${players[0].overall} overall**\n${players[0].url}`
    : `🔥 **${players.length} High Progression Players Found!**\n\n` +
      players.slice(0, 20).map(p => 
        `• **Player ${p.playerId}**: +${p.overall} overall → ${p.url}`
      ).join('\n') +
      (players.length > 20 ? `\n\n...and ${players.length - 20} more` : '');

  await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: message })
  });
  
  console.log('\n✅ Discord alert sent!');
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
  console.log('\n📋 Results:');
  highProgressionPlayers.forEach(p => {
    console.log(`   ${p.url} (+${p.overall} overall)`);
  });
  
  await sendDiscordAlert(highProgressionPlayers);
} else {
  console.log('\nℹ️  No high-progression players found today.');
}
