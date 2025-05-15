// Apify SDK - toolkit for building Apify Actors
import { Actor } from 'apify';
// Web scraping and browser automation library
import { PuppeteerCrawler } from 'crawlee';
// Import router from routes.js
import { router } from './routes.js';

// Initialize the Actor
await Actor.init();

// Get input or use default URL
const input = await Actor.getInput();
const startUrls = input?.startUrls || [{ 
    url: 'https://en.wikipedia.org/wiki/List_of_municipalities_in_Texas'
}];

console.log('Starting with URLs:', JSON.stringify(startUrls, null, 2));

// Ensure userData is attached to requests
const requests = startUrls.map(url => ({
    ...url,
    userData: {
        label: 'municipality-table'
    }
}));

// Configure proxy rotation
const proxyConfiguration = await Actor.createProxyConfiguration();

// Create a PuppeteerCrawler
const crawler = new PuppeteerCrawler({
    proxyConfiguration,
    requestHandler: router,
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--disable-gpu',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--window-size=1920,1080',
            ]
        }
    },
    // Additional settings
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 300,
    navigationTimeoutSecs: 180,
    maxConcurrency: 1,
    // Log page console messages
    preNavigationHooks: [
        async ({ page, request }) => {
            page.on('console', (msg) => console.log(`PAGE LOG [${request.loadedUrl}]:`, msg.text()));
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        },
    ],
});

// Run the crawler
console.log('Starting the crawler...');
try {
    // Log userData for debugging
    console.log('Request userData:', requests[0].userData);
    
    await crawler.run(requests);
    console.log('Crawler finished successfully!');
} catch (error) {
    console.error('Error during crawling:', error);
}

// Exit the Actor gracefully
await Actor.exit();