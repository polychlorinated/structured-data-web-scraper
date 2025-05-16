// Apify SDK - toolkit for building Apify Actors
import { Actor } from 'apify';
// Web scraping and browser automation library
import { PuppeteerCrawler } from 'crawlee';
// Import router from routes.js
import { router } from './routes.js';

// Initialize the Actor
await Actor.init();

// Get input with improved validation
const input = await Actor.getInput();

// Set up default URLs if none provided
const startUrls = input?.startUrls || [{ 
    url: 'https://en.wikipedia.org/wiki/List_of_municipalities_in_New_Mexico'
}];

console.log('Starting with URLs:', JSON.stringify(startUrls, null, 2));

// Process each URL and prepare request configurations
const requests = startUrls.map(startUrl => {
    // Accept either full object or simple URL string
    const url = typeof startUrl === 'string' ? startUrl : startUrl.url;
    
    // Extract any custom options
    const userData = {
        label: startUrl.label || null, // Will default to 'default' handler
        dataSourceType: startUrl.dataSourceType || input?.dataSourceType || 'auto', // Will be auto-detected if not specified
        apiType: startUrl.apiType || input?.apiType || null,
        
        // API-specific options
        apiToken: input?.apiToken || startUrl.apiToken || null,
        headers: input?.headers || startUrl.headers || {},
        method: startUrl.method || 'GET',
        body: startUrl.body || null,
        
        // Pagination options
        paginationType: startUrl.paginationType || null,
        pageParamName: startUrl.pageParamName || 'page',
        maxPages: input?.maxPages || startUrl.maxPages || 0, // 0 means no limit
        
        // Table options
        tableSelector: startUrl.tableSelector || null,
        extractAllColumns: (startUrl.extractAllColumns !== undefined) 
            ? startUrl.extractAllColumns 
            : (input?.extractAllColumns !== undefined ? input.extractAllColumns : true),
            
        // Debug options
        debug: input?.debug || startUrl.debug || false,
    };
    
    // For ASHA API specifically, configure the request properly
    if (userData.apiType === 'asha') {
        console.log('Configuring for ASHA API extraction');
        
        // ASHA requires browser-based navigation - use their main page
        if (!url.includes('find.asha.org')) {
            const originalUrl = url;
            url = 'https://find.asha.org/pro/';
            console.log(`Redirecting ASHA URL from ${originalUrl} to ${url}`);
        }
        
        // ASHA now uses a browser-based approach, so we only
        // need minimal headers if custom headers aren't provided
        if (!startUrl.headers) {
            userData.headers = {
                'accept': '*/*',
                'accept-language': 'en-US,en;q=0.9',
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
            };
        }
    }
    
    // For other APIs, ensure proper configuration
    if (userData.dataSourceType === 'api' && userData.apiType !== 'asha') {
        // Add basic JSON API headers if not set
        if (Object.keys(userData.headers).length === 0) {
            userData.headers = {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            };
        }
        
        // Add authorization if token provided
        if (userData.apiToken && !userData.headers['Authorization'] && !userData.headers['authorization']) {
            userData.headers['Authorization'] = `Bearer ${userData.apiToken}`;
        }
    }
    
    return {
        url,
        userData
    };
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
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 300,
    navigationTimeoutSecs: 180,
    maxConcurrency: input?.maxConcurrency || 1,
    // Log page console messages
    preNavigationHooks: [
        async ({ page, request }) => {
            page.on('console', (msg) => console.log(`PAGE LOG [${request.loadedUrl}]:`, msg.text()));
            await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36');
            
            // Enable debug features if requested
            if (request.userData.debug) {
                page.on('response', async (response) => {
                    const url = response.url();
                    const status = response.status();
                    if (status >= 400) {
                        console.log(`⚠️ Error ${status} for ${url}`);
                    } else if (url.includes('api') || url.includes('rest') || url.includes('.json')) {
                        console.log(`📡 API Response: ${status} ${url}`);
                        try {
                            const contentType = response.headers()['content-type'] || '';
                            if (contentType.includes('application/json')) {
                                const text = await response.text();
                                console.log(`Response preview: ${text.substring(0, 150)}...`);
                            }
                        } catch (e) {
                            console.log(`Could not preview response: ${e.message}`);
                        }
                    }
                });
            }
        },
    ],
    // Set up failedRequestHandler to log errors more explicitly
    failedRequestHandler: async ({ request, error }) => {
        console.error(`Request ${request.url} failed:`, error);
        
        // If the request was an API call, log additional details
        if (request.userData.dataSourceType === 'api') {
            console.error(`API call failed with method: ${request.userData.method}, headers:`, request.userData.headers);
            if (request.userData.body) {
                console.error('Request body:', request.userData.body);
            }
        }
    },
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