const http = require("node:http");
const https = require("node:https");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const stockData = require("./stock-data");
const { findBestSingleFunds, findOptimalBundles, computeOverlap } = require("./stock-optimizer");

function parseProperties(rawContent) {
  return String(rawContent || "")
    .split(/\r?\n/)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return acc;
      }

      const separator = trimmed.indexOf("=");
      if (separator < 0) {
        return acc;
      }

      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key) {
        acc[key] = value;
      }

      return acc;
    }, {});
}

function loadAppConfig() {
  const configPath = path.join(__dirname, "config", "app.properties");
  try {
    const raw = fsSync.readFileSync(configPath, "utf8");
    return parseProperties(raw);
  } catch {
    return {};
  }
}

const APP_CONFIG = loadAppConfig();
const SERVER_HOST = process.env.SERVER_HOST || APP_CONFIG.SERVER_HOST || "localhost";
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || APP_CONFIG.SERVER_PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const YAHOO_USER_AGENT = "Mozilla/5.0";

const TTL = {
  nseMaster: 24 * 60 * 60 * 1000,
  schemeSearch: 6 * 60 * 60 * 1000,
  portfolio: 4 * 60 * 60 * 1000,
  symbol: 24 * 60 * 60 * 1000,
  quote: 2 * 60 * 1000,
  nav: 60 * 60 * 1000,
};

const cache = {
  nseMaster: new Map(),
  schemeSearch: new Map(),
  portfolio: new Map(),
  symbol: new Map(),
  quote: new Map(),
  nav: new Map(),
};

function clearCaches() {
  Object.values(cache).forEach((store) => {
    if (store && typeof store.clear === "function") {
      store.clear();
    }
  });
}

// ── Scheme code lookup for mfapi.in NAV ──
const SCHEME_CODES = (() => {
  const SHARED_DATA_DIR = process.env.MF_SHARED_DATA_DIR
    ? path.resolve(process.env.MF_SHARED_DATA_DIR)
    : path.join(path.resolve(__dirname, ".."), "shared-data");
  const realDataPath = process.env.MF_REAL_DATA_PATH
    ? path.resolve(process.env.MF_REAL_DATA_PATH)
    : path.join(SHARED_DATA_DIR, "real_data.json");
  try {
    const raw = JSON.parse(fsSync.readFileSync(realDataPath, "utf8"));
    const map = {};
    for (const s of raw.schemes) map[s.name] = s.code;
    return map;
  } catch { return {}; }
})();

function findSchemeCode(name) {
  if (!name) {
    return null;
  }

  if (SCHEME_CODES[name]) {
    return { code: SCHEME_CODES[name], matchedName: name, matchType: "exact" };
  }

  const normalize = (value) => String(value || "")
    .toLowerCase()
    .replace(/\s*-\s*(direct|regular)\s*(plan)?\s*/gi, " ")
    .replace(/\s*-\s*(growth|dividend|idcw|bonus)\s*(option)?\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const target = normalize(name);
  let bestMatch = null;
  for (const [schemeName, code] of Object.entries(SCHEME_CODES)) {
    const normalizedScheme = normalize(schemeName);
    if (
      normalizedScheme === target ||
      normalizedScheme.startsWith(target) ||
      target.startsWith(normalizedScheme)
    ) {
      if (!bestMatch || schemeName.length > bestMatch.matchedName.length) {
        bestMatch = {
          code,
          matchedName: schemeName,
          matchType: normalizedScheme === target ? "normalized" : "fuzzy",
        };
      }
    }
  }
  return bestMatch;
}

// Temporary storage for Chrome Extension data injection
let extensionStash = null;

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return normalizeWhitespace(value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .toUpperCase();
}

function normalizeSchemeSpacing(value) {
  return normalizeWhitespace(
    String(value || "")
      .replace(/\bLARGECAP\b/gi, "LARGE CAP")
      .replace(/\bMIDCAP\b/gi, "MID CAP")
      .replace(/\bSMALLCAP\b/gi, "SMALL CAP")
      .replace(/\bFLEXICAP\b/gi, "FLEXI CAP")
      .replace(/\bMULTICAP\b/gi, "MULTI CAP")
      .replace(/([A-Za-z0-9])\(/g, "$1 (")
      .replace(/\)([A-Za-z0-9])/g, ") $1")
      .replace(/\s*-\s*/g, " - "),
  );
}

function stripSchemeNoiseWords(value) {
  return String(value || "").replace(
    /\b(REGULAR|DIRECT|PLAN|OPTION|OPT|GROWTH|BONUS|DIVIDEND|IDCW|REINVESTMENT|REINVEST|PAYOUT|PAY\s+OUT)\b/gi,
    " ",
  );
}

function getCachedValue(map, key) {
  const hit = map.get(key);
  if (!hit) {
    return undefined;
  }

  if (Date.now() > hit.expiresAt) {
    map.delete(key);
    return undefined;
  }

  return hit.value;
}

function setCachedValue(map, key, value, ttlMs) {
  map.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

const SCHEME_GENERIC_TOKENS = new Set([
  "AND",
  "DIRECT",
  "DIVIDEND",
  "FUND",
  "GROWTH",
  "IDCW",
  "OF",
  "OPTION",
  "OPT",
  "OUT",
  "PAY",
  "PAYOUT",
  "PLAN",
  "REGULAR",
  "REINVEST",
  "REINVESTMENT",
  "THE",
]);

const SCHEME_FLAG_DEFINITIONS = [
  { key: "fof", patterns: [/\bFOF\b/i, /\bFUND OF FUNDS?\b/i] },
  { key: "etf", patterns: [/\bETF\b/i] },
  { key: "index", patterns: [/\bINDEX\b/i] },
  { key: "elss", patterns: [/\bELSS\b/i, /\bTAX SAVER\b/i] },
  { key: "largecap", patterns: [/\bLARGE\s*CAP\b/i, /\bLARGECAP\b/i] },
  { key: "midcap", patterns: [/\bMID\s*CAP\b/i, /\bMIDCAP\b/i] },
  { key: "smallcap", patterns: [/\bSMALL\s*CAP\b/i, /\bSMALLCAP\b/i] },
  { key: "flexicap", patterns: [/\bFLEXI\s*CAP\b/i, /\bFLEXICAP\b/i] },
  { key: "multicap", patterns: [/\bMULTI\s*CAP\b/i, /\bMULTICAP\b/i] },
  { key: "liquid", patterns: [/\bLIQUID\b/i] },
  { key: "overnight", patterns: [/\bOVERNIGHT\b/i] },
  { key: "creditrisk", patterns: [/\bCREDIT\s*RISK\b/i] },
  { key: "gilt", patterns: [/\bGILT\b/i] },
  { key: "arbitrage", patterns: [/\bARBITRAGE\b/i] },
];

const STRICT_SCHEME_TRAIT_GROUPS = [
  ["largecap", "midcap", "smallcap", "flexicap", "multicap"],
  ["liquid", "overnight", "creditrisk", "gilt", "arbitrage"],
];

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];

  values.forEach((value) => {
    const cleaned = normalizeWhitespace(value);
    if (!cleaned) {
      return;
    }

    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    output.push(cleaned);
  });

  return output;
}

