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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const ANGEL_HISTORICAL_API_KEY = process.env.ANGEL_HISTORICAL_API_KEY; 


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

// --- Helper function to get historical data (getCandleData) ---
const getHistoricalData = async (params) => {
    const { symboltoken, exchange, timeframe, fromdate, todate } = params;
    
    // Prepare headers for the historical data call
    const headers = {
        'Authorization': `Bearer ${session.jwtToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        // As per documentation, X-PrivateKey is also needed for some endpoints
        'X-PrivateKey': ANGEL_HISTORICAL_API_KEY || ANGEL_API_KEY 
    };

    try {
        const response = await axios.post('https://apiconnect.angelbroking.com/rest/secure/angelbroking/historical/v1/getCandleData', {
            exchange,
            symboltoken,
            interval: timeframe,
            fromdate,
            todate
        }, { headers }); 
        
        // Robustly check if response.data is an object and has a 'data' property
        const historicalData = (typeof response.data === 'object' && response.data !== null) ? response.data.data : null;

        if (!Array.isArray(historicalData)) {
            console.warn(`Historical data for ${symboltoken} is not an array, received:`, historicalData);
            return []; // Return empty array if data is not as expected
        }
        return historicalData;
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
            
            // Robustly check if response.data is an object and has a 'data' property
            const liveData = (typeof quoteResponse.data === 'object' && quoteResponse.data !== null) ? quoteResponse.data.data : null;

            if (liveData && liveData.ltp !== undefined && liveData.ltp !== null) { 
                currentPrice = liveData.ltp;
                // Fetch previous day's close for accurate change calculation for live data
                const today = new Date();
                let previousTradingDay = new Date(today);
                previousTradingDay.setDate(today.getDate() - 1); 

                let previousTradingDayClose = null;

                // Loop backwards to find the last trading day's close (max 5 days to avoid excessive calls)
                for (let i = 0; i < 5; i++) {
                    const prevDayCandles = await getHistoricalData({
                        exchange, symboltoken, timeframe: 'ONE_DAY',
                        fromdate: previousTradingDay.toISOString().slice(0, 10),
                        todate: previousTradingDay.toISOString().slice(0, 10)
                    });
                    if (prevDayCandles && prevDayCandles.length > 0) {
                        previousTradingDayClose = prevDayCandles[0][4]; 
                        break;
                    }
                    previousTradingDay.setDate(previousTradingDay.getDate() - 1); 
                }

                if (previousTradingDayClose !== null && previousTradingDayClose !== 0) {
                    netChange = currentPrice - previousTradingDayClose;
                    percentChange = (netChange / previousTradingDayClose) * 100;
                } else {
                    netChange = 0;
                    percentChange = 0;
                }
            } else {
                throw new Error("Live LTP data not available.");
            }
        } catch (quoteError) {
            console.log(`Live LTP fetch failed for ${symboltoken}, falling back to last available close price from historical data. Error: ${quoteError.message}`);
            if (closingPrices.length > 0) {
                currentPrice = closingPrices[closingPrices.length - 1]; 
                if (closingPrices.length > 1) {
                    const previousClose = closingPrices[closingPrices.length - 2];
                    if (previousClose !== 0) { 
                        netChange = currentPrice - previousClose;
                        percentChange = (netChange / previousClose) * 100;
                    } else {
                        netChange = 0;
                        percentChange = 0;
                    }
                } else {
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
        const indexTokensNSE = ["26000", "26009"]; 
        const indexTokensBSE = ["26037"]; 
        const nifty50Tokens = ["2885", "11536", "1594", "3456", "1333", "5258", "10940", "3045", "1660", "1394"];

        const tokensToFetch = {
            "NSE": [...indexTokensNSE, ...nifty50Tokens],
            "BSE": [...indexTokensBSE]
        };

        console.log("Market Data Request: tokensToFetch", tokensToFetch);

        let quoteData = [];
        let isLiveMarketData = true; 

        try {
            // Attempt to get FULL mode (live) data first
            const quotePayload = { "mode": "FULL", "exchangeTokens": tokensToFetch };
            const quoteResponse = await axios.post('https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/getQuote', quotePayload, {
                headers: { 'Authorization': `Bearer ${session.jwtToken}` }
            });
            
            console.log("FULL Mode API Raw Response:", JSON.stringify(quoteResponse.data, null, 2));

            const fullModeData = (typeof quoteResponse.data === 'object' && quoteResponse.data !== null) ? quoteResponse.data.data : null;

            if (fullModeData && Array.isArray(fullModeData) && fullModeData.length > 0 && fullModeData[0].ltp !== undefined) {
                quoteData = fullModeData;
                console.log("Fetched LIVE market data.");
            } else {
                throw new Error("No live data received from FULL mode, attempting historical data fallback.");
            }
        } catch (liveError) {
            console.log("Live data fetch failed (market likely closed or no data), fetching historical data instead.", liveError.message);
            isLiveMarketData = false;

            const allSymbolTokens = [
                ...indexTokensNSE.map(token => ({ exchange: 'NSE', symboltoken: token })),
                ...indexTokensBSE.map(token => ({ exchange: 'BSE', symboltoken: token })),
                ...nifty50Tokens.map(token => ({ exchange: 'NSE', symboltoken: token }))
            ];
            
            const today = new Date();
            let lastTradingDay = new Date(today);
            lastTradingDay.setDate(today.getDate() - 1); // Start checking from yesterday

            // Find the actual last trading day by checking for historical data
            let actualLastTradingDate = null;
            for (let i = 0; i < 7; i++) { // Check up to last 7 days to find a trading day
                const testDate = new Date(today);
                testDate.setDate(today.getDate() - i);
                const testDateString = testDate.toISOString().slice(0, 10);

                // Try fetching historical data for a known index (e.g., Nifty 50) for this date
                try {
                    const testCandles = await getHistoricalData({
                        exchange: 'NSE',
                        symboltoken: '26000', // Nifty 50 token
                        timeframe: 'ONE_DAY',
                        fromdate: testDateString,
                        todate: testDateString
                    });
                    if (testCandles && testCandles.length > 0) {
                        actualLastTradingDate = testDateString;
                        break;
                    }
                } catch (histError) {
                    // Ignore error, just means no data for that day
                }
            }

            if (!actualLastTradingDate) {
                console.warn("Could not determine a recent actual last trading date for historical data fallback.");
                res.json({ indices: [], topPerformers: [] }); // Send empty data if no trading day found
                return;
            }
            console.log("Determined last actual trading date:", actualLastTradingDate);

            // Fetch last trading day's close and previous trading day's close for all tokens
            for (const tokenInfo of allSymbolTokens) {
                try {
                    const lastDayCandles = await getHistoricalData({
                        exchange: tokenInfo.exchange,
                        symboltoken: tokenInfo.symboltoken,
                        timeframe: 'ONE_DAY',
                        fromdate: actualLastTradingDate,
                        todate: actualLastTradingDate
                    });

                    if (lastDayCandles && lastDayCandles.length > 0) {
                        const currentClose = lastDayCandles[0][4]; // Close price of last trading day

                        // Fetch the day before the last trading day for change calculation
                        let prevDayForChange = new Date(actualLastTradingDate);
                        prevDayForChange.setDate(prevDayForChange.getDate() - 1);
                        let previousClose = null;

                        for (let i = 0; i < 5; i++) { // Look back up to 5 days for previous trading day
                            const prevCandles = await getHistoricalData({
                                exchange: tokenInfo.exchange,
                                symboltoken: tokenInfo.symboltoken,
                                timeframe: 'ONE_DAY',
                                fromdate: prevDayForChange.toISOString().slice(0, 10),
                                todate: prevDayForChange.toISOString().slice(0, 10)
                            });
                            if (prevCandles && prevCandles.length > 0) {
                                previousClose = prevCandles[0][4];
                                break;
                            }
                            prevDayForChange.setDate(prevDayForChange.getDate() - 1);
                        }

                        const netChange = previousClose !== null ? currentClose - previousClose : 0;
                        const percentChange = (previousClose !== null && previousClose !== 0) ? (netChange / previousClose) * 100 : 0;

                        // Find the instrument details from the scrip master (assuming it was loaded earlier)
                        // This part needs to be robust. We don't have allStocks here.
                        // For now, we'll use a placeholder or assume the frontend maps tokens to names.
                        // Ideally, instrument list should be cached or fetched once.
                        // For this context, we'll use a placeholder for name/tradingSymbol
                        const instrumentName = `Token ${tokenInfo.symboltoken}`; // Placeholder
                        const tradingSymbol = `SYM${tokenInfo.symboltoken}`; // Placeholder

                        quoteData.push({
                            exchange: tokenInfo.exchange,
                            symbolToken: tokenInfo.symboltoken,
                            name: instrumentName, // Placeholder
                            tradingSymbol: tradingSymbol, // Placeholder
                            ltp: currentClose,
                            netChange: netChange,
                            percentChange: percentChange,
                            close: currentClose
                        });
                    }
                } catch (itemError) {
                    console.error(`Error fetching historical data for token ${tokenInfo.symboltoken}:`, itemError.message);
                }
            }
            console.log("Fetched Historical data for market data fallback.");
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

// Endpoint to generate news summary using Google AI API
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
        const apiKey = GEMINI_API_KEY; 
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
