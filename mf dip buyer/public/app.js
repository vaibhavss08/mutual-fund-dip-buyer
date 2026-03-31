const SAMPLE_PORTFOLIO = `ICICI Prudential Flexicap Fund - Growth | 250000
Parag Parikh Flexi Cap Fund | 400000
HDFC Flexi Cap Fund | 350000`;

// ── Strategy Configs ──
const STRATEGIES = {
  aggressive: {
    label: "Aggressive",
    minDipPct: 0.5,
    maxFunds: 5,
    dipWeight: 0.7,
    exposureWeight: 0.3,
    description: "Chasing the biggest drops across your portfolio",
  },
  balanced: {
    label: "Balanced",
    minDipPct: 1.0,
    maxFunds: 4,
    dipWeight: 0.5,
    exposureWeight: 0.5,
    description: "Balancing dip magnitude with portfolio exposure",
  },
  conservative: {
    label: "Conservative",
    minDipPct: 2.0,
    maxFunds: 3,
    dipWeight: 0.3,
    exposureWeight: 0.7,
    description: "Only meaningful dips in your core holdings",
  },
};

// ── DOM Elements ──
const portfolioText = document.querySelector("#portfolio-text");
const loadSampleButton = document.querySelector("#load-sample");
const analyzeButton = document.querySelector("#analyze-button");
const searchInput = document.querySelector("#scheme-search");
const schemeResults = document.querySelector("#scheme-results");
const statusBanner = document.querySelector("#status-banner");
const resultsSection = document.querySelector("#results");
const resultTabButtons = document.querySelectorAll("[data-result-tab]");
const resultPanels = document.querySelectorAll("[data-result-panel]");
const summaryGrid = document.querySelector("#summary-grid");
const analysisNotes = document.querySelector("#analysis-notes");
const dipRanking = document.querySelector("#dip-ranking");

const manualView = document.querySelector("#manual-view");

const modeCards = document.querySelector("#mode-cards");
const investAmountInput = document.querySelector("#invest-amount");
const generateRecsBtn = document.querySelector("#generate-recs");
const recOutput = document.querySelector("#rec-output");

const parsedFundsList = document.querySelector("#parsed-funds");
const parsedFundsCount = document.querySelector("#parsed-funds-count");
const timeframeBtns = document.querySelectorAll(".tf-btn");
const fundTabsContainer = document.querySelector("#fund-tabs");
const fundTabContents = document.querySelector("#fund-tab-contents");

// Extension elements
const extDataBanner = document.querySelector("#ext-data-banner");
const extFundCount = document.querySelector("#ext-fund-count");
const extShowRaw = document.querySelector("#ext-show-raw");

// Stock filter elements
const stockFilterSection = document.querySelector("#stock-filter");
const stockFilterList = document.querySelector("#stock-filter-list");
const filterSelectAll = document.querySelector("#filter-select-all");
const filterDeselectAll = document.querySelector("#filter-deselect-all");

// Stock add elements (inline search for manual stocks)
const stockAddSearch = document.querySelector("#stock-add-search");
const stockAddAC = document.querySelector("#stock-add-ac");
const stockAddTags = document.querySelector("#stock-add-tags");
const stockAddResults = document.querySelector("#stock-add-results");

// ── Formatters ──
const currencyFormatter = new Intl.NumberFormat("en-IN", {
  currency: "INR",
  maximumFractionDigits: 0,
  style: "currency",
});

const valueCurrencyFormatter = new Intl.NumberFormat("en-IN", {
  currency: "INR",
  maximumFractionDigits: 2,
  style: "currency",
});

const DEFAULT_INVESTMENT_AMOUNT = 10000;

// ── State ──
let parsedFunds = null;
let lastAnalysisData = null;
let currentMode = "aggressive";
let currentTimeframe = "1d";
let extensionDataLoaded = false;
let excludedStocks = new Set(); // stocks the user has deselected
let manualStocks = new Set();   // stocks manually added via search
let lastMatcherData = null;
let lastMatcherKey = "";
let activeResultTab = "overview";

// Manual view is always visible (no tab switching needed)


function formatAmountValue(amount) {
  return `\u20B9 ${Number(amount).toLocaleString("en-IN")}`;
}

