document.addEventListener("DOMContentLoaded", () => {
  const tokenInput = document.getElementById("token");
  const saveBtn = document.getElementById("save");
  const status = document.getElementById("status");

  // Load existing token
  chrome.storage.sync.get("githubToken", (data) => {
    if (data.githubToken) {
      tokenInput.value = data.githubToken;
    }
  });

  saveBtn.addEventListener("click", () => {
    const token = tokenInput.value.trim();
    chrome.storage.sync.set({ githubToken: token }, () => {
      status.style.display = "block";
      setTimeout(() => {
        status.style.display = "none";
      }, 2000);
    });
  });
});
