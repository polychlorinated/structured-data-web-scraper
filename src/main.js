// Run the crawler
console.log(`Starting the crawler in ${mode} mode...`);
try {
    // Log request details for debugging
    console.log('First request details:', JSON.stringify(requests[0], null, 2));
    
    await crawler.run(requests);
    console.log('Crawler finished successfully!');
} catch (error) {
    console.error('Error during crawling:', error);
    // Log error details
    if (error.stack) {
        console.error('Stack trace:', error.stack);
    }
    
    // Record the error in the dataset
    await Dataset.pushData({
        error: 'Crawler error',
        message: error.message,
        timestamp: new Date().toISOString()
    });
}

// Exit the Actor gracefully
await Actor.exit();// Apify SDK - toolkit for building Apify Actors
import { Actor } from 'apify';
// Web scraping and browser automation library
import { PuppeteerCrawler, gotScraping, Dataset } from 'crawlee';
// Import router from routes.js
import { router } from './routes.js';

// Initialize the Actor
await Actor.init();

// Get input or use default URL
const input = await Actor.getInput();
const startUrls = input?.startUrls || [{ 
    url: 'https://en.wikipedia.org/wiki/List_of_municipalities_in_Texas'
}];

// Get the extraction mode - 'html' (default) or 'api'
const mode = input?.mode || 'html';

console.log(`Starting in ${mode} mode with URLs:`, JSON.stringify(startUrls, null, 2));

// Process start URLs to include additional metadata
const requests = startUrls.map(urlObj => {
    // Extract the page title from the URL for better identification
    let title = 'Data Extraction';
    try {
        // Try to extract a meaningful title from the URL
        const urlParts = new URL(urlObj.url).pathname.split('/');
        const lastPart = urlParts[urlParts.length - 1];
        if (lastPart) {
            // Convert URL format (e.g., List_of_municipalities_in_Texas) to readable title
            title = lastPart.replace(/_/g, ' ');
        }
    } catch (e) {
        console.log('Could not parse URL for title, using default');
    }
    
    return {
        ...urlObj,
        userData: {
            label: 'municipality-table',
            title: title,
            pageType: urlObj.pageType || 'default',
            mode: mode,
            apiParams: urlObj.apiParams || {},
            apiType: urlObj.apiType || null
        }
    };
});

// Configure proxy rotation
const proxyConfiguration = await Actor.createProxyConfiguration();

// Initialize the appropriate crawler based on mode
let crawler;