// ── Strategy Mode Selector ──
modeCards.addEventListener("click", (evt) => {
  const chip = evt.target.closest(".mode-chip");
  if (!chip) return;
  modeCards.querySelectorAll(".mode-chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
  currentMode = chip.dataset.mode;
  maybeRefreshRecommendations();
});

function maybeRefreshRecommendations() {
  if (!lastAnalysisData) {
    return;
  }
  if (!recOutput.innerHTML.trim()) {
    return;
  }
  generateRecommendations();
}

function getEligibleDipCandidates(analysisData, config) {
  return (analysisData.dipCandidates || []).filter(
    (candidate) => Math.abs(candidate.changePct) >= config.minDipPct && !excludedStocks.has(candidate.symbol),
  );
}

function getManualOnlySymbols(analysisData) {
  const dippedSymbols = new Set((analysisData.dipCandidates || []).map((candidate) => candidate.symbol));
  return [...manualStocks].filter((symbol) => !dippedSymbols.has(symbol));
}

async function ensureMatcherInsights(analysisData, selectedSymbols) {
  if (!selectedSymbols.length) {
    return null;
  }

  const preferredFunds = (analysisData.funds || []).map((fund) => fund.resolvedSchemeName);
  const requestKey = JSON.stringify({
    preferredFunds: [...preferredFunds].sort(),
    stocks: [...selectedSymbols].sort(),
  });

  if (requestKey === lastMatcherKey && lastMatcherData) {
    return lastMatcherData;
  }

  const response = await fetch("/api/matcher/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      preferredFunds,
      stocks: selectedSymbols,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Unable to match funds for the selected stocks.");
  }

  lastMatcherKey = requestKey;
  lastMatcherData = payload;
  return payload;
}

function buildStockSignals(eligible, manualOnlySymbols, config) {
  const maxDip = eligible.length ? Math.max(...eligible.map((candidate) => Math.abs(candidate.changePct))) : 0;
  const maxExposure = eligible.length
    ? Math.max(...eligible.map((candidate) => candidate.portfolioExposurePct))
    : 0;
  const signals = new Map();

  eligible.forEach((candidate) => {
    const dipScore = maxDip > 0 ? Math.abs(candidate.changePct) / maxDip : 0;
    const exposureScore = maxExposure > 0 ? candidate.portfolioExposurePct / maxExposure : 0;
    const score = config.dipWeight * dipScore + config.exposureWeight * exposureScore;

    signals.set(candidate.symbol, {
      changePct: candidate.changePct,
      company: candidate.company,
      kind: "dip",
      score,
      symbol: candidate.symbol,
    });
  });

  const dipScores = [...signals.values()].map((signal) => signal.score);
  const manualBaseline = dipScores.length
    ? Math.max(dipScores.reduce((sum, score) => sum + score, 0) / dipScores.length * 0.8, 0.4)
    : 0.65;

  manualOnlySymbols.forEach((symbol) => {
    if (signals.has(symbol)) {
      return;
    }

    signals.set(symbol, {
      changePct: 0,
      company: symbol,
      kind: "manual",
      score: manualBaseline,
      symbol,
    });
  });

  return signals;
}

function weightToSignalFactor(weight) {
  const normalized = Math.min(Math.max(Number(weight) || 0, 0), 12);
  return 0.25 + (normalized / 12) * 0.75;
}

function upsertFundCandidate(pool, fundName, isExistingFund) {
  const existing = pool.get(fundName);
  if (existing) {
    existing.isExistingFund = existing.isExistingFund || isExistingFund;
    return existing;
  }

  const created = {
    fundName,
    isExistingFund,
    stocks: new Map(),
  };
  pool.set(fundName, created);
  return created;
}

function addStockToFundCandidate(pool, fundName, signal, matchedWeight, isExistingFund) {
  if (!fundName || !signal) {
    return;
  }

  const candidate = upsertFundCandidate(pool, fundName, isExistingFund);
  const contribution = signal.score * weightToSignalFactor(matchedWeight);
  const existingStock = candidate.stocks.get(signal.symbol);

  if (existingStock && existingStock.score >= contribution) {
    return;
  }

  candidate.stocks.set(signal.symbol, {
    changePct: signal.changePct,
    company: signal.company,
    isExistingFund,
    kind: signal.kind,
    matchedWeight: matchedWeight || 0,
    score: contribution,
    symbol: signal.symbol,
  });
}

function buildFundPools(analysisData, matcherData, stockSignals) {
  const existingPool = new Map();
  const externalPool = new Map();
  const existingFundNames = new Set((analysisData.funds || []).map((fund) => fund.resolvedSchemeName));

  (analysisData.funds || []).forEach((fund) => {
    (fund.topHoldings || []).forEach((holding) => {
      const signal = stockSignals.get(holding.symbol);
      if (!signal) {
        return;
      }

      addStockToFundCandidate(
        existingPool,
        fund.resolvedSchemeName,
        signal,
        holding.holdingsPct,
        true,
      );
    });
  });

  const ingestMatcherFunds = (results, preferredOnly = false) => {
    (results || []).forEach((fund) => {
      const fundName = fund.scheme_name;
      const isExistingFund = preferredOnly || existingFundNames.has(fundName);
      const targetPool = isExistingFund ? existingPool : externalPool;

      (fund.matched_stocks || []).forEach((stock) => {
        const signal = stockSignals.get(stock.symbol);
        if (!signal) {
          return;
        }

        addStockToFundCandidate(
          targetPool,
          fundName,
          signal,
          stock.weight,
          isExistingFund,
        );
      });
    });
  };

  ingestMatcherFunds(matcherData?.preferred_single_funds, true);
  ingestMatcherFunds(matcherData?.single_funds, false);

  (matcherData?.bundles || []).forEach((bundle) => {
    (bundle.funds || []).forEach((fund) => {
      const fundName = fund.scheme_name;
      const isExistingFund = existingFundNames.has(fundName);
      const targetPool = isExistingFund ? existingPool : externalPool;

      (fund.matched_stocks || []).forEach((stock) => {
        const signal = stockSignals.get(stock.symbol);
        if (!signal) {
          return;
        }

        addStockToFundCandidate(
          targetPool,
          fundName,
          signal,
          stock.weight,
          isExistingFund,
        );
      });
    });
  });

  return { existingPool, externalPool };
}

function getCandidateFit(candidate, remainingSymbols) {
  const matchedStocks = [...candidate.stocks.values()]
    .filter((stock) => remainingSymbols.has(stock.symbol))
    .sort((left, right) => right.score - left.score);

  const totalScore = matchedStocks.reduce((sum, stock) => sum + stock.score, 0);
  const dipCount = matchedStocks.filter((stock) => stock.kind === "dip").length;
  const totalWeight = matchedStocks.reduce((sum, stock) => sum + (stock.matchedWeight || 0), 0);

  return {
    dipCount,
    matchedStocks,
    totalScore,
    totalWeight,
  };
}

function isBetterFundFit(candidateFit, bestFit, candidate, bestCandidate) {
  if (!bestFit) {
    return true;
  }

  if (candidateFit.totalScore !== bestFit.totalScore) {
    return candidateFit.totalScore > bestFit.totalScore;
  }

  if (candidateFit.matchedStocks.length !== bestFit.matchedStocks.length) {
    return candidateFit.matchedStocks.length > bestFit.matchedStocks.length;
  }

  if (candidateFit.dipCount !== bestFit.dipCount) {
    return candidateFit.dipCount > bestFit.dipCount;
  }

  if (candidateFit.totalWeight !== bestFit.totalWeight) {
    return candidateFit.totalWeight > bestFit.totalWeight;
  }

  return candidate.fundName.localeCompare(bestCandidate.fundName) < 0;
}

function pickFundsFromPool(pool, remainingSymbols, maxFunds) {
  const selected = [];
  const usedFunds = new Set();

  while (selected.length < maxFunds && remainingSymbols.size > 0) {
    let bestCandidate = null;
    let bestFit = null;

    pool.forEach((candidate) => {
      if (usedFunds.has(candidate.fundName)) {
        return;
      }

      const fit = getCandidateFit(candidate, remainingSymbols);
      if (fit.matchedStocks.length === 0) {
        return;
      }

      if (isBetterFundFit(fit, bestFit, candidate, bestCandidate)) {
        bestCandidate = candidate;
        bestFit = fit;
      }
    });

    if (!bestCandidate || !bestFit) {
      break;
    }

    usedFunds.add(bestCandidate.fundName);
    bestFit.matchedStocks.forEach((stock) => remainingSymbols.delete(stock.symbol));

    selected.push({
      bundleScore: bestFit.totalScore,
      fundName: bestCandidate.fundName,
      isExistingFund: bestCandidate.isExistingFund,
      stocks: bestFit.matchedStocks,
    });
  }

  return selected;
}

function assignRecommendationAmounts(recommendations, totalAmount) {
  if (!recommendations.length) {
    return [];
  }

  const totalScore = recommendations.reduce((sum, recommendation) => {
    return sum + (recommendation.bundleScore > 0 ? recommendation.bundleScore : 0);
  }, 0);

  let remainingAmount = totalAmount;
  return recommendations
    .map((recommendation, index) => {
      const amount =
        index === recommendations.length - 1
          ? remainingAmount
          : Math.round(
              totalAmount *
                (totalScore > 0 ? recommendation.bundleScore / totalScore : 1 / recommendations.length),
            );

      remainingAmount -= amount;
      return {
        ...recommendation,
        amount,
        pct: totalAmount > 0 ? (amount / totalAmount) * 100 : 0,
        stocks: [...recommendation.stocks].sort((left, right) => right.score - left.score),
      };
    })
    .sort((left, right) => right.amount - left.amount);
}

// ── Strategy Engine ──
async function computeStrategy(analysisData, mode, totalAmount) {
  const config = STRATEGIES[mode];
  const eligible = getEligibleDipCandidates(analysisData, config);
  const manualOnlySymbols = getManualOnlySymbols(analysisData);

  if (eligible.length === 0 && manualOnlySymbols.length === 0) {
    return { recommendations: [], config, totalAmount };
  }

  const stockSignals = buildStockSignals(eligible, manualOnlySymbols, config);
  const selectedSymbols = [...stockSignals.keys()];
  const matcherData = await ensureMatcherInsights(analysisData, selectedSymbols);
  const { existingPool, externalPool } = buildFundPools(analysisData, matcherData, stockSignals);
  const remainingSymbols = new Set(selectedSymbols);

  const existingRecommendations = pickFundsFromPool(existingPool, remainingSymbols, config.maxFunds);
  const externalRecommendations =
    existingRecommendations.length < config.maxFunds
      ? pickFundsFromPool(
          externalPool,
          remainingSymbols,
          config.maxFunds - existingRecommendations.length,
        )
      : [];

  const selectedRecommendations = [...existingRecommendations, ...externalRecommendations];
  if (!selectedRecommendations.length) {
    return {
      recommendations: [],
      config,
      matcherData,
      totalAmount,
      unmatchedManualSymbols: manualOnlySymbols,
    };
  }

  const recommendations = assignRecommendationAmounts(selectedRecommendations, totalAmount);
  const coveredSymbols = new Set(
    recommendations.flatMap((recommendation) => recommendation.stocks.map((stock) => stock.symbol)),
  );

  return {
    recommendations,
    config,
    matcherData,
    totalAmount,
    eligibleCount: eligible.length,
    unmatchedManualSymbols: manualOnlySymbols.filter((symbol) => !coveredSymbols.has(symbol)),
  };
}

// ── Generate Recommendations ──
generateRecsBtn.addEventListener("click", generateRecommendations);

function parseAmountInput(raw) {
  const cleaned = String(raw || "").replace(/[₹,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function generateRecommendations() {
  if (!lastAnalysisData) {
    showStatus("Run a dip scan first.", "error");
    return;
  }

  const amount = parseAmountInput(investAmountInput.value) || DEFAULT_INVESTMENT_AMOUNT;
  if (!parseAmountInput(investAmountInput.value)) {
    investAmountInput.value = formatAmountValue(DEFAULT_INVESTMENT_AMOUNT);
  }

  showStatus("Building integrated buy recommendations...", "loading");
  try {
    const result = await computeStrategy(lastAnalysisData, currentMode, amount);
    hideStatus();
    renderRecommendations(result);
  } catch (error) {
    showStatus(error.message || "Failed to build recommendations.", "error");
  }
}

function renderRecommendations(result) {
  const { recommendations, config, unmatchedManualSymbols = [] } = result;

  if (recommendations.length === 0) {
    recOutput.innerHTML = `
      <div class="rec-section slide-up">
        <div class="no-recs">
          <div class="no-recs-icon">No signal</div>
          <p>No buy ideas cleared <strong>${config.label}</strong> mode after applying your stock filters${excludedStocks.size > 0 ? ` (${excludedStocks.size} stock(s) excluded)` : ""}.</p>
          <p>${unmatchedManualSymbols.length ? `No fund matches were found for: ${escapeHtml(unmatchedManualSymbols.join(", "))}.` : "Try a more aggressive profile or add a few manual stocks."}</p>
        </div>
      </div>`;
    return;
  }

  const maxPct = Math.max(...recommendations.map((r) => r.pct));
  const movePhrase = currentTimeframe === "5d" ? "over 5 days" : "today";

  const cards = recommendations
    .map((rec, index) => {
      const stockTags = rec.stocks
        .map((stock) => {
          const label = stock.kind === "manual"
            ? stock.isExistingFund
              ? "Held"
              : "New"
            : `${stock.changePct.toFixed(1)}%`;
          return `<span class="rec-stock-tag">${escapeHtml(stock.company)}<span class="tag-drop">${label}</span></span>`;
        })
        .join("");

      const dipStocks = rec.stocks.filter((stock) => stock.kind === "dip");
      const manualSelections = rec.stocks.filter((stock) => stock.kind === "manual");
      const reasonParts = [];

      if (dipStocks.length > 0) {
        const topDip = dipStocks.reduce(
          (best, stock) => (Math.abs(stock.changePct) > Math.abs(best.changePct) ? stock : best),
          dipStocks[0],
        );
        reasonParts.push(
          dipStocks.length === 1
            ? `${escapeHtml(topDip.company)} down ${Math.abs(topDip.changePct).toFixed(1)}% ${movePhrase}`
            : `${dipStocks.length} dipping holdings led by ${escapeHtml(topDip.company)} at ${topDip.changePct.toFixed(1)}%`,
        );
      }

      if (manualSelections.length > 0) {
        reasonParts.push(
          rec.isExistingFund
            ? `${manualSelections.length} manual pick(s) already covered in your portfolio funds`
            : `${manualSelections.length} manual pick(s) require a new external fund match`,
        );
      }

      const reason = reasonParts.join(" • ");

      const barWidth = maxPct > 0 ? (rec.pct / maxPct) * 100 : 0;

      return `
        <div class="rec-card buy-signal slide-up" style="animation-delay: ${index * 60}ms">
          <div class="rec-left">
            <div class="rec-fund-name" title="${escapeHtml(rec.fundName)}">${escapeHtml(rec.fundName)}</div>
            <div class="rec-fund-reason">${reason}</div>
            <div class="rec-stocks">${stockTags}</div>
          </div>
          <div class="rec-right">
            <div class="rec-pct">${rec.isExistingFund ? "Existing MF" : "New Fund"}</div>
            <div class="rec-amount">${currencyFormatter.format(rec.amount)}</div>
            <div class="rec-pct">${rec.pct.toFixed(1)}%</div>
          </div>
          <div class="rec-alloc-bar"><div class="rec-alloc-fill" style="width: ${barWidth}%"></div></div>
        </div>`;
    })
    .join("");

  recOutput.innerHTML = `
    <div class="rec-section slide-up">
      <div class="rec-section-header">
        <h3>Buy Recommendations</h3>
        <span class="rec-mode-badge ${currentMode}">${config.label}</span>
      </div>
      <div class="rec-grid">${cards}</div>
    </div>`;

  requestAnimationFrame(() => {
    recOutput.querySelectorAll(".rec-alloc-fill").forEach((bar) => {
      bar.style.width = bar.style.width;
    });
  });
}

// ── Stock Filter (selective buying) ──
function renderStockFilter(data) {
  // Always show the stock filter section so users can add manual stocks
  stockFilterSection.classList.remove("hidden");

  if (!data.dipCandidates || data.dipCandidates.length === 0) {
    stockFilterList.innerHTML = `<p style="color:var(--text-3);font-size:0.85rem;padding:8px 0;">No declining holdings found. Use the search below to add stocks manually.</p>`;
    return;
  }

  stockFilterList.innerHTML = data.dipCandidates
    .map((c) => {
      const isExcluded = excludedStocks.has(c.symbol);
      return `<label class="stock-filter__item${isExcluded ? " excluded" : ""}" data-symbol="${escapeHtml(c.symbol)}">
        <input type="checkbox" ${isExcluded ? "" : "checked"} />
        <span class="stock-filter__name" title="${escapeHtml(c.company)}">${escapeHtml(c.company)}</span>
        <span class="stock-filter__dip">${c.changePct.toFixed(1)}%</span>
      </label>`;
    })
    .join("");

  // Attach listeners
  stockFilterList.querySelectorAll("input[type='checkbox']").forEach((cb) => {
    cb.addEventListener("change", () => {
      const item = cb.closest(".stock-filter__item");
      const symbol = item.dataset.symbol;
      if (cb.checked) {
        excludedStocks.delete(symbol);
        item.classList.remove("excluded");
      } else {
        excludedStocks.add(symbol);
        item.classList.add("excluded");
      }
      if (manualStocks.size > 0) runStockOptimizer();
      maybeRefreshRecommendations();
    });
  });
}

filterSelectAll.addEventListener("click", () => {
  excludedStocks.clear();
  stockFilterList.querySelectorAll("input[type='checkbox']").forEach((cb) => {
    cb.checked = true;
    cb.closest(".stock-filter__item").classList.remove("excluded");
  });
  maybeRefreshRecommendations();
});

filterDeselectAll.addEventListener("click", () => {
  stockFilterList.querySelectorAll("input[type='checkbox']").forEach((cb) => {
    const symbol = cb.closest(".stock-filter__item").dataset.symbol;
    excludedStocks.add(symbol);
    cb.checked = false;
    cb.closest(".stock-filter__item").classList.add("excluded");
  });
  maybeRefreshRecommendations();
});

// ── Helpers ──
function showStatus(message, type = "loading") {
  statusBanner.textContent = message;
  statusBanner.className = `status-banner ${type}`;
}

function hideStatus() {
  statusBanner.className = "status-banner hidden";
  statusBanner.textContent = "";
}

function formatPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "NA";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatExposure(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "NA";
  return `${value.toFixed(2)}%`;
}

function formatMoveClass(value) {
  if (value < 0) return "negative";
  if (value > 0) return "positive";
  return "flat";
}

function formatTimeframeLabel(timeframe = currentTimeframe, short = false) {
  if (timeframe === "5d") return short ? "5D" : "last 5 trading days";
  return short ? "1D" : "today";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isLikelyNavNoiseName(value) {
  const text = String(value || "").trim();
  if (!text) {
    return true;
  }

  return (
    /^showing\s+\d+\s+funds?$/i.test(text) ||
    /^\d+\s+funds?$/i.test(text) ||
    /^current value$/i.test(text) ||
    /^invested$/i.test(text) ||
    /^xirr$/i.test(text) ||
    /^absolute returns$/i.test(text)
  );
}

function appendSchemeToPortfolio(name) {
  tabManual.click();
  // If extension data was hiding the textarea, show it
  if (extensionDataLoaded) {
    portfolioText.classList.remove("ext-hidden");
    extDataBanner.classList.add("hidden");
    extensionDataLoaded = false;
  }
  const existingSchemes = portfolioText.value
    .split(/\r?\n/)
    .map((line) => line.split("|")[0].trim().toUpperCase())
    .filter(Boolean);

  if (existingSchemes.includes(name.trim().toUpperCase())) {
    portfolioText.focus();
    return;
  }

  const currentValue = portfolioText.value.trim();
  portfolioText.value = currentValue ? `${currentValue}\n${name}` : name;
  portfolioText.focus();
}

// ── Scheme Search ──
function renderSchemeSuggestions(items) {
  if (!items.length) {
    schemeResults.className = "scheme-results empty-results";
    schemeResults.textContent = "No matching schemes found.";
    return;
  }
  schemeResults.className = "scheme-results";
  schemeResults.innerHTML = items
    .map((item) => {
      const escaped = escapeHtml(item);
      return `<div class="scheme-result fade-in">
        <div>
          <div class="scheme-result-name">${escaped}</div>
          <div class="scheme-result-meta">Add to scan list</div>
        </div>
        <button type="button" data-scheme="${escaped}">Add</button>
      </div>`;
    })
    .join("");
  schemeResults.querySelectorAll("button[data-scheme]").forEach((button) => {
    button.addEventListener("click", () => appendSchemeToPortfolio(button.dataset.scheme));
  });
}

let searchTimer = null;
searchInput.addEventListener("input", () => {
  const query = searchInput.value.trim();
  window.clearTimeout(searchTimer);
  if (query.length < 3) {
    schemeResults.className = "scheme-results hidden-results";
    return;
  }
  schemeResults.className = "scheme-results empty-results";
  schemeResults.textContent = "Searching...";
  searchTimer = window.setTimeout(async () => {
    try {
      const response = await fetch(`/api/search-schemes?q=${encodeURIComponent(query)}`);
      const payload = await response.json();
      renderSchemeSuggestions(payload.suggestions || []);
    } catch {
      schemeResults.className = "scheme-results empty-results";
      schemeResults.textContent = "Search failed.";
    }
  }, 280);
});

// Hide search results when clicking outside
document.addEventListener("click", (e) => {
  if (!searchInput.contains(e.target) && !schemeResults.contains(e.target)) {
    schemeResults.className = "scheme-results hidden-results";
  }
});
searchInput.addEventListener("focus", () => {
  if (searchInput.value.trim().length >= 3) {
    // Re-show results on focus if there was a query
    if (schemeResults.innerHTML && schemeResults.classList.contains("hidden-results")) {
      schemeResults.classList.remove("hidden-results");
    }
  }
});

// ── Results Rendering ──
function renderSummary(data) {
  const deepestDip = data.dipCandidates[0];
  const totalDipping = data.dipCandidates.length;
  const totalFunds = (data.funds?.length || 0) + (data.fundErrors?.length || 0);
  const tfLabel = formatTimeframeLabel(currentTimeframe, true);
  summaryGrid.innerHTML = `
    <div class="summary-stat fade-in">
      <p class="summary-stat__label">Funds</p>
      <p class="summary-stat__value">${totalFunds}</p>
      <p class="summary-stat__foot">${data.funds.length} scanned successfully</p>
    </div>
    <div class="summary-stat fade-in">
      <p class="summary-stat__label">Live Holdings</p>
      <p class="summary-stat__value">${data.liveHoldingsCount}</p>
      <p class="summary-stat__foot">Real-time priced</p>
    </div>
    <div class="summary-stat fade-in">
      <p class="summary-stat__label">Deepest ${tfLabel} Dip</p>
      <p class="summary-stat__value" style="color:var(--red)">${deepestDip ? formatPercent(deepestDip.changePct) : "—"}</p>
      <p class="summary-stat__foot">${deepestDip ? escapeHtml(deepestDip.company) : "No declines"}</p>
    </div>
    <div class="summary-stat fade-in">
      <p class="summary-stat__label">Dipping</p>
      <p class="summary-stat__value">${totalDipping}</p>
      <p class="summary-stat__foot">${tfLabel} · ${data.unresolvedHoldings.length} unresolved</p>
    </div>`;
}

function renderDipRanking(data) {
  if (!data.dipCandidates.length) {
    dipRanking.innerHTML = `<div class="empty-state">No declining holdings found ${currentTimeframe === "5d" ? "over 5 days" : "today"}.</div>`;
    return;
  }
  const moveLabel = currentTimeframe === "5d" ? "5D Move" : "Today";
  const rows = data.dipCandidates
    .map((candidate, index) => {
      const fundList = candidate.funds
        .map((fund) => `${escapeHtml(fund.fundName)} (${formatExposure(fund.exposurePct)})`)
        .join("<br />");
      return `<tr>
        <td>${index + 1}</td>
        <td><strong>${escapeHtml(candidate.company)}</strong><br /><span class="small-text">${escapeHtml(candidate.symbol)}</span></td>
        <td class="numeric ${formatMoveClass(candidate.changePct)}">${formatPercent(candidate.changePct)}</td>
        <td class="numeric">${valueCurrencyFormatter.format(candidate.currentPrice)}</td>
        <td class="numeric">${formatExposure(candidate.portfolioExposurePct)}</td>
        <td>${fundList}</td>
        <td><button class="btn btn--ghost btn--xs find-funds-link" onclick="addStockFromDipTable('${escapeHtml(candidate.symbol)}')">+ Add</button></td>
      </tr>`;
    })
    .join("");

  dipRanking.innerHTML = `
    <div class="table-wrap fade-in">
      <table>
        <thead><tr><th>#</th><th>Company</th><th class="numeric">${moveLabel}</th><th class="numeric">Price</th><th class="numeric">Exposure</th><th>Found In</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderHoldingsTable(holdings) {
  const moveLabel = currentTimeframe === "5d" ? "5D Move" : "Today";
  const rows = holdings
    .map((holding) => {
      const move = holding.quote?.changePct;
      const subLabel =
        holding.sourceFunds?.length > 0
          ? `via ${escapeHtml(holding.sourceFunds.join(", "))}`
          : escapeHtml(holding.symbol || "Unresolved");
      return `<tr>
        <td><strong>${escapeHtml(holding.company)}</strong><br /><span class="small-text">${subLabel}</span></td>
        <td class="numeric">${formatExposure(holding.holdingsPct)}</td>
        <td class="numeric">${formatExposure(holding.portfolioExposurePct)}</td>
        <td class="numeric ${typeof move === "number" ? formatMoveClass(move) : ""}">${typeof move === "number" ? formatPercent(move) : "NA"}</td>
      </tr>`;
    })
    .join("");

  return `<div class="table-wrap"><table>
    <thead><tr><th>Holding</th><th class="numeric">Fund Wt</th><th class="numeric">Exposure</th><th class="numeric">${moveLabel}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderParsedFunds(data) {
  if (!data.funds || !data.funds.length) {
    if (parsedFundsCount) parsedFundsCount.textContent = "0 items";
    parsedFundsList.innerHTML = `<span style="color:var(--text-3)">No funds parsed.</span>`;
    return;
  }

  if (parsedFundsCount) parsedFundsCount.textContent = `${data.funds.length} items`;

  parsedFundsList.innerHTML = data.funds.map((fund) => {
    const sourceLabel = fund.holdingSource === "look-through" ? "FOF" : "Equity";
    const changed = fund.requestedSchemeName && fund.requestedSchemeName !== fund.resolvedSchemeName;
    return `<div class="resolved-tag ${fund.holdingSource === "look-through" ? "look-through" : ""}">
      <span class="resolved-tag__name">${escapeHtml(fund.resolvedSchemeName)}</span>
      <span class="resolved-tag__type">${sourceLabel}</span>
      ${changed ? '<span class="resolved-tag__match">Adjusted</span>' : '<span class="resolved-tag__match resolved-tag__match--ok">Exact</span>'}
      <span class="resolved-tag__weight">${formatExposure(fund.portfolioWeight * 100)}</span>
    </div>`;
  }).join("");
}

function renderFundBreakdown(data) {
  if (!data.funds.length) {
    fundTabsContainer.innerHTML = "";
    fundTabContents.innerHTML = "";
    return;
  }

  fundTabsContainer.innerHTML = data.funds
    .map((fund, index) => `
      <button class="fund-tab-btn ${index === 0 ? "active" : ""}" data-index="${index}">
        ${escapeHtml(fund.resolvedSchemeName)}
      </button>`)
    .join("");

  fundTabContents.innerHTML = data.funds
    .map((fund, index) => `
      <div class="fund-tab-content ${index === 0 ? "active" : ""}" data-content="${index}">
        <p class="fund-meta">
          Requested as <code>${escapeHtml(fund.requestedSchemeName)}</code> &middot;
          Matched to <code>${escapeHtml(fund.resolvedSchemeName)}</code> &middot;
          ${fund.holdingSource === "look-through" ? `Look-through via <strong>${fund.expandedFromFunds?.length || 0}</strong> underlying fund(s)` : "Direct equity"} &middot;
          Weight: <strong>${formatExposure(fund.portfolioWeight * 100)}</strong> &middot;
          Date: ${escapeHtml(fund.portfolioDate || "NA")}
        </p>
        ${renderHoldingsTable(fund.topHoldings)}
      </div>`)
    .join("");

  const tabBtns = fundTabsContainer.querySelectorAll(".fund-tab-btn");
  const tabPanels = fundTabContents.querySelectorAll(".fund-tab-content");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      tabPanels.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const target = fundTabContents.querySelector(`[data-content="${btn.dataset.index}"]`);
      if (target) target.classList.add("active");
    });
  });
}

function renderAnalysisNotes(data) {
  analysisNotes.classList.add("hidden");
  analysisNotes.innerHTML = "";
  // Section removed for production: no skipped lines, warnings, or details shown
}

function setActiveResultTab(tabId) {
  activeResultTab = tabId;
  resultTabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.resultTab === tabId);
  });
  resultPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.resultPanel === tabId);
  });
}

