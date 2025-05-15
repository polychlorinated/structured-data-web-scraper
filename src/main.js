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
const mode = input?.mode || 'html';
const startUrls = input?.startUrls || [{
    url: 'https://en.wikipedia.org/wiki/List_of_municipalities_in_Texas'
}];
const bearerToken = input?.bearerToken || null;
const maxPages = input?.maxPages || 10;

console.log('Starting with URLs:', JSON.stringify(startUrls, null, 2));

// Ensure userData is attached to requests
const requests = startUrls.map(url => ({
    ...url,
    userData: {
        label: 'municipality-table',
        maxPages
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
    
    if (mode === 'html') {
        console.log('Running in HTML scraping mode');
        await crawler.run(requests);
        console.log('HTML crawl finished successfully!');
    } else if (mode === 'api') {
        console.log('Running in API scraping mode');
        await scrapeFromApi({ bearerToken });
        console.log('API scraping finished!');
    } else {
        throw new Error(`Invalid mode: ${mode}`);
    }

} catch (error) {
    console.error('Error during crawling:', error);
}
import { gotScraping } from 'crawlee';

async function scrapeFromApi({ bearerToken }) {
    if (!bearerToken) {
        throw new Error('Missing bearerToken for API scraping mode');
    }

    let offset = 0;
    const pageSize = 10;
    const maxResults = 500; // adjust as needed

    while (offset < maxResults) {
        console.log(`Fetching records ${offset} to ${offset + pageSize}...`);

        const response = await gotScraping.post({
            url: 'https://americanspeechlanguagehearingassociationproductionh0xeoc4i.org.coveo.com/rest/search/v2?organizationId=americanspeechlanguagehearingassociationproductionh0xeoc4i',
            headers: {
                'Authorization': `Bearer ${bearerToken}`,
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Origin': 'https://find.asha.org',
            },
            form: {
                aq: '@provider==Audiologist',
                firstResult: offset,
                numberOfResults: pageSize,
                locale: 'en',
                searchHub: 'ProFind',
                excerptLength: 200,
                enableDidYouMean: true,
                retrieveFirstSentences: true,
                timezone: 'America/Chicago',
                enableQuerySyntax: false,
                allowQueriesWithoutKeywords: true,
            },
            responseType: 'json',
        });

        const results = response.body?.results || [];
        console.log(`→ Got ${results.length} results`);

        if (results.length === 0) break;

        await Actor.pushData(results);
        offset += pageSize;
    }
}
// Exit the Actor gracefully
await Actor.exit();