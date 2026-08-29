// ---------------------------------------------------------------------------
// Human Capital as an Alpha Signal
// Post module deliverable, Generative AI in Finance, Data Science Masters.
//
// Design rules carried over from the course reference application:
//   1. Every number shown to the user is computed here in JavaScript. The
//      language model writes prose only, it never calculates anything.
//   2. Booleans are named first, then compared explicitly against true.
//   3. Every conditional uses a brace delimited block.
//   4. No em dashes in comments or interface strings.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Universe. Screened on workforce quality first (appearance in at least two of
// Great Place to Work, Glassdoor Best Places to Work, JUST Capital workers
// ranking), then capped at six names per sector so the optimiser cannot
// collapse the whole portfolio into information technology.
// ---------------------------------------------------------------------------
const UNIVERSE = [
    { ticker: 'MSFT', name: 'Microsoft', sector: 'Information Technology' },
    { ticker: 'NVDA', name: 'NVIDIA', sector: 'Information Technology' },
    { ticker: 'ADBE', name: 'Adobe', sector: 'Information Technology' },
    { ticker: 'INTU', name: 'Intuit', sector: 'Information Technology' },
    { ticker: 'ACN', name: 'Accenture', sector: 'Information Technology' },
    { ticker: 'CSCO', name: 'Cisco Systems', sector: 'Information Technology' },
    { ticker: 'JNJ', name: 'Johnson & Johnson', sector: 'Health Care' },
    { ticker: 'LLY', name: 'Eli Lilly', sector: 'Health Care' },
    { ticker: 'ISRG', name: 'Intuitive Surgical', sector: 'Health Care' },
    { ticker: 'ABBV', name: 'AbbVie', sector: 'Health Care' },
    { ticker: 'AXP', name: 'American Express', sector: 'Financials' },
    { ticker: 'MA', name: 'Mastercard', sector: 'Financials' },
    { ticker: 'PGR', name: 'Progressive', sector: 'Financials' },
    { ticker: 'COST', name: 'Costco', sector: 'Consumer' },
    { ticker: 'PG', name: 'Procter & Gamble', sector: 'Consumer' },
    { ticker: 'NKE', name: 'Nike', sector: 'Consumer' },
    { ticker: 'MAR', name: 'Marriott', sector: 'Consumer' },
    { ticker: 'CMG', name: 'Chipotle', sector: 'Consumer' },
    { ticker: 'DE', name: 'Deere', sector: 'Industrials / Utilities' },
    { ticker: 'NEE', name: 'NextEra Energy', sector: 'Industrials / Utilities' },
];

// SPY is a reference series only. It is never optimised over, exactly as in
// the course R scripts where the benchmark is kept in a separate object.
const BENCHMARK = 'SPY';

const TRADING_DAYS = 252;
const LOOKBACK_DAYS = 505;        // roughly two years of trading days
const SECTOR_CAP = 0.35;
const CREDITS_PER_MINUTE = 8;     // Twelve Data free tier limit
const WEIGHT_TOLERANCE = 0.0002;  // same sanity check tolerance as the R scripts

// Application state. Kept in one object so the snapshot export is a single
// serialisation and nothing can drift out of sync.
const state = {
    prices: {},        // ticker -> array of { date, open, high, low, close, volume }
    source: null,      // provenance string shown to the user
    fetchedAt: null,
    weights: null,
    metrics: null,
    signals: null,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function el(id) {
    return document.getElementById(id);
}

function setStatus(message, isError) {
    const node = el('status');
    node.textContent = message;
    const errorRequested = isError === true;
    if (errorRequested === true) {
        node.classList.add('error');
    } else {
        node.classList.remove('error');
    }
}

function logLine(message) {
    const node = el('progress-log');
    const line = document.createElement('div');
    line.textContent = message;
    node.appendChild(line);
    node.scrollTop = node.scrollHeight;
}

function clearLog() {
    el('progress-log').innerHTML = '';
}

function pct(value, digits) {
    const places = digits === undefined ? 2 : digits;
    return (value * 100).toFixed(places) + '%';
}

function money(value) {
    return '$' + Math.round(value).toLocaleString('en-US');
}

function sleep(milliseconds) {
    return new Promise(function (resolve) {
        setTimeout(resolve, milliseconds);
    });
}

function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Data retrieval, Twelve Data time_series.
//
// Twelve Data returns permissive CORS headers, so the browser calls it
// directly with no proxy. The binding constraint is the free tier allowance of
// eight credits per minute. One symbol costs one credit, so 21 series cannot
// be requested in a single burst. Symbols are batched eight at a time and the
// queue waits between batches.
// ---------------------------------------------------------------------------

async function fetchBatch(symbols, apiKey) {
    const symbolList = symbols.join(',');
    const url = 'https://api.twelvedata.com/time_series'
        + '?symbol=' + encodeURIComponent(symbolList)
        + '&interval=1day'
        + '&outputsize=' + LOOKBACK_DAYS
        + '&apikey=' + encodeURIComponent(apiKey);

    const response = await fetch(url);
    const body = await response.text();

    let raw;
    try {
        raw = JSON.parse(body);
    } catch (parseError) {
        throw new Error('Twelve Data returned something that is not JSON: ' + body.slice(0, 200));
    }

    // A single symbol request returns the series at the top level. A multi
    // symbol request returns an object keyed by ticker. Normalise both shapes.
    const isSingle = symbols.length === 1;
    const keyed = isSingle === true ? { [symbols[0]]: raw } : raw;

    // A whole batch can fail as one, for example on a bad key or a rate limit.
    const batchFailed = raw && raw.status === 'error';
    if (batchFailed === true) {
        throw new Error(raw.message || 'Twelve Data rejected the request');
    }

    const results = {};
    for (const symbol of symbols) {
        const entry = keyed[symbol];
        const entryMissing = entry === undefined || entry === null;
        if (entryMissing === true) {
            results[symbol] = { ok: false, reason: 'no data returned' };
            continue;
        }
        const entryFailed = entry.status === 'error';
        if (entryFailed === true) {
            results[symbol] = { ok: false, reason: entry.message || 'error' };
            continue;
        }
        const values = entry.values || [];
        const valuesEmpty = values.length === 0;
        if (valuesEmpty === true) {
            results[symbol] = { ok: false, reason: 'empty series' };
            continue;
        }
        // Twelve Data sends newest first. Everything downstream expects oldest
        // to newest, matching the ordering the R lesson scripts rely on.
        const bars = values
            .map(function (b) {
                return {
                    date: b.datetime,
                    open: Number(b.open),
                    high: Number(b.high),
                    low: Number(b.low),
                    close: Number(b.close),
                    volume: Number(b.volume),
                };
            })
            .filter(function (b) {
                return Number.isNaN(b.close) === false;
            })
            .sort(function (a, b) {
                return a.date < b.date ? -1 : 1;
            });
        results[symbol] = { ok: true, bars: bars };
    }
    return results;
}

async function fetchAll() {
    const apiKey = el('twelvedata-key').value.trim();
    const keyMissing = apiKey.length === 0;
    if (keyMissing === true) {
        setStatus('Enter your Twelve Data API key first.', true);
        return;
    }

    clearLog();
    state.prices = {};
    const symbols = UNIVERSE.map(function (u) { return u.ticker; }).concat([BENCHMARK]);
    const batches = chunk(symbols, CREDITS_PER_MINUTE);

    setStatus('Fetching ' + symbols.length + ' series in ' + batches.length + ' batches. This takes about two minutes.');

    let retrieved = 0;
    const failures = [];

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        logLine('Batch ' + (i + 1) + ' of ' + batches.length + ': requesting ' + batch.join(', '));

        try {
            const results = await fetchBatch(batch, apiKey);
            for (const symbol of batch) {
                const result = results[symbol];
                const succeeded = result && result.ok === true;
                if (succeeded === true) {
                    state.prices[symbol] = result.bars;
                    retrieved = retrieved + 1;
                    logLine('  ' + symbol + ': ' + result.bars.length + ' bars');
                } else {
                    failures.push(symbol);
                    logLine('  ' + symbol + ': failed, ' + (result ? result.reason : 'unknown'));
                }
            }
        } catch (batchError) {
            for (const symbol of batch) {
                failures.push(symbol);
            }
            logLine('  batch failed: ' + batchError.message);
        }

        const moreBatchesRemain = i < batches.length - 1;
        if (moreBatchesRemain === true) {
            logLine('Waiting 61 seconds for the rate limit window to reset.');
            await sleep(61000);
        }
    }

    const anyFailures = failures.length > 0;
    if (anyFailures === true) {
        logLine('Excluded from the optimisation: ' + failures.join(', '));
    }

    state.source = 'Live retrieval from Twelve Data';
    state.fetchedAt = new Date().toISOString();
    el('save-snapshot').disabled = false;

    setStatus('Retrieved ' + retrieved + ' of ' + symbols.length + ' series.', retrieved < 10);
    rebuild();
}

