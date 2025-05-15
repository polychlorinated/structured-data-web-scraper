import { Dataset, createPuppeteerRouter, gotScraping } from 'crawlee';

export const router = createPuppeteerRouter();

// Default handler
router.addDefaultHandler(async ({ request, page, log, crawler }) => {
    log.info(`Running default handler for URL: ${request.url}`);
    try {
        await extractStructuredData(request, page, log, crawler);
    } catch (error) {
        log.error(`Error in default handler: ${error.message}`, { url: request.loadedUrl });
        // Record the error in the dataset
        await Dataset.pushData({
            url: request.loadedUrl,
            title: request.userData.title || 'Structured Data Extraction',
            timestamp: new Date().toISOString(),
            error: error.message,
            errorDetails: error.stack
        });
    }
});

// Keep specific handlers as needed
router.addHandler('municipality-table', async ({ request, page, log, crawler }) => {
    log.info(`Municipality table handler for URL: ${request.url}`);
    try {
        await extractStructuredData(request, page, log, crawler);
    } catch (error) {
        log.error(`Error in municipality-table handler: ${error.message}`, { url: request.loadedUrl });
        // Record the error in the dataset
        await Dataset.pushData({
            url: request.loadedUrl,
            title: request.userData.title || 'Structured Data Extraction',
            timestamp: new Date().toISOString(),
            error: error.message,
            errorDetails: error.stack
        });
    }
});

/**
 * Main function to extract structured data from tables on the page
 */
async function extractStructuredData(request, page, log, crawler) {
    log.info('Processing structured data extraction', { url: request.loadedUrl });
    
    // Check if this is an API-based request
    if (request.userData.mode === 'api') {
        log.info('Processing API-based request');
        await extractApiData(request, page, log, crawler);
        return;
    }
    
    // This is an HTML-based request
    log.info('Processing HTML-based request');
    
    // Wait for page to be fully loaded
    await page.waitForSelector('body', { timeout: 30000 });
    
    // Take a screenshot for debugging (optional)
    await page.screenshot({ path: 'page-initial.png', fullPage: false });
    
    // Analyze the page for tables
    const tableAnalysis = await analyzeTablesOnPage(page, log);
    log.info(`Found ${tableAnalysis.tableCount} tables on the page`);
    
    // Find the most likely target table
    const targetTableInfo = await findTargetTable(page, log);
    const bodyRows = table.querySelectorAll('tr');
    
    if (!targetTableInfo.found) {
        log.error('Could not find a suitable table to extract');
        await page.screenshot({ path: 'error-no-table.png', fullPage: true });
        
        // Record the failure in the dataset
        await Dataset.pushData({
            url: request.loadedUrl,
            title: request.userData.title || 'Structured Data Extraction',
            timestamp: new Date().toISOString(),
            error: 'No suitable table found on page',
            tableCount: tableAnalysis.tableCount
        });
        
        return;
    }
    
    // Extract data from the selected table
    const extractedData = await extractTableData(page, targetTableInfo.selector, log);
    
    if (!extractedData || extractedData.length === 0) {
        log.error('Failed to extract data from the selected table');
        await page.screenshot({ path: 'error-extraction.png', fullPage: true });
        
        // Record the failure in the dataset
        await Dataset.pushData({
            url: request.loadedUrl,
            title: request.userData.title || 'Structured Data Extraction',
            timestamp: new Date().toISOString(),
            error: 'Failed to extract data from the selected table',
            tableSelector: targetTableInfo.selector
        });
        
        return;
    }
    
    log.info(`Successfully extracted ${extractedData.length} rows`);
    
    // Format and store the extracted data
    await storeExtractedData(extractedData, request, log);
    
    // Check for pagination and process next pages
    const paginationInfo = await checkForPagination(page, log);
    
    if (paginationInfo.found) {
        log.info(`Pagination detected: ${paginationInfo.url}`);
        await handlePagination(page, request, log, crawler);
    } else {
        log.info('No pagination detected on this page');
    }
    
    // Take a success screenshot (optional)
    await page.screenshot({ path: 'success.png', fullPage: false });
    log.info('Data extraction completed successfully');
}