function isLikelyPortfolioNoiseLine(line) {
  const value = normalizeWhitespace(line);
  if (!value) {
    return true;
  }

  const lower = value.toLowerCase();
  const exactNoise = new Set([
    "current value",
    "invested",
    "xirr",
    "absolute returns",
    "unrealised gain",
    "unrealized gain",
    "holding details",
    "view details",
    "add to cart",
    "buy now",
  ]);

  if (exactNoise.has(lower)) {
    return true;
  }

  if (
    /^showing\s+\d+\s+funds?$/i.test(value) ||
    /^\d+\s+funds?$/i.test(value) ||
    /^page\s+\d+$/i.test(value) ||
    /^sort by/i.test(value) ||
    /^filter by/i.test(value) ||
    /^search\b/i.test(value) ||
    /^download\b/i.test(value) ||
    /^export\b/i.test(value) ||
    /^refresh\b/i.test(value)
  ) {
    return true;
  }

  if (
    /^(₹|rs\.?|inr)?\s?[\d,]+(?:\.\d+)?%?$/i.test(value) ||
    /^-?\d+(?:\.\d+)?%$/.test(value)
  ) {
    return true;
  }

  return false;
}

function canonicalFundName(value) {
  return normalizeText(stripSchemeNoiseWords(normalizeSchemeSpacing(value)))
    .split(" ")
    .filter(Boolean)
    .filter((token) => !SCHEME_GENERIC_TOKENS.has(token))
    .join(" ");
}

function isPreferredFundName(fundName, preferredLookup) {
  const canonical = canonicalFundName(fundName);
  if (!canonical) {
    return false;
  }

  if (preferredLookup.has(canonical)) {
    return true;
  }

  for (const preferredName of preferredLookup) {
    if (canonical.includes(preferredName) || preferredName.includes(canonical)) {
      return true;
    }
  }

  return false;
}

function extractSchemeTokens(value) {
  return normalizeText(value)
    .split(" ")
    .filter(Boolean);
}

function getSchemeBase(value) {
  return normalizeText(
    stripSchemeNoiseWords(
      normalizeSchemeSpacing(value).replace(/\([^)]*\)/g, " "),
    ),
  );
}

function detectSchemePlanType(normalized) {
  if (/\bDIRECT\b/.test(normalized)) {
    return "direct";
  }

  if (/\bREGULAR\b/.test(normalized)) {
    return "regular";
  }

  return null;
}

function detectSchemeOptionType(normalized) {
  if (/\bGROWTH\b/.test(normalized)) {
    return "growth";
  }

  if (/\bBONUS\b/.test(normalized)) {
    return "bonus";
  }

  if (/\b(IDCW|DIVIDEND|PAYOUT|REINVESTMENT|REINVEST)\b/.test(normalized)) {
    return "idcw";
  }

  return null;
}

function parseSchemeDescriptor(value) {
  const raw = normalizeSchemeSpacing(value);
  const normalized = normalizeText(raw);
  const tokenSet = new Set(extractSchemeTokens(raw));
  const base = getSchemeBase(raw);
  const baseTokens = new Set(
    base
      .split(" ")
      .filter(Boolean)
      .filter((token) => !SCHEME_GENERIC_TOKENS.has(token)),
  );
  const bracketTokens = new Set(
    [...raw.matchAll(/\(([^)]+)\)/g)]
      .flatMap((match) => extractSchemeTokens(match[1] || "")),
  );
  const flags = Object.fromEntries(
    SCHEME_FLAG_DEFINITIONS.map(({ key, patterns }) => [
      key,
      patterns.some((pattern) => pattern.test(raw)),
    ]),
  );

  return {
    raw,
    normalized,
    tokenSet,
    base,
    baseTokens,
    bracketTokens,
    flags,
    optionType: detectSchemeOptionType(normalized),
    planType: detectSchemePlanType(normalized),
  };
}

function countSharedTokens(left, right) {
  let shared = 0;

  left.forEach((token) => {
    if (right.has(token)) {
      shared += 1;
    }
  });

  return shared;
}

function countMissingTokens(expected, actual) {
  let missing = 0;

  expected.forEach((token) => {
    if (!actual.has(token)) {
      missing += 1;
    }
  });

  return missing;
}

function hasAllTokens(actual, expected) {
  return countMissingTokens(expected, actual) === 0;
}

function scoreSchemeCandidate(queryInfo, candidateInfo) {
  let score = 0;

  if (candidateInfo.normalized === queryInfo.normalized) {
    score += 500;
  }

  if (candidateInfo.base && candidateInfo.base === queryInfo.base) {
    score += 320;
  } else if (
    candidateInfo.base &&
    queryInfo.base &&
    (candidateInfo.base.includes(queryInfo.base) || queryInfo.base.includes(candidateInfo.base))
  ) {
    score += 130;
  }

  score += countSharedTokens(queryInfo.baseTokens, candidateInfo.baseTokens) * 28;
  score -= countMissingTokens(queryInfo.baseTokens, candidateInfo.baseTokens) * 35;
  score -= countMissingTokens(candidateInfo.baseTokens, queryInfo.baseTokens) * 4;

  STRICT_SCHEME_TRAIT_GROUPS.forEach((group) => {
    const queryTraits = group.filter((key) => queryInfo.flags[key]);
    if (queryTraits.length === 0) {
      return;
    }

    const extraCandidateTraits = group.filter(
      (key) => candidateInfo.flags[key] && !queryInfo.flags[key],
    );
    const matchedTraits = queryTraits.filter((key) => candidateInfo.flags[key]);

    score += matchedTraits.length * 90;
    score -= extraCandidateTraits.length * 170;
  });

  if (queryInfo.planType) {
    score += candidateInfo.planType === queryInfo.planType ? 95 : -130;
  } else {
    score += candidateInfo.planType === "regular" ? 12 : 0;
    score += candidateInfo.planType === "direct" ? -4 : 0;
  }

  if (queryInfo.optionType) {
    score += candidateInfo.optionType === queryInfo.optionType ? 70 : -90;
  } else {
    score += candidateInfo.optionType === "growth" ? 22 : 0;
    score += candidateInfo.optionType === "bonus" ? -24 : 0;
    score += candidateInfo.optionType === "idcw" ? -18 : 0;
  }

  if (queryInfo.bracketTokens.size > 0) {
    const bracketOverlap = countSharedTokens(queryInfo.bracketTokens, candidateInfo.tokenSet);
    score += bracketOverlap * 45;
    if (bracketOverlap === 0) {
      score -= 170;
    }
  } else if (candidateInfo.bracketTokens.size > 0) {
    score -= Math.min(candidateInfo.bracketTokens.size * 5, 20);
  }

  SCHEME_FLAG_DEFINITIONS.forEach(({ key }) => {
    if (!queryInfo.flags[key]) {
      return;
    }

    score += candidateInfo.flags[key] ? 55 : -85;
  });

  return score;
}

function filterSchemeCandidates(queryInfo, candidates) {
  let filtered = candidates;

  if (queryInfo.base) {
    const exactBaseMatches = filtered.filter(({ info }) => info.base === queryInfo.base);
    if (exactBaseMatches.length > 0) {
      filtered = exactBaseMatches;
    }
  }

  if (queryInfo.planType) {
    const planMatches = filtered.filter(({ info }) => info.planType === queryInfo.planType);
    if (planMatches.length > 0) {
      filtered = planMatches;
    }
  }

  if (queryInfo.optionType) {
    const optionMatches = filtered.filter(({ info }) => info.optionType === queryInfo.optionType);
    if (optionMatches.length > 0) {
      filtered = optionMatches;
    }
  }

  if (queryInfo.bracketTokens.size > 0) {
    const bracketMatches = filtered.filter(({ info }) => hasAllTokens(info.tokenSet, queryInfo.bracketTokens));
    if (bracketMatches.length > 0) {
      filtered = bracketMatches;
    }
  }

  STRICT_SCHEME_TRAIT_GROUPS.forEach((group) => {
    const querySignature = group.filter((key) => queryInfo.flags[key]).join("|");
    if (!querySignature) {
      return;
    }

    const exactTraitMatches = filtered.filter(({ info }) => {
      return group.filter((key) => info.flags[key]).join("|") === querySignature;
    });
    if (exactTraitMatches.length > 0) {
      filtered = exactTraitMatches;
    }
  });

  SCHEME_FLAG_DEFINITIONS.forEach(({ key }) => {
    if (!queryInfo.flags[key]) {
      return;
    }

    const flagMatches = filtered.filter(({ info }) => info.flags[key]);
    if (flagMatches.length > 0) {
      filtered = flagMatches;
    }
  });

  return filtered;
}

