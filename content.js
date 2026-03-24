(() => {
  "use strict";

  const SUPPORTED_EXTENSIONS = {
    pdf: "PDF",
    xlsx: "Excel",
    xls: "Excel",
    docx: "Word",
    doc: "Word",
  };

  const FILE_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 1.75v11.5c0 .09.048.17.12.217a.24.24 0 00.24.033L8 12.25l4.14 1.25a.24.24 0 00.24-.033.25.25 0 00.12-.217V1.75a.25.25 0 00-.25-.25h-8.5a.25.25 0 00-.25.25z"/></svg>`;

  // Track already-processed file headers
  const processedFiles = new WeakSet();

  // Extract repo info from the current URL
  function getRepoInfo() {
    const match = location.pathname.match(
      /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/
    );
    if (!match) return null;
    return { owner: match[1], repo: match[2], pr: match[3] };
  }

  // Get the file extension from a path
  function getFileExtension(filePath) {
    const ext = filePath.split(".").pop().toLowerCase();
    return ext;
  }

  // Build the raw file URL for a given file in the PR
  // We use the GitHub API to get the file content
  async function fetchFileContent(filePath, repoInfo) {
    // First, get the PR head SHA to construct the raw URL
    const prApiUrl = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${repoInfo.pr}`;
    const prResp = await fetch(prApiUrl);
    if (!prResp.ok) throw new Error(`Failed to fetch PR info: ${prResp.status}`);
    const prData = await prResp.json();
    const headSha = prData.head.sha;
    const headRef = prData.head.ref;
    const headRepo = prData.head.repo.full_name;

    // Try raw.githubusercontent.com first
    const rawUrl = `https://raw.githubusercontent.com/${headRepo}/${headRef}/${filePath}`;
    const rawResp = await fetch(rawUrl);
    if (rawResp.ok) {
      return await rawResp.arrayBuffer();
    }

    // Fallback: use the git blob API
    const treeUrl = `https://api.github.com/repos/${headRepo}/contents/${filePath}?ref=${headSha}`;
    const treeResp = await fetch(treeUrl);
    if (!treeResp.ok) throw new Error(`Failed to fetch file: ${treeResp.status}`);
    const treeData = await treeResp.json();

    if (treeData.content) {
      // Base64 encoded content
      const binary = atob(treeData.content.replace(/\n/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }

    // If too large, fetch from download_url
    if (treeData.download_url) {
      const dlResp = await fetch(treeData.download_url);
      if (dlResp.ok) return await dlResp.arrayBuffer();
    }

    throw new Error("Could not retrieve file content");
  }

  // Render PDF preview using canvas (no worker needed)
  async function renderPDF(container, arrayBuffer) {
    // Convert PDF to images using OffscreenCanvas approach
    // Use an iframe with the extension's own PDF viewer page
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const dataUrl = "data:application/pdf;base64," + base64;

    const iframe = document.createElement("iframe");
    iframe.src = dataUrl;
    iframe.style.cssText = "width:100%;height:550px;border:1px solid #21262d;border-radius:4px;background:#fff;";
    container.appendChild(iframe);
  }

  // Render XLSX preview
  function renderXLSX(container, arrayBuffer) {
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    const sheetNames = workbook.SheetNames;

    if (sheetNames.length === 0) {
      container.textContent = "Empty workbook";
      return;
    }

    // Sheet tabs
    const tabBar = document.createElement("div");
    tabBar.className = "ghfp-xlsx-tabs";
    container.appendChild(tabBar);

    const sheetContainer = document.createElement("div");
    container.appendChild(sheetContainer);

    function showSheet(name) {
      // Update active tab
      tabBar.querySelectorAll(".ghfp-xlsx-tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.sheet === name);
      });

      const sheet = workbook.Sheets[name];
      const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      if (jsonData.length === 0) {
        sheetContainer.innerHTML = '<div style="color:#8b949e;padding:16px;">Empty sheet</div>';
        return;
      }

      // Limit rows for preview
      const maxRows = Math.min(jsonData.length, 200);
      const maxCols = jsonData.reduce((max, row) => Math.max(max, row.length), 0);

      const table = document.createElement("table");
      table.className = "ghfp-xlsx-table";

      // Header row
      if (jsonData.length > 0) {
        const thead = document.createElement("thead");
        const headerRow = document.createElement("tr");
        for (let c = 0; c < maxCols; c++) {
          const th = document.createElement("th");
          th.textContent = jsonData[0][c] !== undefined ? String(jsonData[0][c]) : "";
          headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);
      }

      // Data rows
      const tbody = document.createElement("tbody");
      for (let r = 1; r < maxRows; r++) {
        const tr = document.createElement("tr");
        for (let c = 0; c < maxCols; c++) {
          const td = document.createElement("td");
          td.textContent = jsonData[r] && jsonData[r][c] !== undefined ? String(jsonData[r][c]) : "";
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      sheetContainer.innerHTML = "";

      const info = document.createElement("div");
      info.style.cssText = "color:#8b949e;font-size:12px;margin-bottom:8px;";
      info.textContent = `${jsonData.length} rows, ${maxCols} columns${jsonData.length > maxRows ? ` (showing first ${maxRows})` : ""}`;
      sheetContainer.appendChild(info);
      sheetContainer.appendChild(table);
    }

    // Create tabs
    sheetNames.forEach((name, idx) => {
      const tab = document.createElement("button");
      tab.className = "ghfp-xlsx-tab" + (idx === 0 ? " active" : "");
      tab.dataset.sheet = name;
      tab.textContent = name;
      tab.addEventListener("click", () => showSheet(name));
      tabBar.appendChild(tab);
    });

    showSheet(sheetNames[0]);
  }

  // Render DOCX preview
  async function renderDOCX(container, arrayBuffer) {
    const result = await mammoth.convertToHtml({ arrayBuffer });

    const content = document.createElement("div");
    content.className = "ghfp-docx-content";
    content.innerHTML = result.value;
    container.appendChild(content);

    if (result.messages && result.messages.length > 0) {
      const warnings = document.createElement("div");
      warnings.style.cssText = "color:#d29922;font-size:11px;margin-top:8px;border-top:1px solid #21262d;padding-top:8px;";
      warnings.textContent = `${result.messages.length} conversion warning(s)`;
      container.appendChild(warnings);
    }
  }

  // Create preview button and attach to a file header
  function addPreviewButton(fileHeader, filePath, ext, repoInfo) {
    const btn = document.createElement("button");
    btn.className = "ghfp-preview-btn";
    btn.innerHTML = `${FILE_ICON} Preview ${SUPPORTED_EXTENSIONS[ext]}`;
    btn.title = `Preview ${filePath}`;

    let previewContainer = null;
    let isOpen = false;

    btn.addEventListener("click", async () => {
      if (isOpen && previewContainer) {
        previewContainer.remove();
        previewContainer = null;
        isOpen = false;
        btn.classList.remove("active");
        return;
      }

      // Find the file diff container (the parent that holds everything for this file)
      // Old UI: .file, New UI: parent of DiffFileHeader (usually 2-3 levels up)
      const fileContainer =
        fileHeader.closest(".file") ||
        fileHeader.closest('[data-tagsearch-path]') ||
        fileHeader.closest('[class*="DiffSquished"]') ||
        fileHeader.closest('[class*="diff-"]') ||
        fileHeader.parentElement?.parentElement ||
        fileHeader.parentElement;

      previewContainer = document.createElement("div");
      previewContainer.className = "ghfp-preview-container loading";

      // Close button
      const closeBtn = document.createElement("button");
      closeBtn.className = "ghfp-close-btn";
      closeBtn.textContent = "Close";
      closeBtn.addEventListener("click", () => {
        previewContainer.remove();
        previewContainer = null;
        isOpen = false;
        btn.classList.remove("active");
      });

      previewContainer.appendChild(closeBtn);

      // Insert after the file header area
      if (fileContainer) {
        const diffContent =
          fileContainer.querySelector(".js-file-content") ||
          fileContainer.querySelector('[data-diff-anchor]') ||
          fileContainer.querySelector('[class*="DiffContent"]') ||
          fileContainer.lastElementChild;
        if (diffContent && diffContent !== fileHeader) {
          diffContent.insertAdjacentElement("afterend", previewContainer);
        } else {
          fileContainer.appendChild(previewContainer);
        }
      } else {
        fileHeader.insertAdjacentElement("afterend", previewContainer);
      }

      isOpen = true;
      btn.classList.add("active");

      try {
        const arrayBuffer = await fetchFileContent(filePath, repoInfo);
        previewContainer.classList.remove("loading");

        if (ext === "pdf") {
          await renderPDF(previewContainer, arrayBuffer);
        } else if (ext === "xlsx" || ext === "xls") {
          renderXLSX(previewContainer, arrayBuffer);
        } else if (ext === "docx" || ext === "doc") {
          await renderDOCX(previewContainer, arrayBuffer);
        }
      } catch (err) {
        previewContainer.classList.remove("loading");
        previewContainer.classList.add("error");
        previewContainer.textContent = `Failed to load preview: ${err.message}`;
        // Re-add close button
        previewContainer.prepend(closeBtn);
      }
    });

    // Find a good place to insert the button
    // Old UI: .file-actions, details
    // New UI: ActionBar or the "..." menu button area
    const actionsArea =
      fileHeader.querySelector(".file-actions") ||
      fileHeader.querySelector('[class*="ActionBar"]') ||
      fileHeader.querySelector('[class*="actions"]') ||
      fileHeader.querySelector("details") ||
      null;

    if (actionsArea) {
      actionsArea.insertAdjacentElement("beforebegin", btn);
    } else {
      // For new UI, insert before the last few action buttons (Viewed checkbox, comment, ...)
      const lastButtons = fileHeader.querySelectorAll('button, [class*="prc-Button"]');
      if (lastButtons.length > 1) {
        // Insert before the second-to-last button group
        lastButtons[lastButtons.length - 2].insertAdjacentElement("beforebegin", btn);
      } else {
        fileHeader.appendChild(btn);
      }
    }
  }

  // Extract file path from a header element (works for both old and new UI)
  function extractFilePath(header) {
    // Direct attributes
    let filePath =
      header.getAttribute("data-tagsearch-path") ||
      header.getAttribute("data-path") ||
      "";

    if (!filePath) {
      // Try child elements (old UI: .file-info a, new UI: a.Link--primary > code)
      const pathEl =
        header.querySelector('[data-tagsearch-path]') ||
        header.querySelector(".file-info a[title]") ||
        header.querySelector('a[href*="#diff-"]') ||
        header.querySelector(".Link--primary") ||
        header.querySelector('a[title]');

      if (pathEl) {
        filePath =
          pathEl.getAttribute("data-tagsearch-path") ||
          pathEl.getAttribute("title") ||
          pathEl.textContent.trim();
      }
    }

    // Check parent .file element (old UI)
    if (!filePath) {
      const fileEl = header.closest(".file");
      if (fileEl) {
        const anchor = fileEl.querySelector('a[title]');
        if (anchor) filePath = anchor.getAttribute("title") || anchor.textContent.trim();
      }
    }

    return filePath;
  }

  // Check if a header already has a preview button (including in parent containers)
  function alreadyHasButton(header) {
    if (header.querySelector(".ghfp-preview-btn")) return true;
    const parentFile = header.closest(".file") || header.closest('[class*="DiffSquished"]') || header.parentElement;
    if (parentFile && parentFile.querySelector(".ghfp-preview-btn")) return true;
    return false;
  }

  // Scan the page for binary files that can be previewed
  function scanForFiles() {
    const repoInfo = getRepoInfo();
    if (!repoInfo) return;

    // Find all file headers in the PR diff view
    // Old UI: .file-header, [data-tagsearch-path], .file-info, .diffbar
    // New UI (React): elements with DiffFileHeader CSS module classes
    const fileHeaders = document.querySelectorAll(
      '.file-header, [data-tagsearch-path], .file-info, .diffbar, [class*="DiffFileHeader"]'
    );

    fileHeaders.forEach((header) => {
      if (processedFiles.has(header)) return;
      processedFiles.add(header);

      const filePath = extractFilePath(header);
      if (!filePath) return;

      const ext = getFileExtension(filePath);
      if (!SUPPORTED_EXTENSIONS[ext]) return;

      if (alreadyHasButton(header)) return;

      addPreviewButton(header, filePath, ext, repoInfo);
    });

    // Also look for "Binary file not shown" messages and add buttons near them
    // Old UI: .empty-diff, .data.empty
    // New UI: plain text in various containers
    document.querySelectorAll(".empty-diff, .data.empty").forEach((emptyDiff) => {
      if (processedFiles.has(emptyDiff)) return;
      processedFiles.add(emptyDiff);

      const fileEl = emptyDiff.closest(".file");
      if (!fileEl) return;

      const header = fileEl.querySelector(".file-header");
      if (!header || header.querySelector(".ghfp-preview-btn")) return;

      const filePath = extractFilePath(fileEl);
      if (!filePath) return;
      const ext = getFileExtension(filePath);
      if (!SUPPORTED_EXTENSIONS[ext]) return;

      addPreviewButton(header, filePath, ext, repoInfo);
    });

    // New UI fallback: scan for "Binary file not shown" text nodes
    // and find the nearest file header ancestor
    if (!document.querySelector('.file-header')) {
      scanNewUIBinaryFiles(repoInfo);
    }
  }

  // New UI: find binary file sections by walking up from "Binary file not shown" text
  function scanNewUIBinaryFiles(repoInfo) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.includes("Binary file not shown")) continue;

      // Walk up to find the file container
      let container = node.parentElement;
      for (let i = 0; i < 10 && container; i++) {
        // Look for a DiffFileHeader inside this container
        const header = container.querySelector('[class*="DiffFileHeader"]');
        if (header) {
          if (processedFiles.has(container)) break;
          processedFiles.add(container);

          const filePath = extractFilePath(header);
          if (!filePath) break;

          const ext = getFileExtension(filePath);
          if (!SUPPORTED_EXTENSIONS[ext]) break;

          if (alreadyHasButton(header)) break;

          addPreviewButton(header, filePath, ext, repoInfo);
          break;
        }
        container = container.parentElement;
      }
    }
  }

  // Run initial scan
  scanForFiles();

  // Observe DOM changes (GitHub uses turbo/pjax for navigation)
  const observer = new MutationObserver(() => {
    scanForFiles();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Also re-scan on turbo navigation
  document.addEventListener("turbo:load", () => scanForFiles());
  document.addEventListener("pjax:end", () => scanForFiles());

  // Re-scan after a delay to catch late-rendered content
  setTimeout(() => scanForFiles(), 3000);

  console.log("[GitHub PR File Preview] Extension loaded");
})();