function wireResultTabs() {
  resultTabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setActiveResultTab(button.dataset.resultTab);
    });
  });
}

// ── Analysis ──
async function runAnalysis() {
  const rawText = portfolioText.value.trim();
  if (!rawText) {
    showStatus("Add at least one mutual fund scheme.", "error");
    return;
  }

  const activeTimeBtn = document.querySelector(".tf-btn.active");
  currentTimeframe = activeTimeBtn ? activeTimeBtn.dataset.time : "1d";

  analyzeButton.disabled = true;
  showStatus(
    `Resolving schemes and fetching ${currentTimeframe === "5d" ? "5-day" : "today's"} moves...`,
    "loading",
  );
  resultsSection.classList.add("hidden");
  analysisNotes.classList.add("hidden");
  analysisNotes.innerHTML = "";
  recOutput.innerHTML = "";
  excludedStocks.clear();
  lastMatcherData = null;
  lastMatcherKey = "";

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ portfolioText: rawText, timeframe: currentTimeframe }),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(
        response.status === 404 || response.status === 502 || response.status === 503
          ? "Server is waking up — please wait a few seconds and try again."
          : `Server returned an unexpected response (${response.status}). Please try again.`
      );
    }
    if (!response.ok) throw new Error(payload.error || "Analysis failed.");

    lastAnalysisData = payload;

    renderSummary(payload);
    renderParsedFunds(payload);
    renderDipRanking(payload);
    renderFundBreakdown(payload);
    renderAnalysisNotes(payload);
    renderStockFilter(payload);
    renderManualTags(); // re-render manual stock tags + re-run optimizer if any

    // Fetch NAV performance for portfolio funds
    const navFunds = [
      ...(payload.funds || []).map((fund) => ({
        requestedSchemeName: fund.requestedSchemeName,
        resolvedSchemeName: fund.resolvedSchemeName,
      })),
      ...(payload.fundErrors || []).map((fund) => ({
        requestedSchemeName: fund.requestedSchemeName,
        resolvedSchemeName: fund.requestedSchemeName,
      })),
    ].filter((fund) => !isLikelyNavNoiseName(fund.requestedSchemeName));
    if (navFunds.length > 0) fetchPortfolioNav(navFunds);

    resultsSection.classList.remove("hidden");
    setActiveResultTab("overview");
    hideStatus();

    // Auto-generate recs if amount is set
    const amount = parseAmountInput(investAmountInput.value);
    if (amount && payload.dipCandidates.length > 0) {
        const result = await computeStrategy(payload, currentMode, amount);
        renderRecommendations(result);
    }

    resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showStatus(error.message || "Analysis failed.", "error");
  } finally {
    analyzeButton.disabled = false;
  }
}

