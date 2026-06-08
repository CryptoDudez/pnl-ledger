// ============================================================
// P&L LEDGER — MT4/MT5 IMPORT MODULE
// Drop this into your main app JS file
// All functions are prefixed with `importer_` to avoid conflicts
// ============================================================

const SUPABASE_URL = 'https://fiucxbfhjmvdwfgnnxsa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpdWN4YmZoam12ZHdmZ25ueHNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1ODg4NTAsImV4cCI6MjA5NjE2NDg1MH0.6K5BNqVC9z0eiYbToy4EjMIwrwQflVodYdLqV2glU18';

// ============================================================
// 1. ENTRY POINT
// Call this when the user drops or selects a file
// e.g. <input type="file" onchange="importer_handleFile(this)">
// ============================================================
function importer_handleFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const trades = importer_parseAuto(text, file.name);
    if (!trades.length) {
      importer_onError('No trades found. Make sure this is an MT4/MT5 history export (.htm or .csv).');
      return;
    }
    importer_onParsed(trades, file.name);
  };
  reader.readAsText(file);
}

// ============================================================
// 2. AUTO-DETECT FORMAT AND PARSE
// Handles both HTM (Save as Report) and CSV (Export to CSV)
// ============================================================
function importer_parseAuto(text, filename) {
  const isHTML = filename.endsWith('.htm') || filename.endsWith('.html')
    || text.includes('<table') || text.includes('<TABLE') || text.includes('<tr');
  return isHTML ? importer_parseHTM(text) : importer_parseCSV(text);
}

