require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const whatsapp = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: 'C:\\Users\\Dello\\.cache\\puppeteer\\chrome\\win64-149.0.7827.22\\chrome-win64\\chrome.exe',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  }
});

whatsapp.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
});

whatsapp.on('ready', () => {
  console.log('BOT LISTO');
});

whatsapp.initialize();