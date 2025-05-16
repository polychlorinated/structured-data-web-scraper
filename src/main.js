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
        
        // API-specific options
        apiToken: input?.apiToken || startUrl.apiToken || null,
        headers: input?.headers || startUrl.headers || {},
        method: startUrl.method || 'GET',
        body: startUrl.body || null,
        apiType: startUrl.apiType || null,
        
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
        userData.method = 'POST';
        
        // Set default headers if not provided
        if (!startUrl.headers) {
            userData.headers = {
                'accept': '*/*',
                'accept-language': 'en-US,en;q=0.9',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'origin': 'https://find.asha.org',
                'referer': 'https://find.asha.org/',
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
            };
        }
        
        // Add authorization if token provided
        if (userData.apiToken) {
            userData.headers['authorization'] = `Bearer ${userData.apiToken}`;
        }
        
        // Set up default body for ASHA API if not provided
        if (!userData.body) {
            userData.body = {
                aq: "@provider==Audiologist",
                searchHub: "ProFind",
                locale: "en",
                firstResult: 0,
                numberOfResults: 10,
                excerptLength: 200,
                fieldsToInclude: ["date", "clickUri", "syssource", "filetype", "syslanguage", 
                    "sysindexeddate", "syssize", "provider", "outlookformacuri", "outlookuri", 
                    "connectortype", "urihash", "collection", "source", "author", "state", 
                    "ages", "expertise", "language", "objecttype", "permanentid"]
            };
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
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 300,
    navigationTimeoutSecs: 180,
    maxConcurrency: input?.maxConcurrency || 1,
    // Log page console messages
    preNavigationHooks: [
        async ({ page, request }) => {
            page.on('console', (msg) => console.log(`PAGE LOG [${request.loadedUrl}]:`, msg.text()));
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
            
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