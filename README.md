# GitHub PR File Preview

A Chrome extension that adds inline preview buttons for PDF, XLSX, and DOCX files directly in GitHub Pull Request "Files Changed" pages.

GitHub normally shows "Binary file not shown." for these file types. This extension adds a **Preview** button that lets you view the file content without downloading.

## Features

- **PDF Preview** - Renders PDFs using the browser's native PDF viewer with zoom, download, and print controls
- **Excel Preview** - Displays spreadsheet data in a formatted table with sheet tab navigation
- **Word Preview** - Converts DOCX documents to HTML for inline viewing with formatting support

## Installation

### From Release (Recommended)

1. Download the latest `.zip` from [Releases](../../releases)
2. Unzip the file
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (toggle in top-right)
5. Click **Load unpacked**
6. Select the unzipped folder

### From Source

```bash
git clone https://github.com/brownellington-glitch/github-file-preview.git
```

Then follow steps 3-6 above, selecting the cloned folder.

## Usage

1. Navigate to any GitHub Pull Request's **Files changed** tab
2. Binary files (PDF, XLSX, DOCX) will show a **Preview** button in their file header
3. Click to toggle the inline preview

## Supported File Types

| Type | Extension | Library |
|------|-----------|---------|
| PDF | `.pdf` | Native browser PDF viewer |
| Excel | `.xlsx`, `.xls` | [SheetJS](https://sheetjs.com/) |
| Word | `.docx`, `.doc` | [mammoth.js](https://github.com/mwilliamson/mammoth.js) |

## How It Works

- Content script injects into GitHub PR file diff pages
- Scans for binary file headers and adds Preview buttons
- On click, fetches file content via GitHub's raw URL or API
- Renders preview inline using the appropriate library
- MutationObserver handles GitHub's SPA navigation

## Tech Stack

- Chrome Extension Manifest V3
- Content Scripts
- SheetJS for Excel parsing
- mammoth.js for DOCX to HTML conversion
- Native `<iframe>` with data URL for PDF rendering

## License

MIT