// ── Event Listeners ──
loadSampleButton.addEventListener("click", () => {
  // If extension data was hiding the textarea, show it
  if (extensionDataLoaded) {
    portfolioText.classList.remove("ext-hidden");
    extDataBanner.classList.add("hidden");
    extensionDataLoaded = false;
  }
  portfolioText.value = SAMPLE_PORTFOLIO;
});

analyzeButton.addEventListener("click", runAnalysis);

timeframeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.classList.contains("active")) return;
    timeframeBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (portfolioText.value.trim().length > 0) {
      runAnalysis();
    }
  });
});

// Format amount with commas
investAmountInput.addEventListener("input", () => {
  const raw = investAmountInput.value.replace(/[^0-9]/g, "");
  if (raw) {
    investAmountInput.value = formatAmountValue(raw);
  }
  maybeRefreshRecommendations();
});

// Extension "Show raw text" toggle
extShowRaw.addEventListener("click", () => {
  if (portfolioText.classList.contains("ext-hidden")) {
    portfolioText.classList.remove("ext-hidden");
    extShowRaw.textContent = "Hide raw text";
  } else {
    portfolioText.classList.add("ext-hidden");
    extShowRaw.textContent = "Show raw text";
  }
});

// ── Stock Add: Autocomplete + Tags + Optimizer ──
let stockAcIdx = -1;
let stockAcTimer = null;

