// index.js

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;

// --- Access the Gemini API key from environment variables ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(cors());
app.use(express.json()); // Middleware to parse JSON bodies

// --- API Endpoints ---

app.get('/', (req, res) => {
  res.send('Angel One API Backend (Public Endpoints) is running!');
});

/**
 * @api {get} /api/instruments Get NSE Equity Instruments
 */
app.get('/api/instruments', async (req, res) => {
  try {
    const instrumentListUrl = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
    const response = await axios.get(instrumentListUrl);
    const nseStocks = response.data.filter(instrument => 
        instrument.exch_seg === 'NSE' && 
        instrument.symbol.endsWith('-EQ')
    );
    res.json(nseStocks);
  } catch (error) {
    console.error('Error fetching instruments:', error.message);
    res.status(500).json({ message: 'Failed to fetch instruments.' });
  }
});

/**
 * @api {get} /api/market-news Get AI-Generated Market News
 */
app.get('/api/market-news', async (req, res) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ message: "AI API key is not configured on the server." });
    }
    try {
        const prompt = "Provide a brief, one-paragraph summary of today's key highlights and trends in the Indian stock market (NSE & BSE). Mention the performance of key indices like NIFTY 50 and SENSEX, and any notable sector movements.";
        const chatHistory = [{ role: "user", parts: [{ text: prompt }] }];
        const payload = { contents: chatHistory };
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
        const response = await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' } });

        if (response.data.candidates && response.data.candidates[0].content.parts) {
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

/**
 * @api {post} /api/company-details Get AI-Generated Company Details
 * @description Generates a profile for a specific company using its name.
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
        const prompt = `Provide a concise, one-paragraph business summary for the Indian company: ${companyName}. Include its primary sector, key products or services, and its general market position.`;
        const chatHistory = [{ role: "user", parts: [{ text: prompt }] }];
        const payload = { contents: chatHistory };
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
        const response = await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' } });

        if (response.data.candidates && response.data.candidates[0].content.parts) {
            const detailsText = response.data.candidates[0].content.parts[0].text;
            res.json({ details: detailsText });
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
