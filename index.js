// index.js

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { authenticator } = require('otplib');
const { RSI, SMA } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 3001;

// --- Securely access your credentials from environment variables ---
const ANGEL_API_KEY = process.env.ANGEL_API_KEY;
const ANGEL_CLIENT_ID = process.env.ANGEL_CLIENT_ID;
const ANGEL_PASSWORD = process.env.ANGEL_PASSWORD;
const ANGEL_TOTP_SECRET = process.env.ANGEL_TOTP_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // This is the key for Google AI API

// --- In-memory storage for session tokens ---
let session = {
    jwtToken: null,
    feedToken: null,
    refreshToken: null,
    profile: null
};

app.use(cors());
app.use(express.json());

// --- Middleware to check for login status ---
const requireLogin = (req, res, next) => {
    if (!session.jwtToken) {
        return res.status(401).json({ message: "Not logged in. Please login first." });
    }
    next();
};

// --- Helper function to get historical data ---
const getHistoricalData = async (params) => {
    const { symboltoken, exchange, timeframe, fromdate, todate } = params;
    try {
        const response = await axios.post('https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData', {
            exchange,
            symboltoken,
            interval: timeframe,
            fromdate,
            todate
        }, {
            headers: {
                'Authorization': `Bearer ${session.jwtToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-UserType': 'USER',
                'X-SourceID': 'WEB'
            }
        });
        return response.data.data;
    } catch (error) {
        console.error(`Error fetching historical data for ${symboltoken} from Angel One:`, error.response ? error.response.data : error.message);
        throw new Error(`Failed to fetch historical data for ${symboltoken} from Angel One.`);
    }
};


// --- API Endpoints ---

app.get('/', (req, res) => {
    res.send('Angel One Authenticated Backend is running!');
});

app.post('/api/login', async (req, res) => {
    console.log("Login attempt started...");
    if (!ANGEL_API_KEY || !ANGEL_CLIENT_ID || !ANGEL_PASSWORD || !ANGEL_TOTP_SECRET) {
        console.error("Server credentials not configured.");
        return res.status(500).json({ message: "API credentials are not configured on the server." });
    }
    try {
        const totp = authenticator.generate(ANGEL_TOTP_SECRET);
        const loginResponse = await axios.post('https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword', {
            clientcode: ANGEL_CLIENT_ID,
            password: ANGEL_PASSWORD,
            totp: totp
        }, {
            headers: {
                'Content-Type': 'application/json', 'Accept': 'application/json', 'X-UserType': 'USER',
                'X-SourceID': 'WEB', 'X-ClientLocalIP': '192.168.1.1', 'X-ClientPublicIP': '103.1.1.1',
                'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': ANGEL_API_KEY
            }
        });

        if (loginResponse.data.status === true) {
            const responseData = loginResponse.data.data;
            session.jwtToken = responseData.jwtToken;
            session.feedToken = responseData.feedToken;
            session.refreshToken = responseData.refreshToken;
            
            const profileResponse = await axios.get('https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/getProfile', {
                headers: { 'Authorization': `Bearer ${session.jwtToken}` }
            });
            // Safely access profile data, defaulting to empty object if null/undefined
            session.profile = (profileResponse.data && profileResponse.data.data) ? profileResponse.data.data : {};
            console.log("Login successful for user:", session.profile.name || 'N/A');
            res.json({ status: true, message: "Login successful!", data: { name: session.profile.name || 'N/A' } });
        } else {
            console.error("Angel One Login Failed. Reason:", loginResponse.data.message);
            res.status(401).json({ status: false, message: loginResponse.data.message || "Login failed." });
        }
    } catch (error) {
        const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error("Critical error during login process:", errorMsg);
        res.status(500).json({ status: false, message: "An unexpected error occurred during the login process.", error: error.response ? error.response.data.message : error.message });
    }
});

app.get('/api/instruments', requireLogin, async (req, res) => {
    try {
        const instrumentListUrl = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
        const response = await axios.get(instrumentListUrl);
        const nseStocks = response.data.filter(instrument => 
            instrument.exch_seg === 'NSE' && 
            instrument.symbol.endsWith('-EQ')
        );
        res.json(nseStocks);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch instruments.' });
    }
});

app.post('/api/historical-data', requireLogin, async (req, res) => {
    try {
        const data = await getHistoricalData(req.body);
        res.json(data);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/stock-analysis', requireLogin, async (req, res) => {
    const { symboltoken, exchange } = req.body;
    try {
        // Fetch a year's worth of daily historical data for indicator calculation
        const todate = new Date().toISOString().slice(0, 10);
        let fromdate = new Date();
        fromdate.setFullYear(fromdate.getFullYear() - 1);
        fromdate = fromdate.toISOString().slice(0, 10);

        const candles = await getHistoricalData({
            exchange, symboltoken, timeframe: 'ONE_DAY', fromdate, todate
        });

        if (!candles || candles.length === 0) {
            return res.status(404).json({ message: "No historical data available for this stock." });
        }
        const closingPrices = candles.map(c => c[4]);

        // Calculate indicators only if there's enough data
        const rsi = closingPrices.length >= 14 ? RSI.calculate({ values: closingPrices, period: 14 }) : [];
        const sma20 = closingPrices.length >= 20 ? SMA.calculate({ values: closingPrices, period: 20 }) : [];
        const sma50 = closingPrices.length >= 50 ? SMA.calculate({ values: closingPrices, period: 50 }) : [];
        const sma200 = closingPrices.length >= 200 ? SMA.calculate({ values: closingPrices, period: 200 }) : [];

        let currentPrice = null;
        let netChange = null;
        let percentChange = null;

        // Try to get live data (LTP) first
        try {
            const quotePayload = { "mode": "LTP", "exchangeTokens": { [exchange]: [symboltoken] } };
            const quoteResponse = await axios.post('https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/getQuote', quotePayload, {
                headers: { 'Authorization': `Bearer ${session.jwtToken}` }
            });
            const liveData = quoteResponse.data.data;

            if (liveData && liveData.ltp !== undefined && liveData.ltp !== null) { // Check for valid LTP
                currentPrice = liveData.ltp;
                // Fetch previous day's close for accurate change calculation for live data
                const today = new Date();
                let previousTradingDay = new Date(today);
                previousTradingDay.setDate(today.getDate() - 1); // Start checking from yesterday

                let previousTradingDayClose = null;

                // Loop backwards to find the last trading day's close (max 5 days to avoid excessive calls)
                for (let i = 0; i < 5; i++) {
                    const prevDayCandles = await getHistoricalData({
                        exchange, symboltoken, timeframe: 'ONE_DAY',
                        fromdate: previousTradingDay.toISOString().slice(0, 10),
                        todate: previousTradingDay.toISOString().slice(0, 10)
                    });
                    if (prevDayCandles && prevDayCandles.length > 0) {
                        previousTradingDayClose = prevDayCandles[0][4]; // Close price of that day
                        break;
                    }
                    previousTradingDay.setDate(previousTradingDay.getDate() - 1); // Go further back
                }

                if (previousTradingDayClose !== null && previousTradingDayClose !== 0) {
                    netChange = currentPrice - previousTradingDayClose;
                    percentChange = (netChange / previousTradingDayClose) * 100;
                } else {
                    // Fallback if previous day's close can't be found or is zero
                    netChange = 0;
                    percentChange = 0;
                }
            } else {
                // If live LTP fails or is empty, fall back to historical close
                throw new Error("Live LTP data not available.");
            }
        } catch (quoteError) {
            console.log(`Live LTP fetch failed for ${symboltoken}, falling back to last available close price from historical data. Error: ${quoteError.message}`);
            // Use the last available close price from the fetched historical daily candles
            if (closingPrices.length > 0) {
                currentPrice = closingPrices[closingPrices.length - 1]; // Last available close price
                // To calculate change, use the second to last close price if available
                if (closingPrices.length > 1) {
                    const previousClose = closingPrices[closingPrices.length - 2];
                    if (previousClose !== 0) { // Avoid division by zero
                        netChange = currentPrice - previousClose;
                        percentChange = (netChange / previousClose) * 100;
                    } else {
                        netChange = 0;
                        percentChange = 0;
                    }
                } else {
                    // Only one data point, no change to calculate from a previous day
                    netChange = 0;
                    percentChange = 0;
                }
            }
        }

        res.json({
            currentPrice: currentPrice,
            netChange: netChange,
            percentChange: percentChange,
            rsi: rsi.length > 0 ? rsi[rsi.length - 1] : null,
            dma20: sma20.length > 0 ? sma20[sma20.length - 1] : null,
            dma50: sma50.length > 0 ? sma50[sma50.length - 1] : null,
            dma200: sma200.length > 0 ? sma200[sma200.length - 1] : null
        });
    } catch (error) {
        console.error("Error in stock-analysis:", error.message);
        res.status(500).json({ message: 'Failed to calculate stock analysis.', error: error.message });
    }
});

app.get('/api/market-data', requireLogin, async (req, res) => {
    try {
        // Nifty (26000), Bank Nifty (26009), Sensex (26037)
        const indexTokensNSE = ["26000", "26009"]; // Nifty, Bank Nifty
        const indexTokensBSE = ["26037"]; // Sensex
        // Example Nifty 50 tokens (adjust as needed, these are just illustrative)
        const nifty50Tokens = ["2885", "11536", "1594", "3456", "1333", "5258", "10940", "3045", "1660", "1394"];

        const tokensToFetch = {
            "NSE": [...indexTokensNSE, ...nifty50Tokens],
            "BSE": [...indexTokensBSE]
        };

        console.log("Market Data Request: tokensToFetch", tokensToFetch);

        let quoteData = [];
        let isLiveMarketData = true; // Flag to indicate if data is truly live or historical fallback

        try {
            // Attempt to get FULL mode (live) data first
            const quotePayload = { "mode": "FULL", "exchangeTokens": tokensToFetch };
            const quoteResponse = await axios.post('https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/getQuote', quotePayload, {
                headers: { 'Authorization': `Bearer ${session.jwtToken}` }
            });
            
            console.log("FULL Mode API Raw Response:", JSON.stringify(quoteResponse.data, null, 2));

            // Check if live data is actually returned and not empty
            if (quoteResponse.data && Array.isArray(quoteResponse.data.data) && quoteResponse.data.data.length > 0 && quoteResponse.data.data[0].ltp !== undefined) {
                quoteData = quoteResponse.data.data;
                console.log("Fetched LIVE market data.");
            } else {
                // If live data is empty or LTP is undefined, assume market is closed or no live data
                throw new Error("No live data received from FULL mode, attempting OHLC fallback.");
            }
        } catch (liveError) {
            console.log("Live data fetch failed (market likely closed or no data), fetching OHLC data instead.", liveError.message);
            isLiveMarketData = false;

            // Fetch OHLC data for current day (which will be the last trading day's close if market is closed)
            const ohlcPayload = { "mode": "OHLC", "exchangeTokens": tokensToFetch };
            const ohlcResponse = await axios.post('https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/getQuote', ohlcPayload, {
                headers: { 'Authorization': `Bearer ${session.jwtToken}` }
            });
            
            console.log("OHLC Mode API Raw Response:", JSON.stringify(ohlcResponse.data, null, 2));

            let ohlcRawData = ohlcResponse.data.data;

            // FIX: Ensure ohlcRawData is an array before iterating
            if (!Array.isArray(ohlcRawData)) {
                console.warn("ohlcRawData from OHLC API is not an array, received:", ohlcRawData);
                ohlcRawData = []; // Initialize as empty array to prevent iteration error
            }
            console.log("OHLC Raw Data (after array check):", JSON.stringify(ohlcRawData, null, 2));


            // Prepare to fetch previous day's close for each instrument
            const today = new Date();
            let previousTradingDay = new Date(today);
            previousTradingDay.setDate(today.getDate() - 1); // Start checking from yesterday

            for (const item of ohlcRawData) {
                let previousClose = null;
                // Loop backwards to find the last trading day's close (max 5 days to avoid excessive calls)
                let tempPrevDay = new Date(previousTradingDay); // Use a temporary date for each item
                for (let i = 0; i < 5; i++) { // Check up to 5 previous days
                    const prevDayCandles = await getHistoricalData({
                        exchange: item.exchange,
                        symboltoken: item.symbolToken,
                        timeframe: 'ONE_DAY',
                        fromdate: tempPrevDay.toISOString().slice(0, 10),
                        todate: tempPrevDay.toISOString().slice(0, 10)
                    });
                    console.log(`Historical data for ${item.symbolToken} on ${tempPrevDay.toISOString().slice(0, 10)}:`, prevDayCandles);

                    if (prevDayCandles && prevDayCandles.length > 0) {
                        previousClose = prevDayCandles[0][4]; // Close price of that day
                        break;
                    }
                    tempPrevDay.setDate(tempPrevDay.getDate() - 1); // Go further back
                }

                const currentClose = item.ohlc.close;
                const netChange = previousClose !== null ? currentClose - previousClose : 0;
                const percentChange = (previousClose !== null && previousClose !== 0) ? (netChange / previousClose) * 100 : 0;

                quoteData.push({
                    ...item,
                    ltp: currentClose, // Use last close as LTP when market is closed
                    netChange: netChange,
                    percentChange: percentChange,
                    close: currentClose // Ensure close is also set
                });
            }
            console.log("Fetched OHLC fallback market data.");
        }
        
        console.log("Final quoteData before filtering:", JSON.stringify(quoteData, null, 2));

        // Filter and process indices and top performers based on the collected quoteData
        const indices = quoteData.filter(d => indexTokensNSE.includes(d.symbolToken) || indexTokensBSE.includes(d.symbolToken));
        const topStocksData = quoteData.filter(d => nifty50Tokens.includes(d.symbolToken));

        console.log("Filtered Indices:", JSON.stringify(indices, null, 2));
        console.log("Filtered Top Stocks Data:", JSON.stringify(topStocksData, null, 2));


        const topPerformers = topStocksData.map(stock => {
            const price = stock.ltp; 
            const change = stock.netChange; 
            const percentChange = stock.percentChange; 
            
            return { name: stock.name, symbol: stock.tradingSymbol, price: price, change, percentChange };
        }).sort((a, b) => b.percentChange - a.percentChange).slice(0, 10);

        console.log("Final Top Performers sent to frontend:", JSON.stringify(topPerformers, null, 2));

        res.json({ indices, topPerformers });

    } catch (error) {
        console.error("Error in market-data endpoint:", error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Failed to fetch market data.', error: error.response ? error.response.data : error.message });
    }
});

// NEW: Endpoint to generate news summary using Google AI API
app.post('/api/generate-news-summary', requireLogin, async (req, res) => {
    const { companyName } = req.body;

    if (!companyName) {
        return res.status(400).json({ message: "Company name is required for news summary." });
    }
    if (!GEMINI_API_KEY) {
        console.error("GEMINI_API_KEY is not configured on the server.");
        return res.status(500).json({ message: "Google AI API key is not configured on the server." });
    }

    try {
        let chatHistory = [];
        const prompt = `Summarize recent news about ${companyName} from reliable financial sources. Provide 3-5 concise bullet points. If no recent news is found, state that.`;
        chatHistory.push({ role: "user", parts: [{ text: prompt }] });

        const payload = { contents: chatHistory };
        const apiKey = GEMINI_API_KEY; // Use the configured API key
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (result.candidates && result.candidates.length > 0 &&
            result.candidates[0].content && result.candidates[0].content.parts &&
            result.candidates[0].content.parts.length > 0) {
            const newsSummary = result.candidates[0].content.parts[0].text;
            res.json({ newsSummary });
        } else {
            console.warn("Google AI API response structure unexpected or empty:", result);
            res.status(500).json({ message: "Failed to generate news summary. Unexpected AI response." });
        }

    } catch (error) {
        console.error("Error calling Google AI API:", error.response ? error.response.data : error.message);
        res.status(500).json({ message: "Failed to generate news summary due to an AI API error.", error: error.message });
    }
});


app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
