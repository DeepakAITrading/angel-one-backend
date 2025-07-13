/* ================================================================================= */
/* File: backend/index.js                                                            */
/* Description: The Node.js server, with endpoints for login, fetching the           */
/* instrument list, and fetching historical candle data.                             */
/* ================================================================================= */

// Import necessary packages
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env file

// Initialize the app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('../frontend'));

// === API ENDPOINTS ===

// Endpoint to handle login
app.post('/api/login', async (req, res) => {
    const { client_id, password } = req.body;
    const apiKey = process.env.ANGEL_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ status: false, message: 'API key is not configured on the server.' });
    }

    try {
        const response = await axios.post('https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword', {
            clientcode: client_id,
            password: password
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-UserType': 'USER',
                'X-SourceID': 'WEB',
                'X-ClientLocalIP': '192.168.1.1',
                'X-ClientPublicIP': '103.103.103.103',
                'X-MACAddress': '00:00:00:00:00:00',
                'X-PrivateKey': apiKey
            }
        });
        res.json(response.data);
    } catch (error) {
        console.error('Angel One Login Error:', error.response ? error.response.data : error.message);
        res.status(error.response?.status || 500).json(error.response?.data || { message: 'An internal server error occurred.' });
    }
});

// Endpoint to fetch instruments
app.get('/api/instruments', async (req, res) => {
    try {
        const response = await axios.get('https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json');
        res.json(response.data);
    } catch (error) {
        console.error('Fetch Instruments Error:', error.message);
        res.status(500).json({ message: 'Failed to fetch instrument data.' });
    }
});

// Endpoint to fetch historical data
app.post('/api/historical', async (req, res) => {
    // The JWT Token is sent from the frontend in the Authorization header
    const jwtToken = req.headers.authorization;
    const apiKey = process.env.ANGEL_API_KEY;

    if (!jwtToken) {
        return res.status(401).json({ status: false, message: 'Authorization token is required.' });
    }

    try {
        const response = await axios.post('https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData', 
        req.body, // The body from the frontend contains symboltoken, interval, etc.
        {
            headers: {
                'Authorization': jwtToken, // Pass the Bearer token
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-UserType': 'USER',
                'X-SourceID': 'WEB',
                'X-ClientLocalIP': '192.168.1.1',
                'X-ClientPublicIP': '103.103.103.103',
                'X-MACAddress': '00:00:00:00:00:00',
                'X-PrivateKey': apiKey
            }
        });
        res.json(response.data);
    } catch (error) {
        console.error('Historical Data Error:', error.response ? error.response.data : error.message);
        res.status(error.response?.status || 500).json(error.response?.data || { message: 'An internal server error occurred while fetching historical data.' });
    }
});


// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
