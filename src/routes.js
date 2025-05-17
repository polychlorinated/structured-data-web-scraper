import { Dataset, createPuppeteerRouter } from 'crawlee';

export const router = createPuppeteerRouter();

// Default handler
router.addDefaultHandler(async ({ request, page, log }) => {
    log.info(`Running default handler for URL: ${request.url}`);
    
    // Check if there's a specific table selector in userData
    const tableSelector = request.userData?.tableSelector || 'table.wikitable';
    const extractAllColumns = request.userData?.extractAllColumns !== false;
    const debug = request.userData?.debug === true;
    
    await extractWikitableTables(request, page, log, tableSelector, extractAllColumns, debug);
});

// Dedicated handler for wikitable extraction
router.addHandler('wikitable', async ({ request, page, log }) => {
    log.info(`Wikitable handler for URL: ${request.url}`);
    
    const tableSelector = request.userData?.tableSelector || 'table.wikitable';
    const extractAllColumns = request.userData?.extractAllColumns !== false;
    const debug = request.userData?.debug === true;
    
    await extractWikitableTables(request, page, log, tableSelector, extractAllColumns, debug);
});

async function extractWikitableTables(request, page, log, tableSelector = 'table.wikitable', extractAllColumns = true, debug = false) {
    log.info('Processing wikitables extraction', { url: request.loadedUrl, tableSelector });
    
    // Wait for page to be fully loaded
    await page.waitForSelector('body', { timeout: 30000 });
    
    // Take a screenshot for debugging if enabled
    if (debug) {
        await page.screenshot({ path: 'page-initial.png', fullPage: true });
        log.info('Initial page screenshot saved');
    }
    
    // Log the page title
    const pageTitle = await page.title();
    log.info(`Page title: ${pageTitle}`);
    
    // First, analyze all tables on the page to help with debugging
    const tableAnalysis = await page.evaluate((selector) => {
        // Find all tables on the page for logging purposes
        const allTables = document.querySelectorAll('table');
        console.log(`Found ${allTables.length} tables on the page`);
        
        // Log basic info about each table
        const tableInfo = [];
        allTables.forEach((table, index) => {
            // Get table class
            const tableClass = table.className || "";
            
            // Get headers
            const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
            
            // Get row count
            const rows = table.querySelectorAll('tbody > tr').length;
            
            console.log(`Table ${index + 1}: Class="${tableClass}", Headers=${headers.length}, Rows=${rows}`);
            
            tableInfo.push({
                index: index + 1,
                class: tableClass,
                headerCount: headers.length,
                rowCount: rows,
                isWikitable: tableClass.includes('wikitable'),
                headers: headers
            });
        });
        
        // Now find tables matching our specific selector
        const targetTables = document.querySelectorAll(selector);
        console.log(`Found ${targetTables.length} tables matching selector "${selector}"`);
        
        return {
            totalTables: allTables.length,
            matchingTables: targetTables.length,
            tableInfo: tableInfo
        };
    }, tableSelector);
    
    log.info(`Table analysis: ${tableAnalysis.totalTables} total tables, ${tableAnalysis.matchingTables} matching wikitables`);
    
    // If no matching tables were found, log a warning
    if (tableAnalysis.matchingTables === 0) {
        log.warning(`No tables matching selector "${tableSelector}" found on the page.`);
        
        // Optional: Suggest alternative table selectors if we found wikitables with slightly different classes
        const potentialWikitables = tableAnalysis.tableInfo.filter(t => t.class.includes('wikitable'));
        if (potentialWikitables.length > 0) {
            log.info(`Found ${potentialWikitables.length} potential wikitables with different classes:`);
            potentialWikitables.forEach(t => {
                log.info(`Table ${t.index}: Class="${t.class}", Headers: ${t.headers.length}, Rows: ${t.rowCount}`);
            });
        }
        
        if (debug) {
            await page.screenshot({ path: 'no-matching-tables.png', fullPage: true });
        }
    }
    
    // Extract data from all matching tables
    const tableDataResults = await page.evaluate((selector, extractAll) => {
        const tables = document.querySelectorAll(selector);
        const results = [];
        
        // Process each matching table
        for (let tableIndex = 0; tableIndex < tables.length; tableIndex++) {
            const table = tables[tableIndex];
            const tableRows = table.querySelectorAll('tbody > tr');
            console.log(`Table ${tableIndex + 1}: Found ${tableRows.length} rows`);
            
            // Extract headers (column names)
            const headerRow = table.querySelector('tr');
            if (!headerRow) continue;
            
            const headers = Array.from(headerRow.querySelectorAll('th'))
                .map(th => th.textContent.trim());
            
            // If no headers found, try using first row as header or skip
            if (headers.length === 0) {
                // Option: Generate numeric headers if allowed by extractAll
                if (extractAll) {
                    const firstRowCells = headerRow.querySelectorAll('td');
                    headers.push(...Array.from({length: firstRowCells.length}, (_, i) => `Column${i+1}`));
                } else {
                    console.log(`Table ${tableIndex + 1}: No headers found, skipping`);
                    continue;
                }
            }
            
            // Extract data rows
            const rows = [];
            
            // IMPROVED: Handle header row more carefully
            // If we have a header row with th elements, we'll start from the next row
            // If there are no th elements, we need to check if the first row might be a header with td elements
            let startRow = 0;
            
            // If we found th elements, start from row 1 (skip the header row)
            if (headers.length > 0 && headerRow.querySelectorAll('th').length > 0) {
                startRow = 1;
                console.log(`Table ${tableIndex + 1}: Starting from row 1 (skipping header row with th elements)`);
            } 
            // If the first row has different formatting or structure, it might be a header even without th elements
            else if (tableRows.length > 1) {
                const firstRowCellCount = tableRows[0].querySelectorAll('td').length;
                const secondRowCellCount = tableRows[1].querySelectorAll('td').length;
                
                // If the first row has fewer cells or different structure, it might be a header
                if (firstRowCellCount !== secondRowCellCount || 
                    tableRows[0].querySelector('td[colspan]') || 
                    tableRows[0].querySelector('td[rowspan]')) {
                    console.log(`Table ${tableIndex + 1}: First row appears to be a header based on structure`);
                    // Add first row as headers if needed
                    if (headers.length === 0) {
                        headers.push(...Array.from(tableRows[0].querySelectorAll('td')).map(td => td.textContent.trim()));
                    }
                    startRow = 1;
                } else {
                    console.log(`Table ${tableIndex + 1}: No clear header row detected, starting from row 0`);
                }
            }
            
            // Process all data rows
            for (let i = startRow; i < tableRows.length; i++) {
                try {
                    const row = tableRows[i];
                    const cells = row.querySelectorAll('td');
                    
                    // Only skip completely empty rows
                    if (cells.length === 0) {
                        console.log(`Table ${tableIndex + 1}: Skipping row ${i} - no cells found`);
                        continue;
                    }
                    
                    // Create an object for this row
                    const rowData = {};
                    
                    // If extracting all columns or if we have valid headers
                    if (extractAll || headers.length > 0) {
                        // IMPROVED: Make sure we capture all cells, even if there are more cells than headers
                        const maxCells = Math.max(cells.length, headers.length);
                        
                        for (let j = 0; j < maxCells; j++) {
                            let cellContent = '';
                            
                            // Get cell content if the cell exists
                            if (j < cells.length) {
                                // Try to get text from link first (common in Wikipedia tables)
                                const link = cells[j].querySelector('a');
                                if (link) {
                                    cellContent = link.textContent.trim();
                                    
                                    // Include href attribute if available (optional)
                                    const href = link.getAttribute('href');
                                    if (href) {
                                        // Store the URL path or full URL depending on format
                                        rowData[`${j < headers.length ? headers[j] : `Column${j+1}`}_url`] = 
                                            href.startsWith('http') ? href : `https://en.wikipedia.org${href}`;
                                    }
                                } else {
                                    cellContent = cells[j].textContent.trim();
                                }
                            }
                            
                            // Use header as the key if available, otherwise use column index
                            const headerKey = j < headers.length ? headers[j] : `Column${j+1}`;
                            rowData[headerKey] = cellContent;
                        }
                        
                        rows.push(rowData);
                    }
                } catch (error) {
                    console.error(`Error processing row ${i}:`, error.message);
                }
            }
            
            console.log(`Extracted ${rows.length} rows from table ${tableIndex + 1}`);
            
            // Add this table's data to the results
            results.push({
                tableIndex: tableIndex + 1,
                tableClass: table.className,
                headers: headers,
                rowCount: rows.length,
                rows: rows
            });
        }
        
        return results;
    }, tableSelector, extractAllColumns);
    
    // If we got data, format and save it
    if (tableDataResults.length > 0) {
        const totalRows = tableDataResults.reduce((sum, table) => sum + table.rowCount, 0);
        log.info(`Successfully extracted ${tableDataResults.length} tables with ${totalRows} total rows`);
        
        // Format the output
        const formattedOutput = {
            url: request.loadedUrl,
            pageTitle: pageTitle,
            extractionDate: new Date().toISOString(),
            tablesFound: tableDataResults.length,
            totalRows: totalRows,
            tables: tableDataResults
        };
        
        // Push to dataset
        await Dataset.pushData(formattedOutput);
        log.info('Table data successfully pushed to dataset');
        
        // Take a success screenshot if debug is enabled
        if (debug) {
            await page.screenshot({ path: 'success.png', fullPage: false });
            log.info('Success screenshot saved');
        }
    } else {
        log.error('No table data was extracted from the page');
        
        if (debug) {
            // Take a screenshot for debugging
            await page.screenshot({ path: 'error-extraction.png', fullPage: true });
            log.info('Error screenshot saved');
        }
    }
    
    // Check for pagination links - this is optional and can be removed if not needed
    try {
        const hasPagination = await page.evaluate(() => {
            const paginationSelectors = [
                'a:contains("Next")', 
                'a:contains("next")', 
                'a:contains("→")',
                '.wikitable + .navbox a:contains("next")'
            ];
            
            for (const selector of paginationSelectors) {
                try {
                    const nextLink = document.querySelector(selector);
                    if (nextLink) return true;
                } catch (error) {
                    console.error(`Error checking selector ${selector}:`, error.message);
                }
            }
            
            return false;
        });
        
        if (hasPagination) {
            log.info('Pagination detected, but not currently handled');
        } else {
            log.info('No pagination detected on this page');
        }
    } catch (error) {
        log.warning('Error checking for pagination:', error.message);
    }
}

// Error handler
router.addHandler('error', async ({ request, log }) => {
    log.error(`Error processing ${request.url}`);
});