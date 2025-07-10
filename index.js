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
 * @api {get} /api/top-performers Get AI-Generated Top Performing Stocks
 */
app.get('/api/top-performers', async (req, res) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ message: "AI API key is not configured on the server." });
    }
    try {
        // **FIX:** Updated prompt to get change and percentChange
        const prompt = "Generate a JSON object with a key 'performers' which is an array of 10 of today's top-performing Indian NSE equity stocks. For each stock, provide its 'name', 'symbol', a realistic simulated 'price' (number), a positive 'change' (number), and a positive 'percentChange' (number).";
        const chatHistory = [{ role: "user", parts: [{ text: prompt }] }];
        
        // **FIX:** Updated schema to include new fields
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


/**
 * @api {post} /api/chart-data Get AI-Generated Candlestick Chart Data
 */
app.post('/api/chart-data', async (req, res) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ message: "AI API key is not configured on the server." });
    }

    const { companyName, timeframe } = req.body;
    if (!companyName) {
        return res.status(400).json({ message: "Company name is required." });
    }

    let prompt;
    const effectiveTimeframe = timeframe || 'D';

    switch (effectiveTimeframe) {
        case 'W':
            prompt = `Generate a JSON object containing an array of exactly 24 simulated weekly OHLCV (Open, High, Low, Close, Volume) stock data points for the Indian company: ${companyName}. The array should be named "ohlc". Each object must have a "date" (the Monday of that week in "YYYY-MM-DD" format, sequential, ending this week), and five numbers: "open", "high", "low", "close", and "volume".`;
            break;
        case 'M':
            prompt = `Generate a JSON object containing an array of exactly 24 simulated monthly OHLCV (Open, High, Low, Close, Volume) stock data points for the Indian company: ${companyName}. The array should be named "ohlc". Each object must have a "date" (the first day of that month in "YYYY-MM-DD" format, sequential, ending this month), and five numbers: "open", "high", "low", "close", and "volume".`;
            break;
        default:
            prompt = `Generate a JSON object containing an array of exactly 30 simulated daily OHLCV (Open, High, Low, Close, Volume) stock data points for the Indian company: ${companyName}. The array should be named "ohlc". Each object must have a "date" (in "YYYY-MM-DD" format, sequential, ending today), and five numbers: "open", "high", "low", "close", and "volume".`;
            break;
    }

    try {
        const chatHistory = [{ role: "user", parts: [{ text: prompt }] }];
        const payload = {
            contents: chatHistory,
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: { "ohlc": { type: "ARRAY", items: { type: "OBJECT", properties: { "date": { "type": "STRING" }, "open": { "type": "NUMBER" }, "high": { "type": "NUMBER" }, "low": { "type": "NUMBER" }, "close": { "type": "NUMBER" }, "volume": { "type": "NUMBER" } }, required: ["date", "open", "high", "low", "close", "volume"] } } }, required: ["ohlc"]
                }
            }
        };

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
        const response = await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' } });

        if (response.data.candidates && response.data.candidates[0].content.parts) {
            const chartData = JSON.parse(response.data.candidates[0].content.parts[0].text);
            res.json(chartData);
        } else {
            throw new Error("Invalid response structure from AI API for chart data.");
        }
    } catch (error) {
        console.error(`Error fetching AI chart data for ${companyName}:`, error.response ? error.response.data : error.message);
        res.status(500).json({ message: "Failed to generate chart data." });
    }
});

/**
 * @api {post} /api/technical-indicators Get AI-Generated Technical Indicators
 */
app.post('/api/technical-indicators', async (req, res) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ message: "AI API key is not configured on the server." });
    }

    const { companyName } = req.body;
    if (!companyName) {
        return res.status(400).json({ message: "Company name is required." });
    }

    try {
        const prompt = `For the Indian company ${companyName}, generate a JSON object with simulated technical analysis data. The object must contain these keys: "currentPrice" (a realistic number), "rsi" (a number between 20 and 80), "dma20" (a number), "dma50" (a number), and "dma200" (a number).`;
        const chatHistory = [{ role: "user", parts: [{ text: prompt }] }];
        const payload = {
            contents: chatHistory,
            generationConfig: { responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { "currentPrice": { "type": "NUMBER" }, "rsi": { "type": "NUMBER" }, "dma20": { "type": "NUMBER" }, "dma50": { "type": "NUMBER" }, "dma200": { "type": "NUMBER" } }, required: ["currentPrice", "rsi", "dma20", "dma50", "dma200"] } }
        };

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
        const response = await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' } });

        if (response.data.candidates && response.data.candidates[0].content.parts) {
            const technicalData = JSON.parse(response.data.candidates[0].content.parts[0].text);
            res.json(technicalData);
        } else {
            throw new Error("Invalid response structure from AI API for technical indicators.");
        }
    } catch (error) {
        console.error(`Error fetching AI technicals for ${companyName}:`, error.response ? error.response.data : error.message);
        res.status(500).json({ message: "Failed to generate technical indicators." });
    }
});


app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
