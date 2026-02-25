// scripts/checkProgressions.js
import axios from 'axios';
import { readFile } from 'fs/promises';
import { google } from 'googleapis';

// ==========================================
// CONFIGURATION - EDIT THESE VALUES
// ==========================================
const THRESHOLD = 1;
const DELAY_MS = 100;
const COOLDOWN_403_MS = 300000;
const ROTATE_HEADERS_EVERY = 25;
// ==========================================

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const GOOGLE_SHEETS_CREDS = process.env.GOOGLE_SHEETS_CREDENTIALS;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CLUB_IDS = JSON.parse(await readFile('clubIds.json', 'utf8'));

const threshold = process.argv[2] ? parseInt(process.argv[2]) : THRESHOLD;

console.log(`🔍 Searching ${CLUB_IDS.length} clubs for players with +${threshold} or higher overall progression...\n`);

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
let playerDetailsFailed = 0;

function getCurrentHeaders() {
  const index = Math.floor(requestCount / ROTATE_HEADERS_EVERY) % HEADER_SETS.length;
  return HEADER_SETS[index];
}

async function fetchPlayerDetails(playerId) {
  try {
    requestCount++;
    const headers = getCurrentHeaders();
    
    const { data } = await axios.get(
      `https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/players/${playerId}`,
      { headers }
    );
    
    await new Promise(r => setTimeout(r, DELAY_MS));
    return data;
  } catch (err) {
    playerDetailsFailed++;
    console.error(`⚠️  Failed to fetch details for player ${playerId}: ${err.message}`);
    return null;
  }
}

async function fetchPlayerHistory(playerId) {
  try {
    requestCount++;
    const headers = getCurrentHeaders();
    
    const { data } = await axios.get(
      `https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod/players/${playerId}/experiences/history`,
      { headers }
    );
    
    await new Promise(r => setTimeout(r, DELAY_MS));
    return data;
  } catch (err) {
    playerDetailsFailed++;
    console.error(`⚠️  Failed to fetch history for player ${playerId}: ${err.message}`);
    return null;
  }
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

    if (!data || typeof data !== 'object') {
      clubsChecked++;
      return;
    }

    for (const [playerId, stats] of Object.entries(data)) {
      if (stats && stats.overall && stats.overall >= threshold) {
        console.log(`🔥 Player ${playerId}: +${stats.overall} overall (Club ${clubId}) - fetching details...`);
        
        // Fetch detailed player data
        const playerDetails = await fetchPlayerDetails(playerId);
        const playerHistory = await fetchPlayerHistory(playerId);
        
        if (!playerDetails) {
          console.log(`   ⚠️  Skipping ${playerId} - failed to fetch details`);
          continue;
        }
        
        // Extract data from player details
        const metadata = playerDetails.player?.metadata || {};
        const listing = playerDetails.listing || {};
        const owner = playerDetails.player?.ownedBy || {};
        
        // Extract history data (first record)
        let startingAge = null;
        let startingOverall = null;
        let seasonsInGame = null;
        let careerProgression = null;
        
        if (playerHistory && Array.isArray(playerHistory) && playerHistory.length > 0) {
          const firstRecord = playerHistory[0];
          startingAge = firstRecord.values?.age || null;
          startingOverall = firstRecord.values?.overall || null;
          
          if (startingAge && metadata.age) {
            seasonsInGame = metadata.age - startingAge;
          }
          
          if (startingOverall && metadata.overall) {
            careerProgression = metadata.overall - startingOverall;
          }
        }
        
        highProgressionPlayers.push({
          playerId: playerId,
          seasonProgression: stats.overall,
          currentOverall: metadata.overall || 'N/A',
          age: metadata.age || 'N/A',
          seasonsInGame: seasonsInGame !== null ? seasonsInGame : 'N/A',
          careerProgression: careerProgression !== null ? careerProgression : 'N/A',
          positions: metadata.positions ? metadata.positions.join(', ') : 'N/A',
          pace: metadata.pace || 'N/A',
          shooting: metadata.shooting || 'N/A',
          passing: metadata.passing || 'N/A',
          dribbling: metadata.dribbling || 'N/A',
          defense: metadata.defense || 'N/A',
          physical: metadata.physical || 'N/A',
          goalkeeping: metadata.goalkeeping || 'N/A',
          owner: owner.name || 'N/A',
          price: listing.price || 'Not Listed',
          clubId: clubId,
          url: `https://app.playmfl.com/players/${playerId}`
        });
      }
    }
    
    clubsChecked++;
  } catch (err) {
    clubsFailed++;
    
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

async function updateGoogleSheet(players) {
  if (!GOOGLE_SHEETS_CREDS || !GOOGLE_SHEET_ID) {
    console.log('\n⚠️  Google Sheets not configured. Skipping sheet update.');
    return { added: 0, updated: 0 };
  }

  try {
    const credentials = JSON.parse(GOOGLE_SHEETS_CREDS);
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const today = new Date().toISOString().split('T')[0];

    // Read existing data (columns A-S only)
    const existingData = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'A2:S',
    });

    const rows = existingData.data.values || [];
    const playerIndex = {};
    
    rows.forEach((row, index) => {
      const playerId = row[1]; // Column B (Player ID)
      if (playerId) {
        playerIndex[playerId] = index + 2;
      }
    });

    let addedCount = 0;
    let updatedCount = 0;
    const updates = [];
    const newRows = [];

    for (const player of players) {
      const rowData = [
        today,                        // A: Date
        player.playerId,              // B: Player ID
        player.seasonProgression,     // C: Season Progression
        player.currentOverall,        // D: Current Overall
        player.age,                   // E: Age
        player.seasonsInGame,         // F: Seasons in Game
        player.careerProgression,     // G: Career Progression
        player.positions,             // H: Position
        player.pace,                  // I: Pace
        player.shooting,              // J: Shooting
        player.passing,               // K: Passing
        player.dribbling,             // L: Dribbling
        player.defense,               // M: Defense
        player.physical,              // N: Physical
        player.goalkeeping,           // O: Goalkeeping
        player.owner,                 // P: Owner
        player.price,                 // Q: Price
        player.clubId,                // R: Club ID
        player.url                    // S: URL
      ];

      if (playerIndex[player.playerId]) {
        // Update existing player (columns A-S only)
        const rowNumber = playerIndex[player.playerId];
        updates.push({
          range: `A${rowNumber}:S${rowNumber}`,
          values: [rowData]
        });
        updatedCount++;
      } else {
        // New player
        newRows.push(rowData);
        addedCount++;
      }
    }

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: GOOGLE_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: updates
        }
      });
    }

    if (newRows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: 'A:S',
        valueInputOption: 'RAW',
        requestBody: {
          values: newRows
        }
      });
    }

    console.log(`\n✅ Google Sheet updated: ${addedCount} added, ${updatedCount} updated`);
    return { added: addedCount, updated: updatedCount };

  } catch (err) {
    console.error(`\n❌ Failed to update Google Sheet: ${err.message}`);
    return { added: 0, updated: 0 };
  }
}

