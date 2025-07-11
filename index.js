// index.js

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { authenticator } = require('otplib'); // Correct Node.js library for TOTP
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


// --- API Endpoints ---

app.get('/', (req, res) => {
  res.send('Angel One Authenticated Backend is running!');
});

/**
 * @api {post} /api/login Login to Angel One
 */
app.post('/api/login', async (req, res) => {
    if (!ANGEL_API_KEY || !ANGEL_CLIENT_ID || !ANGEL_PASSWORD || !ANGEL_TOTP_SECRET) {
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
            session.profile = profileResponse.data.data;
            res.json({ status: true, message: "Login successful!", data: { name: session.profile.name, clientcode: session.profile.clientcode } });
        } else {
            res.status(401).json({ status: false, message: loginResponse.data.message || "Login failed." });
        }
    } catch (error) {
        res.status(500).json({ status: false, message: "An error occurred during the login process.", error: error.response ? error.response.data : error.message });
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
    const { symboltoken, exchange, timeframe, fromdate, todate } = req.body;
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
        res.json(response.data.data);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch historical data.', error: error.response ? error.response.data : error.message });
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
        fromdate.setFullYear(fromdate.getFullYear() - 1); // Fetch 1 year of data for calculations
        fromdate = fromdate.toISOString().slice(0, 10);

        const histResponse = await axios.post(`http://127.0.0.1:${port}/api/historical-data`, {
            exchange, symboltoken, timeframe: 'ONE_DAY', fromdate, todate
        }, { headers: { 'Authorization': `Bearer ${session.jwtToken}` } });

        const candles = histResponse.data;
        if (!candles || candles.length < 200) { // Need enough data for 200DMA
            return res.status(404).json({ message: "Not enough historical data to calculate all indicators." });
        }

        const closingPrices = candles.map(c => c[4]); // O, H, L, C, V -> Index 4 is Close

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
 * @api {get} /api/top-performers Get AI-Generated Top Performing Stocks
 */
app.get('/api/top-performers', async (req, res) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ message: "AI API key is not configured on the server." });
    }
    try {
        const prompt = "Generate a JSON object with a key 'performers' which is an array of 10 of today's top-performing Indian NSE equity stocks. For each stock, provide its 'name', 'symbol', a realistic simulated 'price' (number), a positive 'change' (number), and a positive 'percentChange' (number).";
        const chatHistory = [{ role: "user", parts: [{ text: prompt }] }];
        const payload = {
            contents: chatHistory,
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        "performers": {
                            type: "ARRAY",
                            items: {
                                type: "OBJECT",
                                properties: {
                                    "name": { "type": "STRING" },
                                    "symbol": { "type": "STRING" },
                                    "price": { "type": "NUMBER" },
                                    "change": { "type": "NUMBER" },
                                    "percentChange": { "type": "NUMBER" }
                                },
                                required: ["name", "symbol", "price", "change", "percentChange"]
                            }
                        }
                    },
                    required: ["performers"]
                }
            }
        };

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
        const response = await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' } });

        if (response.data.candidates && response.data.candidates[0].content.parts) {
            const performersData = JSON.parse(response.data.candidates[0].content.parts[0].text);
            res.json(performersData);
        } else {
            throw new Error("Invalid response structure from AI API for top performers.");
        }
    } catch (error) {
        console.error(`Error fetching AI top performers:`, error.response ? error.response.data : error.message);
        res.status(500).json({ message: "Failed to generate top performers list." });
    }
});


app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