stockAddSearch.addEventListener("input", () => {
  clearTimeout(stockAcTimer);
  stockAcTimer = setTimeout(fetchStockAC, 150);
});

stockAddSearch.addEventListener("keydown", (e) => {
  const items = stockAddAC.querySelectorAll(".m-ac-item");
  if (e.key === "ArrowDown") { e.preventDefault(); stockAcIdx = Math.min(stockAcIdx + 1, items.length - 1); highlightStockAC(items); }
  else if (e.key === "ArrowUp") { e.preventDefault(); stockAcIdx = Math.max(stockAcIdx - 1, 0); highlightStockAC(items); }
  else if (e.key === "Enter") { e.preventDefault(); if (stockAcIdx >= 0 && items[stockAcIdx]) items[stockAcIdx].click(); else if (items.length) items[0].click(); }
  else if (e.key === "Escape") { closeStockAC(); }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".stock-add__search-wrap")) closeStockAC();
});

async function fetchStockAC() {
  const q = stockAddSearch.value.trim();
  if (q.length < 1) { closeStockAC(); return; }
  try {
    const res = await fetch("/api/matcher/stocks/search?q=" + encodeURIComponent(q));
    const data = await res.json();
    stockAddAC.innerHTML = "";
    stockAcIdx = -1;
    if (!data.length) { closeStockAC(); return; }
    data.forEach((s) => {
      const d = document.createElement("div");
      d.className = "m-ac-item";
      d.innerHTML = `<span class="m-ac-sym">${escapeHtml(s.symbol)}</span><span class="m-ac-name">${escapeHtml(s.name)}</span><span class="m-ac-sector">${escapeHtml(s.sector)}</span>`;
      d.addEventListener("click", () => addManualStock(s.symbol));
      stockAddAC.appendChild(d);
    });
    stockAddAC.classList.add("show");
  } catch (_) {
    closeStockAC();
  }
}