// ---------------------------------------------------------------------------
// Snapshot handling.
//
// The snapshot is not shipped pre-filled, because inventing price data and
// labelling it as market data would be dishonest. Instead: fetch live once,
// export the snapshot, commit the file. From then on the application has a
// reproducible offline path for the presentation, and the file records the
// date the data was actually retrieved.
// ---------------------------------------------------------------------------

async function loadSnapshot() {
    setStatus('Loading bundled snapshot.');
    try {
        const response = await fetch('./snapshot.json');
        const notFound = response.ok === false;
        if (notFound === true) {
            setStatus('No snapshot.json in the repository yet. Fetch live data once, then use Export snapshot and commit the file.', true);
            return;
        }
        const payload = await response.json();
        state.prices = payload.prices;
        state.source = 'Bundled snapshot, retrieved ' + (payload.fetchedAt || 'date not recorded');
        state.fetchedAt = payload.fetchedAt;
        el('save-snapshot').disabled = false;
        setStatus('Snapshot loaded. ' + Object.keys(state.prices).length + ' series.');
        rebuild();
    } catch (loadError) {
        setStatus('Could not load the snapshot: ' + loadError.message, true);
    }
}

function saveSnapshot() {
    const payload = { fetchedAt: state.fetchedAt, prices: state.prices };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'snapshot.json';
    link.click();
    URL.revokeObjectURL(url);
    setStatus('Snapshot downloaded. Commit it to the repository root as snapshot.json.');
}

// ---------------------------------------------------------------------------
// Returns and alignment.
//
// Simple (discrete) returns are used throughout, matching the course scripts.
// The portfolio return is then exactly the weighted sum of asset returns,
// which is the assumption the optimiser relies on. Only dates present for
// every surviving ticker are kept, so each day's weighted sum is complete.
// ---------------------------------------------------------------------------

function buildReturns(tickers) {
    const dateSets = tickers.map(function (t) {
        return new Set(state.prices[t].map(function (b) { return b.date; }));
    });

    let commonDates = state.prices[tickers[0]].map(function (b) { return b.date; });
    for (const dateSet of dateSets) {
        commonDates = commonDates.filter(function (d) { return dateSet.has(d); });
    }
    commonDates.sort();

    const closes = {};
    for (const ticker of tickers) {
        const byDate = new Map();
        for (const bar of state.prices[ticker]) {
            byDate.set(bar.date, bar.close);
        }
        closes[ticker] = commonDates.map(function (d) { return byDate.get(d); });
    }

    const returns = {};
    for (const ticker of tickers) {
        const series = closes[ticker];
        const r = [];
        for (let i = 1; i < series.length; i++) {
            r.push(series[i] / series[i - 1] - 1);
        }
        returns[ticker] = r;
    }

    return { dates: commonDates.slice(1), returns: returns, closes: closes };
}

function mean(values) {
    let total = 0;
    for (const v of values) {
        total = total + v;
    }
    return total / values.length;
}

function stdev(values) {
    const m = mean(values);
    let sum = 0;
    for (const v of values) {
        sum = sum + (v - m) * (v - m);
    }
    // Sample standard deviation, divide by n minus 1.
    return Math.sqrt(sum / (values.length - 1));
}

function covarianceMatrix(tickers, returns) {
    const n = tickers.length;
    const means = tickers.map(function (t) { return mean(returns[t]); });
    const observations = returns[tickers[0]].length;
    const matrix = [];
    for (let i = 0; i < n; i++) {
        matrix.push(new Array(n).fill(0));
    }
    for (let i = 0; i < n; i++) {
        for (let j = i; j < n; j++) {
            let sum = 0;
            const ri = returns[tickers[i]];
            const rj = returns[tickers[j]];
            for (let k = 0; k < observations; k++) {
                sum = sum + (ri[k] - means[i]) * (rj[k] - means[j]);
            }
            const cov = sum / (observations - 1);
            matrix[i][j] = cov;
            matrix[j][i] = cov;
        }
    }
    return matrix;
}