/**
 * Analyze all tables on the page to get information about them
 */
async function analyzeTablesOnPage(page, log) {
    return page.evaluate(() => {
        const allTables = document.querySelectorAll('table');
        const tablesInfo = [];
        
        allTables.forEach((table, index) => {
            // Get header information
            const headers = table.querySelectorAll('th');
            const headerTexts = Array.from(headers).map(th => th.textContent.trim());
            
            // Get row count
            const rows = table.querySelectorAll('tbody > tr');
            
            // Get table attributes
            const tableInfo = {
                index,
                id: table.id || null,
                className: table.className || null,
                headerCount: headers.length,
                headers: headerTexts,
                rowCount: rows.length,
                isWikitable: table.classList.contains('wikitable'),
                isSortable: table.classList.contains('sortable')
            };
            
            tablesInfo.push(tableInfo);
        });
        
        return {
            tableCount: allTables.length,
            tables: tablesInfo
        };
    });
}

/**
 * Find the most likely target table based on page structure
 */
async function findTargetTable(page, log) {
    return page.evaluate(() => {
        // Strategy 1: Look for wikitable sortable (common in Wikipedia)
        const wikitableSortable = document.querySelector('table.wikitable.sortable');
        if (wikitableSortable) {
            return {
                found: true,
                selector: 'table.wikitable.sortable',
                reason: 'Found wikitable sortable'
            };
        }
        
        // Strategy 2: Look for any wikitable
        const wikitable = document.querySelector('table.wikitable');
        if (wikitable) {
            return {
                found: true,
                selector: 'table.wikitable',
                reason: 'Found wikitable'
            };
        }
        
        // Strategy 3: Look for tables with enough data rows (likely the main content table)
        const tables = document.querySelectorAll('table');
        let bestTable = null;
        let maxRows = 0;
        
        for (const table of tables) {
            const rows = table.querySelectorAll('tbody > tr');
            if (rows.length > maxRows) {
                maxRows = rows.length;
                bestTable = table;
            }
        }
        
        if (bestTable && maxRows > 5) {
            // Generate a specific selector for this table
            const tableId = bestTable.id ? `#${bestTable.id}` : '';
            const tableClass = bestTable.className ? `.${bestTable.className.replace(/\s+/g, '.')}` : '';
            const selector = tableId || tableClass || `table:nth-of-type(${Array.from(tables).indexOf(bestTable) + 1})`;
            
            return {
                found: true,
                selector,
                reason: `Selected table with ${maxRows} rows (highest row count)`
            };
        }
        
        return {
            found: false,
            reason: 'No suitable table found'
        };
    });
}

/**
 * Extract data from the specified table
 */