function highlightStockAC(items) {
  items.forEach((el, i) => el.classList.toggle("active", i === stockAcIdx));
  if (items[stockAcIdx]) items[stockAcIdx].scrollIntoView({ block: "nearest" });
}

function closeStockAC() {
  stockAddAC.classList.remove("show");
  stockAcIdx = -1;
}

function addManualStock(sym) {
  // If this stock is already in dipCandidates, just re-enable it in the filter
  if (lastAnalysisData?.dipCandidates?.some((c) => c.symbol === sym)) {
    excludedStocks.delete(sym);
    const item = stockFilterList.querySelector(`[data-symbol="${sym}"]`);
    if (item) {
      const cb = item.querySelector("input[type='checkbox']");
      if (cb) cb.checked = true;
      item.classList.remove("excluded");
    }
    closeStockAC();
    stockAddSearch.value = "";
    stockAddSearch.focus();
    return;
  }

  if (manualStocks.has(sym)) { closeStockAC(); stockAddSearch.value = ""; return; }
  manualStocks.add(sym);
  renderManualTags();
  stockAddSearch.value = "";
  closeStockAC();
  stockAddSearch.focus();
  maybeRefreshRecommendations();
}

function removeManualStock(sym) {
  manualStocks.delete(sym);
  renderManualTags();
  if (manualStocks.size === 0) stockAddResults.classList.add("hidden");
  maybeRefreshRecommendations();
}