function matrixTimesVector(matrix, vector) {
    return matrix.map(function (row) {
        let total = 0;
        for (let i = 0; i < row.length; i++) {
            total = total + row[i] * vector[i];
        }
        return total;
    });
}

function dot(a, b) {
    let total = 0;
    for (let i = 0; i < a.length; i++) {
        total = total + a[i] * b[i];
    }
    return total;
}

// ---------------------------------------------------------------------------
// Optimisation.
//
// The course R scripts solve this as a quadratic program (quadprog for minimum
// variance, PortfolioAnalytics over an ROI quadprog backend for maximum
// Sharpe). This application runs entirely in the browser, so the same problem
// is solved by projected gradient descent: step downhill, then project the
// result back onto the constraint set, and repeat.
//
// A closed form solution is deliberately not used. The closed form minimum
// variance and tangency solutions both permit negative weights, and the
// mandate here is long only.
// ---------------------------------------------------------------------------

// Euclidean projection onto the constraint set.
//
// The set is: weights sum to one, every weight in [0, maxWeight], and every
// sector at or below SECTOR_CAP. Projecting properly matters. An earlier
// version simply clipped and renormalised, which looks equivalent but is not:
// it distorts the descent direction and lets the optimiser get stuck in a
// corner of the feasible set instead of finding the interior optimum.
//
// projectOntoCappedSimplex solves the one dimensional problem exactly. For
// weights clamp(v_i - theta, 0, cap), the sum decreases monotonically in
// theta, so a bisection on theta finds the value that makes the sum equal the
// target.
function projectOntoCappedSimplex(vector, cap, target) {
    let low = Math.min(...vector) - target - cap - 1;
    let high = Math.max(...vector) + target + cap + 1;

    function sumAt(theta) {
        let total = 0;
        for (const v of vector) {
            let clamped = v - theta;
            if (clamped < 0) {
                clamped = 0;
            }
            if (clamped > cap) {
                clamped = cap;
            }
            total = total + clamped;
        }
        return total;
    }

    for (let iteration = 0; iteration < 60; iteration++) {
        const middle = (low + high) / 2;
        const sumIsTooLarge = sumAt(middle) > target;
        if (sumIsTooLarge === true) {
            low = middle;
        } else {
            high = middle;
        }
    }

    const theta = (low + high) / 2;
    return vector.map(function (v) {
        let clamped = v - theta;
        if (clamped < 0) {
            clamped = 0;
        }
        if (clamped > cap) {
            clamped = cap;
        }
        return clamped;
    });
}

// The full constraint set is the intersection of the capped simplex and one
// cap per sector. Alternating projections converge to a point in the
// intersection of convex sets, which is what feasibility requires here.
function projectWeights(weights, sectors, maxWeight, sectorCap) {
    const cap = sectorCap === undefined ? SECTOR_CAP : sectorCap;
    const sectorNames = Array.from(new Set(sectors));
    let w = projectOntoCappedSimplex(weights, maxWeight, 1);

    for (let pass = 0; pass < 40; pass++) {
        let anySectorOverCap = false;

        for (const sector of sectorNames) {
            const indices = [];
            for (let i = 0; i < w.length; i++) {
                if (sectors[i] === sector) {
                    indices.push(i);
                }
            }
            let sectorTotal = 0;
            for (const i of indices) {
                sectorTotal = sectorTotal + w[i];
            }
            const sectorOverCap = sectorTotal > cap + 1e-10;
            if (sectorOverCap === true) {
                anySectorOverCap = true;
                const subVector = indices.map(function (i) { return w[i]; });
                const projectedSub = projectOntoCappedSimplex(subVector, maxWeight, cap);
                indices.forEach(function (i, k) {
                    w[i] = projectedSub[k];
                });
            }
        }

        let total = 0;
        for (const value of w) {
            total = total + value;
        }
        const sumIsCorrect = Math.abs(total - 1) < 1e-10;
        const feasible = anySectorOverCap === false && sumIsCorrect === true;
        if (feasible === true) {
            return w;
        }

        // Restore the budget constraint. Only assets that still have headroom
        // in both their position cap and their sector cap can absorb weight,
        // otherwise the next pass would just undo the sector projection.
        const deficit = 1 - total;
        const needToAdd = deficit > 0;
        if (needToAdd === true) {
            const sectorTotals = {};
            for (let i = 0; i < w.length; i++) {
                sectorTotals[sectors[i]] = (sectorTotals[sectors[i]] || 0) + w[i];
            }
            const headroom = w.map(function (value, i) {
                const positionRoom = maxWeight - value;
                const sectorRoom = cap - sectorTotals[sectors[i]];
                const room = Math.min(positionRoom, sectorRoom);
                return room > 0 ? room : 0;
            });
            let totalHeadroom = 0;
            for (const room of headroom) {
                totalHeadroom = totalHeadroom + room;
            }
            const noHeadroomLeft = totalHeadroom <= 1e-12;
            if (noHeadroomLeft === true) {
                // The constraints cannot all be met at once. Report the sum
                // honestly rather than forcing a number that hides it.
                return w;
            }
            const share = Math.min(deficit, totalHeadroom);
            for (let i = 0; i < w.length; i++) {
                w[i] = w[i] + share * (headroom[i] / totalHeadroom);
            }
        } else {
            w = projectOntoCappedSimplex(w, maxWeight, 1);
        }
    }
    return w;
}

function optimiseMinimumVariance(covMatrix, sectors, maxWeight, sectorCap) {
    const n = covMatrix.length;
    let w = new Array(n).fill(1 / n);
    let stepSize = 0.5;

    // Objective: w' Sigma w. Gradient: 2 Sigma w.
    for (let iteration = 0; iteration < 1500; iteration++) {
        const gradient = matrixTimesVector(covMatrix, w).map(function (g) { return 2 * g; });
        const scale = Math.max(...gradient.map(Math.abs)) || 1;
        const candidate = w.map(function (value, i) {
            return value - stepSize * gradient[i] / scale;
        });
        const projected = projectWeights(candidate, sectors, maxWeight, sectorCap);

        const before = dot(w, matrixTimesVector(covMatrix, w));
        const after = dot(projected, matrixTimesVector(covMatrix, projected));
        const improved = after < before;
        if (improved === true) {
            w = projected;
        } else {
            stepSize = stepSize * 0.7;
        }
        const stepTooSmall = stepSize < 1e-8;
        if (stepTooSmall === true) {
            break;
        }
    }
    return w;
}