if (mode === 'api') {
    console.log('Initializing API mode - using request-based approach');
    
    // For API requests, we'll use gotScraping directly
    // but still initialize the crawler for HTML fallback if needed
    crawler = new PuppeteerCrawler({
        proxyConfiguration,
        requestHandler: router,
        launchContext: {
            launchOptions: {
                headless: true,
                defaultViewport: {
                    width: 1920,
                    height: 1080
                },
                args: [
                    '--disable-gpu',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--window-size=1920,1080',
                ]
            }
        },
        // Improved settings
        maxRequestRetries: 3,
        requestHandlerTimeoutSecs: 300,
        navigationTimeoutSecs: 180,
        maxConcurrency: 2,
        // Additional settings for API mode
        preNavigationHooks: [
            async ({ page, request }) => {
                // For API requests, we'll use the page's fetch API
                console.log(`Processing API request: ${request.url}`);
            }
        ],
    });
    
    // Process API requests directly if needed
    if (input?.skipBrowser) {
        console.log('Processing API requests directly without browser');
        
        for (const request of requests) {
            try {
                console.log(`Direct API request to: ${request.url}`);
                
                // Make direct API request using gotScraping
                const response = await gotScraping({
                    url: request.url,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    json: request.userData.apiParams || {},
                    responseType: 'json',
                    retry: {
                        limit: 3
                    }
                });
                if (response.statusCode >= 400) {
                    console.error('API error response body:', response.body);
                    log.error('API error response body:', response.body);
                    throw new Error(`API responded with status: ${response.statusCode}`);
                }
                // Process the API response
                if (response.body) {
                    console.log(`API response received for ${request.url}`);
                    
                    // Process API data
                    let processedData = [];
                    if (Array.isArray(response.body)) {
                        processedData = response.body;
                    } else if (response.body.data && Array.isArray(response.body.data)) {
                        processedData = response.body.data;
                    } else if (request.userData.apiType === 'asha' && response.body.results) {
                        processedData = response.body.results.map(item => ({
                            id: item.id,
                            name: item.name,
                            address: item.address,
                            city: item.city,
                            state: item.state,
                            zip: item.zip,
                            phone: item.phone,
                            type: item.type
                        }));
                    } else {
                        processedData = [response.body];
                    }
                    
                    // Push to dataset
                    await Dataset.pushData({
                        url: request.url,
                        title: request.userData.title || 'API Data Extraction',
                        timestamp: new Date().toISOString(),
                        source: 'api',
                        apiParams: request.userData.apiParams,
                        rowCount: processedData.length,
                        data: processedData
                    });
                    
                    // Handle API pagination if present
                    if (response.body.pagination && response.body.pagination.nextPage) {
                        console.log(`API has more pages. Adding next page.`);
                        
                        // Add next page to requests
                        const nextPageParams = {
                            ...request.userData.apiParams,
                            page: (request.userData.apiParams.page || 1) + 1
                        };
                        
                        requests.push({
                            url: request.url,
                            userData: {
                                ...request.userData,
                                apiParams: nextPageParams
                            }
                        });
                    }
                }
            } catch (error) {
                console.error(`Error making direct API request: ${error.message}`);
                
                // Record the error
                await Dataset.pushData({
                    url: request.url,
                    title: request.userData.title || 'API Data Extraction',
                    timestamp: new Date().toISOString(),
                    source: 'api',
                    error: error.message
                });
            }
        }
        
        console.log('Direct API processing completed');
        await Actor.exit();
    }
} else {
    // Standard HTML mode
    crawler = new PuppeteerCrawler({
        proxyConfiguration,
        requestHandler: router,
        launchContext: {
            launchOptions: {
                headless: true,
                defaultViewport: {
                    width: 1920,
                    height: 1080
                },
                args: [
                    '--disable-gpu',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--window-size=1920,1080',
                ]
            }
        },
        // Improved settings
        maxRequestRetries: 3,
        requestHandlerTimeoutSecs: 300,
        navigationTimeoutSecs: 180,
        maxConcurrency: 1,
        // Enhanced navigation hooks
        preNavigationHooks: [
            async ({ page, request }) => {
                // Capture console logs
                page.on('console', (msg) => console.log(`PAGE LOG [${request.loadedUrl}]:`, msg.text()));
                
                // Set modern user agent
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');
                
                // Set extra HTTP headers to appear more like a normal browser
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                });
                
                // Disable unnecessary features
                await page.setRequestInterception(true);
                page.on('request', (interceptedRequest) => {
                    // Block unnecessary resources to speed up crawling
                    const resourceType = interceptedRequest.resourceType();
                    if (['image', 'media', 'font', 'other'].includes(resourceType)) {
                        interceptedRequest.abort();
                    } else {
                        interceptedRequest.continue();
                    }
                });
            },
        ],
        // Add post-navigation hook for additional setup
        postNavigationHooks: [
            async ({ page, request }) => {
                // Wait for network to be mostly idle
                await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {
                    console.log('Network did not reach idle state, continuing anyway');
                });
                
                // Set request metadata for tracking
                request.userData.loadTime = Date.now();
            },
        ],
    });
}

// Run the crawler
console.log('Starting the crawler...');
try {
    // Log request details for debugging
    console.log('First request details:', JSON.stringify(requests[0], null, 2));
    
    await crawler.run(requests);
    console.log('Crawler finished successfully!');
} catch (error) {
    console.error('Error during crawling:', error);
    // Log error details
    if (error.stack) {
        console.error('Stack trace:', error.stack);
    }
}

// Exit the Actor gracefully
await Actor.exit();