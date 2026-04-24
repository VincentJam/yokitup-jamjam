const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.YOKITUP_API_KEY;
const BASE = 'https://api.yokitup.com';

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'changeme';

function checkAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
    return res.status(401).send('Accès refusé');
  }
  const credentials = Buffer.from(auth.slice(6), 'base64').toString();
  const [, password] = credentials.split(':');
  if (password !== DASHBOARD_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
    return res.status(401).send('Mot de passe incorrect');
  }
  next();
}

app.use(checkAuth);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/*', async (req, res) => {
  const endpoint = req.path.replace('/api', '');
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const url = BASE + endpoint + query;

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Yokitup-Version': '2025-01-01',
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('Dashboard running on port ' + PORT));