async function sendDiscordSummary(players, sheetStats, duration) {
  if (!DISCORD_WEBHOOK) {
    console.log('\n⚠️  No Discord webhook configured. Skipping alert.');
    return;
  }

  const grouped = {};
  players.forEach(p => {
    if (!grouped[p.seasonProgression]) grouped[p.seasonProgression] = 0;
    grouped[p.seasonProgression]++;
  });

  const progressionLevels = Object.keys(grouped).sort((a, b) => b - a);
  
  const summary = `✅ **Progression Check Complete!**\n\n` +
    `⏱️ Duration: ${duration} minutes\n` +
    `🔥 Found: ${players.length} high-progression players\n` +
    `📊 Google Sheet: ${sheetStats.added} new, ${sheetStats.updated} updated\n\n` +
    `**Breakdown:**\n` +
    progressionLevels.map(level => `• +${level} Overall: ${grouped[level]} player${grouped[level] > 1 ? 's' : ''}`).join('\n') +
    `\n\n📋 View full details: [Open Google Sheet](https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID})`;

  await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: summary })
  });
  
  console.log('\n✅ Discord summary sent!');
}

// Main execution
const startTime = Date.now();

for (const clubId of CLUB_IDS) {
  await checkClubProgressions(clubId);
  await new Promise(r => setTimeout(r, DELAY_MS));
  
  if (clubsChecked % 100 === 0) {
    console.log(`📊 Progress: ${clubsChecked}/${CLUB_IDS.length} clubs checked (${highProgressionPlayers.length} players found)...`);
  }
}

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
  if (DISCORD_WEBHOOK) {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        content: `ℹ️ **Progression Check Complete**\n\nNo players with +${threshold} or higher progression found today.` 
      })
    });
  }
}