function optimiseMaximumSharpe(covMatrix, meanReturns, riskFreeDaily, sectors, maxWeight, sectorCap) {
    const n = covMatrix.length;
    let w = new Array(n).fill(1 / n);
    let stepSize = 0.5;

    function sharpeOf(weights) {
        const portfolioReturn = dot(weights, meanReturns);
        const variance = dot(weights, matrixTimesVector(covMatrix, weights));
        const varianceIsZero = variance <= 0;
        if (varianceIsZero === true) {
            return -Infinity;
        }
        return (portfolioReturn - riskFreeDaily) / Math.sqrt(variance);
    }

    // Gradient ascent on the Sharpe ratio. The analytic gradient of
    // (w'mu - rf) / sqrt(w'Sigma w) is used rather than a finite difference,
    // because with twenty assets the numerical version is both slower and
    // noisier.
    for (let iteration = 0; iteration < 1500; iteration++) {
        const excess = dot(w, meanReturns) - riskFreeDaily;
        const sigmaW = matrixTimesVector(covMatrix, w);
        const variance = dot(w, sigmaW);
        const volatility = Math.sqrt(variance);
        const volatilityIsZero = volatility <= 0;
        if (volatilityIsZero === true) {
            break;
        }
        const gradient = meanReturns.map(function (mu, i) {
            return mu / volatility - excess * sigmaW[i] / (variance * volatility);
        });
        const scale = Math.max(...gradient.map(Math.abs)) || 1;
        const candidate = w.map(function (value, i) {
            return value + stepSize * gradient[i] / scale;
        });
        const projected = projectWeights(candidate, sectors, maxWeight, sectorCap);

        const improved = sharpeOf(projected) > sharpeOf(w);
        if (improved === true) {
            w = projected;
        } else {
            stepSize = stepSize * 0.7;
        }
        const stepTooSmall = stepSize < 1e-8;
        if (stepTooSmall === true) {
            break;
        }
    }
    return w;
}

// ---------------------------------------------------------------------------
// Portfolio statistics
// ---------------------------------------------------------------------------

function portfolioSeries(weights, tickers, returns) {
    const observations = returns[tickers[0]].length;
    const series = [];
    for (let day = 0; day < observations; day++) {
        let total = 0;
        for (let i = 0; i < tickers.length; i++) {
            total = total + weights[i] * returns[tickers[i]][day];
        }
        series.push(total);
    }
    return series;
}

function annualisedStats(dailySeries, riskFreeAnnual) {
    const annualReturn = mean(dailySeries) * TRADING_DAYS;
    const annualVolatility = stdev(dailySeries) * Math.sqrt(TRADING_DAYS);
    const sharpe = (annualReturn - riskFreeAnnual) / annualVolatility;
    return { annualReturn: annualReturn, annualVolatility: annualVolatility, sharpe: sharpe };
}

// ---------------------------------------------------------------------------
// Technical indicators, same conventions as the day one lesson scripts
// ---------------------------------------------------------------------------

function sma(values, window) {
    const out = new Array(values.length).fill(null);
    let running = 0;
    for (let i = 0; i < values.length; i++) {
        running = running + values[i];
        const windowComplete = i >= window;
        if (windowComplete === true) {
            running = running - values[i - window];
        }
        const haveFullWindow = i >= window - 1;
        if (haveFullWindow === true) {
            out[i] = running / window;
        }
    }
    return out;
}

function ema(values, window) {
    const out = new Array(values.length).fill(null);
    const multiplier = 2 / (window + 1);
    const seedIndex = window - 1;
    const notEnoughData = seedIndex >= values.length;
    if (notEnoughData === true) {
        return out;
    }
    let seedSum = 0;
    for (let i = 0; i <= seedIndex; i++) {
        seedSum = seedSum + values[i];
    }
    out[seedIndex] = seedSum / window;
    for (let i = seedIndex + 1; i < values.length; i++) {
        out[i] = values[i] * multiplier + out[i - 1] * (1 - multiplier);
    }
    return out;
}

function macdState(closes) {
    const fast = ema(closes, 12);
    const slow = ema(closes, 26);
    const macdLine = closes.map(function (_, i) {
        const anyMissing = fast[i] === null || slow[i] === null;
        if (anyMissing === true) {
            return null;
        }
        return fast[i] - slow[i];
    });
    const firstValid = macdLine.findIndex(function (v) { return v !== null; });
    const noValidValues = firstValid === -1;
    if (noValidValues === true) {
        return { state: 'insufficient data', macd: null };
    }
    const validPortion = macdLine.slice(firstValid);
    const signalPortion = ema(validPortion, 9);
    const lastMacd = validPortion[validPortion.length - 1];
    const lastSignal = signalPortion[signalPortion.length - 1];
    const signalMissing = lastSignal === null;
    if (signalMissing === true) {
        return { state: 'insufficient data', macd: null };
    }
    const histogram = lastMacd - lastSignal;
    // A steady trend produces a constant MACD line, so the histogram sits at
    // zero. That is neutral, not bearish, and the band below says so. The
    // threshold is scaled to the price level so it means the same thing for a
    // 20 dollar stock and a 900 dollar one.
    const lastClose = closes[closes.length - 1];
    const neutralBand = Math.abs(lastClose) * 1e-4;
    const isNeutral = Math.abs(histogram) <= neutralBand;
    if (isNeutral === true) {
        return { state: 'neutral', macd: histogram };
    }
    const aboveSignal = histogram > 0;
    return { state: aboveSignal === true ? 'bullish' : 'bearish', macd: histogram };
}

