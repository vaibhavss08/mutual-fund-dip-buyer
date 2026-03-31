/**
 * SQLite data access layer for stock/fund data.
 */

const Database = require("better-sqlite3");
const path = require("node:path");

const WORKSPACE_ROOT = path.resolve(__dirname, "..");
const SHARED_DATA_DIR = process.env.MF_SHARED_DATA_DIR
  ? path.resolve(process.env.MF_SHARED_DATA_DIR)
  : path.join(WORKSPACE_ROOT, "shared-data");
const DB_PATH = process.env.MF_MATCHER_DB_PATH
  ? path.resolve(process.env.MF_MATCHER_DB_PATH)
  : path.join(SHARED_DATA_DIR, "mf_matcher.db");
let db = null;
let _cachedFunds = null;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  }
  return db;
}

function searchStocks(query) {
  if (!query || query.length < 1) return [];
  const q = query.trim().toUpperCase();
  const conn = getDb();

  const exact = conn
    .prepare(
      "SELECT symbol, name, sector, market_cap FROM stocks WHERE UPPER(symbol) = ?"
    )
    .all(q);

  const startsSym = conn
    .prepare(
      "SELECT symbol, name, sector, market_cap FROM stocks WHERE UPPER(symbol) LIKE ? AND UPPER(symbol) != ? ORDER BY LENGTH(symbol), symbol LIMIT 20"
    )
    .all(q + "%", q);

  const containsName = conn
    .prepare(
      "SELECT symbol, name, sector, market_cap FROM stocks WHERE UPPER(name) LIKE ? ORDER BY LENGTH(symbol), symbol LIMIT 20"
    )
    .all("%" + q + "%");

  const seen = new Set();
  const results = [];
  for (const row of [...exact, ...startsSym, ...containsName]) {
    if (!seen.has(row.symbol)) {
      seen.add(row.symbol);
      results.push(row);
    }
    if (results.length >= 15) break;
  }
  return results;
}

function getAllMutualFunds() {
  const conn = getDb();
  const rows = conn
    .prepare(
      `SELECT mf.id, mf.scheme_name, mf.category, mf.amc, mf.aum_cr, mf.risk_level,
              h.symbol, h.weight
       FROM mutual_funds mf
       LEFT JOIN holdings h ON h.fund_id = mf.id
       ORDER BY mf.id, h.weight DESC`
    )
    .all();

  const fundsMap = new Map();
  for (const row of rows) {
    if (!fundsMap.has(row.id)) {
      fundsMap.set(row.id, {
        id: row.id,
        scheme_name: row.scheme_name,
        category: row.category,
        amc: row.amc,
        aum_cr: row.aum_cr,
        risk_level: row.risk_level,
        holdings: [],
      });
    }
    if (row.symbol) {
      fundsMap.get(row.id).holdings.push({
        symbol: row.symbol,
        weight: row.weight,
      });
    }
  }
  return [...fundsMap.values()];
}

function getAllMutualFundsCached() {
  if (!_cachedFunds) _cachedFunds = getAllMutualFunds();
  return _cachedFunds;
}

module.exports = {
  searchStocks,
  getAllMutualFundsCached,
};
