// index.js

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const pyotp = require('pyotp'); // Library to generate Time-based One-Time Passwords

const app = express();
const port = process.env.PORT || 3001;

// --- Securely access your credentials from environment variables ---
const ANGEL_API_KEY = process.env.ANGEL_API_KEY;
const ANGEL_CLIENT_ID = process.env.ANGEL_CLIENT_ID;
const ANGEL_PASSWORD = process.env.ANGEL_PASSWORD;
const ANGEL_TOTP_SECRET = process.env.ANGEL_TOTP_SECRET;

// --- In-memory storage for session tokens ---
let session = {
    jwtToken: null,
    feedToken: null,
    profile: null
};

app.use(cors());
app.use(express.json());

// --- API Endpoints ---

app.get('/', (req, res) => {
  res.send('Angel One Authenticated Backend is running!');
});

app.post('/api/login', async (req, res) => {
    if (!ANGEL_API_KEY || !ANGEL_CLIENT_ID || !ANGEL_PASSWORD || !ANGEL_TOTP_SECRET) {
        return res.status(500).json({ message: "API credentials are not configured on the server." });
    }
    try {
        const totp = new pyotp.TOTP(ANGEL_TOTP_SECRET).now();
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

app.get('/api/instruments', async (req, res) => {
  try {
    const instrumentListUrl = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
    const response = await axios.get(instrumentListUrl);
    const nseStocks = response.data.filter(instrument => 
        instrument.exch_seg === 'NSE' && instrument.instrumenttype === 'AMX' && instrument.symbol.endsWith('-EQ')
    );
    res.json(nseStocks);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch instruments.' });
  }
});

/**
 * @api {get} /api/market-news Get AI-Generated Market News
 * @description Calls the Gemini API to generate a summary of the latest Indian market news.
 */
app.get('/api/market-news', async (req, res) => {
    try {
        const prompt = "Provide a brief, one-paragraph summary of today's key highlights and trends in the Indian stock market (NSE & BSE). Mention the performance of key indices like NIFTY 50 and SENSEX, and any notable sector movements.";
        
        const chatHistory = [{ role: "user", parts: [{ text: prompt }] }];
        const payload = { contents: chatHistory };
        const apiKey = ""; // API key is handled by the environment
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
        
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data.candidates && response.data.candidates.length > 0 &&
            response.data.candidates[0].content && response.data.candidates[0].content.parts &&
            response.data.candidates[0].content.parts.length > 0) {
            const newsText = response.data.candidates[0].content.parts[0].text;
            res.json({ news: newsText });
        } else {
            throw new Error("Invalid response structure from AI API.");
        }
    } catch (error) {
        console.error("Error fetching AI market news:", error.response ? error.response.data : error.message);
        res.status(500).json({ message: "Failed to generate market news." });
    }
});
