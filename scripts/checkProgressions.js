// scripts/checkProgressions.js
import axios from 'axios';
import { readFile } from 'fs/promises';

// ==========================================
// CONFIGURATION - EDIT THESE VALUES
// ==========================================
const THRESHOLD = 3;  // ← Change this number to set minimum overall progression
const DELAY_MS = 100; // Delay between API calls (ms)
// ==========================================

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const CLUB_IDS = JSON.parse(await readFile('clubIds.json', 'utf8'));

// Allow command-line override: node checkProgressions.js 5
const threshold = process.argv[2] ? parseInt(process.argv[2]) : THRESHOLD;

console.log(`🔍 Searching ${CLUB_IDS.length} clubs for players with +${threshold} or higher overall progression...\n`);

const highProgressionPlayers = [];
let clubsChecked = 0;
let clubsFailed = 0;

async function checkClubProgressions(clubId) {
  const url = `https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/players/progressions`;
  
  try {
    const { data } = await axios.get(url, {
      params: {
        clubId: clubId,
        interval: 'CURRENT_SEASON'
      }
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
    console.error(`❌ Club ${clubId} failed: ${err.message}`);
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
    console.log(`📊 Progress: ${clubsChecked}/${CLUB_IDS.length} clubs checked...`);
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