// ============================================================
// 3. HTM PARSER — for MT4/MT5 "Save as Report" (.htm)
// MT4: Account History tab → right-click → Save as Report
// MT5: History tab → right-click → Save as Detailed Report
// ============================================================
function importer_parseHTM(html) {
  const trades = [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = doc.querySelectorAll('tr');

  rows.forEach((row) => {
    const cells = [...row.querySelectorAll('td')].map(c => c.textContent.trim());
    if (cells.length < 10) return;

    const profit = parseFloat(cells[cells.length - 1]);
    if (isNaN(profit)) return;

    // Must have a date in the second cell (MT4/MT5 format: 2025.06.02 09:14)
    if (!/\d{4}\.\d{2}\.\d{2}/.test(cells[1] || '')) return;

    const type = (cells[2] || '').toLowerCase();
    const validTypes = ['buy', 'sell', 'buy limit', 'sell limit', 'buy stop', 'sell stop'];
    if (!validTypes.some(t => type.includes(t))) return;

    trades.push(importer_buildTrade(
      cells[1],          // open time
      cells[2],          // type
      parseFloat(cells[3]),  // lots
      cells[4],          // symbol
      parseFloat(cells[5]),  // open price
      parseFloat(cells[9]),  // close price
      parseFloat(cells[6]),  // stop loss
      parseFloat(cells[7]),  // take profit
      parseFloat(cells[12] || 0), // swap
      profit             // profit/loss
    ));
  });

  return trades;
}

// ============================================================
// 4. CSV PARSER — for MT4/MT5 "Export to CSV"
// Column order: #, Time, Type, Size, Item, Price, S/L, T/P, Time, Price, Commission, Taxes, Swap, Profit
// ============================================================
function importer_parseCSV(text) {
  const trades = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Only process lines that look like trade data (contain a date)
  const dataLines = lines.filter(l => /\d{4}[.\-\/]\d{2}[.\-\/]\d{2}/.test(l));

  dataLines.forEach((line) => {
    const cells = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    if (cells.length < 8) return;

    const profit = parseFloat(cells[cells.length - 1]);
    if (isNaN(profit)) return;

    const type = (cells[2] || '').toLowerCase();
    if (!['buy', 'sell'].some(t => type.includes(t))) return;

    trades.push(importer_buildTrade(
      cells[1],              // open time
      cells[2],              // type
      parseFloat(cells[3]),  // lots
      cells[4],              // symbol
      parseFloat(cells[5]),  // open price
      parseFloat(cells[9] || 0), // close price
      parseFloat(cells[6] || 0), // stop loss
      parseFloat(cells[7] || 0), // take profit
      parseFloat(cells[12] || 0), // swap
      profit                 // profit/loss
    ));
  });

  return trades;
}

// ============================================================
// 5. TRADE BUILDER — normalises into P&L Ledger format
// Matches the structure inside your trades_data JSON blob
// ============================================================
function importer_buildTrade(openTime, type, lots, symbol, openPrice, closePrice, sl, tp, swap, profit) {
  // Convert MT4 date format (2025.06.02) to ISO (2025-06-02)
  const dateKey = (openTime || '').replace(/\./g, '-').split(' ')[0];

  return {
    id: 'mt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    date: dateKey,
    openTime: openTime || '',
    symbol: (symbol || '').toUpperCase().trim(),
    type: (type || '').toLowerCase().trim(),
    lots: parseFloat((lots || 0).toFixed(2)),
    openPrice: parseFloat((openPrice || 0).toFixed(5)),
    closePrice: parseFloat((closePrice || 0).toFixed(5)),
    sl: parseFloat((sl || 0).toFixed(5)),
    tp: parseFloat((tp || 0).toFixed(5)),
    swap: parseFloat((swap || 0).toFixed(2)),
    profit: parseFloat((profit || 0).toFixed(2)),
    source: 'mt4_import',
    importedAt: new Date().toISOString(),
  };
}

// ============================================================
// 6. SAVE TO SUPABASE
// Fetches existing trades_data, merges new trades, patches back
// Requires: supabaseUser object with { id, access_token }
// Get this from your existing Supabase auth session
// ============================================================
async function importer_saveToSupabase(parsedTrades, supabaseUser, onProgress) {
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + supabaseUser.access_token,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  try {
    // Step 1: Fetch existing data for this user
    onProgress && onProgress(10, 'Fetching your existing journal data...');
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/pnl_ledger_data?user_id=eq.${supabaseUser.id}&select=trades_data`,
      { headers }
    );
    const fetchData = await fetchRes.json();
    if (!fetchRes.ok) throw new Error(fetchData.message || 'Failed to fetch existing data');

    // Step 2: Parse existing trades_data JSON
    onProgress && onProgress(30, 'Reading existing journal entries...');
    let existingTradesData = {};
    if (fetchData && fetchData.length && fetchData[0].trades_data) {
      try { existingTradesData = JSON.parse(fetchData[0].trades_data); }
      catch (e) { existingTradesData = {}; }
    }
    const isNewUser = !fetchData || !fetchData.length;

    // Step 3: Merge imported trades — no duplicates, no overwrites
    onProgress && onProgress(50, `Merging ${parsedTrades.length} trades...`);
    let newCount = 0;
    let dupeCount = 0;

    parsedTrades.forEach((trade) => {
      const dateKey = trade.date;
      if (!existingTradesData[dateKey]) existingTradesData[dateKey] = { trades: [] };
      if (!existingTradesData[dateKey].trades) existingTradesData[dateKey].trades = [];

      // Duplicate check: same open time + symbol + profit = same trade
      const isDupe = existingTradesData[dateKey].trades.some(t =>
        t.openTime === trade.openTime &&
        t.symbol === trade.symbol &&
        t.profit === trade.profit
      );

      if (!isDupe) {
        existingTradesData[dateKey].trades.push(trade);
        newCount++;
      } else {
        dupeCount++;
      }
    });

    // Step 4: Upsert back to Supabase
    onProgress && onProgress(75, 'Saving to journal...');
    const payload = { trades_data: JSON.stringify(existingTradesData) };

    let saveRes;
    if (isNewUser) {
      // New user — INSERT
      saveRes = await fetch(`${SUPABASE_URL}/rest/v1/pnl_ledger_data`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ user_id: supabaseUser.id, ...payload }),
      });
    } else {
      // Existing user — PATCH
      saveRes = await fetch(
        `${SUPABASE_URL}/rest/v1/pnl_ledger_data?user_id=eq.${supabaseUser.id}`,
        { method: 'PATCH', headers, body: JSON.stringify(payload) }
      );
    }

    if (!saveRes.ok) {
      const errData = await saveRes.json();
      throw new Error(errData.message || 'Save failed');
    }

    onProgress && onProgress(100, 'Done!');

    return {
      success: true,
      newCount,
      dupeCount,
      totalMerged: Object.keys(existingTradesData).length,
      message: `${newCount} trades imported successfully. ${dupeCount > 0 ? dupeCount + ' duplicates skipped.' : ''}`,
    };

  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ============================================================
// 7. CALLBACK HOOKS — wire these to your UI
// Replace these with your actual UI update functions
// ============================================================

// Called when trades are successfully parsed from the file
// trades = array of trade objects, filename = string
function importer_onParsed(trades, filename) {
  console.log(`[P&L Ledger Import] Parsed ${trades.length} trades from ${filename}`);
  // TODO: Show your preview modal/table here
  // Example: showImportPreview(trades);
}

// Called when something goes wrong
function importer_onError(message) {
  console.error('[P&L Ledger Import] Error:', message);
  // TODO: Show your error toast/alert here
  // Example: showToast(message, 'error');
}

// ============================================================
// 8. CONVENIENCE WRAPPER — one call to do everything
// Usage: importer_run(fileInputElement, supabaseUser)
// supabaseUser = your existing Supabase session user object
// ============================================================
async function importer_run(fileInput, supabaseUser) {
  const file = fileInput.files[0];
  if (!file) { importer_onError('No file selected'); return; }

  const reader = new FileReader();
  reader.onload = async (e) => {
    const trades = importer_parseAuto(e.target.result, file.name);
    if (!trades.length) {
      importer_onError('No trades found in this file.');
      return;
    }

    const result = await importer_saveToSupabase(
      trades,
      supabaseUser,
      (pct, msg) => console.log(`[${pct}%] ${msg}`)
    );

    if (result.success) {
      console.log('[P&L Ledger Import] Success:', result.message);
      // TODO: Show success toast, refresh journal view
      // Example: showToast(result.message, 'success'); refreshJournal();
    } else {
      importer_onError(result.message);
    }
  };
  reader.readAsText(file);
}

// ============================================================
// HOW TO USE IN YOUR APP
// ============================================================
//
// 1. Add a file input to your HTML:
//    <input type="file" id="importFile" accept=".csv,.htm,.html,.txt"
//           onchange="importer_run(this, window.currentUser)">
//
// 2. Make sure window.currentUser has { id, access_token }
//    This should already exist from your Supabase auth session
//
// 3. Replace the TODO comments in importer_onParsed and
//    importer_onError with your actual UI calls
//
// 4. If you want a preview step before saving, call:
//    importer_handleFile(input)  — parses only, calls importer_onParsed
//    importer_saveToSupabase(trades, user, onProgress) — saves separately
//
// That's it. The rest is handled automatically.
// ============================================================
