/**
 * MF Stock Matcher Optimization Engine.
 * Port of mf stock matcher/optimizer.py
 *
 * Finds mutual funds that maximize exposure to user-selected stocks.
 * Supports single-fund matching and multi-fund bundle optimization.
 */

/**
 * Generate all combinations of `size` elements from `arr`.
 */
function* combinations(arr, size) {
  if (size === 1) {
    for (const item of arr) yield [item];
    return;
  }
  for (let i = 0; i <= arr.length - size; i++) {
    for (const rest of combinations(arr.slice(i + 1), size - 1)) {
      yield [arr[i], ...rest];
    }
  }
}

/**
 * Compare two numeric arrays lexicographically (like Python tuple comparison).
 * Returns positive if a > b, negative if a < b, 0 if equal.
 */
function compareTuples(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/**
 * Score a mutual fund based on how well it matches the selected stocks.
 */
function scoreFund(fund, selectedSymbols) {
  const selectedSet = new Set(selectedSymbols);
  const matched = [];
  for (const h of fund.holdings) {
    if (selectedSet.has(h.symbol)) {
      matched.push({ symbol: h.symbol, weight: h.weight });
    }
  }
  const totalExposure = matched.reduce((sum, m) => sum + m.weight, 0);
  const coverage = selectedSymbols.length > 0
    ? matched.length / selectedSymbols.length
    : 0;

  return {
    scheme_name: fund.scheme_name,
    category: fund.category,
    amc: fund.amc,
    aum_cr: fund.aum_cr || 0,
    matched_stocks: matched,
    matched_count: matched.length,
    total_stocks: selectedSymbols.length,
    total_exposure: Math.round(totalExposure * 100) / 100,
    coverage: Math.round(coverage * 1000) / 10,
    all_holdings: fund.holdings,
  };
}

/**
 * Find the best individual mutual funds for selected stocks.
 * Sorted by coverage first, then by total exposure.
 */
function findBestSingleFunds(funds, selectedSymbols, topN = 20) {
  if (!selectedSymbols || selectedSymbols.length === 0) return [];

  const scored = [];
  for (const fund of funds) {
    const result = scoreFund(fund, selectedSymbols);
    if (result.matched_count > 0) {
      scored.push(result);
    }
  }

  scored.sort((a, b) => {
    if (b.matched_count !== a.matched_count) return b.matched_count - a.matched_count;
    return b.total_exposure - a.total_exposure;
  });

  return scored.slice(0, topN);
}

/**
 * Find optimal bundles via exhaustive enumeration on pre-filtered candidates.
 *
 * Strategies:
 *   1. Balanced Exposure – maximize the weakest stock's exposure (maximin)
 *   2. Maximum Exposure  – maximize total aggregate weight
 *   3. Most Compact      – fewest funds with best coverage
 */
function findOptimalBundles(funds, selectedSymbols, maxBundleSize = null) {
  if (!selectedSymbols || selectedSymbols.length === 0) return [];

  const selectedSet = new Set(selectedSymbols);
  const nStocks = selectedSet.size;
  if (maxBundleSize === null) {
    maxBundleSize = Math.min(nStocks, 5);
  }

  // Pre-compute per-fund coverage and exposure
  const fundData = [];
  for (let i = 0; i < funds.length; i++) {
    const fund = funds[i];
    const holdingsMap = {};
    for (const h of fund.holdings) {
      holdingsMap[h.symbol] = h.weight;
    }
    const covered = new Set();
    for (const sym of selectedSet) {
      if (holdingsMap[sym] !== undefined) covered.add(sym);
    }
    if (covered.size > 0) {
      const weights = {};
      let totalExposure = 0;
      for (const s of covered) {
        weights[s] = holdingsMap[s];
        totalExposure += holdingsMap[s];
      }
      fundData.push({
        index: i,
        fund,
        covered,
        coveredCount: covered.size,
        weights,
        totalExposure,
      });
    }
  }

  if (fundData.length === 0) return [];

  // Three independent candidate rankings
  const byCoverage = [...fundData].sort((a, b) => {
    if (b.coveredCount !== a.coveredCount) return b.coveredCount - a.coveredCount;
    return b.totalExposure - a.totalExposure;
  });

  const byExposure = [...fundData].sort((a, b) => {
    if (b.totalExposure !== a.totalExposure) return b.totalExposure - a.totalExposure;
    return b.coveredCount - a.coveredCount;
  });

  // Per-stock best: for each selected stock, top 10 funds by that stock's weight
  const perStockTop = [];
  const psSeen = new Set();
  for (const sym of selectedSet) {
    const bestFor = fundData
      .filter((fd) => fd.covered.has(sym))
      .sort((a, b) => b.weights[sym] - a.weights[sym]);
    for (const fd of bestFor.slice(0, 10)) {
      if (!psSeen.has(fd.index)) {
        psSeen.add(fd.index);
        perStockTop.push(fd);
      }
    }
  }

  const SIZE_LIMITS = { 1: fundData.length, 2: 120, 3: 50, 4: 25, 5: 20 };

  // Trackers: [sortKey, combo, coveredSet, perStockDict]
  let bestBalanced = null;
  let bestExp = null;
  let bestCompact = null;

  for (let size = 1; size <= maxBundleSize; size++) {
    const lim = SIZE_LIMITS[size] || 20;

    // Merge three pools, deduplicate
    const seenIdx = new Set();
    const merged = [];
    for (const fd of [...byCoverage.slice(0, lim), ...byExposure.slice(0, lim), ...perStockTop]) {
      if (!seenIdx.has(fd.index)) {
        seenIdx.add(fd.index);
        merged.push(fd);
      }
    }

    for (const combo of combinations(merged, size)) {
      const rawPerStock = {};
      const covered = new Set();
      for (const fd of combo) {
        for (const sym of fd.covered) covered.add(sym);
        for (const [sym, w] of Object.entries(fd.weights)) {
          rawPerStock[sym] = (rawPerStock[sym] || 0) + w;
        }
      }

      const covCount = covered.size;

      // Effective exposure = raw_sum / bundle_size (equal allocation assumption).
      // This prevents larger bundles from appearing better just because they add
      // up more weights without actually giving more per-stock exposure.
      const effVals = [...selectedSet].map(s => (rawPerStock[s] || 0) / size);
      const expTotal = effVals.reduce((s, v) => s + v, 0);
      const minStockExp = effVals.length > 0 ? Math.min(...effVals) : 0;

      // Strategy 1 – Balanced Exposure
      const kBal = [covCount, minStockExp, expTotal, -size];
      if (bestBalanced === null || compareTuples(kBal, bestBalanced[0]) > 0) {
        bestBalanced = [kBal, combo, covered, { ...rawPerStock }];
      }

      // Strategy 2 – Maximum Exposure
      const kExp = [covCount, expTotal, -size];
      if (bestExp === null || compareTuples(kExp, bestExp[0]) > 0) {
        bestExp = [kExp, combo, covered, { ...rawPerStock }];
      }

      // Strategy 3 – Most Compact
      const kComp = [covCount, -size, minStockExp, expTotal];
      if (bestCompact === null || compareTuples(kComp, bestCompact[0]) > 0) {
        bestCompact = [kComp, combo, covered, { ...rawPerStock }];
      }
    }
  }

  // Assemble results, skip duplicates
  const bundles = [];
  const seenNames = new Set();

  const candidates = [
    [
      "Balanced Exposure",
      "Maximizes the weakest stock\u2019s exposure \u2014 no weak links",
      bestBalanced,
    ],
    [
      "Maximum Exposure",
      "Maximizes total portfolio weight across all your stocks",
      bestExp,
    ],
  ];

  // Only show Most Compact if genuinely different
  if (bestCompact !== null) {
    const compactSize = bestCompact[1].length;
    const otherSizes = new Set();
    if (bestBalanced) otherSizes.add(bestBalanced[1].length);
    if (bestExp) otherSizes.add(bestExp[1].length);

    const compactNames = new Set(bestCompact[1].map((fd) => fd.fund.scheme_name));
    const balancedNames = bestBalanced
      ? new Set(bestBalanced[1].map((fd) => fd.fund.scheme_name))
      : new Set();
    const expNames = bestExp
      ? new Set(bestExp[1].map((fd) => fd.fund.scheme_name))
      : new Set();

    const setsEqual = (a, b) =>
      a.size === b.size && [...a].every((x) => b.has(x));

    const maxOther = otherSizes.size > 0 ? Math.max(...otherSizes) : compactSize + 1;
    if (
      compactSize < maxOther ||
      (!setsEqual(compactNames, balancedNames) && !setsEqual(compactNames, expNames))
    ) {
      const nFunds = bestCompact[1].length;
      const desc =
        nFunds === 1
          ? "Single fund with highest balanced exposure"
          : `Best ${nFunds}-fund combination with balanced exposure`;
      candidates.push(["Most Compact", desc, bestCompact]);
    }
  }

  for (const [label, desc, result] of candidates) {
    if (result === null) continue;
    const [, combo, covered, perStock] = result;
    const names = [...combo.map((fd) => fd.fund.scheme_name)].sort().join("|");
    if (seenNames.has(names)) continue;
    seenNames.add(names);

    const bundleFunds = combo.map((fd) =>
      scoreFund(fd.fund, [...selectedSet])
    );

    const bundleSize = combo.length;
    const perStockList = [...selectedSet].sort().map((sym) => ({
      symbol: sym,
      // Effective exposure = allocation-weighted; for equal split = raw / bundle_size
      exposure: Math.round(((perStock[sym] || 0) / bundleSize) * 100) / 100,
    }));

    const totalExp = Math.round(
      perStockList.reduce((s, v) => s + v.exposure, 0) * 100
    ) / 100;
    const minExp = Math.round(
      (perStockList.length > 0 ? Math.min(...perStockList.map(s => s.exposure)) : 0) * 100
    ) / 100;

    const missingStocks = [...selectedSet].filter((s) => !covered.has(s)).sort();

    bundles.push({
      strategy: label,
      description: desc,
      funds: bundleFunds,
      total_coverage: Math.round((covered.size / nStocks) * 1000) / 10,
      total_exposure: totalExp,
      min_stock_exposure: minExp,
      per_stock_exposure: perStockList,
      stocks_covered: [...covered].sort(),
      stocks_missing: missingStocks,
    });
  }

  return bundles;
}

/**
 * Compute which funds share which selected stocks (overlap matrix).
 * Port of app.py _compute_overlap().
 */
function computeOverlap(topFunds, selectedSymbols) {
  const stockToFunds = {};
  for (const s of selectedSymbols) {
    stockToFunds[s] = [];
    for (const f of topFunds) {
      for (const m of f.matched_stocks) {
        if (m.symbol === s) {
          stockToFunds[s].push({ fund: f.scheme_name, weight: m.weight });
          break;
        }
      }
    }
  }
  return stockToFunds;
}

module.exports = {
  scoreFund,
  findBestSingleFunds,
  findOptimalBundles,
  computeOverlap,
};