function renderManualTags() {
  stockAddTags.innerHTML = "";
  if (manualStocks.size === 0) return;
  manualStocks.forEach((sym) => {
    const t = document.createElement("span");
    t.className = "m-tag";
    t.innerHTML = `${escapeHtml(sym)} <span class="m-tag-remove" data-sym="${escapeHtml(sym)}">\u2715</span>`;
    stockAddTags.appendChild(t);
  });
  stockAddTags.querySelectorAll(".m-tag-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeManualStock(btn.dataset.sym));
  });

  // Auto-search when tags change and there are manual stocks
  if (manualStocks.size > 0) runStockOptimizer();
}

// Global helper for dip table "Add" buttons
window.addStockFromDipTable = function (sym) {
  addManualStock(sym);
  stockFilterSection.scrollIntoView({ behavior: "smooth", block: "start" });
};

// ── Stock Optimizer: Find best funds for all selected stocks ──
async function runStockOptimizer() {
  if (!lastAnalysisData || manualStocks.size === 0) {
    stockAddResults.classList.add("hidden");
    return;
  }

  const allStocks = [...manualStocks];

  if (allStocks.length === 0) {
    stockAddResults.classList.add("hidden");
    return;
  }

  stockAddResults.classList.remove("hidden");
  stockAddResults.innerHTML = `<div class="stock-add__loading"><p>Checking whether your current mutual funds already cover these manual stocks...</p></div>`;

  try {
    const data = await ensureMatcherInsights(lastAnalysisData, allStocks);
    renderOptimizerResults(data);
  } catch (e) {
    stockAddResults.innerHTML = `<div class="m-empty"><p>Failed to check stock coverage. ${escapeHtml(e.message)}</p></div>`;
  }
}

function formatAUM(v) {
  if (v >= 1000) return (v / 1000).toFixed(1) + "K";
  return v.toFixed(0);
}

function renderOptimizerResults(data) {
  const preferredFunds = data.preferred_single_funds || [];
  const uncoveredSymbols = data.uncovered_symbols || [];
  const preferredExamples = preferredFunds.slice(0, 3).map((fund) => fund.scheme_name);
  const coveredSymbols = new Set(
    preferredFunds.flatMap((fund) => fund.matched_stocks.map((stock) => stock.symbol)),
  );

  const summary = [];
  summary.push(`<span><strong>${manualStocks.size}</strong> manual stock(s)</span>`);
  summary.push(`<span><strong>${coveredSymbols.size}</strong> already covered by your current funds</span>`);
  if (uncoveredSymbols.length) {
    summary.push(`<span><strong>${uncoveredSymbols.length}</strong> may need an external fund</span>`);
  }

  let html = `<div class="stock-add__summary">${summary.join("")}</div>`;
  if (preferredExamples.length) {
    html += `<p>Your existing mutual funds already covering these picks: <strong>${escapeHtml(preferredExamples.join(", "))}</strong>.</p>`;
  }

  if (uncoveredSymbols.length) {
    html += `<p>Buy Recommendations will only pull in a new external fund if needed for: <strong>${escapeHtml(uncoveredSymbols.join(", "))}</strong>.</p>`;
  } else {
    html += `<p>All selected manual stocks can be routed through funds you already hold.</p>`;
  }

  stockAddResults.innerHTML = html;
}

// ── Portfolio NAV Performance ──
let navPerfData = [];
let navSortCol = "today";
let navSortDir = "desc";
const NAV_RET_COLS = ["today", "yesterday", "1w", "2w", "1m", "3m", "6m"];

