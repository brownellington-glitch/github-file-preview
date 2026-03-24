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

  const processedFiles = new WeakSet();
  let prInfoCache = null;

  // Strip invisible Unicode characters (LTR/RTL marks, zero-width spaces, etc.)
  function cleanFileName(name) {
    return name.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, "").trim();
  }

  function getRepoInfo() {
    const match = location.pathname.match(
      /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/
    );
    if (!match) return null;
    return { owner: match[1], repo: match[2], pr: match[3] };
  }

  function getFileExtension(filePath) {
    return filePath.split(".").pop().toLowerCase();
  }

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

  // Extract PR head info from the page DOM (no cross-origin API call needed)
  function extractPRInfoFromPage() {
    // Strategy 1: New React UI embedded JSON
    const embeddedScript = document.querySelector('script[data-target="react-app.embeddedData"]');
    if (embeddedScript) {
      try {
        const data = JSON.parse(embeddedScript.textContent);
        const pr = data?.payload?.pullRequestsChangesRoute?.pullRequest
          || data?.payload?.pullRequestsLayoutRoute?.pullRequest;
        const comparison = data?.payload?.pullRequestsChangesRoute?.comparison?.fullDiff
          || data?.payload?.pullRequestsChangesRoute?.comparison;
        const headSha = data?.payload?.pullRequestsLayoutRoute?.mergeStatusButtonData?.headSha
          || comparison?.headOid;
        if (pr && pr.headRepositoryOwnerLogin && pr.headRepositoryName && pr.headBranch) {
          return {
            headRef: pr.headBranch,
            headRepo: `${pr.headRepositoryOwnerLogin}/${pr.headRepositoryName}`,
            headSha: headSha || null,
          };
        }
      } catch (e) { /* continue */ }
    }

    // Strategy 2: Old UI - react-partial embedded data
    for (const script of document.querySelectorAll('script[data-target="react-partial.embeddedData"]')) {
      try {
        const data = JSON.parse(script.textContent);
        const pr = data?.props?.pullRequest || data?.pullRequest;
        if (pr?.headRefName && pr?.headRepository?.nameWithOwner) {
          return {
            headRef: pr.headRefName,
            headRepo: pr.headRepository.nameWithOwner,
            headSha: pr.headRefOid || null,
          };
        }
      } catch (e) { /* continue */ }
    }

    return null;
  }

  async function fetchFileContent(filePath, repoInfo) {
    if (!prInfoCache) {
      // Try extracting from page DOM first (works for both public and private repos)
      prInfoCache = extractPRInfoFromPage();

      // Fallback: same-origin fetch of PR page to parse info
      if (!prInfoCache) {
        try {
          const prPageUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}/pull/${repoInfo.pr}`;
          const resp = await fetch(prPageUrl, {
            credentials: "same-origin",
            headers: { Accept: "text/html" },
          });
          if (resp.ok) {
            const html = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, "text/html");
            for (const script of doc.querySelectorAll('script[data-target*="embeddedData"]')) {
              try {
                const data = JSON.parse(script.textContent);
                const pr = data?.payload?.pullRequestsLayoutRoute?.pullRequest
                  || data?.payload?.pullRequest;
                if (pr?.headBranch && pr?.headRepositoryOwnerLogin && pr?.headRepositoryName) {
                  prInfoCache = {
                    headRef: pr.headBranch,
                    headRepo: `${pr.headRepositoryOwnerLogin}/${pr.headRepositoryName}`,
                    headSha: data?.payload?.pullRequestsLayoutRoute?.mergeStatusButtonData?.headSha || null,
                  };
                  break;
                }
              } catch (e) { /* continue */ }
            }
          }
        } catch (e) { /* continue */ }
      }

      // Last resort: GitHub API (needs PAT for private repos)
      if (!prInfoCache) {
        const token = await getGitHubToken();
        const headers = { Accept: "application/vnd.github.v3+json" };
        if (token) headers["Authorization"] = `token ${token}`;

        const prApiUrl = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${repoInfo.pr}`;
        const prResp = await fetch(prApiUrl, { headers });
        if (!prResp.ok) throw new Error(`Failed to fetch PR info: ${prResp.status}`);
        const prData = await prResp.json();
        prInfoCache = {
          headRef: prData.head.ref,
          headRepo: prData.head.repo.full_name,
          headSha: prData.head.sha,
        };
      }
    }

    const headRef = prInfoCache.headRef;
    const headRepo = prInfoCache.headRepo;
    const headSha = prInfoCache.headSha;

    // Strategy 1: Same-origin fetch (includes session cookies - works for private repos)
    try {
      const sameOriginUrl = `https://github.com/${headRepo}/raw/${headRef}/${filePath}`;
      const resp = await fetch(sameOriginUrl, { credentials: "same-origin" });
      if (resp.ok) return await resp.arrayBuffer();
    } catch (e) { /* continue */ }

    // Strategy 2: raw.githubusercontent.com (public repos)
    try {
      const rawUrl = `https://raw.githubusercontent.com/${headRepo}/${headRef}/${filePath}`;
      const resp = await fetch(rawUrl);
      if (resp.ok) return await resp.arrayBuffer();
    } catch (e) { /* continue */ }

    // Strategy 3: GitHub API with optional token
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

  function createPreviewContainer(btn) {
    const previewContainer = document.createElement("div");
    previewContainer.className = "ghfp-preview-container loading";

    const closeBtn = document.createElement("button");
    closeBtn.className = "ghfp-close-btn";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => {
      previewContainer.remove();
      btn._ghfpOpen = false;
      btn.classList.remove("active");
    });

    previewContainer.appendChild(closeBtn);
    return { previewContainer, closeBtn };
  }

  // ===== NEW REACT UI (prx_files / /changes URL) =====

  function scanNewUI(repoInfo) {
    // New UI diff sections have id="diff-<hash>" and class containing "Diff-module__diff"
    const diffSections = document.querySelectorAll('div[id^="diff-"][class*="Diff-module"]');

    diffSections.forEach((section) => {
      if (processedFiles.has(section)) return;

      // Find the filename link: Link--primary inside DiffFileHeader
      const fileLink = section.querySelector('a.Link--primary[href*="#diff-"]');
      if (!fileLink) return;

      // Extract and clean filename (strip invisible Unicode chars like U+200E)
      let filePath = fileLink.getAttribute("title") || cleanFileName(fileLink.textContent);
      if (!filePath) return;
      filePath = cleanFileName(filePath);

      const ext = getFileExtension(filePath);
      if (!SUPPORTED_EXTENSIONS[ext]) return;

      processedFiles.add(section);

      if (section.querySelector(".ghfp-preview-btn")) return;

      // Find the file header div
      const fileHeader = section.querySelector('[class*="DiffFileHeader-module__diff-file-header"]');
      if (!fileHeader) return;

      addNewUIPreviewButton(fileHeader, section, filePath, ext, repoInfo);
    });
  }

  function addNewUIPreviewButton(fileHeader, diffSection, filePath, ext, repoInfo) {
    const btn = document.createElement("button");
    btn.className = "ghfp-preview-btn";
    btn.innerHTML = `${FILE_ICON} Preview ${SUPPORTED_EXTENSIONS[ext]}`;
    btn.title = `Preview ${filePath}`;
    btn._ghfpOpen = false;

    btn.addEventListener("click", async () => {
      if (btn._ghfpOpen) {
        const existing = diffSection.querySelector(".ghfp-preview-container");
        if (existing) existing.remove();
        btn._ghfpOpen = false;
        btn.classList.remove("active");
        return;
      }

      const { previewContainer, closeBtn } = createPreviewContainer(btn);

      // Insert after the header wrapper (before the diff content area)
      const headerWrapper = diffSection.querySelector('[class*="Diff-module__diffHeaderWrapper"]');
      if (headerWrapper && headerWrapper.nextSibling) {
        headerWrapper.parentNode.insertBefore(previewContainer, headerWrapper.nextSibling);
      } else {
        diffSection.appendChild(previewContainer);
      }

      btn._ghfpOpen = true;
      btn.classList.add("active");

      try {
        const arrayBuffer = await fetchFileContent(filePath, repoInfo);
        previewContainer.classList.remove("loading");
        if (ext === "pdf") await renderPDF(previewContainer, arrayBuffer);
        else if (ext === "xlsx" || ext === "xls") renderXLSX(previewContainer, arrayBuffer);
        else if (ext === "docx" || ext === "doc") await renderDOCX(previewContainer, arrayBuffer);
      } catch (err) {
        previewContainer.classList.remove("loading");
        previewContainer.classList.add("error");
        previewContainer.textContent = `Failed to load preview: ${err.message}`;
        previewContainer.prepend(closeBtn);
      }
    });

    // Insert button into the header's right-side action area
    // Structure: fileHeader > [collapse btn] [file-path-section] [right-side flex container]
    const rightSide = fileHeader.querySelector(".d-flex.flex-row.flex-justify-end");
    if (rightSide) {
      rightSide.insertAdjacentElement("beforebegin", btn);
    } else {
      // Fallback: insert before the last button group
      const kebab = fileHeader.querySelector('[aria-haspopup="true"]');
      if (kebab) {
        kebab.insertAdjacentElement("beforebegin", btn);
      } else {
        fileHeader.appendChild(btn);
      }
    }
  }

  // ===== OLD UI (.file / .file-header) =====

  function scanOldUI(repoInfo) {
    // Old UI: .file-header with data-tagsearch-path
    document.querySelectorAll('.file-header[data-tagsearch-path]').forEach((header) => {
      if (processedFiles.has(header)) return;
      processedFiles.add(header);

      const filePath = header.getAttribute("data-tagsearch-path");
      if (!filePath) return;

      const ext = getFileExtension(filePath);
      if (!SUPPORTED_EXTENSIONS[ext]) return;

      const section = header.closest(".file") || header.parentElement;
      if (section.querySelector(".ghfp-preview-btn")) return;

      addOldUIPreviewButton(header, section, filePath, ext, repoInfo);
    });

    // Also scan for diff links in .file sections (old UI variant)
    document.querySelectorAll('.file a[href*="#diff-"]').forEach((link) => {
      if (processedFiles.has(link)) return;

      const section = link.closest(".file");
      if (!section || processedFiles.has(section)) return;

      let filePath = link.getAttribute("title") || link.getAttribute("data-tagsearch-path") || cleanFileName(link.textContent);
      if (!filePath) return;
      filePath = cleanFileName(filePath);

      const ext = getFileExtension(filePath);
      if (!SUPPORTED_EXTENSIONS[ext]) return;

      processedFiles.add(section);
      processedFiles.add(link);

      if (section.querySelector(".ghfp-preview-btn")) return;

      const headerRow = section.querySelector(".file-header") || link.parentElement;
      addOldUIPreviewButton(headerRow, section, filePath, ext, repoInfo);
    });
  }

  function addOldUIPreviewButton(headerRow, fileSection, filePath, ext, repoInfo) {
    const btn = document.createElement("button");
    btn.className = "ghfp-preview-btn";
    btn.innerHTML = `${FILE_ICON} Preview ${SUPPORTED_EXTENSIONS[ext]}`;
    btn.title = `Preview ${filePath}`;
    btn._ghfpOpen = false;

    btn.addEventListener("click", async () => {
      if (btn._ghfpOpen) {
        const existing = fileSection.querySelector(".ghfp-preview-container");
        if (existing) existing.remove();
        btn._ghfpOpen = false;
        btn.classList.remove("active");
        return;
      }

      const { previewContainer, closeBtn } = createPreviewContainer(btn);
      fileSection.appendChild(previewContainer);
      btn._ghfpOpen = true;
      btn.classList.add("active");

      try {
        const arrayBuffer = await fetchFileContent(filePath, repoInfo);
        previewContainer.classList.remove("loading");
        if (ext === "pdf") await renderPDF(previewContainer, arrayBuffer);
        else if (ext === "xlsx" || ext === "xls") renderXLSX(previewContainer, arrayBuffer);
        else if (ext === "docx" || ext === "doc") await renderDOCX(previewContainer, arrayBuffer);
      } catch (err) {
        previewContainer.classList.remove("loading");
        previewContainer.classList.add("error");
        previewContainer.textContent = `Failed to load preview: ${err.message}`;
        previewContainer.prepend(closeBtn);
      }
    });

    const actionsArea =
      headerRow.querySelector(".file-actions") ||
      headerRow.querySelector("details");

    if (actionsArea) {
      actionsArea.insertAdjacentElement("beforebegin", btn);
    } else {
      const buttons = headerRow.querySelectorAll("button");
      const lastBtn = buttons.length > 0 ? buttons[buttons.length - 1] : null;
      if (lastBtn && lastBtn !== headerRow) {
        lastBtn.insertAdjacentElement("beforebegin", btn);
      } else {
        headerRow.appendChild(btn);
      }
    }
  }

  // ===== MAIN SCANNER =====

  function scanForFiles() {
    const repoInfo = getRepoInfo();
    if (!repoInfo) return;

    scanNewUI(repoInfo);
    scanOldUI(repoInfo);
  }

  let scanTimeout = null;
  function debouncedScan() {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => scanForFiles(), 200);
  }

  scanForFiles();

  const observer = new MutationObserver(debouncedScan);
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("turbo:load", () => scanForFiles());
  document.addEventListener("pjax:end", () => scanForFiles());

  setTimeout(() => scanForFiles(), 2000);
  setTimeout(() => scanForFiles(), 5000);

  console.log("[GitHub PR File Preview] Extension loaded v1.5.1");
})();
