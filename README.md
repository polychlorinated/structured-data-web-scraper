# Structured Data Web Extractor

This actor is designed to extract structured data from various sources including HTML tables and API endpoints. It provides flexible configuration options to handle different data sources and pagination patterns.

## Features

- **Multi-source extraction**: Extract data from HTML tables (like Wikipedia) or API endpoints
- **Comprehensive table extraction**: Extracts all columns from tables, not just a predefined subset
- **API support**: Makes authenticated API requests with custom headers and body
- **Automatic pagination**: Follows pagination links to extract data from multiple pages
- **Flexible configuration**: Customize extraction behavior through input parameters

## Use Cases

1. **Extract data from HTML tables**
   - Wikipedia tables (municipalities, statistics, rankings, etc.)
   - Any website with tabular data

2. **Extract data from API endpoints**
   - JSON APIs requiring authentication
   - Public data APIs
   - Specifically supports ASHA provider directory API

## Input Configuration

The actor accepts the following input parameters:

### Basic Parameters

- **startUrls** (required): Array of URLs to scrape. Can be simple URLs or objects with extended configuration.
- **apiToken**: Optional Bearer token for API authentication.
- **dataSourceType**: Specify the data source type ("auto", "table", or "api"). Defaults to "auto".
- **extractAllColumns**: When true, extracts all columns from tables. Defaults to true.
- **maxPages**: Maximum number of pages to process when pagination is available. Set to 0 for unlimited.
- **debug**: Enable additional debugging information.

### Advanced URL Configuration

For more complex scenarios, you can provide detailed configuration for each URL:

```json
{
  "url": "https://example.com/data-table",
  "label": "table",
  "dataSourceType": "table",
  "tableSelector": "table.wikitable.sortable",
  "extractAllColumns": true
}
```

Or for API endpoints:

```json
{
  "url": "https://api.example.com/data",
  "dataSourceType": "api",
  "apiToken": "your-bearer-token",
  "method": "POST",
  "headers": {
    "custom-header": "value"
  },
  "body": {
    "key": "value"
  },
  "paginationType": "page",
  "pageParamName": "page"
}
```

## Example 1: Extract Wikipedia Table

To extract the municipalities from New Mexico's Wikipedia page:

```json
{
  "startUrls": [
    {
      "url": "https://en.wikipedia.org/wiki/List_of_municipalities_in_New_Mexico",
      "dataSourceType": "table"
    }
  ],
  "extractAllColumns": true
}
```

## Example 2: Extract ASHA API Data

To extract audiologist data from the ASHA API:

```json
{
  "startUrls": [
    {
      "url": "https://americanspeechlanguagehearingassociationproductionh0xeoc4i.org.coveo.com/rest/search/v2?organizationId=americanspeechlanguagehearingassociationproductionh0xeoc4i",
      "dataSourceType": "api",
      "apiType": "asha",
      "body": {
        "aq": "@provider==Audiologist",
        "searchHub": "ProFind",
        "locale": "en",
        "firstResult": 0,
        "numberOfResults": 10
      }
    }
  ],
  "apiToken": "xxee022e66-e168-47e9-8f83-d77df9a3cae0"
}
```

## Output Format

The actor produces a structured Dataset with data from all processed sources. The format depends on the data source type:

### HTML Table Output

```json
{
  "source_type": "html_table",
  "url": "https://en.wikipedia.org/wiki/List_of_municipalities_in_New_Mexico",
  "page_title": "List of municipalities in New Mexico - Wikipedia",
  "tables": [
    {
      "tableIndex": 0,
      "className": "wikitable sortable",
      "headers": ["Name", "County", "Census Designation", "..."],
      "rows": [
        {
          "Name": "Albuquerque",
          "County": "Bernalillo",
          "Census Designation": "City",
          "...": "..."
        },
        "..."
      ],
      "rowCount": 105,
      "columnCount": 7,
      "hasHeaders": true
    }
  ]
}
```

### API Output

```json
{
  "source_type": "api",
  "url": "https://americanspeechlanguagehearingassociationproductionh0xeoc4i.org.coveo.com/rest/search/v2",
  "data": [
    {
      "title": "Jennifer C Abbink, CCC-A",
      "uri": "https://apps.asha.org/eweb/ashadynamicpage.aspx?pfk=3c702b41-35fa-4a92-9f01-fe16aef88c7b",
      "state": ["Colorado"],
      "expertise": ["Hearing assistive technology systems", "Audiologic rehabilitation", "Aural rehabilitation"],
      "ages": ["0-6 Months", "7 Months - 2 Years", "3-5 Years", "6-11 Years", "12-17 Years", "18-64 Years"]
    },
    "..."
  ],
  "metadata": {
    "total_count": 2408,
    "page_info": {}
  }
}
```

## Limitations

- The actor may not correctly extract data from tables with complex structures (merged cells, nested tables).
- API support is limited to JSON-based REST APIs.
- The actor relies on Puppeteer and may not work with websites that use advanced anti-scraping techniques.

## Troubleshooting

- If the actor fails to extract data, try enabling debug mode to get more information.
- For API requests, ensure that the correct authentication token and headers are provided.
- For complex tables, try specifying the exact table selector to target the right table.

## Development

To modify this actor for your specific needs:

1. Update the `routes.js` file to handle different data sources
2. Modify the extraction logic in `extractTableData` or `extractApiData` functions
3. Add support for additional pagination patterns

For more information, see the [Crawlee documentation](https://crawlee.dev/docs).