function cleanCompanyName(value) {
  return normalizeText(value)
    .replace(/\b(LIMITED|LTD|EQ|EQUITY|FV|RS|RE|NEW|FULLY|PAID|UP|SHARE)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  cells.push(current);
  return cells;
}

function similarityScore(candidate, target) {
  if (!candidate || !target) {
    return 0;
  }

  if (candidate === target) {
    return 80;
  }

  if (candidate.includes(target) || target.includes(candidate)) {
    return 55;
  }

  const candidateTokens = new Set(candidate.split(" "));
  return target.split(" ").reduce((score, token) => {
    return score + (candidateTokens.has(token) ? 10 : 0);
  }, 0);
}

function buildSchemeSearchQueries(schemeInput) {
  const raw = normalizeWhitespace(schemeInput);
  const spaced = normalizeSchemeSpacing(raw);
  const withoutNoise = normalizeWhitespace(stripSchemeNoiseWords(spaced));
  const withoutBrackets = normalizeWhitespace(spaced.replace(/\([^)]*\)/g, " "));
  const withoutBracketsOrNoise = normalizeWhitespace(stripSchemeNoiseWords(withoutBrackets));

  return uniqueStrings([
    raw,
    spaced,
    withoutNoise,
    withoutBrackets,
    withoutBracketsOrNoise,
  ]).filter((query) => query.length >= 3);
}

function parseAmount(raw) {
  if (!raw) return null;

  const upper = raw.toUpperCase();
  let multiplier = 1;
  if (upper.includes("CR")) multiplier = 10000000;
  else if (upper.includes("L")) multiplier = 100000;
  else if (upper.includes("M")) multiplier = 1000000;
  else if (upper.includes("K")) multiplier = 1000;

  const cleaned = raw.replace(/[^\d.-]/g, "");
  if (!cleaned) return null;

  const value = Number(cleaned) * multiplier;
  return Number.isFinite(value) && value > 0 ? value : null;
}

const NOISY_PORTFOLIO_STOP_PATTERNS = [
  /mutual fund execution provided by/i,
  /all rights reserved/i,
  /^products$/i,
  /^company$/i,
  /^legal(?:\s*&\s*|\s+and\s+)regulatory$/i,
  /^disclaimer/i,
  /^explore more funds$/i,
  /^trending funds$/i,
  /^index funds$/i,
  /^high return funds$/i,
  /^tax saver funds$/i,
  /^gold funds$/i,
];

const NOISY_PORTFOLIO_SECTION_PATTERNS = [
  /^mutual funds$/i,
  /^my mutual funds$/i,
  /^external portfolio$/i,
  /^explore\s*&\s*invest$/i,
  /^performance summary$/i,
  /^transactions$/i,
  /^selected$/i,
  /^sort\s*&\s*filter$/i,
  /^report error$/i,
  /^gain\/?\s*loss$/i,
  /^invest in$/i,
  /^return %$/i,
  /^returns$/i,
  /^invested$/i,
  /^current value$/i,
  /^view details$/i,
];

const NOISY_PORTFOLIO_INDEX_PATTERNS = [
  /^nifty(?:\s+\d+|\s+financial|\s+midcap|\s+next|\s+smallcap|\s+bank)?$/i,
  /^sensex$/i,
  /^bank nifty$/i,
  /^bankex$/i,
  /^exp today$/i,
];

const NOISY_PORTFOLIO_FUND_HINT_PATTERNS = [
  /\bfund\b/i,
  /\bgrowth\b/i,
  /\bregular\b/i,
  /\bdirect\b/i,
  /\bsmall\s*cap\b/i,
  /\bmid\s*cap\b/i,
  /\blarge\s*cap\b/i,
  /\bflexi\s*cap\b/i,
  /\bmulti\s*asset\b/i,
  /\bcredit\s*risk\b/i,
  /\bindex\b/i,
  /\bopportunit(?:y|ies)\b/i,
  /\binnovation\b/i,
  /\bconsumption\b/i,
  /\benergy\b/i,
  /\bhealth(?:care)?\b/i,
  /\bbanking\b/i,
  /\bfinancial\b/i,
  /\bthematic\b/i,
  /\belss\b/i,
  /\bteck\b/i,
  /\badvantage\b/i,
];

function isLikelyNoisyPortfolioStopLine(line) {
  const value = normalizeWhitespace(line);
  if (!value) {
    return true;
  }

  if (NOISY_PORTFOLIO_STOP_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }

  return false;
}

function isLikelyNoisyPortfolioSectionLine(line) {
  const value = normalizeWhitespace(line);
  if (!value) {
    return true;
  }

  if (NOISY_PORTFOLIO_SECTION_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }

  return false;
}

function isLikelyMarketSnapshotLine(line) {
  return NOISY_PORTFOLIO_INDEX_PATTERNS.some((pattern) => pattern.test(normalizeWhitespace(line)));
}

function hasFundLikeHint(line) {
  return NOISY_PORTFOLIO_FUND_HINT_PATTERNS.some((pattern) => pattern.test(line));
}

function looksLikeNoisyFundName(line) {
  const value = normalizeWhitespace(line);
  if (!value || value.length < 8 || value.length > 120) {
    return false;
  }

  if (isLikelyPortfolioNoiseLine(value)) {
    return false;
  }

  if (isLikelyNoisyPortfolioStopLine(value) || isLikelyNoisyPortfolioSectionLine(value)) {
    return false;
  }

  if (isLikelyMarketSnapshotLine(value)) {
    return false;
  }

  if (
    /^(myind|indstocks|us stocks|flash trading|algo trading|f&o|products|company)$/i.test(value)
  ) {
    return false;
  }

  const alphaTokens = value.match(/[A-Za-z]+/g) || [];
  if (alphaTokens.length < 2) {
    return false;
  }

  return hasFundLikeHint(value);
}

function getNoisyPortfolioMetricKey(line) {
  const value = normalizeWhitespace(line);
  if (/^current value$/i.test(value)) {
    return "currentValue";
  }
  if (/^invested$/i.test(value)) {
    return "invested";
  }
  if (/^market value$/i.test(value)) {
    return "marketValue";
  }
  if (/^gain\/?\s*loss$/i.test(value)) {
    return "gainLoss";
  }
  if (/^returns$/i.test(value)) {
    return "returns";
  }
  if (/^return %$/i.test(value)) {
    return "returnPct";
  }
  if (/^xirr$/i.test(value)) {
    return "xirr";
  }
  return null;
}