function rsi(closes, window) {
    const period = window === undefined ? 14 : window;
    const notEnoughData = closes.length <= period;
    if (notEnoughData === true) {
        return null;
    }
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change >= 0) {
            gains = gains + change;
        } else {
            losses = losses - change;
        }
    }
    let averageGain = gains / period;
    let averageLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        averageGain = (averageGain * (period - 1) + gain) / period;
        averageLoss = (averageLoss * (period - 1) + loss) / period;
    }
    const noLosses = averageLoss === 0;
    if (noLosses === true) {
        return 100;
    }
    const rs = averageGain / averageLoss;
    return 100 - 100 / (1 + rs);
}

function crossoverState(closes) {
    const fast = sma(closes, 50);
    const slow = sma(closes, 200);
    const last = closes.length - 1;
    const missing = fast[last] === null || slow[last] === null;
    if (missing === true) {
        return 'insufficient data';
    }
    const fastAbove = fast[last] > slow[last];
    return fastAbove === true ? 'golden cross' : 'death cross';
}

function computeSignals(tickers) {
    const signals = [];
    for (const ticker of tickers) {
        const closes = state.prices[ticker].map(function (b) { return b.close; });
        const rsiValue = rsi(closes, 14);
        let rsiFlag = 'neutral';
        const rsiKnown = rsiValue !== null;
        if (rsiKnown === true) {
            const overbought = rsiValue > 70;
            const oversold = rsiValue < 30;
            if (overbought === true) {
                rsiFlag = 'overbought';
            }
            if (oversold === true) {
                rsiFlag = 'oversold';
            }
        }
        const macd = macdState(closes);
        signals.push({
            ticker: ticker,
            crossover: crossoverState(closes),
            macd: macd.state,
            rsi: rsiValue,
            rsiFlag: rsiFlag,
        });
    }
    return signals;
}

// ---------------------------------------------------------------------------
// Rendering. Charts are hand drawn SVG rather than a charting library, so the
// application has no runtime dependency beyond the build tool and cannot break
// on a package version change close to a deadline.
// ---------------------------------------------------------------------------

function renderWeightsChart(rows) {
    const width = 720;
    const barHeight = 22;
    const gap = 6;
    const labelWidth = 120;
    const height = rows.length * (barHeight + gap) + 30;
    const maxWeight = Math.max(...rows.map(function (r) { return r.weight; }));

    let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" class="chart" role="img" aria-label="Portfolio weights">';
    rows.forEach(function (row, index) {
        const y = index * (barHeight + gap);
        const barWidth = maxWeight > 0 ? (row.weight / maxWeight) * (width - labelWidth - 70) : 0;
        svg += '<text x="0" y="' + (y + barHeight * 0.7) + '" class="chart-label">' + row.ticker + '</text>';
        svg += '<rect x="' + labelWidth + '" y="' + y + '" width="' + barWidth + '" height="' + barHeight + '" class="bar bar-' + row.sectorIndex + '" />';
        svg += '<text x="' + (labelWidth + barWidth + 6) + '" y="' + (y + barHeight * 0.7) + '" class="chart-value">' + pct(row.weight) + '</text>';
    });
    svg += '</svg>';
    el('weights-chart').innerHTML = svg;
}

function renderWeightsTable(rows, capital) {
    let html = '<table><thead><tr>'
        + '<th>Ticker</th><th>Company</th><th>Sector</th>'
        + '<th class="num">Weight</th><th class="num">Allocation</th>'
        + '</tr></thead><tbody>';
    for (const row of rows) {
        html += '<tr>'
            + '<td class="mono">' + row.ticker + '</td>'
            + '<td>' + row.name + '</td>'
            + '<td>' + row.sector + '</td>'
            + '<td class="num">' + pct(row.weight) + '</td>'
            + '<td class="num">' + money(row.weight * capital) + '</td>'
            + '</tr>';
    }
    html += '</tbody></table>';

    // Sector totals, so the reader can check the 35 per cent cap by eye.
    const sectorTotals = {};
    for (const row of rows) {
        sectorTotals[row.sector] = (sectorTotals[row.sector] || 0) + row.weight;
    }
    html += '<h3>Sector exposure</h3><table><thead><tr><th>Sector</th><th class="num">Weight</th></tr></thead><tbody>';
    for (const sector of Object.keys(sectorTotals)) {
        html += '<tr><td>' + sector + '</td><td class="num">' + pct(sectorTotals[sector]) + '</td></tr>';
    }
    html += '</tbody></table>';

    el('weights-table').innerHTML = html;
}

function renderMetrics(portfolio, equal, benchmark, methodLabel) {
    const cards = [
        { label: 'Annualised return', value: pct(portfolio.annualReturn) },
        { label: 'Annualised volatility', value: pct(portfolio.annualVolatility) },
        { label: 'Sharpe ratio', value: portfolio.sharpe.toFixed(3) },
    ];
    let cardHtml = '';
    for (const card of cards) {
        cardHtml += '<div class="metric-card"><div class="metric-label">' + card.label
            + '</div><div class="metric-value">' + card.value + '</div></div>';
    }
    el('metrics-cards').innerHTML = cardHtml;

    let html = '<table><thead><tr><th>Portfolio</th>'
        + '<th class="num">Return</th><th class="num">Volatility</th><th class="num">Sharpe</th>'
        + '</tr></thead><tbody>';
    const comparisonRows = [
        { name: methodLabel, stats: portfolio },
        { name: 'Equal weight (naive benchmark)', stats: equal },
    ];
    const benchmarkAvailable = benchmark !== null;
    if (benchmarkAvailable === true) {
        comparisonRows.push({ name: 'SPY (market benchmark)', stats: benchmark });
    }
    for (const row of comparisonRows) {
        html += '<tr><td>' + row.name + '</td>'
            + '<td class="num">' + pct(row.stats.annualReturn) + '</td>'
            + '<td class="num">' + pct(row.stats.annualVolatility) + '</td>'
            + '<td class="num">' + row.stats.sharpe.toFixed(3) + '</td></tr>';
    }
    html += '</tbody></table>';
    el('comparison-table').innerHTML = html;
}