async function extractTableData(page, tableSelector, log) {
    log.info(`Extracting data from table: ${tableSelector}`);
    
    // First scroll to the table to make sure it's in view
    await page.evaluate((selector) => {
        const table = document.querySelector(selector);
        if (table) {
            table.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, tableSelector);
    
    // Small delay to allow any lazy-loading
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Extract the header information first
    const headers = await extractTableHeaders(page, tableSelector, log);
    
    if (!headers || headers.length === 0) {
        log.warn('Could not extract headers from the table');
    } else {
        log.info(`Extracted headers: ${headers.join(', ')}`);
    }
    
    // Now extract the data rows
    return extractTableRows(page, tableSelector, headers, log);
    const bodyRows = table.querySelectorAll('tr');
}

/**
 * Extract headers from the table
 */
async function extractTableHeaders(page, tableSelector, log) {
    return page.evaluate((selector) => {
        const table = document.querySelector(selector);
        if (!table) return null;
        
        // Helper function to clean text
        function cleanText(text) {
            return text.replace(/\[\d+\]/g, '')  // Remove reference numbers like [1]
                      .replace(/\s+/g, ' ')      // Normalize whitespace
                      .trim();                   // Trim leading/trailing whitespace
        }
        
        // First try to find headers in thead
        let headerCells = [];
        const thead = table.querySelector('thead');
        if (thead) {
            const headerRow = thead.querySelector('tr');
            if (headerRow) {
                headerCells = headerRow.querySelectorAll('th');
            }
        }
        
        // If no headers in thead, try the first row
        if (headerCells.length === 0) {
            const firstRow = table.querySelector('tbody > tr:first-child');
            if (firstRow) {
                headerCells = firstRow.querySelectorAll('th');
                
                // If still no th elements, try td elements in first row
                if (headerCells.length === 0) {
                    headerCells = firstRow.querySelectorAll('td');
                }
            }
        }
        
        // Convert NodeList to array and extract text
        return Array.from(headerCells).map(cell => cleanText(cell.textContent));
    }, tableSelector);
}

/**
 * Extract rows from the table
 */
async function extractTableRows(page, tableSelector, extractedHeaders, log) {
    return page.evaluate((selector, headers) => {
        const table = document.querySelector(selector);
        if (!table) return [];
        const bodyRows = table.querySelectorAll('tr');
        
        // Helper function to clean text
        function cleanText(text) {
            return text.replace(/\[\d+\]/g, '')  // Remove reference numbers like [1]
                      .replace(/\s+/g, ' ')      // Normalize whitespace
                      .trim();                   // Trim leading/trailing whitespace
        }
        
        // Helper function to clean numeric values
        function cleanNumericValue(text) {
            return text.replace(/[^\d.-]/g, '').trim();
        }
        
        // Helper function to extract text from cell with priority for links
        function extractCellText(cell) {
            // First try to get text from a link if it exists
            const link = cell.querySelector('a');
            if (link) {
                return cleanText(link.textContent);
            }
            
            // Otherwise get the cell's text content
            return cleanText(cell.textContent);
        }
        
        // Find the body rows (skip header row if we're looking at tbody)
        const bodyRows = table.querySelectorAll('tbody > tr');
        
        // Determine where data rows start - skip header row if needed
        let startIndex = 0;
        if (bodyRows.length > 0 && bodyRows[0].querySelectorAll('th').length > 0) {
            startIndex = 1; // Skip the first row if it has th elements
        }
        
        // Process each data row
        const rows = [];
        for (let i = startIndex; i < bodyRows.length; i++) {
            const row = bodyRows[i];
            const cells = row.querySelectorAll('td');
            
            // Skip rows without enough cells
            if (cells.length ===0) continue;
            
            // Create an object to hold this row's data
            const rowData = {};
            
            // If we have extracted headers, use them as keys
            if (headers && headers.length > 0) {
                // Map each cell to its corresponding header
                cells.forEach((cell, cellIndex) => {
                    if (cellIndex < headers.length) {
                        const header = headers[cellIndex];
                        
                        // Handle different types of cells based on content
                        const cellText = extractCellText(cell);
                        
                        // Special handling for numeric columns
                        if (header.toLowerCase().includes('rank') || 
                            header.toLowerCase().includes('population') ||
                            header.toLowerCase().includes('number')) {
                            rowData[header] = cleanNumericValue(cellText);
                        } else {
                            rowData[header] = cellText;
                        }
                    }
                });
            } else {
                // Fallback: use generic column names
                cells.forEach((cell, cellIndex) => {
                    rowData[`Column ${cellIndex + 1}`] = extractCellText(cell);
                });
            }
            
            rows.push(rowData);
        }
        
        return rows;
    }, tableSelector, extractedHeaders);
}

/**
 * API-based data extraction for services like ASHA
 */
async function extractApiData(request, page, log, crawler) {
    // For API-based extraction, we use gotScraping instead of page interactions
    log.info('Extracting data from API endpoint', { url: request.url });
    
    try {
        // Get API-specific parameters from request.userData
        const apiParams = request.userData.apiParams || {};
        const apiUrl = request.url;
        const apiType = request.userData.apiType || 'standard';
        
        log.info('Making API request', { 
            url: apiUrl, 
            apiType,
            paramSample: JSON.stringify(apiParams).substring(0, 100) + '...' 
        });
        
        // Use gotScraping directly for API requests instead of page.evaluate
        const response = await gotScraping.post({
            url: apiUrl,
            json: apiParams,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...(request.userData.authHeaders || {})
            },
            retry: {
                limit: 3
            },
            responseType: 'json'
        });
        
        // Check for error responses
        if (response.statusCode >= 400) {
            log.error('API error response body:', response.body);
            throw new Error(`API responded with status: ${response.statusCode}`);
        }
        
        const apiResponse = response.body;
        log.info('Successfully received API response');
        
        // Process the API data
        const processedData = processApiData(apiResponse, request.userData);
        log.info(`Processed ${processedData.length} rows from API response`);
        
        // Store the extracted data
        await Dataset.pushData({
            url: request.url,
            title: request.userData.title || 'API Data Extraction',
            timestamp: new Date().toISOString(),
            source: 'api',
            apiType,
            apiParams,
            rowCount: processedData.length,
            data: processedData
        });
        
        // Check for API pagination
        if (apiResponse.pagination && apiResponse.pagination.nextPage) {
            log.info('API has more pages. Enqueueing next page request.');
            
            // Create next page request
            const nextPageParams = {
                ...apiParams,
                page: (apiParams.page || 1) + 1
            };
            
            // Enqueue the next page
            await crawler.addRequests([{
                url: apiUrl,
                userData: {
                    ...request.userData,
                    apiParams: nextPageParams,
                    label: request.userData.label || 'default'
                }
            }]);
        }
        
        // Handle ASHA-specific pagination
        if (apiType === 'asha' && apiResponse.pagination) {
            const currentStart = apiParams.firstResult || 0;
            const pageSize = apiParams.numberOfResults || 10;
            const totalResults = apiResponse.pagination.totalResults || 0;
            
            if (currentStart + pageSize < totalResults) {
                log.info(`ASHA API has more results (${currentStart + pageSize}/${totalResults}). Enqueueing next page.`);
                
                // Create next page request with ASHA-specific pagination
                const nextPageParams = {
                    ...apiParams,
                    firstResult: currentStart + pageSize
                };
                
                // Enqueue the next page
                await crawler.addRequests([{
                    url: apiUrl,
                    userData: {
                        ...request.userData,
                        apiParams: nextPageParams,
                        label: request.userData.label || 'default'
                    }
                }]);
            }
        }
    } catch (error) {
        log.error(`API extraction failed: ${error.message}`);
        
        // Record the error in the dataset
        await Dataset.pushData({
            url: request.url,
            title: request.userData.title || 'API Data Extraction',
            timestamp: new Date().toISOString(),
            source: 'api',
            error: error.message
        });
    }
}

/**
 * Process API response data
 */
function processApiData(apiResponse, userData) {
    // Handle different API response formats
    if (Array.isArray(apiResponse)) {
        return apiResponse;
    }
    
    // Common pattern for API responses
    if (apiResponse.data && Array.isArray(apiResponse.data)) {
        return apiResponse.data;
    }
    
    // Handle ASHA-specific format
    if (userData.apiType === 'asha' && apiResponse.results) {
        return apiResponse.results.map(item => ({
            id: item.id,
            name: item.name,
            address: item.address,
            city: item.city,
            state: item.state,
            zip: item.zip,
            phone: item.phone,
            type: item.type
        }));
    }
    
    // Fallback - return the whole response
    return [apiResponse];
}

// Error handler
router.addHandler('error', async ({ request, log }) => {
    log.error(`Error processing ${request.url}`);
});