function scanNoisyPortfolioCard(lines, startIndex) {
  const labels = new Set();
  const amounts = {};
  let endIndex = startIndex;

  for (
    let cursor = startIndex + 1;
    cursor < lines.length && cursor <= startIndex + 14;
    cursor += 1
  ) {
    const line = normalizeWhitespace(lines[cursor]);
    if (!line) {
      continue;
    }

    if (isLikelyNoisyPortfolioStopLine(line)) {
      break;
    }

    if (cursor > startIndex + 3 && labels.size === 0 && looksLikeNoisyFundName(line)) {
      break;
    }

    const metricKey = getNoisyPortfolioMetricKey(line);
    if (metricKey) {
      labels.add(metricKey);

      const nextValues = [lines[cursor + 1], lines[cursor + 2]]
        .map((value) => normalizeWhitespace(value));
      const amountOffset = nextValues.findIndex((value) => parseAmount(value));
      if (amountOffset >= 0) {
        amounts[metricKey] = parseAmount(nextValues[amountOffset]);
        endIndex = Math.max(endIndex, cursor + amountOffset + 1);
      } else {
        endIndex = Math.max(endIndex, cursor);
      }
      continue;
    }

    if (labels.size > 0 && looksLikeNoisyFundName(line)) {
      break;
    }

    endIndex = Math.max(endIndex, cursor);
  }

  const allocation = amounts.currentValue || amounts.invested || amounts.marketValue || 0;
  return {
    allocation,
    endIndex,
    metricCount: labels.size,
  };
}

function parseNoisyPortfolioText(rawLines) {
  const parsed = [];

  for (let index = 0; index < rawLines.length; index += 1) {
    const line = normalizeWhitespace(rawLines[index]);
    if (!line) {
      continue;
    }

    if (isLikelyNoisyPortfolioStopLine(line)) {
      break;
    }

    if (!looksLikeNoisyFundName(line)) {
      continue;
    }

    const card = scanNoisyPortfolioCard(rawLines, index);
    if (card.metricCount < 2 || card.allocation <= 0) {
      continue;
    }

    parsed.push({
      lineNumber: index + 1,
      schemeInput: line,
      allocation: card.allocation,
    });

    index = Math.max(index, card.endIndex);
  }

  return parsed;
}

function parsePortfolioText(portfolioText) {
  const rawLines = String(portfolioText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const cleanLines = rawLines.filter(
    (line) => line.length > 3 && !isLikelyPortfolioNoiseLine(line),
  );

  // If there are many lines and most lack explicit format dividers like | or \t,
  // it's likely a raw DOM text dump from the extension.
  const explicitLines = rawLines.filter((line) => line.includes("|") || line.includes("\t")).length;
  let fundsParser = [];

  if (rawLines.length > 15 && explicitLines < rawLines.length * 0.2) {
    // ---- NOISY DOM PARSING MODE ----
    fundsParser = parseNoisyPortfolioText(rawLines);
  }

  if (fundsParser.length === 0) {
    // ---- EXPLICIT FORMAT MODE (CSV/TSV/Pipe) ----
    fundsParser = cleanLines
      .map((line, index) => {
        const parts = line.includes("|") ? line.split("|") : line.includes("\t") ? line.split("\t") : [line];
        const schemeInput = String(parts[0] || "").trim();
        const allocation = parseAmount(parts[1] || "") || 0;
        return {
          lineNumber: index + 1,
          schemeInput,
          allocation,
        };
      })
      .filter((f) => f.schemeInput.length > 3);
  }

  if (fundsParser.length === 0) {
    const error = new Error("No mutual fund schemes found. Add at least one valid mutual fund.");
    error.statusCode = 400;
    throw error;
  }

  const hasAnyAllocationFinal = fundsParser.some((fund) => fund.allocation > 0);
  const units = fundsParser.map((fund) => {
    if (!hasAnyAllocationFinal) return 1;
    return fund.allocation || 1;
  });

  const totalUnits = units.reduce((sum, value) => sum + value, 0);

  return fundsParser.map((fund, index) => ({
    ...fund,
    units: units[index],
    portfolioWeight: totalUnits > 0 ? units[index] / totalUnits : 0,
  }));
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickBestSchemeName(query, suggestions) {
  if (suggestions.length === 0) return null;

  const queryInfo = parseSchemeDescriptor(query);
  const exact = suggestions.find((suggestion) => {
    return parseSchemeDescriptor(suggestion).normalized === queryInfo.normalized;
  });
  if (exact) return exact;

  const candidates = filterSchemeCandidates(
    queryInfo,
    suggestions.map((name) => ({
      info: parseSchemeDescriptor(name),
      name,
    })),
  );

  let bestMatch = candidates[0]?.name || suggestions[0];
  let highestScore = -Infinity;

  for (const candidate of candidates) {
    const score = scoreSchemeCandidate(queryInfo, candidate.info);

    if (score > highestScore) {
      highestScore = score;
      bestMatch = candidate.name;
    }
  }

  return highestScore > -Infinity ? bestMatch : suggestions[0];
}

async function readBody(req) {
  let body = "";

  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
  }

  return body;
}

async function fetchText(url, options = {}, label = "request") {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        ...options.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });

    const text = await response.text();
    if (response.ok) {
      return text;
    }

    if ((response.status === 429 || response.status === 503) && attempt < 2) {
      await sleep(500 * (attempt + 1));
      continue;
    }

    const error = new Error(`${label} failed with ${response.status}: ${text.slice(0, 160)}`);
    error.statusCode = response.status;
    throw error;
  }

  throw new Error(`${label} failed after repeated attempts.`);
}

async function fetchJson(url, options = {}, label = "request") {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const text = await fetchText(url, options, label);
    const cleaned = String(text || "").replace(/^\uFEFF/, "").trim();

    try {
      return JSON.parse(cleaned);
    } catch (error) {
      const firstJsonIndex = cleaned.search(/[\[{]/);
      const lastBrace = cleaned.lastIndexOf("}");
      const lastBracket = cleaned.lastIndexOf("]");
      const lastJsonIndex = Math.max(lastBrace, lastBracket);

      if (firstJsonIndex >= 0 && lastJsonIndex > firstJsonIndex) {
        try {
          return JSON.parse(cleaned.slice(firstJsonIndex, lastJsonIndex + 1));
        } catch {
          // Fall through to retry/error handling below.
        }
      }

      const looksRetryable =
        !cleaned ||
        /<!doctype|<html|access denied|request rejected|temporarily unavailable|service unavailable/i.test(
          cleaned,
        );

      if (looksRetryable && attempt < 2) {
        await sleep(500 * (attempt + 1));
        continue;
      }

      const wrapped = new Error(`${label} returned invalid JSON.`);
      wrapped.cause = error;
      wrapped.responseSnippet = cleaned.slice(0, 160);
      throw wrapped;
    }
  }

  throw new Error(`${label} returned invalid JSON.`);
}

async function httpsGetText(url, headers = {}, label = "request") {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const request = https.request(
          url,
          {
            method: "GET",
            headers: {
              "User-Agent": YAHOO_USER_AGENT,
              Accept: "application/json, text/javascript, */*; q=0.01",
              "Accept-Language": "en-US,en;q=0.9",
              Connection: "close",
              ...headers,
            },
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => {
              if (response.statusCode >= 200 && response.statusCode < 300) {
                resolve(body);
                return;
              }

              const error = new Error(
                `${label} failed with ${response.statusCode}: ${body.slice(0, 160)}`,
              );
              error.statusCode = response.statusCode;
              reject(error);
            });
          },
        );

        request.setTimeout(15_000, () => {
          request.destroy(new Error(`${label} timed out.`));
        });
        request.on("error", reject);
        request.end();
      });
    } catch (error) {
      if ((error.statusCode === 429 || error.statusCode === 503) && attempt < 2) {
        await sleep(500 * (attempt + 1));
        continue;
      }

      throw error;
    }
  }

  throw new Error(`${label} failed after repeated attempts.`);
}

async function httpsGetJson(url, headers = {}, label = "request") {
  const text = await httpsGetText(url, headers, label);
  const cleaned = String(text || "").replace(/^\uFEFF/, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const wrapped = new Error(`${label} returned invalid JSON.`);
    wrapped.cause = error;
    wrapped.responseSnippet = cleaned.slice(0, 160);
    throw wrapped;
  }
}

