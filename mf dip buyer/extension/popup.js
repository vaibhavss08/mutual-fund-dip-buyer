const DEFAULT_BACKEND_BASE_URL = 'http://localhost:3000';

function parseProperties(rawContent) {
  return String(rawContent || '')
    .split(/\r?\n/)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return acc;
      }

      const separator = trimmed.indexOf('=');
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

function normalizeBaseUrl(value) {
  const cleaned = String(value || '').trim();
  return cleaned.replace(/\/+$/, '');
}

function buildApiUrl(baseUrl, path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

function buildLaunchUrl(baseUrl, text) {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/`);
  url.searchParams.set('ext', 'true');

  const hashParams = new URLSearchParams();
  hashParams.set('extPayload', text);
  url.hash = hashParams.toString();

  return url.toString();
}

async function loadBackendBaseUrl() {
  try {
    const response = await fetch(chrome.runtime.getURL('config.properties'), { cache: 'no-store' });
    if (!response.ok) {
      return DEFAULT_BACKEND_BASE_URL;
    }

    const raw = await response.text();
    const config = parseProperties(raw);
    return normalizeBaseUrl(config.BACKEND_BASE_URL) || DEFAULT_BACKEND_BASE_URL;
  } catch {
    return DEFAULT_BACKEND_BASE_URL;
  }
}

document.getElementById('extract-btn').addEventListener('click', async () => {
  const btn = document.getElementById('extract-btn');
  const statusEl = document.getElementById('status');
  let activeBackendBaseUrl = await loadBackendBaseUrl();

  btn.disabled = true;
  btn.textContent = 'Extracting...';

  const logStep = async (msg, isError = false) => {
    const color = isError ? 'red' : '#4B5563';
    statusEl.innerHTML += `<br/><span style="color:${color}">↳ ${msg}</span>`;

    try {
      await fetch(buildApiUrl(activeBackendBaseUrl, '/api/ext-log'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, level: isError ? 'error' : 'info' })
      });
    } catch (e) {
      // Server may be down or URL may be misconfigured.
    }
  };

  try {
    await logStep('Querying active tab...');
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const supportedSites = ['indmoney.com', 'mfcentral.com', 'kite.zerodha.com', 'coin.zerodha.com', 'groww.in'];
    const isSupportedSite = supportedSites.some(site => activeTab.url.includes(site));
    if (!isSupportedSite) {
      throw new Error('Unsupported site. Open one of: IndMoney, MFCentral, Coin/Zerodha, or Groww.');
    }
    await logStep(`Found matching tab: ${activeTab.url}`);

    await logStep('Executing content.js scraper...');
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['content.js']
    });

    const rawText = injectionResults[0].result;

    if (!rawText || rawText.trim().length === 0) {
      throw new Error('Could not find portfolio text on this page.');
    }
    await logStep(`Scraped ${rawText.length} characters of raw text.`);

    await logStep('Sending data to backend...');
    const postStash = async (baseUrl) => {
      try {
        const response = await fetch(buildApiUrl(baseUrl, '/api/ext-stash'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: rawText })
        });
        return { ok: response.ok, status: response.status, response };
      } catch (error) {
        return { ok: false, status: 0, error };
      }
    };

    let stashResult = await postStash(activeBackendBaseUrl);
    let fallbackResult = null;
    if (!stashResult.ok && activeBackendBaseUrl !== DEFAULT_BACKEND_BASE_URL) {
      await logStep(`Primary backend unreachable (${activeBackendBaseUrl}, status ${stashResult.status || 'network'}). Retrying localhost...`);
      fallbackResult = await postStash(DEFAULT_BACKEND_BASE_URL);
      if (fallbackResult.ok) {
        activeBackendBaseUrl = DEFAULT_BACKEND_BASE_URL;
        stashResult = fallbackResult;
        await logStep(`Fallback succeeded on ${DEFAULT_BACKEND_BASE_URL}.`);
      }
    }

    if (!stashResult.ok) {
      await logStep('Backend stash endpoint was unavailable. Opening the app with direct URL payload instead...');
    }

    if (stashResult.ok) {
      await logStep('Data stashed successfully.', false);
    }
    await logStep('Opening Dip Buyer app...');

    await chrome.tabs.create({
      url: buildLaunchUrl(activeBackendBaseUrl, rawText),
      active: true,
    });

    statusEl.innerHTML += '<br/><b style="color:#10B981">Extraction flow complete!</b>';
    statusEl.className = 'success';
  } catch (err) {
    await logStep(`Error: ${err.message}`, true);
    statusEl.className = 'error';
    btn.disabled = false;
    btn.textContent = 'Extract & Analyze';
  }
});