async function fetchPortfolioNav(funds) {
  const body = document.getElementById("nav-perf-body");
  const loading = document.getElementById("nav-perf-loading");
  if (!funds || funds.length === 0) {
    body.innerHTML = '<div class="empty-state">No resolved funds to show.</div>';
    return;
  }
  loading.style.display = "";
  body.innerHTML = "";
  body.appendChild(loading);

  try {
    const res = await fetch("/api/portfolio-nav", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ funds }),
    });
    const data = await res.json();
    navPerfData = data.funds || [];
    renderNavPerf();
  } catch (e) {
    body.innerHTML = `<div class="empty-state">Failed to fetch NAV data: ${escapeHtml(e.message)}</div>`;
  }
}

function renderNavPerf() {
  const body = document.getElementById("nav-perf-body");
  if (navPerfData.length === 0) {
    body.innerHTML = '<div class="empty-state">No NAV data available.</div>';
    return;
  }

  const dir = navSortDir === "asc" ? 1 : -1;
  const sorted = [...navPerfData].sort((a, b) => {
    if (navSortCol === "nav") {
      const leftNav = (a.returns || {}).nav ?? -Infinity;
      const rightNav = (b.returns || {}).nav ?? -Infinity;
      return dir * (leftNav - rightNav);
    }
    if (navSortCol === "requested_scheme_name") {
      return dir * (a.requested_scheme_name || "").localeCompare(b.requested_scheme_name || "");
    }
    const va = (a.returns || {})[navSortCol] ?? -Infinity;
    const vb = (b.returns || {})[navSortCol] ?? -Infinity;
    return dir * (va - vb);
  });

  const thClass = (col) => {
    if (navSortCol !== col) return "";
    return navSortDir === "asc" ? " sorted-asc" : " sorted-desc";
  };

  const retCell = (v) => {
    if (v == null) return '<td class="nav-num nav-flat">—</td>';
    const cls = v > 0 ? "nav-pos" : v < 0 ? "nav-neg" : "nav-flat";
    const s = v > 0 ? "+" : "";
    return `<td class="nav-num ${cls}">${s}${v.toFixed(2)}%</td>`;
  };

  const rows = sorted.map((f, i) => {
    const r = f.returns || {};
    const requestedName = f.requested_scheme_name || f.resolved_scheme_name || f.nav_scheme_name || "Unknown fund";
    const matchNote = f.error
      ? `<span class="nav-match nav-match--error">${escapeHtml(f.error)}</span>`
      : f.nav_scheme_name && f.nav_scheme_name !== requestedName
        ? `<span class="nav-match">NAV from ${escapeHtml(f.nav_scheme_name)}</span>`
        : `<span class="nav-match nav-match--ok">NAV matched</span>`;
    return `<tr>
      <td class="nav-num" style="color:var(--text-3)">${i + 1}</td>
      <td class="nav-fund-name" title="${escapeHtml(requestedName)}"><strong>${escapeHtml(requestedName)}</strong><br><span class="nav-sub">${matchNote}</span></td>
      <td class="nav-num">${r.nav != null ? `<span class="nav-val">${r.nav.toFixed(2)}</span>` : '<span class="nav-flat">—</span>'}</td>
      ${retCell(r.today)}${retCell(r.yesterday)}${retCell(r["1w"])}${retCell(r["2w"])}${retCell(r["1m"])}${retCell(r["3m"])}${retCell(r["6m"])}
    </tr>`;
  }).join("");

  body.innerHTML = `<div class="nav-perf-table"><table>
    <thead><tr>
      <th style="width:32px;cursor:default">#</th>
      <th data-navcol="requested_scheme_name" class="${thClass("requested_scheme_name")}">Fund Name</th>
      <th data-navcol="nav" class="nav-num${thClass("nav")}">NAV</th>
      <th data-navcol="today" class="nav-num${thClass("today")}">Today</th>
      <th data-navcol="yesterday" class="nav-num${thClass("yesterday")}">Yest.</th>
      <th data-navcol="1w" class="nav-num${thClass("1w")}">1W</th>
      <th data-navcol="2w" class="nav-num${thClass("2w")}">2W</th>
      <th data-navcol="1m" class="nav-num${thClass("1m")}">1M</th>
      <th data-navcol="3m" class="nav-num${thClass("3m")}">3M</th>
      <th data-navcol="6m" class="nav-num${thClass("6m")}">6M</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;

  // Wire header clicks
  body.querySelectorAll("th[data-navcol]").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.navcol;
      if (navSortCol === col) navSortDir = navSortDir === "desc" ? "asc" : "desc";
      else { navSortCol = col; navSortDir = NAV_RET_COLS.includes(col) || col === "nav" ? "desc" : "asc"; }
      document.getElementById("nav-sort-col").value = navSortCol;
      document.getElementById("nav-sort-dir").value = navSortDir;
      renderNavPerf();
    });
  });
}

function wireNavControls() {
  document.getElementById("nav-sort-col").addEventListener("change", (e) => { navSortCol = e.target.value; renderNavPerf(); });
  document.getElementById("nav-sort-dir").addEventListener("change", (e) => { navSortDir = e.target.value; renderNavPerf(); });
}

// ── Extension Data Handover (On Page Load) ──
function applyExtensionPortfolioText(text) {
  tabManual.click();
  portfolioText.value = text;

  extensionDataLoaded = true;
  portfolioText.classList.add("ext-hidden");
  extDataBanner.classList.remove("hidden");

  const lines = text.split("\n").filter((line) => line.trim().length > 10);
  extFundCount.textContent = `${lines.length} lines of portfolio data extracted`;

  window.history.replaceState({}, document.title, "/");
  setTimeout(() => runAnalysis(), 100);
}

window.addEventListener("DOMContentLoaded", async () => {
  if (!investAmountInput.value.trim()) {
    investAmountInput.value = formatAmountValue(DEFAULT_INVESTMENT_AMOUNT);
  }
  wireResultTabs();
  wireNavControls();

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("ext") === "true") {
    try {
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const directPayload = hashParams.get("extPayload");

      if (directPayload) {
        applyExtensionPortfolioText(directPayload);
        hideStatus();
        return;
      }

      showStatus("Retrieving portfolio from extension...", "loading");
      const res = await fetch("/api/ext-get");
      const data = await res.json();
      hideStatus();

      if (data && data.text) {
        applyExtensionPortfolioText(data.text);
      }
    } catch (e) {
      console.error("Failed to retrieve extension stash", e);
      hideStatus();
    }
  }
});