async function postFormJson(url, formData, headers, label) {
  return fetchJson(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...headers,
      },
      body: new URLSearchParams(formData).toString(),
    },
    label,
  );
}

async function searchSchemes(query) {
  const key = query.trim().toLowerCase();
  const cached = getCachedValue(cache.schemeSearch, key);
  if (cached) {
    return cached;
  }

  const result = await postFormJson(
    "https://www.adityarajcapital.com/mutual-funds-research/autoSuggestAllMfSchemes",
    { query: query.trim() },
    {
      Origin: "https://www.adityarajcapital.com",
      Referer: "https://www.adityarajcapital.com/mutual-funds-research/fund-card",
      "X-Requested-With": "XMLHttpRequest",
    },
    "scheme search",
  );

  const suggestions = ensureArray(result).map((item) => String(item || "").trim()).filter(Boolean);
  setCachedValue(cache.schemeSearch, key, suggestions, TTL.schemeSearch);
  return suggestions;
}

async function loadNseSecurityMaster() {
  const cached = getCachedValue(cache.nseMaster, "equity-master");
  if (cached) {
    return cached;
  }

  const csv = await fetchText(
    "https://archives.nseindia.com/content/equities/EQUITY_L.csv",
    {
      headers: {
        Referer: "https://www.nseindia.com/",
      },
    },
    "NSE security master",
  );

  const rows = csv
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map(parseCsvLine);

  const byIsin = new Map();
  rows.forEach((row) => {
    const symbol = String(row[0] || "").trim();
    const isin = String(row[6] || "").trim();
    const company = String(row[1] || "").trim();

    if (symbol && isin) {
      byIsin.set(isin, {
        displayName: company || symbol,
        exchange: "NSI",
        symbol: `${symbol}.NS`,
      });
    }
  });

  setCachedValue(cache.nseMaster, "equity-master", byIsin, TTL.nseMaster);
  return byIsin;
}

async function resolveSchemeName(schemeInput) {
  const requestedInfo = parseSchemeDescriptor(schemeInput);
  const queries = buildSchemeSearchQueries(schemeInput);
  const suggestions = [];
  const seen = new Set();

  for (const query of queries) {
    const matches = await searchSchemes(query);
    matches.forEach((item) => {
      const key = normalizeText(item);
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      suggestions.push(item);
    });

    const currentBest = pickBestSchemeName(schemeInput, suggestions);
    if (currentBest && parseSchemeDescriptor(currentBest).normalized === requestedInfo.normalized) {
      break;
    }
  }

  return {
    requested: schemeInput,
    resolved: pickBestSchemeName(schemeInput, suggestions),
    suggestions: suggestions.slice(0, 8),
  };
}

function isEquityHolding(holding) {
  const text = [holding.asset_class_eq, holding.asset_class, holding.asset_type, holding.asset_subclass]
    .filter(Boolean)
    .join(" ");

  return /equity/i.test(text) && !/\bMF\b|MUTUAL FUNDS?/i.test(text);
}

function isFundHolding(holding) {
  const text = [holding.asset_class_eq, holding.asset_class, holding.asset_type, holding.asset_subclass]
    .filter(Boolean)
    .join(" ");

  return /\bMF\b|MUTUAL FUNDS?/i.test(text);
}

function buildHoldingRecord(holding) {
  const displayName =
    String(holding.issuer_name || "").trim() ||
    cleanCompanyName(holding.instrument) ||
    String(holding.instrument || "").trim();

  return {
    company: displayName,
    instrument: String(holding.instrument || "").trim(),
    isin: String(holding.isin || "").trim(),
    industry: String(holding.industry || "").trim(),
    holdingsPct: Number(holding.holdings) || 0,
    portfolioDate: String(holding.portfolio_date || "").trim(),
    sourceFunds: [],
  };
}

function aggregateHoldingRecords(holdings) {
  const byKey = new Map();

  holdings
    .filter((holding) => Number(holding.holdingsPct) > 0)
    .forEach((holding) => {
      const key = holding.isin || normalizeText(holding.company);
      const existing = byKey.get(key);

      if (existing) {
        existing.holdingsPct += holding.holdingsPct;
        existing.sourceFunds = uniqueStrings([
          ...existing.sourceFunds,
          ...(holding.sourceFunds || []),
        ]);
        return;
      }

      byKey.set(key, {
        ...holding,
        sourceFunds: uniqueStrings(holding.sourceFunds || []),
      });
    });

  return [...byKey.values()].sort((left, right) => right.holdingsPct - left.holdingsPct);
}

function describeDominantAsset(assetAllocationMap) {
  const entries = Object.entries(assetAllocationMap || {})
    .filter(([, weight]) => Number(weight) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]));

  if (entries.length === 0) {
    return null;
  }

  const [asset, weight] = entries[0];
  return `${asset} (${Number(weight).toFixed(2)}%)`;
}

async function expandFundHoldings(rawFundHoldings, context) {
  const expanded = await mapWithConcurrency(rawFundHoldings, 2, async (holding) => {
    try {
      const childInput =
        normalizeWhitespace(holding.instrument) ||
        normalizeWhitespace(holding.issuer_name);
      if (!childInput) {
        return [];
      }

      const resolution = await resolveSchemeName(childInput);
      const resolvedChildScheme = resolution.resolved || childInput;
      const lineageKey = normalizeText(resolvedChildScheme);
      if (context.lineage.has(lineageKey)) {
        return [];
      }

      const childPortfolio = await fetchFundPortfolio(resolvedChildScheme, {
        depth: context.depth + 1,
        lineage: new Set([...context.lineage, lineageKey]),
      });

      return childPortfolio.holdings.map((childHolding) => ({
        ...childHolding,
        holdingsPct: ((Number(holding.holdings) || 0) * childHolding.holdingsPct) / 100,
        sourceFunds: uniqueStrings([
          resolvedChildScheme,
          ...(childHolding.sourceFunds || []),
        ]),
      }));
    } catch {
      return [];
    }
  });

  return aggregateHoldingRecords(expanded.flat());
}

async function fetchFundPortfolio(schemeName, context = {}) {
  const key = schemeName.trim().toLowerCase();
  const cached = getCachedValue(cache.portfolio, key);
  if (cached) {
    return cached;
  }

  const result = await postFormJson(
    "https://www.adityarajcapital.com/mutual-funds-research/getPortfolioAnalysis",
    { scheme_amfi: schemeName },
    {
      Origin: "https://www.adityarajcapital.com",
      Referer: "https://www.adityarajcapital.com/mutual-funds-research/fund-card",
      "X-Requested-With": "XMLHttpRequest",
    },
    "fund portfolio",
  );

  const schemePortfolioList = ensureArray(result?.schemePortfolioAnalysisResponse?.schemePortfolioList)
    .filter((holding) => Number(holding.holdings) > 0);
  const assetAllocation =
    result?.schemePortfolioAnalysisResponse?.assetAllocationMap &&
    typeof result.schemePortfolioAnalysisResponse.assetAllocationMap === "object"
      ? result.schemePortfolioAnalysisResponse.assetAllocationMap
      : {};
  const portfolioDate =
    String(schemePortfolioList[0]?.portfolio_date || "").trim() || null;
  const directEquityHoldings = aggregateHoldingRecords(
    schemePortfolioList
      .filter(isEquityHolding)
      .map(buildHoldingRecord),
  );

  let holdingSource = "direct";
  let holdings = directEquityHoldings;
  let expandedFromFunds = [];

  if (holdings.length === 0) {
    const fundHoldings = schemePortfolioList.filter(isFundHolding);
    if (fundHoldings.length > 0 && (context.depth || 0) < 2) {
      holdings = await expandFundHoldings(fundHoldings, {
        depth: context.depth || 0,
        lineage: context.lineage || new Set([normalizeText(schemeName)]),
      });

      if (holdings.length > 0) {
        holdingSource = "look-through";
        expandedFromFunds = uniqueStrings(
          fundHoldings.map((holding) => holding.instrument || holding.issuer_name),
        );
      }
    }
  }

  const finalHoldings = [...holdings].sort((left, right) => right.holdingsPct - left.holdingsPct);
  const dominantAsset = describeDominantAsset(assetAllocation);

  const payload = {
    assetAllocation,
    expandedFromFunds,
    holdingSource,
    holdings: finalHoldings,
    noEligibleHoldingsReason:
      finalHoldings.length === 0
        ? dominantAsset
          ? `Latest disclosed portfolio is dominated by ${dominantAsset}, so there are no listed equities to scan.`
          : "Latest disclosed portfolio has no listed equities to scan."
        : null,
    portfolioDate,
    topHoldings: finalHoldings.slice(0, 10),
  };

  setCachedValue(cache.portfolio, key, payload, TTL.portfolio);
  return payload;
}

