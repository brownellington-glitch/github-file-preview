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

  // Track already-processed elements
  const processedFiles = new WeakSet();

  // Cache PR info to avoid repeated API calls
  let prInfoCache = null;

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
    return filePath.split(".").pop().toLowerCase();
  }

  // Get stored GitHub token (if any)
  async function getGitHubToken() {
    return new Promise((resolve) => {
      if (typeof chrome !== "undefined" && chrome.storage) {
        chrome.storage.sync.get("githubToken", (data) => {
          resolve(data.githubToken || "");
        });
      } else {
        resolve("");
      }
    });
  }

  // Fetch file content - works for both public and private repos
  async function fetchFileContent(filePath, repoInfo) {
    // Get PR head info (cached)
    if (!prInfoCache) {
      const token = await getGitHubToken();
      const headers = { Accept: "application/vnd.github.v3+json" };
      if (token) headers["Authorization"] = `token ${token}`;

      const prApiUrl = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${repoInfo.pr}`;
      const prResp = await fetch(prApiUrl, { headers });
      if (!prResp.ok) throw new Error(`Failed to fetch PR info: ${prResp.status}`);
      prInfoCache = await prResp.json();
    }

    const headRef = prInfoCache.head.ref;
    const headRepo = prInfoCache.head.repo.full_name;
    const headSha = prInfoCache.head.sha;

    // Strategy 1: Use same-origin GitHub URL (includes session cookies - works for private repos!)
    try {
      const sameOriginUrl = `https://github.com/${headRepo}/raw/${headRef}/${filePath}`;
      const resp = await fetch(sameOriginUrl, { credentials: "same-origin" });
      if (resp.ok) return await resp.arrayBuffer();
    } catch (e) { /* continue to next strategy */ }

    // Strategy 2: Use raw.githubusercontent.com (public repos)
    try {
      const rawUrl = `https://raw.githubusercontent.com/${headRepo}/${headRef}/${filePath}`;
      const resp = await fetch(rawUrl);
      if (resp.ok) return await resp.arrayBuffer();
    } catch (e) { /* continue */ }

    // Strategy 3: GitHub API with optional token (handles private repos with PAT)
    const token = await getGitHubToken();
    const apiHeaders = {};
    if (token) apiHeaders["Authorization"] = `token ${token}`;

    const treeUrl = `https://api.github.com/repos/${headRepo}/contents/${filePath}?ref=${headSha}`;
    const treeResp = await fetch(treeUrl, { headers: apiHeaders });
    if (!treeResp.ok) throw new Error(`Failed to fetch file: ${treeResp.status}`);
    const treeData = await treeResp.json();

    if (treeData.content) {
      const binary = atob(treeData.content.replace(/\n/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }

    if (treeData.download_url) {
      const dlResp = await fetch(treeData.download_url);
      if (dlResp.ok) return await dlResp.arrayBuffer();
    }

    throw new Error("Could not retrieve file content");
  }

  // Render PDF preview
  async function renderPDF(container, arrayBuffer) {
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

    const tabBar = document.createElement("div");
    tabBar.className = "ghfp-xlsx-tabs";
    container.appendChild(tabBar);

    const sheetContainer = document.createElement("div");
    container.appendChild(sheetContainer);

    function showSheet(name) {
      tabBar.querySelectorAll(".ghfp-xlsx-tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.sheet === name);
      });

      const sheet = workbook.Sheets[name];
      const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      if (jsonData.length === 0) {
        sheetContainer.innerHTML = '<div style="color:#8b949e;padding:16px;">Empty sheet</div>';
        return;
      }

      const maxRows = Math.min(jsonData.length, 200);
      const maxCols = jsonData.reduce((max, row) => Math.max(max, row.length), 0);

      const table = document.createElement("table");
      table.className = "ghfp-xlsx-table";

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

  // Find the file section container for a given element
  function findFileSection(el) {
    // Old UI: .file class
    const fileEl = el.closest(".file");
    if (fileEl) return fileEl;

    // New UI: walk up looking for a container that has both a file link and "Binary file not shown"
    let node = el;
    for (let i = 0; i < 15 && node; i++) {
      if (node.querySelector && node.querySelector('a[href*="#diff-"]')) {
        return node;
      }
      node = node.parentElement;
    }
    return el.parentElement;
  }

  // Find the header row within a file section
  function findHeaderInSection(section) {
    // Old UI
    const oldHeader = section.querySelector(".file-header");
    if (oldHeader) return oldHeader;

    // New UI: the first child div that contains the file link and action buttons
    // Look for the row containing the filename link and the "..." menu
    const fileLink = section.querySelector('a[href*="#diff-"]');
    if (!fileLink) return null;

    // Walk up from the file link to find the header row
    let row = fileLink;
    for (let i = 0; i < 5 && row; i++) {
      // A header row typically has buttons (toggle, copy, menu)
      if (row.querySelectorAll("button").length >= 2) return row;
      row = row.parentElement;
      if (row === section) return row.firstElementChild;
    }
    return fileLink.parentElement;
  }

  // Create preview button and attach to a file header
  function addPreviewButton(headerRow, filePath, ext, repoInfo) {
    const btn = document.createElement("button");
    btn.className = "ghfp-preview-btn";
    btn.innerHTML = `${FILE_ICON} Preview ${SUPPORTED_EXTENSIONS[ext]}`;
    btn.title = `Preview ${filePath}`;

    let previewContainer = null;
    let isOpen = false;

    const fileSection = findFileSection(headerRow);

    btn.addEventListener("click", async () => {
      if (isOpen && previewContainer) {
        previewContainer.remove();
        previewContainer = null;
        isOpen = false;
        btn.classList.remove("active");
        return;
      }

      previewContainer = document.createElement("div");
      previewContainer.className = "ghfp-preview-container loading";

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

      // Insert preview after the file section
      if (fileSection) {
        fileSection.appendChild(previewContainer);
      } else {
        headerRow.insertAdjacentElement("afterend", previewContainer);
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
        previewContainer.prepend(closeBtn);
      }
    });

    // Insert button into the header row
    // Old UI: before .file-actions or details
    const actionsArea =
      headerRow.querySelector(".file-actions") ||
      headerRow.querySelector("details");

    if (actionsArea) {
      actionsArea.insertAdjacentElement("beforebegin", btn);
    } else {
      // New UI: insert before the last button group (usually the "..." menu)
      const buttons = headerRow.querySelectorAll("button");
      const lastBtn = buttons.length > 0 ? buttons[buttons.length - 1] : null;
      if (lastBtn && lastBtn !== headerRow) {
        lastBtn.insertAdjacentElement("beforebegin", btn);
      } else {
        headerRow.appendChild(btn);
      }
    }
  }

  // UNIVERSAL file scanner - works for both old and new GitHub UI
  function scanForFiles() {
    const repoInfo = getRepoInfo();
    if (!repoInfo) return;

    // Strategy: find ALL diff-anchor links on the page (present in both old and new UI)
    // These are links like: <a href="#diff-abc123">filename.ext</a>
    const diffLinks = document.querySelectorAll('a[href*="#diff-"]');

    diffLinks.forEach((link) => {
      if (processedFiles.has(link)) return;

      // Extract filename from link text or attributes
      let filePath =
        link.getAttribute("title") ||
        link.getAttribute("data-tagsearch-path") ||
        link.textContent.trim();

      if (!filePath) return;

      const ext = getFileExtension(filePath);
      if (!SUPPORTED_EXTENSIONS[ext]) return;

      // Find the file section this link belongs to
      const section = findFileSection(link);
      if (!section) return;

      // Mark as processed (mark the section, not just the link, to avoid duplicates)
      if (processedFiles.has(section)) return;
      processedFiles.add(section);
      processedFiles.add(link);

      // Check if already has a preview button
      if (section.querySelector(".ghfp-preview-btn")) return;

      // Find the header row
      const headerRow = findHeaderInSection(section);
      if (!headerRow) return;

      addPreviewButton(headerRow, filePath, ext, repoInfo);
    });

    // Fallback: also scan for old UI-specific elements
    scanOldUIFiles(repoInfo);
  }

  // Old UI specific scanning (backward compatibility)
  function scanOldUIFiles(repoInfo) {
    document.querySelectorAll('.file-header[data-tagsearch-path]').forEach((header) => {
      if (processedFiles.has(header)) return;
      processedFiles.add(header);

      const filePath = header.getAttribute("data-tagsearch-path");
      if (!filePath) return;

      const ext = getFileExtension(filePath);
      if (!SUPPORTED_EXTENSIONS[ext]) return;

      const section = header.closest(".file") || header.parentElement;
      if (section.querySelector(".ghfp-preview-btn")) return;

      addPreviewButton(header, filePath, ext, repoInfo);
    });
  }

  // Debounce scan to avoid excessive re-scanning
  let scanTimeout = null;
  function debouncedScan() {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => scanForFiles(), 200);
  }

  // Run initial scan
  scanForFiles();

  // Observe DOM changes (GitHub SPA navigation)
  const observer = new MutationObserver(debouncedScan);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Re-scan on turbo/pjax navigation
  document.addEventListener("turbo:load", () => scanForFiles());
  document.addEventListener("pjax:end", () => scanForFiles());

  // Re-scan after delays to catch late-rendered React content
  setTimeout(() => scanForFiles(), 2000);
  setTimeout(() => scanForFiles(), 5000);

  console.log("[GitHub PR File Preview] Extension loaded v1.3.0");
})();
