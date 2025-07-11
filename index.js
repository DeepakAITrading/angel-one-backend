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
        console.error("Error fetching historical data from Angel One:", error.response ? error.response.data : error.message);
        throw new Error('Failed to fetch historical data from Angel One.');
    }
};


// --- API Endpoints ---

app.get('/', (req, res) => {
  res.send('Angel One Authenticated Backend is running!');
});

/**
 * @api {post} /api/login Login to Angel One
 */
app.post('/api/login', async (req, res) => {
    console.log("Login attempt started...");
    if (!ANGEL_API_KEY || !ANGEL_CLIENT_ID || !ANGEL_PASSWORD || !ANGEL_TOTP_SECRET) {
        console.error("Server credentials not configured.");
        return res.status(500).json({ message: "API credentials are not configured on the server." });
    }
    try {
        const totp = authenticator.generate(ANGEL_TOTP_SECRET);
        console.log("Generated TOTP.");
        
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

        console.log("Angel One Login API response received.");

        if (loginResponse.data.status === true) {
            const responseData = loginResponse.data.data;
            session.jwtToken = responseData.jwtToken;
            session.feedToken = responseData.feedToken;
            session.refreshToken = responseData.refreshToken;
            
            const profileResponse = await axios.get('https://apiconnect.angelbroking.com/rest/secure/angelbroking/user/v1/getProfile', {
                headers: { 'Authorization': `Bearer ${session.jwtToken}` }
            });
            session.profile = profileResponse.data.data;
            console.log("Login successful for user:", session.profile.name);
            res.json({ status: true, message: "Login successful!", data: { name: session.profile.name, clientcode: session.profile.clientcode } });
        } else {
            console.error("Angel One Login Failed. Reason:", loginResponse.data.message);
            res.status(401).json({ status: false, message: loginResponse.data.message || "Login failed due to an unknown reason from Angel One." });
        }
    } catch (error) {
        const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error("Critical error during login process:", errorMsg);
        res.status(500).json({ status: false, message: "An unexpected error occurred during the login process.", error: error.response ? error.response.data.message : error.message });
    }
});

/**
 * @api {get} /api/instruments Get NSE Equity Instruments
 */
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

/**
 * @api {post} /api/historical-data Get Historical Data from Angel One
 */
app.post('/api/historical-data', requireLogin, async (req, res) => {
    try {
        const data = await getHistoricalData(req.body);
        res.json(data);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

/**
 * @api {post} /api/technical-indicators Get Technical Indicators from Angel One Data
 */
app.post('/api/technical-indicators', requireLogin, async (req, res) => {
    const { symboltoken, exchange } = req.body;
    try {
        const todate = new Date().toISOString().slice(0, 10);
        let fromdate = new Date();
        fromdate.setFullYear(fromdate.getFullYear() - 1);
        fromdate = fromdate.toISOString().slice(0, 10);

        const candles = await getHistoricalData({
            exchange, symboltoken, timeframe: 'ONE_DAY', fromdate, todate
        });

        if (!candles || candles.length < 200) {
            return res.status(404).json({ message: "Not enough historical data to calculate all indicators." });
        }

        const closingPrices = candles.map(c => c[4]);

        const rsi = RSI.calculate({ values: closingPrices, period: 14 });
        const sma20 = SMA.calculate({ values: closingPrices, period: 20 });
        const sma50 = SMA.calculate({ values: closingPrices, period: 50 });
        const sma200 = SMA.calculate({ values: closingPrices, period: 200 });

        res.json({
            currentPrice: closingPrices[closingPrices.length - 1],
            rsi: rsi[rsi.length - 1],
            dma20: sma20[sma20.length - 1],
            dma50: sma50[sma50.length - 1],
            dma200: sma200[sma200.length - 1]
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to calculate technical indicators.', error: error.message });
    }
});

/**
 * @api {get} /api/top-performers Get Top Performing Stocks
 */
app.get('/api/top-performers', requireLogin, async (req, res) => {
    try {
        const nifty50Tokens = ["2885", "11536", "1594", "3456", "1333", "5258", "10940", "3045", "1660", "1394"];
        const payload = {
            "mode": "OHLC",
            "exchangeTokens": { "NSE": nifty50Tokens }
        };
        const response = await axios.post('https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/getQuote', payload, {
            headers: { 'Authorization': `Bearer ${session.jwtToken}` }
        });

        const performers = response.data.data.map(stock => {
            const change = stock.ltp - stock.ohlc.close;
            const percentChange = (change / stock.ohlc.close) * 100;
            return {
                name: stock.name,
                symbol: stock.tradingSymbol,
                price: stock.ltp,
                change: change,
                percentChange: percentChange
            };
        }).sort((a, b) => b.percentChange - a.percentChange).slice(0, 10);

        res.json({ performers });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch top performers.', error: error.response ? error.response.data : error.message });
    }
});

// **FIX:** Added the missing /api/company-details endpoint
/**
 * @api {post} /api/company-details Get AI-Generated Company News
 */
app.post('/api/company-details', async (req, res) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ message: "AI API key is not configured on the server." });
    }

    const { companyName } = req.body;
    if (!companyName) {
        return res.status(400).json({ message: "Company name is required." });
    }

    try {
        const prompt = `Provide a brief, one-paragraph summary of the most recent news and developments for the Indian company: ${companyName}. Focus on the last few weeks.`;
        const chatHistory = [{ role: "user", parts: [{ text: prompt }] }];
        
        const payload = {
            contents: chatHistory,
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        "details": { "type": "STRING" }
                    },
                    required: ["details"]
                }
            }
        };

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
        const response = await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' } });

        if (response.data.candidates && response.data.candidates[0].content.parts) {
            const detailsData = JSON.parse(response.data.candidates[0].content.parts[0].text);
            res.json(detailsData);
        } else {
            throw new Error("Invalid response structure from AI API for company details.");
        }
    } catch (error) {
        console.error(`Error fetching AI details for ${companyName}:`, error.response ? error.response.data : error.message);
        res.status(500).json({ message: "Failed to generate company details." });
    }
});


app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