function buildHoldingSearchQueries(holding) {
  const candidates = [
    holding.isin,
    holding.company,
    cleanCompanyName(holding.company),
    cleanCompanyName(holding.instrument),
  ];

  return [...new Set(candidates.map((item) => String(item || "").trim()).filter(Boolean))];
}

function chooseYahooQuote(quotes, holding, originalQuery) {
  const normalizedTarget = cleanCompanyName(holding.company) || normalizeText(holding.company);

  const scoredQuotes = ensureArray(quotes)
    .filter((quote) => quote.quoteType === "EQUITY" && ["NSI", "BSE"].includes(quote.exchange))
    .map((quote) => {
      const candidateName = cleanCompanyName(quote.longname || quote.shortname || "");
      let score = 0;

      score += quote.exchange === "NSI" ? 60 : 45;
      score += quote.symbol?.endsWith(".NS") ? 10 : 0;
      score += quote.symbol?.endsWith(".BO") ? 7 : 0;
      score += similarityScore(candidateName, normalizedTarget);
      score += originalQuery === holding.isin ? 35 : 0;

      return {
        quote,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);

  if (scoredQuotes.length === 0 || scoredQuotes[0].score < 60) {
    return null;
  }

  return scoredQuotes[0].quote;
}

async function resolveHoldingSymbol(holding) {
  const key = holding.isin || normalizeText(holding.company);
  const cached = getCachedValue(cache.symbol, key);
  if (cached !== undefined) {
    return cached;
  }

  if (holding.isin) {
    const nseSecurityMaster = await loadNseSecurityMaster();
    const nseMatch = nseSecurityMaster.get(holding.isin);

    if (nseMatch) {
      setCachedValue(cache.symbol, key, nseMatch, TTL.symbol);
      return nseMatch;
    }
  }

  const queries = buildHoldingSearchQueries(holding);

  for (const query of queries) {
    const search = await httpsGetJson(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
        query,
      )}&quotesCount=10&newsCount=0`,
      {
        Referer: "https://finance.yahoo.com/",
      },
      "Yahoo search",
    );

    const pickedQuote = chooseYahooQuote(search?.quotes, holding, query);
    if (pickedQuote) {
      const resolved = {
        exchange: pickedQuote.exchange,
        displayName: pickedQuote.longname || pickedQuote.shortname || holding.company,
        shortName: pickedQuote.shortname || holding.company,
        symbol: pickedQuote.symbol,
      };

      setCachedValue(cache.symbol, key, resolved, TTL.symbol);
      return resolved;
    }
  }

  setCachedValue(cache.symbol, key, null, TTL.quote);
  return null;
}

function fallbackPreviousClose(result) {
  const closes = ensureArray(result?.indicators?.quote?.[0]?.close).filter(
    (value) => Number.isFinite(value),
  );

  if (closes.length >= 2) {
    return closes[closes.length - 2];
  }

  return null;
}

async function fetchQuote(symbol, timeframe = "1d") {
  const cacheKey = `${symbol}:${timeframe}`;
  const cached = getCachedValue(cache.quote, cacheKey);
  if (cached) {
    return cached;
  }

  const range = timeframe === "1d" ? "2d" : "5d";
  
  const result = await httpsGetJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol,
    )}?interval=1d&range=${range}&includePrePost=false`,
    {
      Referer: "https://finance.yahoo.com/",
    },
    "Yahoo chart",
  );

  const chartResult = result?.chart?.result?.[0];
  if (!chartResult) {
    throw new Error(`No chart data returned for ${symbol}.`);
  }

  const meta = chartResult.meta || {};
  
  // Array of closing prices
  const closes = ensureArray(chartResult?.indicators?.quote?.[0]?.close).filter((value) => Number.isFinite(value));
  const opens = ensureArray(chartResult?.indicators?.quote?.[0]?.open).filter((value) => Number.isFinite(value));
  
  const currentPrice = Number(meta.regularMarketPrice) || closes.at(-1);

  // Timeframe calculation
  let previousClose = 0;
  if (timeframe === "1d") {
    // For 1-day dip, compare against yesterday's official close
    previousClose = Number(meta.chartPreviousClose) || (closes.length >= 2 ? closes.at(-2) : opens.at(0));
  } else {
    // For 5-day dip, compare against the oldest open price in the 5d period
    previousClose = opens.length > 0 ? opens.at(0) : (closes.length > 0 ? closes.at(0) : 0);
  }

  if (!Number.isFinite(previousClose) || !Number.isFinite(currentPrice)) {
    throw new Error(`Incomplete quote data returned for ${symbol}.`);
  }

  const quote = {
    symbol,
    company: meta.longName || meta.shortName || symbol,
    currency: meta.currency || "INR",
    currentPrice,
    previousClose,
    changePct: ((currentPrice - previousClose) / previousClose) * 100,
    exchange: meta.exchangeName || meta.fullExchangeName || null,
    marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };

  setCachedValue(cache.quote, cacheKey, quote, TTL.quote);
  return quote;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const currentIndex = cursor;
      cursor += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function analyzePortfolio(portfolioText, timeframe = "1d") {
  const parsedFunds = parsePortfolioText(portfolioText);
  const warnings = [
    "Portfolio composition is based on the latest disclosed fund holdings, not same-day AMC filings.",
    "Intraday prices come from Yahoo Finance's NSE/BSE quotes and can briefly lag the exchange feed.",
  ];

  const fundResults = await mapWithConcurrency(parsedFunds, 3, async (fund) => {
    try {
      const schemeResolution = await resolveSchemeName(fund.schemeInput);
      const schemeName = schemeResolution.resolved || fund.schemeInput;
      const portfolio = await fetchFundPortfolio(schemeName);

      if (portfolio.topHoldings.length === 0) {
        throw new Error(
          portfolio.noEligibleHoldingsReason || `No listed equities found for ${schemeName}.`,
        );
      }

      return {
        allocation: fund.allocation,
        assetAllocation: portfolio.assetAllocation,
        expandedFromFunds: portfolio.expandedFromFunds,
        holdingSource: portfolio.holdingSource,
        lineNumber: fund.lineNumber,
        portfolioDate: portfolio.portfolioDate,
        portfolioWeight: fund.portfolioWeight,
        requestedSchemeName: fund.schemeInput,
        resolvedSchemeName: schemeName,
        suggestions: schemeResolution.suggestions,
        topHoldings: portfolio.topHoldings.map((holding) => ({
          ...holding,
          portfolioExposurePct: fund.portfolioWeight * holding.holdingsPct,
        })),
      };
    } catch (error) {
      return {
        error: error.message,
        lineNumber: fund.lineNumber,
        requestedSchemeName: fund.schemeInput,
      };
    }
  });

  const resolvedFunds = fundResults.filter((result) => !result.error);
  const fundErrors = fundResults.filter((result) => result.error);

  if (fundErrors.length > 0) {
    warnings.push(
      `${fundErrors.length} fund line(s) could not be processed and were skipped.`,
    );
  }

  if (resolvedFunds.length === 0) {
    const error = new Error(
      fundErrors[0]?.error || "No funds could be processed from the provided input.",
    );
    error.statusCode = 400;
    throw error;
  }

  const symbolLookup = new Map();
  const holdingsToResolve = [];

  resolvedFunds.forEach((fund) => {
    fund.topHoldings.forEach((holding) => {
      const key = holding.isin || normalizeText(holding.company);
      if (!symbolLookup.has(key)) {
        symbolLookup.set(key, {
          holding,
        });
        holdingsToResolve.push({ key, holding });
      }
    });
  });

  const symbolResolutions = await mapWithConcurrency(holdingsToResolve, 1, async ({ key, holding }) => {
    const resolved = await resolveHoldingSymbol(holding);
    return { key, resolved };
  });

  symbolResolutions.forEach(({ key, resolved }) => {
    symbolLookup.set(key, {
      ...symbolLookup.get(key),
      resolved,
    });
  });

  const uniqueSymbols = [...new Set(symbolResolutions.map((item) => item.resolved?.symbol).filter(Boolean))];
  const quoteEntries = await mapWithConcurrency(uniqueSymbols, 2, async (symbol) => {
    try {
      return {
        quote: await fetchQuote(symbol, timeframe),
        symbol,
      };
    } catch (error) {
      return {
        error: error.message,
        symbol,
      };
    }
  });

  const quoteMap = new Map();
  quoteEntries.forEach((entry) => {
    quoteMap.set(entry.symbol, entry.quote || null);
  });

  const rankedByHolding = new Map();
  const unresolvedHoldings = [];

  const funds = resolvedFunds.map((fund) => {
    const holdings = fund.topHoldings.map((holding) => {
      const key = holding.isin || normalizeText(holding.company);
      const symbolDetails = symbolLookup.get(key)?.resolved || null;
      const quote = symbolDetails ? quoteMap.get(symbolDetails.symbol) || null : null;

      if (!symbolDetails || !quote) {
        unresolvedHoldings.push({
          company: holding.company,
          fund: fund.resolvedSchemeName,
          reason: symbolDetails ? "Live quote unavailable" : "Ticker could not be resolved",
        });
      }

      const decoratedHolding = {
        ...holding,
        exchange: symbolDetails?.exchange || null,
        liveCompanyName: symbolDetails?.displayName || null,
        quote,
        symbol: symbolDetails?.symbol || null,
      };

      if (quote) {
        const keyForRanking = symbolDetails.symbol;
        const existing = rankedByHolding.get(keyForRanking) || {
          company: decoratedHolding.liveCompanyName || decoratedHolding.company,
          currentPrice: quote.currentPrice,
          changePct: quote.changePct,
          currency: quote.currency,
          exchange: quote.exchange,
          funds: [],
          marketTime: quote.marketTime,
          portfolioExposurePct: 0,
          previousClose: quote.previousClose,
          symbol: symbolDetails.symbol,
        };

        existing.portfolioExposurePct += decoratedHolding.portfolioExposurePct;
        existing.funds.push({
          exposurePct: decoratedHolding.portfolioExposurePct,
          fundName: fund.resolvedSchemeName,
          holdingPct: decoratedHolding.holdingsPct,
          schemeWeightPct: fund.portfolioWeight * 100,
        });

        rankedByHolding.set(keyForRanking, existing);
      }

      return decoratedHolding;
    });

    return {
      ...fund,
      topHoldings: holdings,
    };
  });

  const dipCandidates = [...rankedByHolding.values()]
    .filter((item) => item.changePct < 0)
    .sort((left, right) => {
      const byDrop = Math.abs(right.changePct) - Math.abs(left.changePct);
      if (byDrop !== 0) {
        return byDrop;
      }

      return right.portfolioExposurePct - left.portfolioExposurePct;
    });

  return {
    dipCandidates,
    funds,
    fundErrors,
    generatedAt: new Date().toISOString(),
    liveHoldingsCount: quoteEntries.filter((entry) => entry.quote).length,
    unresolvedHoldings,
    warnings,
  };
}

// ── Portfolio NAV Performance ──

const NAV_PERIODS = [
  ["today", 0],      // latest vs previous trading day
  ["yesterday", -1],  // previous day return
  ["1w", 7],
  ["2w", 14],
  ["1m", 30],
  ["3m", 90],
  ["6m", 180],
];

function parseNavDate(s) {
  const [dd, mm, yyyy] = s.split("-");
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
}

function navAtOrBefore(entries, targetDate) {
  for (const e of entries) {
    if (parseNavDate(e.date) <= targetDate) return Number(e.nav);
  }
  return null;
}

function calcNavReturns(entries) {
  if (!entries || entries.length < 2) return null;
  const latest = Number(entries[0].nav);
  if (latest <= 0) return null;
  const latestDt = parseNavDate(entries[0].date);
  const prev = Number(entries[1].nav);
  const ret = { nav: latest, nav_date: entries[0].date };
  if (prev > 0) ret.today = +((latest - prev) / prev * 100).toFixed(2);
  if (entries.length > 2) {
    const d2 = Number(entries[2].nav);
    if (d2 > 0) ret.yesterday = +((prev - d2) / d2 * 100).toFixed(2);
  }
  for (const [key, days] of NAV_PERIODS) {
    if (key === "today" || key === "yesterday") continue;
    const base = navAtOrBefore(entries, new Date(latestDt.getTime() - days * 864e5));
    if (base && base > 0) ret[key] = +((latest - base) / base * 100).toFixed(2);
  }
  return ret;
}

async function fetchPortfolioNav(entries) {
  const results = [];
  const toFetch = [];

  async function resolveNavSchemeMatch(lookupNames) {
    for (const name of lookupNames) {
      const found = findSchemeCode(name);
      if (found) {
        return {
          matchedFrom: name,
          schemeMatch: found,
        };
      }
    }

    for (const name of lookupNames) {
      const cacheKey = `nav-match:${normalizeText(name)}`;
      const cachedMatch = getCachedValue(cache.schemeSearch, cacheKey);
      if (cachedMatch) {
        return {
          matchedFrom: name,
          schemeMatch: cachedMatch,
        };
      }

      const queries = buildSchemeSearchQueries(name);
      for (const query of queries) {
        const suggestions = await searchSchemes(query);
        const picked = pickBestSchemeName(name, suggestions);
        const fallbackMatch = findSchemeCode(picked);
        if (fallbackMatch) {
          setCachedValue(cache.schemeSearch, cacheKey, fallbackMatch, TTL.schemeSearch);
          return {
            matchedFrom: name,
            schemeMatch: fallbackMatch,
          };
        }
      }
    }

    return null;
  }

  await mapWithConcurrency(entries, 5, async (entry) => {
    const requestedName = normalizeWhitespace(entry?.requestedSchemeName || entry?.scheme_name || "");
    const resolvedName = normalizeWhitespace(entry?.resolvedSchemeName || requestedName);
    const lookupNames = uniqueStrings([requestedName, resolvedName]);

    const resolution = await resolveNavSchemeMatch(lookupNames);
    const schemeMatch = resolution?.schemeMatch || null;
    const matchedFromName = resolution?.matchedFrom || null;
    const matchedFrom = matchedFromName === requestedName ? "requested" : matchedFromName === resolvedName ? "resolved" : null;

    if (!schemeMatch) {
      results.push({
        requested_scheme_name: requestedName,
        resolved_scheme_name: resolvedName,
        error: "No NAV match found",
        returns: {},
      });
      return;
    }

    const cached = getCachedValue(cache.nav, schemeMatch.code);
    if (cached) {
      results.push({
        requested_scheme_name: requestedName,
        resolved_scheme_name: resolvedName,
        scheme_code: schemeMatch.code,
        nav_scheme_name: schemeMatch.matchedName,
        nav_match_type: schemeMatch.matchType,
        nav_match_source: matchedFrom,
        returns: cached,
      });
      return;
    }

    toFetch.push({
      requestedName,
      resolvedName,
      schemeMatch,
      matchedFrom,
    });
  });

  if (toFetch.length > 0) {
    await mapWithConcurrency(toFetch, 10, async ({ requestedName, resolvedName, schemeMatch, matchedFrom }) => {
      try {
        const data = await httpsGetJson(
          `https://api.mfapi.in/mf/${schemeMatch.code}`,
          {},
          `NAV ${schemeMatch.code}`,
        );
        const navEntries = (data.data || []).slice(0, 400);
        const ret = calcNavReturns(navEntries);
        if (ret) setCachedValue(cache.nav, schemeMatch.code, ret, TTL.nav);
        results.push({
          requested_scheme_name: requestedName,
          resolved_scheme_name: resolvedName,
          scheme_code: schemeMatch.code,
          nav_scheme_name: schemeMatch.matchedName,
          nav_match_type: schemeMatch.matchType,
          nav_match_source: matchedFrom,
          returns: ret || {},
        });
      } catch {
        results.push({
          requested_scheme_name: requestedName,
          resolved_scheme_name: resolvedName,
          scheme_code: schemeMatch.code,
          nav_scheme_name: schemeMatch.matchedName,
          nav_match_type: schemeMatch.matchType,
          nav_match_source: matchedFrom,
          returns: {},
          error: "NAV history unavailable",
        });
      }
    });
  }

  return { funds: results, fetched_at: new Date().toISOString() };
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function sendStaticFile(res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, requestedPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const contentType = CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
    });
    res.end(data);
  } catch (error) {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    setCorsHeaders(req, res);
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok", app: "dip-buyer", ts: Math.floor(Date.now() / 1000) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/search-schemes") {
      const query = String(url.searchParams.get("q") || "").trim();
      if (query.length < 3) {
        sendJson(res, 200, { query, suggestions: [] });
        return;
      }

      const suggestions = await searchSchemes(query);
      sendJson(res, 200, {
        query,
        suggestions: suggestions.slice(0, 8),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ext-log") {
      const body = await readBody(req);
      const { message, level = "info" } = JSON.parse(body || "{}");
      const prefix = "[Extension]";
      if (level === "error") console.error(`\x1b[31m${prefix} ${message}\x1b[0m`);
      else if (level === "success") console.log(`\x1b[32m${prefix} ${message}\x1b[0m`);
      else console.log(`\x1b[36m${prefix} ${message}\x1b[0m`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ext-stash") {
      const body = await readBody(req);
      const { text } = JSON.parse(body || "{}");
      extensionStash = text;
      console.log(`\x1b[32m[Extension] Received and stashed ${text?.length || 0} characters of portfolio data.\x1b[0m`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ext-get") {
      const text = extensionStash;
      extensionStash = null; // consume it
      sendJson(res, 200, { text });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const analysis = await analyzePortfolio(payload.portfolioText || "", payload.timeframe || "1d");
      sendJson(res, 200, analysis);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/portfolio-nav") {
      const body = await readBody(req);
      const { schemes, funds } = JSON.parse(body || "{}");
      const portfolioFunds = Array.isArray(funds) ? funds : Array.isArray(schemes)
        ? schemes.map((scheme) => ({ scheme_name: scheme }))
        : [];
      if (portfolioFunds.length === 0) {
        sendJson(res, 400, { error: "No schemes provided" });
        return;
      }
      const results = await fetchPortfolioNav(portfolioFunds.slice(0, 100));
      sendJson(res, 200, results);
      return;
    }

    // ── Stock Matcher API endpoints ──
    if (req.method === "GET" && url.pathname === "/api/matcher/stocks/search") {
      const query = String(url.searchParams.get("q") || "").trim();
      sendJson(res, 200, stockData.searchStocks(query));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/matcher/search") {
      const body = await readBody(req);
      const data = JSON.parse(body || "{}");
      const selectedSymbols = (data.stocks || []).slice(0, 30);
      if (selectedSymbols.length === 0) {
        sendJson(res, 400, { error: "No stocks selected" });
        return;
      }

      let funds = stockData.getAllMutualFundsCached().filter((f) => f.holdings.length > 0);
      if (data.category) {
        funds = funds.filter((f) => f.category === data.category);
      }

      const preferredLookup = new Set(
        ensureArray(data.preferredFunds)
          .map(canonicalFundName)
          .filter(Boolean),
      );
      const preferredFundPool = preferredLookup.size
        ? funds.filter((fund) => isPreferredFundName(fund.scheme_name, preferredLookup))
        : [];

      const singleResults = findBestSingleFunds(funds, selectedSymbols, 30);
      const preferredSingleResults = preferredFundPool.length
        ? findBestSingleFunds(preferredFundPool, selectedSymbols, 30)
        : [];
      const hasFullCover = singleResults.some(
        (r) => r.matched_count === selectedSymbols.length
      );

      const maxFunds = data.max_funds;
      const bundles =
        typeof maxFunds === "number" && maxFunds >= 1 && maxFunds <= 10
          ? findOptimalBundles(funds, selectedSymbols, maxFunds)
          : findOptimalBundles(funds, selectedSymbols);

      const overlap = computeOverlap(singleResults.slice(0, 10), selectedSymbols);
      const coveredByPreferred = new Set(
        preferredSingleResults.flatMap((result) => result.matched_stocks.map((stock) => stock.symbol)),
      );
      const uncoveredSymbols = selectedSymbols.filter((symbol) => !coveredByPreferred.has(symbol));

      sendJson(res, 200, {
        selected_stocks: selectedSymbols,
        total_stocks: selectedSymbols.length,
        single_funds: singleResults,
        preferred_single_funds: preferredSingleResults,
        has_full_cover: hasFullCover,
        bundles,
        total_funds_scanned: funds.length,
        preferred_funds_scanned: preferredFundPool.length,
        uncovered_symbols: uncoveredSymbols,
        overlap_matrix: overlap,
      });
      return;
    }

    if (req.method === "GET") {
      await sendStaticFile(res, url.pathname);
      return;
    }

    sendJson(res, 404, { error: "Route not found." });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendJson(res, statusCode, {
      error: error.message || "Unexpected server error.",
    });
  }
});

if (require.main === module) {
  const bindHost = process.env.PORT ? "0.0.0.0" : SERVER_HOST;
  server.listen(PORT, bindHost, () => {
    console.log(`Indian MF Dip Buyer running on http://${bindHost}:${PORT}`);
  });
}

module.exports = {
  analyzePortfolio,
  buildSchemeSearchQueries,
  clearCaches,
  fetchFundPortfolio,
  parsePortfolioText,
  parseSchemeDescriptor,
  pickBestSchemeName,
  server,
};
