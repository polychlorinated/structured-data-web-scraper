import { Dataset, createPuppeteerRouter } from 'crawlee';

export const router = createPuppeteerRouter();

// Default handler that detects data type and routes accordingly
router.addDefaultHandler(async ({ request, page, log, crawler }) => {
    log.info(`Running default handler for URL: ${request.url}`);
    
    // Determine data source type from userData or detect it
    const dataSourceType = request.userData.dataSourceType || await detectDataSourceType(request, page, log);
    
    // Route to appropriate handler based on data source type
    if (dataSourceType === 'api') {
        log.info(`Detected API data source, processing with API handler`);
        await extractApiData(request, page, log, crawler);
    } else {
        log.info(`Detected HTML table data source, processing with table handler`);
        await extractTableData(request, page, log, crawler);
    }
});

// Specific handler for HTML tables (e.g., Wikipedia tables)
router.addHandler('table', async ({ request, page, log, crawler }) => {
    log.info(`Table handler for URL: ${request.url}`);
    await extractTableData(request, page, log, crawler);
});

// Specific handler for API endpoints
router.addHandler('api', async ({ request, page, log, crawler }) => {
    log.info(`API handler for URL: ${request.url}`);
    await extractApiData(request, page, log, crawler);
});

// Error handler
router.addHandler('error', async ({ request, log }) => {
    log.error(`Error processing ${request.url}`);
});

/**
 * Detect the type of data source (API or HTML table)
 */
async function detectDataSourceType(request, page, log) {
    // If URL contains API indicators or userData has API settings, treat as API
    if (
        request.url.includes('/api/') || 
        request.url.includes('/rest/') || 
        request.url.includes('.json') ||
        request.userData.apiToken ||
        request.userData.headers
    ) {
        return 'api';
    }
    
    // Otherwise assume it's a regular HTML page with tables
    return 'table';
}

/**
 * Extract data from API endpoints
 */
async function extractApiData(request, page, log, crawler) {
    log.info('Processing API data extraction', { url: request.loadedUrl });
    
    try {
        // Get API configuration from userData
        const apiToken = request.userData.apiToken;
        const customHeaders = request.userData.headers || {};
        const apiMethod = request.userData.method || 'GET';
        const apiBody = request.userData.body;
        const apiType = request.userData.apiType;
        
        // Handle ASHA API differently - their API requires specific handling
        if (apiType === 'asha') {
            log.info('Using special ASHA API handling');
            return await extractAshaApiData(request, page, log, crawler);
        }
        
        log.info('API extraction configuration', { 
            hasToken: !!apiToken,
            method: apiMethod,
            hasBody: !!apiBody,
            headerCount: Object.keys(customHeaders).length
        });
        
        // Prepare headers
        const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...customHeaders
        };
        
        // Add authorization if token provided
        if (apiToken) {
            headers['Authorization'] = `Bearer ${apiToken}`;
        }
        
        // Execute the request using page.evaluate to leverage browser's fetch
        const apiResponse = await page.evaluate(
            async ({ url, method, headers, body, apiType }) => {
                try {
                    // Prepare the request body based on API type and content-type
                    let requestBody = undefined;
                    
                    // If we have a body, format it correctly based on content-type
                    if (body) {
                        const contentType = headers['content-type'] || headers['Content-Type'] || '';
                        
                        // For form-urlencoded content type
                        if (contentType.includes('form-urlencoded')) {
                            // Convert body object to URL-encoded string
                            const params = new URLSearchParams();
                            
                            // Handle objects, arrays, and primitives properly
                            Object.entries(body).forEach(([key, value]) => {
                                if (typeof value === 'object' && value !== null) {
                                    // For objects and arrays, stringify them
                                    params.append(key, JSON.stringify(value));
                                } else {
                                    // For primitives, convert to string
                                    params.append(key, String(value));
                                }
                            });
                            
                            requestBody = params.toString();
                            console.log('Form URL-encoded body:', requestBody.substring(0, 150) + '...');
                        } 
                        // For JSON content type
                        else if (contentType.includes('application/json')) {
                            requestBody = JSON.stringify(body);
                        }
                        // Default fallback if content-type is not specified
                        else {
                            requestBody = JSON.stringify(body);
                        }
                    }
                    
                    console.log(`Making ${method} request to ${url} with content-type: ${headers['content-type'] || 'not specified'}`);
                    
                    const response = await fetch(url, {
                        method,
                        headers,
                        body: requestBody,
                        credentials: 'include'
                    });
                    
                    // Log response status for debugging
                    console.log(`Response status: ${response.status} ${response.statusText}`);
                    
                    if (!response.ok) {
                        // Try to read response text for better error information
                        try {
                            const errorText = await response.text();
                            return { 
                                error: true, 
                                status: response.status, 
                                statusText: response.statusText,
                                errorText: errorText.substring(0, 500) // Limit length
                            };
                        } catch (readError) {
                            return { 
                                error: true, 
                                status: response.status, 
                                statusText: response.statusText 
                            };
                        }
                    }
                    
                    // Try to parse as JSON
                    try {
                        return await response.json();
                    } catch (jsonError) {
                        // If it's not JSON, return the text
                        const text = await response.text();
                        return { text, _responseType: 'text' };
                    }
                } catch (error) {
                    return { error: true, message: error.toString() };
                }
            }, 
            { 
                url: request.url, 
                method: apiMethod, 
                headers, 
                body: apiBody,
                apiType: request.userData.apiType 
            }
        );
        
        // Check for errors
        if (apiResponse.error) {
            log.error('API request failed', apiResponse);
            return;
        }
        
        // Process the API response data
        const processedData = processApiData(apiResponse, request.userData);
        
        if (!processedData || processedData.length === 0) {
            log.error('Failed to process API data or no records found');
            return;
        }
        
        log.info(`Successfully extracted ${processedData.length} records from API`);
        
        // Format the output
        const formattedOutput = {
            source_type: 'api',
            url: request.loadedUrl,
            data: processedData,
            // Include metadata if available
            metadata: {
                total_count: apiResponse.totalCount || apiResponse.totalCountFiltered || processedData.length,
                page_info: apiResponse.pagination || {}
            }
        };
        
        // Push to dataset
        await Dataset.pushData(formattedOutput);
        log.info('API data successfully pushed to dataset');
        
        // Handle API pagination if available
        await handleApiPagination(request, page, log, crawler, apiResponse);
        
    } catch (error) {
        log.error(`Error during API data extraction: ${error.message}`);
        
        // Take a screenshot for debugging
        await page.screenshot({ path: 'api-error.png', fullPage: true });
        log.info('Error screenshot saved');
    }
}

