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
        let headerRow = null;
        let headerCells = [];
        
        // Check for thead first
        const thead = table.querySelector('thead');
        if (thead) {
            headerRow = thead.querySelector('tr');
            if (headerRow) {
                headerCells = headerRow.querySelectorAll('th');
            }
        }
        
        // If no headers in thead, try the first row in tbody
        if (headerCells.length === 0) {
            const tbody = table.querySelector('tbody');
            if (tbody) {
                headerRow = tbody.querySelector('tr:first-child');
            } else {
                // If no tbody, try the first row directly in the table
                headerRow = table.querySelector('tr:first-child');
            }
            
            if (headerRow) {
                // First try to find th elements
                headerCells = headerRow.querySelectorAll('th');
                
                // If no th elements, use td elements
                if (headerCells.length === 0) {
                    headerCells = headerRow.querySelectorAll('td');
                }
            }
        }
        
        // Extract and clean header text
        if (headerCells.length > 0) {
            // Convert NodeList to array and extract text
            return Array.from(headerCells).map(cell => {
                const text = cleanText(cell.textContent);
                // Use a non-empty placeholder for empty headers
                return text || `Column_${Array.from(headerCells).indexOf(cell) + 1}`;
            });
        }
        
        // If still no headers found, generate generic column names based on the first data row
        const firstDataRow = table.querySelector('tbody tr:first-child') || table.querySelector('tr:first-child');
        if (firstDataRow) {
            const cellCount = firstDataRow.querySelectorAll('td').length;
            return Array.from({ length: cellCount }, (_, i) => `Column_${i + 1}`);
        }
        
        return [];
    }, tableSelector);
}

/**
 * Extract rows from the table
 */
async function extractTableRows(page, tableSelector, extractedHeaders, log) {
    return page.evaluate((selector, headers) => {
        const table = document.querySelector(selector);
        if (!table) return [];
        
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
        
        // Find all rows - either in tbody or as direct tr children of the table
        let allRows = [];
        const tbody = table.querySelector('tbody');
        
        if (tbody) {
            // If tbody exists, get rows from it
            allRows = Array.from(tbody.querySelectorAll('tr'));
        } else {
            // If no tbody, get direct tr children of table
            allRows = Array.from(table.querySelectorAll('tr'));
        }
        
        // Determine where data rows start - skip header row
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
        
        // Process each data row
        const rows = [];
        for (let i = startIndex; i < allRows.length; i++) {
            const row = allRows[i];
            const cells = row.querySelectorAll('td');
            
            // Skip rows without cells (might be section headers, etc.)
            if (cells.length === 0) continue;
            
            // Create an object to hold this row's data
            const rowData = {};
            
            // Process all cells in the row
            cells.forEach((cell, cellIndex) => {
                // Get the header for this column
                let header = '';
                if (headers && cellIndex < headers.length) {
                    header = headers[cellIndex];
                } else {
                    header = `Column_${cellIndex + 1}`;
                }
                
                // Extract and clean the cell text
                const cellText = extractCellText(cell);
                
                // Special handling for numeric columns
                if ((/rank|number|count|total|sum|avg|population|percent|rate|ratio|index|score|rating/i.test(header)) &&
                    /^[\d.,\-+%]+$/.test(cellText.replace(/\s/g, ''))) {
                    rowData[header] = cleanNumericValue(cellText);
                } else {
                    rowData[header] = cellText;
                }
            });
            
            rows.push(rowData);
        }
        
        return rows;
    }, tableSelector, extractedHeaders);
}

/**
 * Format and store the extracted data
 */
async function storeExtractedData(extractedData, request, log) {
    if (!extractedData || extractedData.length === 0) {
        log.info('No data to store');
        return;
    }
    
    // Get all unique columns from all rows
    const allColumns = new Set();
    extractedData.forEach(row => {
        Object.keys(row).forEach(key => allColumns.add(key));
    });
    
    const columns = Array.from(allColumns);
    
    // Create a simpler, more direct output format
    const formattedOutput = {
        url: request.loadedUrl,
        title: request.userData.title || 'Structured Data Extraction',
        timestamp: new Date().toISOString(),
        source: 'html',
        rowCount: extractedData.length,
        columnCount: columns.length,
        columns,
        data: extractedData
    };
    
    // Push to dataset
    await Dataset.pushData(formattedOutput);
    log.info(`Data successfully pushed to dataset (${extractedData.length} rows, ${columns.length} columns)`);
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
    
    // Handle ASHA-specific format - but keep all fields instead of a predefined subset
    if (userData.apiType === 'asha' && apiResponse.results) {
        // Return all fields from each result
        return apiResponse.results;
    }
    
    // Fallback - return the whole response or its fields in an array
    if (typeof apiResponse === 'object' && apiResponse !== null) {
        const fields = Object.keys(apiResponse);
        if (fields.some(field => Array.isArray(apiResponse[field]))) {
            // If any field is an array, it's likely the data we want
            for (const field of fields) {
                if (Array.isArray(apiResponse[field])) {
                    return apiResponse[field];
                }
            }
        }
    }
    
    // If we can't identify a specific array to return, wrap the response in an array
    return [apiResponse];
}

// Error handler
router.addHandler('error', async ({ request, log }) => {
    log.error(`Error processing ${request.url}`);
});