function renderPerformance(dates, seriesList) {
    const width = 720;
    const height = 260;
    const padding = { left: 46, right: 12, top: 12, bottom: 26 };

    const allValues = [];
    for (const series of seriesList) {
        for (const value of series.values) {
            allValues.push(value);
        }
    }
    const minValue = Math.min(...allValues);
    const maxValue = Math.max(...allValues);
    const span = maxValue - minValue || 1;

    function xAt(index, length) {
        return padding.left + (index / (length - 1)) * (width - padding.left - padding.right);
    }
    function yAt(value) {
        return padding.top + (1 - (value - minValue) / span) * (height - padding.top - padding.bottom);
    }

    let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" class="chart" role="img" aria-label="Cumulative performance">';

    // Horizontal gridlines with value labels.
    for (let g = 0; g <= 4; g++) {
        const value = minValue + (span * g) / 4;
        const y = yAt(value);
        svg += '<line x1="' + padding.left + '" y1="' + y + '" x2="' + (width - padding.right) + '" y2="' + y + '" class="grid" />';
        svg += '<text x="4" y="' + (y + 4) + '" class="chart-axis">' + value.toFixed(2) + '</text>';
    }

    seriesList.forEach(function (series, seriesIndex) {
        const points = series.values.map(function (value, index) {
            return xAt(index, series.values.length) + ',' + yAt(value);
        }).join(' ');
        svg += '<polyline points="' + points + '" class="line line-' + seriesIndex + '" />';
    });

    // Date labels at the two ends.
    svg += '<text x="' + padding.left + '" y="' + (height - 6) + '" class="chart-axis">' + dates[0] + '</text>';
    svg += '<text x="' + (width - padding.right - 60) + '" y="' + (height - 6) + '" class="chart-axis">' + dates[dates.length - 1] + '</text>';
    svg += '</svg>';

    let legend = '<div class="legend">';
    seriesList.forEach(function (series, seriesIndex) {
        legend += '<span class="legend-item"><span class="swatch swatch-' + seriesIndex + '"></span>' + series.label + '</span>';
    });
    legend += '</div>';

    el('performance-chart').innerHTML = svg + legend;
}

function renderSignals(signals, weightByTicker) {
    let bullishWeight = 0;
    let bearishWeight = 0;
    for (const signal of signals) {
        const weight = weightByTicker[signal.ticker] || 0;
        const isGolden = signal.crossover === 'golden cross';
        if (isGolden === true) {
            bullishWeight = bullishWeight + weight;
        }
        const isDeath = signal.crossover === 'death cross';
        if (isDeath === true) {
            bearishWeight = bearishWeight + weight;
        }
    }

    el('signal-summary').innerHTML =
        '<p>Weighted by portfolio weight, ' + pct(bullishWeight, 1)
        + ' of the portfolio sits in a golden cross and ' + pct(bearishWeight, 1)
        + ' in a death cross.</p>';

    let html = '<table><thead><tr><th>Ticker</th><th class="num">Weight</th>'
        + '<th>50/200 crossover</th><th>MACD</th><th class="num">RSI (14)</th><th>RSI flag</th>'
        + '</tr></thead><tbody>';
    for (const signal of signals) {
        const rsiText = signal.rsi === null ? 'n/a' : signal.rsi.toFixed(1);
        html += '<tr>'
            + '<td class="mono">' + signal.ticker + '</td>'
            + '<td class="num">' + pct(weightByTicker[signal.ticker] || 0) + '</td>'
            + '<td>' + signal.crossover + '</td>'
            + '<td>' + signal.macd + '</td>'
            + '<td class="num">' + rsiText + '</td>'
            + '<td>' + signal.rsiFlag + '</td>'
            + '</tr>';
    }
    html += '</tbody></table>';
    el('signals-table').innerHTML = html;
}

function renderCorrelation(tickers, returns) {
    const n = tickers.length;
    const cell = 26;
    const labelSpace = 46;
    const size = n * cell + labelSpace;

    const sds = tickers.map(function (t) { return stdev(returns[t]); });
    const cov = covarianceMatrix(tickers, returns);

    let svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" class="chart" role="img" aria-label="Correlation matrix">';
    for (let i = 0; i < n; i++) {
        svg += '<text x="0" y="' + (labelSpace + i * cell + cell * 0.7) + '" class="chart-tiny">' + tickers[i] + '</text>';
        svg += '<text x="' + (labelSpace + i * cell + cell * 0.5) + '" y="' + (labelSpace - 6)
            + '" class="chart-tiny rotated" transform="rotate(-60 '
            + (labelSpace + i * cell + cell * 0.5) + ' ' + (labelSpace - 6) + ')">' + tickers[i] + '</text>';
        for (let j = 0; j < n; j++) {
            const correlation = cov[i][j] / (sds[i] * sds[j]);
            // Map correlation onto opacity so the eye reads intensity, not hue.
            const opacity = Math.max(0, Math.min(1, correlation)).toFixed(2);
            svg += '<rect x="' + (labelSpace + j * cell) + '" y="' + (labelSpace + i * cell)
                + '" width="' + (cell - 1) + '" height="' + (cell - 1)
                + '" fill="#14213d" opacity="' + opacity + '" />';
        }
    }
    svg += '</svg>';
    el('correlation-chart').innerHTML = svg;
}

// ---------------------------------------------------------------------------
// Main recomputation. Called after data loads and whenever a setting changes.
// ---------------------------------------------------------------------------