/**
 * Special handler for the ASHA API, which requires browser-based authentication
 */
async function extractAshaApiData(request, page, log, crawler) {
    log.info('Extracting data from ASHA API');
    
    try {
        // For ASHA API, need to first navigate to the actual page to get authenticated
        const findAshaUrl = 'https://find.asha.org/pro/';
        
        log.info(`Navigating to ASHA find page: ${findAshaUrl}`);
        await page.goto(findAshaUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Wait for the page to load and authenticate
        await page.waitForSelector('body', { timeout: 30000 });
        
        // Take a screenshot for debugging
        if (request.userData.debug) {
            await page.screenshot({ path: 'asha-initial.png', fullPage: true });
            log.info('ASHA initial page screenshot saved');
        }
        
        // Set up the request interceptor to capture API responses
        let apiResponseData = null;
        
        await page.setRequestInterception(true);
        
        page.on('request', (req) => {
            // Pass through all requests
            req.continue();
        });
        
        page.on('response', async (response) => {
            const url = response.url();
            
            // Check if this is the API response we're looking for
            if (url.includes('americanspeechlanguagehearingassociationproductionh0xeoc4i.org.coveo.com/rest/search/v2')) {
                try {
                    const contentType = response.headers()['content-type'] || '';
                    if (contentType.includes('application/json')) {
                        const responseText = await response.text();
                        try {
                            apiResponseData = JSON.parse(responseText);
                            log.info('Successfully captured API response data');
                        } catch (e) {
                            log.error(`Error parsing JSON: ${e.message}`);
                        }
                    }
                } catch (error) {
                    log.error(`Error processing response: ${error.message}`);
                }
            }
        });
        
        // Now trigger the search by setting filter
        log.info('Triggering ASHA search');
        
        await page.evaluate(async () => {
            // This will simulate clicking or filtering for Audiologists
            try {
                // Try to click the Audiologist filter if it exists
                const filterButtons = Array.from(document.querySelectorAll('button'));
                for (const button of filterButtons) {
                    if (button.textContent.includes('Audiologist')) {
                        button.click();
                        console.log('Clicked Audiologist filter button');
                        return;
                    }
                }
                
                // If no button, try to set URL hash directly
                window.location.hash = '#first=0&sort=relevancy&f:@provider=[Audiologist]';
                console.log('Set URL hash for Audiologist filter');
                
                // Force a reload/search if needed
                const searchButtons = Array.from(document.querySelectorAll('button'));
                for (const button of searchButtons) {
                    if (button.textContent.includes('Search')) {
                        button.click();
                        console.log('Clicked Search button');
                        return;
                    }
                }
            } catch (e) {
                console.error('Error triggering search:', e);
            }
        });
        
        // Wait for search results to load
        await page.waitForFunction(() => {
            // Check for results or a loading element or error message
            return document.querySelector('.CoveoResult') !== null || 
                document.querySelector('.coveo-search-complete') !== null;
        }, { timeout: 30000 });
        
        // Take another screenshot after search
        if (request.userData.debug) {
            await page.screenshot({ path: 'asha-search-results.png', fullPage: true });
            log.info('ASHA search results screenshot saved');
        }
        
        // Wait a bit more for any network requests to complete
        await page.waitForTimeout(2000);
        
        // If we got API data from the intercepted response, use it
        if (apiResponseData) {
            log.info('Processing intercepted API response data');
            
            // Process the API response data
            const processedData = processApiData(apiResponseData, request.userData);
            
            if (!processedData || processedData.length === 0) {
                log.error('Failed to process API data or no records found');
                
                // Attempt to extract data directly from the page as fallback
                return await extractAshaResultsFromPage(page, request, log, crawler);
            }
            
            log.info(`Successfully extracted ${processedData.length} records from API`);
            
            // Format the output
            const formattedOutput = {
                source_type: 'api',
                url: request.loadedUrl,
                data: processedData,
                // Include metadata if available
                metadata: {
                    total_count: apiResponseData.totalCount || apiResponseData.totalCountFiltered || processedData.length,
                    page_info: apiResponseData.pagination || {}
                }
            };
            
            // Push to dataset
            await Dataset.pushData(formattedOutput);
            log.info('ASHA API data successfully pushed to dataset');
            
            // Handle pagination
            const totalCount = apiResponseData.totalCount || apiResponseData.totalCountFiltered || 0;
            const currentResults = processedData.length;
            
            if (totalCount > currentResults) {
                log.info(`Found ${totalCount} total results, processing pagination`);
                await handleAshaPagination(page, request, log, crawler, totalCount, currentResults);
            }
            
            return;
        }
        
        // If we couldn't intercept API data, fall back to extracting from the page
        return await extractAshaResultsFromPage(page, request, log, crawler);
        
    } catch (error) {
        log.error(`Error during ASHA API extraction: ${error.message}`);
        
        // Take a screenshot for debugging
        await page.screenshot({ path: 'asha-error.png', fullPage: true });
        log.info('Error screenshot saved');
    }
}

/**
 * Extract ASHA results directly from the page HTML as a fallback
 */
async function extractAshaResultsFromPage(page, request, log, crawler) {
    log.info('Extracting ASHA results directly from page HTML');
    
    try {
        // Extract the data from the page
        const resultData = await page.evaluate(() => {
            const results = [];
            
            // Get all result elements
            const resultElements = document.querySelectorAll('.CoveoResult');
            
            for (const element of resultElements) {
                try {
                    // Extract the title
                    const titleElement = element.querySelector('.CoveoResultLink');
                    const title = titleElement ? titleElement.textContent.trim() : '';
                    
                    // Extract the link
                    const link = titleElement ? titleElement.href : '';
                    
                    // Extract other metadata fields
                    const metaFields = {};
                    const fieldElements = element.querySelectorAll('.coveo-field-caption, .coveo-field-table-toggle-caption');
                    
                    for (const fieldElement of fieldElements) {
                        const label = fieldElement.textContent.trim();
                        const value = fieldElement.nextElementSibling ? fieldElement.nextElementSibling.textContent.trim() : '';
                        
                        if (label && value) {
                            // Clean up label (remove colon)
                            const cleanLabel = label.replace(':', '').trim();
                            metaFields[cleanLabel] = value;
                        }
                    }
                    
                    // Add to results
                    results.push({
                        title,
                        link,
                        ...metaFields
                    });
                } catch (error) {
                    console.error(`Error processing result: ${error.message}`);
                }
            }
            
            // Try to get total count information
            let totalCount = 0;
            const countElement = document.querySelector('.coveo-query-summary-number');
            if (countElement) {
                const countText = countElement.textContent.trim();
                const match = countText.match(/\d+/);
                if (match) {
                    totalCount = parseInt(match[0], 10);
                }
            }
            
            return {
                results,
                totalCount
            };
        });
        
        if (!resultData || !resultData.results || resultData.results.length === 0) {
            log.error('No results found on page');
            return;
        }
        
        log.info(`Extracted ${resultData.results.length} results from page`);
        
        // Format the output
        const formattedOutput = {
            source_type: 'asha_html',
            url: request.loadedUrl,
            data: resultData.results,
            metadata: {
                total_count: resultData.totalCount || resultData.results.length
            }
        };
        
        // Push to dataset
        await Dataset.pushData(formattedOutput);
        log.info('ASHA page data successfully pushed to dataset');
        
        // Handle pagination if needed
        if (resultData.totalCount > resultData.results.length) {
            log.info(`Found ${resultData.totalCount} total results, processing pagination`);
            await handleAshaPagination(page, request, log, crawler, resultData.totalCount, resultData.results.length);
        }
        
    } catch (error) {
        log.error(`Error extracting results from page: ${error.message}`);
        
        // Take a screenshot for debugging
        await page.screenshot({ path: 'asha-extraction-error.png', fullPage: true });
        log.info('Extraction error screenshot saved');
    }
}

/**
 * Handle pagination for ASHA results
 */
async function handleAshaPagination(page, request, log, crawler, totalCount, currentResultsCount) {
    log.info('Handling ASHA pagination');
    
    try {
        // Calculate current page and max pages
        const resultsPerPage = request.userData.numberOfResults || 10;
        const currentPage = Math.floor(currentResultsCount / resultsPerPage);
        const maxPages = Math.ceil(totalCount / resultsPerPage);
        
        // Get max pages from userData if set
        const userMaxPages = request.userData.maxPages || 0;
        const effectiveMaxPages = userMaxPages > 0 ? Math.min(maxPages, userMaxPages) : maxPages;
        
        log.info(`Pagination info: current page ${currentPage}, max pages ${effectiveMaxPages}`);
        
        // Check if we need to continue pagination
        if (currentPage >= effectiveMaxPages - 1) {
            log.info('Reached max pages, stopping pagination');
            return;
        }
        
        // Calculate next page number
        const nextPage = currentPage + 1;
        
        // Calculate next result offset
        const nextOffset = nextPage * resultsPerPage;
        
        log.info(`Loading next page: ${nextPage} (offset: ${nextOffset})`);
        
        // Track processed pages to avoid loops
        const processedPages = request.userData.processedPages || [];
        
        if (processedPages.includes(nextPage)) {
            log.info(`Already processed page ${nextPage}, skipping to avoid loop`);
            return;
        }
        
        processedPages.push(currentPage);
        
        // Try to navigate to the next page
        const nextPageSuccess = await page.evaluate((nextOffset) => {
            try {
                // Try the modern Coveo way first
                if (typeof Coveo !== 'undefined' && Coveo.state) {
                    Coveo.state(Coveo.$('#search'), { first: nextOffset });
                    return true;
                }
                
                // Try using location hash
                const urlObj = new URL(window.location.href);
                urlObj.hash = urlObj.hash.replace(/first=\d+/, `first=${nextOffset}`);
                window.location.href = urlObj.toString();
                return true;
            } catch (e) {
                console.error('Error navigating to next page:', e);
                return false;
            }
        }, nextOffset);
        
        if (!nextPageSuccess) {
            log.error('Failed to navigate to next page');
            return;
        }
        
        // Wait for the page to load
        await page.waitForFunction(() => {
            // Check for results or a loading element or error message
            return document.querySelector('.CoveoResult') !== null || 
                document.querySelector('.coveo-search-complete') !== null;
        }, { timeout: 30000 });
        
        // Take a screenshot after pagination
        if (request.userData.debug) {
            await page.screenshot({ path: `asha-page-${nextPage}.png`, fullPage: true });
            log.info(`ASHA page ${nextPage} screenshot saved`);
        }
        
        // Add this page to the queue for processing
        await crawler.addRequests([{
            url: request.url,
            userData: {
                ...request.userData,
                label: 'api',
                dataSourceType: 'api',
                apiType: 'asha',
                processedPages,
                pageNumber: nextPage,
                firstResult: nextOffset
            }
        }]);
        
    } catch (error) {
        log.error(`Error handling ASHA pagination: ${error.message}`);
    }
}

/**
 * Process API response data
 */
function processApiData(apiResponse, userData) {
    try {
        // If the response is null or undefined, return empty array
        if (!apiResponse) {
            return [];
        }
        
        // If the response is already an array, return it directly
        if (Array.isArray(apiResponse)) {
            return apiResponse;
        }
        
        // Handle ASHA-specific format if specified
        if (userData.apiType === 'asha' && apiResponse.results) {
            // Return all fields from each result
            return apiResponse.results;
        }
        
        // Common pattern: API response has a results array
        if (apiResponse.results && Array.isArray(apiResponse.results)) {
            return apiResponse.results;
        }
        
        // Common pattern: API response has a data array
        if (apiResponse.data && Array.isArray(apiResponse.data)) {
            return apiResponse.data;
        }
        
        // Common pattern: API response has an items array
        if (apiResponse.items && Array.isArray(apiResponse.items)) {
            return apiResponse.items;
        }
        
        // Look for any array property in the response
        if (typeof apiResponse === 'object' && apiResponse !== null) {
            const fields = Object.keys(apiResponse);
            for (const field of fields) {
                if (Array.isArray(apiResponse[field]) && apiResponse[field].length > 0) {
                    return apiResponse[field];
                }
            }
        }
        
        // If we can't identify a specific array to return, wrap the response in an array
        return [apiResponse];
    } catch (error) {
        console.error(`Error processing API data: ${error.message}`);
        return []; // Return empty array to prevent further errors
    }
}

/**
 * Handle pagination for API responses
 */
async function handleApiPagination(request, page, log, crawler, apiResponse) {
    log.info('Checking for API pagination');
    
    try {
        // Get current page info
        const currentPage = request.userData.page || 1;
        const nextPage = currentPage + 1;
        
        // Different APIs have different pagination structures
        let hasNextPage = false;
        let nextPageUrl = null;
        
        // Case 1: API directly provides next page URL
        if (apiResponse.nextPage || apiResponse.next) {
            nextPageUrl = apiResponse.nextPage || apiResponse.next;
            hasNextPage = !!nextPageUrl;
        }
        // Case 2: API provides pagination info with total pages
        else if (apiResponse.pagination && apiResponse.pagination.totalPages) {
            hasNextPage = currentPage < apiResponse.pagination.totalPages;
        }
        // Case 3: ASHA pagination requires manual construction
        else if (request.userData.apiType === 'asha') {
            // Check if we have more results (totalCount > currentOffset + results.length)
            const resultsPerPage = apiResponse.results?.length || 10;
            const offset = request.userData.firstResult || 0;
            const totalItems = apiResponse.totalCount || apiResponse.totalCountFiltered;
            
            hasNextPage = offset + resultsPerPage < totalItems;
            
            if (hasNextPage) {
                // For ASHA, we need to construct a new request with updated body parameters
                const newBody = { ...request.userData.body };
                newBody.firstResult = offset + resultsPerPage;
                request.userData.body = newBody;
                
                // Keep the same URL
                nextPageUrl = request.url;
            }
        }
        // Case 4: Simple page-based pagination (must construct URL)
        else if (request.userData.paginationType === 'page') {
            const pageParamName = request.userData.pageParamName || 'page';
            const url = new URL(request.url);
            url.searchParams.set(pageParamName, nextPage.toString());
            nextPageUrl = url.toString();
            
            // Determine if we have a next page based on current response
            const currentResults = processApiData(apiResponse, request.userData);
            hasNextPage = currentResults && currentResults.length > 0;
        }
        
        if (hasNextPage && (nextPageUrl || request.url)) {
            log.info(`Adding next API page to queue: ${nextPageUrl || request.url} (page ${nextPage})`);
            
            // Track processed URLs to avoid loops
            const processedUrls = request.userData.processedUrls || [];
            if (processedUrls.includes(nextPageUrl)) {
                log.info(`Already processed URL ${nextPageUrl}, skipping to avoid loop`);
                return;
            }
            
            processedUrls.push(request.url);
            
            // Add next page to queue
            await crawler.addRequests([{
                url: nextPageUrl || request.url,
                userData: {
                    ...request.userData,
                    label: 'api',
                    page: nextPage,
                    processedUrls
                }
            }]);
        } else {
            log.info('No more API pages to process');
        }
    } catch (error) {
        log.error(`Error handling API pagination: ${error.message}`);
    }
}

/**
 * Extract data from HTML tables
 */
async function extractTableData(request, page, log, crawler) {
    log.info('Processing HTML table extraction', { url: request.loadedUrl });
    
    try {
        // Wait for page to be fully loaded
        await page.waitForSelector('body', { timeout: 30000 });
        
        // Take a screenshot of the page for debugging
        await page.screenshot({ path: 'page-initial.png', fullPage: true });
        log.info('Initial page screenshot saved');
        
        // Log the page title for debugging
        const pageTitle = await page.title();
        log.info(`Page title: ${pageTitle}`);
        
        // Identify all tables on the page
        const tableData = await identifyAndExtractTables(page, log);
        
        if (!tableData || tableData.length === 0 || !tableData.tables || tableData.tables.length === 0) {
            log.error('No tables found or extraction failed');
            await page.screenshot({ path: 'no-tables.png', fullPage: true });
            return;
        }
        
        log.info(`Successfully extracted ${tableData.tables.length} tables with ${tableData.rowCount} total rows`);
        
        // Format the output
        const formattedOutput = {
            source_type: 'html_table',
            url: request.loadedUrl,
            page_title: pageTitle,
            tables: tableData.tables
        };
        
        // Push to dataset
        await Dataset.pushData(formattedOutput);
        log.info('Table data successfully pushed to dataset');
        
        // Take a success screenshot
        await page.screenshot({ path: 'success.png', fullPage: false });
        log.info('Success screenshot saved');
        
        // Check for pagination and process next pages
        try {
            const paginationInfo = await checkForPagination(page, log);
            
            if (paginationInfo && paginationInfo.found) {
                log.info(`Pagination detected: ${paginationInfo.url}`);
                await handlePagination(page, request, log, crawler, paginationInfo);
            } else {
                log.info('No pagination detected on this page');
            }
        } catch (paginationError) {
            log.error(`Error checking for pagination: ${paginationError.message}`);
            // Continue with the process, pagination is optional
        }
    } catch (error) {
        log.error(`Error during table extraction: ${error.message}`);
        
        // Take a screenshot for debugging
        await page.screenshot({ path: 'error-extraction.png', fullPage: true });
        log.info('Error screenshot saved');
    }
}

/**
 * Identify and extract all tables from the page
 */
async function identifyAndExtractTables(page, log) {
    return await page.evaluate(() => {
        // Helper function to convert a table to a structured object
        function extractTableData(table, tableIndex) {
            try {
                // Collect all headers (th elements) from the table
                const headerElements = table.querySelectorAll('th');
                const headerTexts = Array.from(headerElements).map(th => th.textContent.trim());
                
                // Find all rows - either in tbody or as direct tr children of the table
                let rows = [];
                let allRows = [];
                const tbody = table.querySelector('tbody');
                        
                if (tbody) {
                    // If tbody exists, get rows from it
                    allRows = Array.from(tbody.querySelectorAll('tr'));
                } else {
                    // If no tbody, get direct tr children of table
                    allRows = Array.from(table.querySelectorAll('tr'));
                }
                
                console.log(`Table ${tableIndex + 1}: Found ${allRows.length} rows`);
                
                // Determine header row(s) to skip
                let startIndex = 0;
                
                // Skip thead rows if present
                const thead = table.querySelector('thead');
                if (thead) {
                    const theadRowCount = thead.querySelectorAll('tr').length;
                    startIndex = Math.max(startIndex, theadRowCount);
                } 
                // If first row has th elements, likely a header row
                else if (allRows.length > 0 && allRows[0].querySelectorAll('th').length > 0) {
                    startIndex = 1; // Skip the first row
                }
                
                // If we couldn't find headers from th elements, try using the first row
                if (headerTexts.length === 0 && allRows.length > 0) {
                    const firstRowCells = allRows[0].querySelectorAll('td');
                    if (firstRowCells.length > 0) {
                        Array.from(firstRowCells).forEach(cell => {
                            headerTexts.push(cell.textContent.trim());
                        });
                        startIndex = 1; // Skip the first row since we're using it as header
                    }
                }
                
                // Process each row into an object
                for (let i = startIndex; i < allRows.length; i++) {
                    try {
                        const row = allRows[i];
                        const cells = row.querySelectorAll('td');
                        
                        // Skip rows without any cells
                        if (cells.length === 0) {
                            continue;
                        }
                        
                        const rowData = {};
                        
                        // Process each cell
                        Array.from(cells).forEach((cell, cellIndex) => {
                            try {
                                // Get cell text content
                                let cellText = cell.textContent.trim();
                                
                                // Try to get link text/href if present
                                const link = cell.querySelector('a');
                                const linkHref = link ? link.href : null;
                                const linkText = link ? link.textContent.trim() : null;
                                
                                // Determine column name - use header if available, otherwise use index
                                const columnName = headerTexts[cellIndex] || `Column ${cellIndex + 1}`;
                                
                                // Store the cell value
                                rowData[columnName] = cellText;
                                
                                // If there's a link, store it too
                                if (linkHref) {
                                    rowData[`${columnName} URL`] = linkHref;
                                }
                                
                                // If link text differs from cell text, store it separately
                                if (linkText && linkText !== cellText) {
                                    rowData[`${columnName} Link Text`] = linkText;
                                }
                            } catch (cellError) {
                                console.error(`Error processing cell ${cellIndex}:`, cellError.message);
                            }
                        });
                        
                        // Add the row if it has data
                        if (Object.keys(rowData).length > 0) {
                            rows.push(rowData);
                        }
                    } catch (rowError) {
                        console.error(`Error processing row ${i}:`, rowError.message);
                    }
                }
                
                return {
                    headers: headerTexts,
                    rows: rows,
                    rowCount: rows.length,
                    columnCount: headerTexts.length || (rows[0] ? Object.keys(rows[0]).length : 0),
                    hasHeaders: headerTexts.length > 0
                };
            } catch (tableError) {
                console.error(`Error extracting table data:`, tableError.message);
                return { rows: [], headers: [], rowCount: 0, columnCount: 0, hasHeaders: false };
            }
        }
        
        // Find all tables on the page
        const tables = document.querySelectorAll('table');
        console.log(`Found ${tables.length} tables on the page`);
        
        // Sort tables by likely importance
        // 1. Tables with sortable class (like Wikipedia) are likely data tables
        // 2. Tables with more rows are likely more important
        // 3. Tables with grid/data class names are likely data tables
        const tableElements = Array.from(tables);
        
        // Log information about each table
        tableElements.forEach((table, index) => {
            const headers = table.querySelectorAll('th');
            const rows = table.querySelectorAll('tr');
            const className = table.className;
            console.log(`Table ${index + 1}: Class="${className}", Headers=${headers.length}, Rows=${rows.length}`);
        });
        
        // Sort tables by priority
        const tablePriority = tableElements.map((table, index) => {
            let score = 0;
            const className = table.className.toLowerCase();
            const rows = table.querySelectorAll('tr').length;
            
            // Prioritize tables with data-related classes
            if (className.includes('wikitable')) score += 50;
            if (className.includes('sortable')) score += 30;
            if (className.includes('data')) score += 20;
            if (className.includes('grid')) score += 20;
            if (className.includes('list')) score += 15;
            
            // Prioritize tables with more rows
            score += Math.min(rows, 50);
            
            // Prioritize tables with headers
            score += table.querySelectorAll('th').length * 2;
            
            return { index, score };
        }).sort((a, b) => b.score - a.score);
        
        // Extract data from all tables, ordered by priority
        const extractedTables = [];
        let totalRows = 0;
        
        for (const { index } of tablePriority) {
            const table = tables[index];
            const extractedData = extractTableData(table, index);
            
            if (extractedData.rows.length > 0) {
                extractedTables.push({
                    tableIndex: index,
                    className: table.className,
                    ...extractedData
                });
                
                totalRows += extractedData.rowCount;
                console.log(`Extracted ${extractedData.rowCount} rows from table ${index + 1}`);
            }
        }
        
        return {
            tables: extractedTables,
            rowCount: totalRows,
            tableCount: extractedTables.length
        };
    });
}

/**
 * Check if the page has pagination
 */
async function checkForPagination(page, log) {
    log.info('Checking for pagination links');
    
    try {
        return await page.evaluate(() => {
            // Common pagination patterns
            const nextPageSelectors = [
                'a.next', 
                'a[rel="next"]',
                'a:contains("Next")',
                'a:contains("next")',
                'a:contains("→")',
                'a[aria-label="Next"]',
                '.pagination a:last-child',
                '.wikitable + .navbox a:contains("next")',
                'nav.pagination a.active + a',
                'ul.pager li.next a',
                'a.PagedList-skipToNext',
                '.pagination .next a',
                'a[title="Next page"]'
            ];
            
            // Check for each pagination pattern
            for (const selector of nextPageSelectors) {
                try {
                    const nextLink = document.querySelector(selector);
                    if (nextLink && nextLink.href) {
                        console.log(`Found pagination link with selector '${selector}': ${nextLink.href}`);
                        return { found: true, selector, url: nextLink.href };
                    }
                } catch (error) {
                    console.log(`Error checking selector ${selector}: ${error.message}`);
                }
            }
            
            // Try to find any link containing 'next' text
            const allLinks = Array.from(document.querySelectorAll('a'));
            
            for (const link of allLinks) {
                try {
                    if (link.textContent && link.textContent.toLowerCase().includes('next') && link.href) {
                        console.log(`Found 'next' text in link: ${link.href}`);
                        return { found: true, selector: 'textContent="next"', url: link.href };
                    }
                } catch (error) {
                    console.log(`Error checking link text: ${error.message}`);
                }
            }
            
            // Look for numeric pagination
            try {
                const pageLinks = Array.from(document.querySelectorAll('.pagination a, .pager a'));
                const currentPageElement = document.querySelector('.pagination .active, .pager .active, .pagination .current, .pager .current');
                
                if (currentPageElement && pageLinks.length > 0) {
                    const currentPageNumber = parseInt(currentPageElement.textContent.trim(), 10);
                    
                    if (!isNaN(currentPageNumber)) {
                        for (const link of pageLinks) {
                            const pageNum = parseInt(link.textContent.trim(), 10);
                            if (!isNaN(pageNum) && pageNum === currentPageNumber + 1) {
                                console.log(`Found next page number link (${pageNum}): ${link.href}`);
                                return { found: true, selector: `page=${pageNum}`, url: link.href };
                            }
                        }
                    }
                }
            } catch (error) {
                console.log(`Error checking numeric pagination: ${error.message}`);
            }
            
            return { found: false };
        });
    } catch (error) {
        log.error(`Error in checkForPagination: ${error.message}`);
        return { found: false };
    }
}

/**
 * Handle pagination by processing next pages
 */
async function handlePagination(page, request, log, crawler, paginationInfo) {
    log.info('Handling pagination for table data');
    
    try {
        if (!paginationInfo) {
            // If paginationInfo wasn't provided, check for it
            paginationInfo = await checkForPagination(page, log);
        }
        
        if (paginationInfo.found && paginationInfo.url) {
            const nextPageUrl = paginationInfo.url;
            
            log.info(`Enqueueing next page: ${nextPageUrl}`);
            
            // Record current page processed in userData to avoid loops
            const pagesProcessed = request.userData.pagesProcessed || [];
            
            // Check if we've already processed this URL to avoid infinite loops
            if (pagesProcessed.includes(nextPageUrl)) {
                log.info(`Already processed URL ${nextPageUrl}, skipping to avoid loop`);
                return;
            }
            
            pagesProcessed.push(request.url);
            
            // Add the next page to the queue with the same handler and userData
            await crawler.addRequests([{
                url: nextPageUrl,
                userData: {
                    ...request.userData,
                    label: request.userData.label || 'table',
                    isNextPage: true,
                    previousPage: request.url,
                    pagesProcessed,
                    pageNumber: (request.userData.pageNumber || 1) + 1
                }
            }]);
        } else {
            log.info('No next page found or pagination is not available');
        }
    } catch (error) {
        log.error(`Error handling pagination: ${error.message}`);
        // Pagination errors shouldn't stop the overall process
    }
}