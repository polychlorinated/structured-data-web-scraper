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

// Process input options
const maxConcurrency = input?.maxConcurrency || 1;
const tableSelector = input?.tableSelector || 'table.wikitable';
const extractAllColumns = input?.extractAllColumns !== false;
const debug = input?.debug === true;

console.log(`Configuration: maxConcurrency=${maxConcurrency}, tableSelector="${tableSelector}", extractAllColumns=${extractAllColumns}, debug=${debug}`);

// Ensure userData is attached to requests
const requests = startUrls.map(url => {
    // If url is a string, convert to object
    const requestObject = typeof url === 'string' ? { url } : { ...url };
    
    // Add or merge userData
    requestObject.userData = {
        ...requestObject.userData,
        // Set default label to 'wikitable' if not already set
        label: requestObject.userData?.label || 'wikitable',
        // Add additional configuration
        tableSelector,
        extractAllColumns,
        debug
    };
    
    return requestObject;
});

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
    maxConcurrency,
    // Log page console messages
    preNavigationHooks: [
        async ({ page, request }) => {
            // Log page console messages for debugging
            page.on('console', (msg) => console.log(`PAGE LOG [${request.loadedUrl}]:`, msg.text()));
            
            // Set a user agent to avoid being blocked
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
            
            // Set viewport size
            await page.setViewport({ width: 1920, height: 1080 });
            
            // Optional: Disable images and CSS for faster loading
            if (!debug) {
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    const resourceType = req.resourceType();
                    if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font') {
                        req.abort();
                    } else {
                        req.continue();
                    }
                });
            }
        },
    ],
});

// Run the crawler
console.log('Starting the crawler...');
try {
    // Log userData for debugging
    console.log('First request userData:', JSON.stringify(requests[0].userData, null, 2));
    
    await crawler.run(requests);
    console.log('Crawler finished successfully!');
} catch (error) {
    console.error('Error during crawling:', error);
}

// Exit the Actor gracefully
await Actor.exit();