function rebuild() {
    const available = UNIVERSE.filter(function (u) {
        const present = state.prices[u.ticker] !== undefined;
        return present === true;
    });

    const tooFewAssets = available.length < 2;
    if (tooFewAssets === true) {
        setStatus('Not enough price series to optimise. Load data first.', true);
        return;
    }

    const tickers = available.map(function (u) { return u.ticker; });
    const sectors = available.map(function (u) { return u.sector; });
    const sectorNames = Array.from(new Set(sectors));

    const riskFreeAnnual = Number(el('risk-free').value) / 100;
    const riskFreeDaily = riskFreeAnnual / TRADING_DAYS;
    const capital = Number(el('capital').value);
    const maxWeight = Number(el('max-weight').value) / 100;
    const method = el('method').value;

    const aligned = buildReturns(tickers);
    const returns = aligned.returns;
    const cov = covarianceMatrix(tickers, returns);
    const meanReturns = tickers.map(function (t) { return mean(returns[t]); });

    // Feasibility check before solving. If the caps cannot add up to 100 per
    // cent there is no valid portfolio, and saying so is more useful than
    // returning weights that quietly sum to less than one.
    let capacity = 0;
    for (const sectorName of sectorNames) {
        const countInSector = sectors.filter(function (s) { return s === sectorName; }).length;
        capacity = capacity + Math.min(SECTOR_CAP, countInSector * maxWeight);
    }
    const constraintsImpossible = capacity < 1 - 1e-9;
    if (constraintsImpossible === true) {
        setStatus('These constraints cannot be satisfied. The position and sector caps together allow at most '
            + pct(capacity) + ' of the mandate to be invested. Raise the position cap.', true);
        return;
    }

    let weights;
    let methodLabel;
    if (method === 'minvar') {
        weights = optimiseMinimumVariance(cov, sectors, maxWeight, SECTOR_CAP);
        methodLabel = 'Minimum variance';
    } else if (method === 'maxsharpe') {
        weights = optimiseMaximumSharpe(cov, meanReturns, riskFreeDaily, sectors, maxWeight, SECTOR_CAP);
        methodLabel = 'Maximum Sharpe ratio';
    } else {
        weights = projectWeights(new Array(tickers.length).fill(1 / tickers.length), sectors, maxWeight, SECTOR_CAP);
        methodLabel = 'Equal weight';
    }

    // Sanity checks. Optimiser output is never trusted blindly, the same rule
    // the lesson scripts apply after every solve.
    let weightSum = 0;
    for (const w of weights) {
        weightSum = weightSum + w;
    }
    const sumIsValid = Math.abs(weightSum - 1) < WEIGHT_TOLERANCE;
    const noNegatives = weights.every(function (w) { return w >= -1e-9; });
    let warnings = '';
    if (sumIsValid === false) {
        warnings += '<p class="error">Warning: weights sum to ' + weightSum.toFixed(6) + ', not 1.</p>';
    }
    if (noNegatives === false) {
        warnings += '<p class="error">Warning: a weight solved negative. Check the solver tolerance.</p>';
    }
    el('metrics-warning').innerHTML = warnings;

    // Portfolio statistics.
    const portfolioDaily = portfolioSeries(weights, tickers, returns);
    const portfolioStats = annualisedStats(portfolioDaily, riskFreeAnnual);

    const equalWeights = new Array(tickers.length).fill(1 / tickers.length);
    const equalDaily = portfolioSeries(equalWeights, tickers, returns);
    const equalStats = annualisedStats(equalDaily, riskFreeAnnual);

    let benchmarkStats = null;
    let benchmarkCumulative = null;
    const benchmarkPresent = state.prices[BENCHMARK] !== undefined;
    if (benchmarkPresent === true) {
        const benchmarkByDate = new Map();
        for (const bar of state.prices[BENCHMARK]) {
            benchmarkByDate.set(bar.date, bar.close);
        }
        const benchmarkCloses = aligned.dates.map(function (d) { return benchmarkByDate.get(d); });
        const allDatesCovered = benchmarkCloses.every(function (c) { return c !== undefined; });
        if (allDatesCovered === true) {
            const benchmarkReturns = [];
            for (let i = 1; i < benchmarkCloses.length; i++) {
                benchmarkReturns.push(benchmarkCloses[i] / benchmarkCloses[i - 1] - 1);
            }
            benchmarkStats = annualisedStats(benchmarkReturns, riskFreeAnnual);
            benchmarkCumulative = cumulative(benchmarkReturns);
        }
    }

    // Rows sorted by weight, for both the chart and the table.
    const rows = available.map(function (u, index) {
        return {
            ticker: u.ticker,
            name: u.name,
            sector: u.sector,
            sectorIndex: sectorNames.indexOf(u.sector) % 5,
            weight: weights[index],
        };
    }).sort(function (a, b) { return b.weight - a.weight; });

    const weightByTicker = {};
    rows.forEach(function (row) { weightByTicker[row.ticker] = row.weight; });

    // Render everything.
    el('data-source').textContent = state.source
        + '. ' + tickers.length + ' constituents in the optimisation, '
        + aligned.dates.length + ' aligned trading days ending ' + aligned.dates[aligned.dates.length - 1] + '.';

    renderMetrics(portfolioStats, equalStats, benchmarkStats, methodLabel);
    renderWeightsChart(rows);
    renderWeightsTable(rows, capital);

    const performanceSeries = [
        { label: methodLabel, values: cumulative(portfolioDaily) },
        { label: 'Equal weight', values: cumulative(equalDaily) },
    ];
    const benchmarkChartable = benchmarkCumulative !== null;
    if (benchmarkChartable === true) {
        performanceSeries.push({ label: 'SPY', values: benchmarkCumulative });
    }
    renderPerformance(aligned.dates, performanceSeries);

    const signals = computeSignals(tickers);
    renderSignals(signals, weightByTicker);
    renderCorrelation(tickers, returns);

    for (const panelId of ['data-source-panel', 'metrics-panel', 'weights-panel',
        'performance-panel', 'signals-panel', 'correlation-panel', 'commentary-panel']) {
        el(panelId).hidden = false;
    }

    // Stored for the commentary prompt, so the model receives exactly the
    // figures the user is looking at.
    state.weights = rows;
    state.metrics = {
        method: methodLabel,
        portfolio: portfolioStats,
        equal: equalStats,
        benchmark: benchmarkStats,
        riskFreeAnnual: riskFreeAnnual,
        observations: aligned.dates.length,
        lastDate: aligned.dates[aligned.dates.length - 1],
    };
    state.signals = signals;
}

