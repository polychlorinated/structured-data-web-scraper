import { Dataset, createPuppeteerRouter } from 'crawlee';

export const router = createPuppeteerRouter();

// Default handler
router.addDefaultHandler(async ({ request, page, log }) => {
    log.info(`Running default handler for URL: ${request.url}`);
    
    // We'll extract the table here, since the label routing isn't working as expected
    await extractMunicipalityTable(request, page, log);
});

// Keep the specific handler too
router.addHandler('municipality-table', async ({ request, page, log }) => {
    log.info(`Municipality table handler for URL: ${request.url}`);
    await extractMunicipalityTable(request, page, log);
});

// Extract function to avoid duplicating code
async function extractMunicipalityTable(request, page, log) {
    log.info('Processing municipalities table', { url: request.loadedUrl });
    
    // Wait for page to be fully loaded
    await page.waitForSelector('body', { timeout: 30000 });
    
    // Take a screenshot of the page for debugging
    await page.screenshot({ path: 'page-initial.png', fullPage: true });
    log.info('Initial page screenshot saved');
    
    // Log the page title for debugging
    const pageTitle = await page.title();
    log.info(`Page title: ${pageTitle}`);
    
    // Count all tables on the page for debugging
    const tableCount = await page.evaluate(() => {
        const allTables = document.querySelectorAll('table');
        console.log(`Found ${allTables.length} tables on the page`);
        
        // Log info about each table
        allTables.forEach((table, index) => {
            const headers = table.querySelectorAll('th');
            const headerTexts = Array.from(headers).map(th => th.textContent.trim());
            console.log(`Table ${index + 1}: Class="${table.className}", Headers=[${headerTexts.join(', ')}]`);
        });
        
        return allTables.length;
    });
    
    log.info(`Found ${tableCount} tables on the page`);
    
    // Scroll to the first sortable table
    await page.evaluate(() => {
        window.scrollTo(0, 0); // First scroll to top
        
        // Then scroll down looking for the table
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
            if (table.classList.contains('wikitable') && table.classList.contains('sortable')) {
                console.log('Found wikitable sortable, scrolling to it...');
                table.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }
        }
        
        // If no sortable wikitable, try any wikitable
        const wikiTables = document.querySelectorAll('table.wikitable');
        if (wikiTables.length > 0) {
            console.log('Found wikitable, scrolling to it...');
            wikiTables[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    });
    
    // Use a small delay without waitForTimeout - using a Promise
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Take another screenshot after scrolling
    await page.screenshot({ path: 'page-scrolled.png', fullPage: false });
    log.info('Scrolled page screenshot saved');
    
    const allRows = [];

    let pageNumber = 1;
    let hasNextPage = true;
    
    while (hasNextPage) {
        log.info(`Scraping page ${pageNumber}...`);
    
        const tableData = await page.evaluate(() => {
            const table = document.querySelector('table.wikitable.sortable');
            if (!table) return [];
    
            const rows = [];
            const tableRows = table.querySelectorAll('tbody > tr');
    
            for (let i = 0; i < tableRows.length; i++) {
                const cells = tableRows[i].querySelectorAll('td');
                if (cells.length < 3) continue;
    
                let rankText = cells[0].textContent.trim().replace(/[^\d]/g, '');
                let municipalityText = cells[1].querySelector('a')?.textContent.trim() || cells[1].textContent.trim();
                let designationText = cells[2].textContent.trim();
    
                rows.push({
                    '2023 Rank': rankText,
                    'Municipalities': municipalityText,
                    'Designation': designationText
                });
            }
    
            return rows;
        });
    
        allRows.push(...tableData);
        log.info(`Page ${pageNumber} yielded ${tableData.length} rows`);
    
        hasNextPage = await page.evaluate(() => {
            const nextBtn = document.querySelector('.pagination-next, a[rel="next"]');
            if (nextBtn && !nextBtn.disabled) {
                nextBtn.click();
                return true;
            }
            return false;
        });
    
        if (hasNextPage) {
            await page.waitForTimeout(2000); // you can fine-tune this
            pageNumber++;
        }
    }
    
    log.info(`Scraped a total of ${allRows.length} rows from ${pageNumber} page(s).`);
    
    const formattedOutput = {
        block_1_output: `Scraped ${allRows.length} rows from ${pageNumber} page(s).`,
        block_2_output: {
            rows: allRows
        }
    };
    
    await Dataset.pushData(formattedOutput);
    log.info('Data successfully pushed to dataset');
    await page.screenshot({ path: 'final-screenshot.png', fullPage: false });
    
    // Take a success screenshot
    await page.screenshot({ path: 'success.png', fullPage: false });
    log.info('Success screenshot saved');
}

// Error handler
router.addHandler('error', async ({ request, log }) => {
    log.error(`Error processing ${request.url}`);
});