const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Use CORS to allow cross-origin requests
app.use(cors());

// Angel One API credentials from environment variables
const ANGEL_API_KEY = process.env.ANGEL_API_KEY;
const ANGEL_CLIENT_ID = process.env.ANGEL_CLIENT_ID;
const ANGEL_PASSWORD = process.env.ANGEL_PASSWORD;
// Note: You will need a way to generate the TOTP if required by the API for login.
// For simplicity, this example focuses on an endpoint that might not require a session token,
// or assumes you have a long-lived token. The instruments list can often be fetched publicly.

app.get('/api/instruments', async (req, res) => {
  try {
    // Angel One's API endpoint for fetching instruments.
    // This URL is a placeholder; refer to the official SmartAPI documentation for the correct one.
    const url = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

    const response = await axios.get(url);

    // Filter for NSE stocks
    const nseStocks = response.data.filter(instrument => instrument.exch_seg === 'NSE' && instrument.symbol.endsWith('-EQ'));

    res.json(nseStocks);
  } catch (error) {
    console.error('Error fetching instruments:', error);
    res.status(500).json({ message: 'Failed to fetch instruments' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