function cumulative(dailyReturns) {
    const out = [];
    let level = 1;
    for (const r of dailyReturns) {
        level = level * (1 + r);
        out.push(level);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Commentary. The model is given the finished numbers and asked to interpret
// them. It computes nothing, and the system prompt forbids price targets,
// recommendations, and invented figures.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
    'You are an investment analyst writing a short commentary for an investment committee.',
    'The committee is deciding whether to allocate to a long only equity portfolio.',
    'You are given figures that have already been computed. Use only those figures.',
    '',
    'Structure your answer in three short paragraphs:',
    '1. What the portfolio is and how it is constructed.',
    '2. What the risk and return figures say, including the comparison against equal weighting and the market benchmark.',
    '3. The main caveat a committee member should press on.',
    '',
    'Rules you must follow:',
    'Do not invent any number that is not given to you.',
    'Do not give price targets.',
    'Do not recommend buying or selling any security.',
    'Do not claim the strategy will outperform in future.',
    'Note plainly that the performance figures are in sample, because the weights were fitted on the same window.',
    'Write about 250 words in plain professional prose. No bullet points, no headings.',
].join('\n');

function buildUserPrompt() {
    const m = state.metrics;
    const lines = [];
    lines.push('Strategy: equities screened for workforce quality (Great Place to Work, Glassdoor, JUST Capital), then optimised by mean variance.');
    lines.push('Optimisation method: ' + m.method);
    lines.push('Constraints: long only, weights sum to 1, position cap ' + el('max-weight').value + ' per cent, sector cap 35 per cent.');
    lines.push('Lookback: ' + m.observations + ' aligned trading days ending ' + m.lastDate + '.');
    lines.push('Risk free rate used: ' + (m.riskFreeAnnual * 100).toFixed(2) + ' per cent annual.');
    lines.push('');
    lines.push('Portfolio: annualised return ' + pct(m.portfolio.annualReturn)
        + ', annualised volatility ' + pct(m.portfolio.annualVolatility)
        + ', Sharpe ' + m.portfolio.sharpe.toFixed(3) + '.');
    lines.push('Equal weight benchmark: return ' + pct(m.equal.annualReturn)
        + ', volatility ' + pct(m.equal.annualVolatility)
        + ', Sharpe ' + m.equal.sharpe.toFixed(3) + '.');
    const haveBenchmark = m.benchmark !== null;
    if (haveBenchmark === true) {
        lines.push('SPY benchmark: return ' + pct(m.benchmark.annualReturn)
            + ', volatility ' + pct(m.benchmark.annualVolatility)
            + ', Sharpe ' + m.benchmark.sharpe.toFixed(3) + '.');
    }
    lines.push('');
    lines.push('Largest positions:');
    for (const row of state.weights.slice(0, 8)) {
        lines.push('  ' + row.ticker + ' (' + row.sector + '): ' + pct(row.weight));
    }
    const bullish = state.signals.filter(function (s) { return s.crossover === 'golden cross'; }).length;
    lines.push('');
    lines.push('Technical context: ' + bullish + ' of ' + state.signals.length
        + ' constituents are in a 50/200 day golden cross.');
    return lines.join('\n');
}

async function callGemini(apiKey, model) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
        + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: buildUserPrompt() }] }],
            // Gemini 3 models spend part of the output budget on internal
            // reasoning before emitting any text, and unlike the 2.x series
            // they do not accept a thinkingBudget parameter at all: sending
            // one is rejected as an invalid argument. The budget is therefore
            // simply set high enough that reasoning and a 300 word reply both
            // fit comfortably.
            generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 8000,
            },
        }),
    });
    const requestFailed = response.ok === false;
    if (requestFailed === true) {
        const detail = await response.text();
        throw new Error('Gemini call failed (HTTP ' + response.status + '). ' + detail.slice(0, 300));
    }
    const data = await response.json();
    const candidate = data.candidates && data.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    const noText = parts === undefined || parts === null;
    if (noText === true) {
        throw new Error('Gemini returned no text. It may have blocked the request, or spent the whole output budget on reasoning tokens.');
    }
    // A truncated reply is worse than an error, because it looks finished.
    // Say so rather than displaying half a sentence as if it were the answer.
    const wasTruncated = candidate.finishReason === 'MAX_TOKENS';
    if (wasTruncated === true) {
        throw new Error('Gemini hit the output limit and the commentary was cut off. Raise maxOutputTokens in main.js or choose a smaller model.');
    }
    return parts.map(function (p) { return p.text || ''; }).join('');
}

async function callOpenRouter(apiKey, model) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: model,
            max_tokens: 2000,
            reasoning: { enabled: false },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: buildUserPrompt() },
            ],
        }),
    });
    const requestFailed = response.ok === false;
    if (requestFailed === true) {
        const detail = await response.text();
        const hint = {
            401: 'The key looks invalid or missing.',
            402: 'This model is paid and the account is out of credits.',
            429: 'Rate limited, wait a moment.',
        }[response.status] || '';
        throw new Error('OpenRouter call failed (HTTP ' + response.status + '). ' + hint + ' ' + detail.slice(0, 200));
    }
    const data = await response.json();
    return (data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.content) || '';
}

async function generateCommentary() {
    const apiKey = el('llm-key').value.trim();
    const keyMissing = apiKey.length === 0;
    if (keyMissing === true) {
        el('commentary').innerHTML = '<p class="error">Enter your commentary API key first.</p>';
        return;
    }
    const metricsMissing = state.metrics === null;
    if (metricsMissing === true) {
        el('commentary').innerHTML = '<p class="error">Load data and build the portfolio first.</p>';
        return;
    }

    const provider = el('llm-provider').value;
    const model = el('llm-model').value.trim();
    el('commentary').innerHTML = '<p class="placeholder">Generating.</p>';

    try {
        let text;
        const useGemini = provider === 'gemini';
        if (useGemini === true) {
            text = await callGemini(apiKey, model);
        } else {
            text = await callOpenRouter(apiKey, model);
        }
        const paragraphs = text.split(/\n\s*\n/).filter(function (p) { return p.trim().length > 0; });
        el('commentary').innerHTML = paragraphs.map(function (p) {
            return '<p>' + p.trim().replace(/</g, '&lt;') + '</p>';
        }).join('');
    } catch (callError) {
        el('commentary').innerHTML = '<p class="error">' + callError.message.replace(/</g, '&lt;') + '</p>';
    }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

el('fetch-live').addEventListener('click', fetchAll);
el('load-snapshot').addEventListener('click', loadSnapshot);
el('save-snapshot').addEventListener('click', saveSnapshot);
el('generate-commentary').addEventListener('click', generateCommentary);

// Changing a setting recomputes from data already in memory. No refetch, so
// this costs no API credits.
for (const id of ['method', 'risk-free', 'capital', 'max-weight']) {
    el(id).addEventListener('change', function () {
        const haveData = Object.keys(state.prices).length > 0;
        if (haveData === true) {
            rebuild();
        }
    });
}

// Switching provider swaps in that provider's usual default model id.
el('llm-provider').addEventListener('change', function () {
    const provider = el('llm-provider').value;
    const useGemini = provider === 'gemini';
    el('llm-model').value = useGemini === true ? 'gemini-3.6-flash' : 'anthropic/claude-sonnet-5';
});
