// ---- Google Auth + Drive Sync ----

const CLIENT_ID = "610473872-eufjj87q02u997kdt2bo5kpld1prps4m.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive";
const CONSOLE_FOLDER_NAME = "Console";

let accessToken = null;
let tokenClient = null;
let currentFileId = null;
let consoleFolderId = null;
let driveFiles = []; // { id, name } list of files in /Console/
let isDirty = false;

// ---- Dirty state ----
function markDirty() {
    isDirty = true;
    const ind = document.getElementById("unsaved-indicator");
    if (ind) ind.style.display = "inline";
}

function markClean() {
    isDirty = false;
    const ind = document.getElementById("unsaved-indicator");
    if (ind) ind.style.display = "none";
}

// ---- Auth ----
function initGoogleAuth() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: onTokenReceived,
    });

    const savedToken = sessionStorage.getItem("gAccessToken");
    if (savedToken) {
        accessToken = savedToken;
        showApp();
        initDrive();
    }

    document.getElementById("signin-btn").addEventListener("click", () => {
        tokenClient.requestAccessToken();
    });

    document.getElementById("btn-signout").addEventListener("click", () => {
        if (accessToken) google.accounts.oauth2.revoke(accessToken);
        accessToken = null;
        currentFileId = null;
        consoleFolderId = null;
        driveFiles = [];
        sessionStorage.removeItem("gAccessToken");
        sessionStorage.removeItem("currentFileId");
        document.getElementById("main-app").style.display = "none";
        document.getElementById("signin-screen").style.display = "flex";
    });
}

function onTokenReceived(response) {
    if (response.error) { console.error(response); return; }
    accessToken = response.access_token;
    sessionStorage.setItem("gAccessToken", accessToken);
    showApp();
    initDrive();
}

let appInitialized = false;

function showApp() {
    document.getElementById("signin-screen").style.display = "none";
    document.getElementById("main-app").style.display = "block";
    if (!appInitialized) {
        appInitialized = true;
        initApp();
    }
}

// ---- Drive folder + file management ----

async function driveRequest(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(options.headers || {})
        }
    });
    return res;
}

async function getOrCreateFolder() {
    // find Console folder
    const res = await driveRequest(
        `https://www.googleapis.com/drive/v3/files?q=name='${CONSOLE_FOLDER_NAME}'+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)`
    );
    const data = await res.json();
    if (data.files && data.files.length > 0) {
        consoleFolderId = data.files[0].id;
        return consoleFolderId;
    }
    // create it
    const createRes = await driveRequest(
        "https://www.googleapis.com/drive/v3/files",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: CONSOLE_FOLDER_NAME,
                mimeType: "application/vnd.google-apps.folder"
            })
        }
    );
    const folder = await createRes.json();
    consoleFolderId = folder.id;
    return consoleFolderId;
}

async function listFiles() {
    await getOrCreateFolder();
    const res = await driveRequest(
        `https://www.googleapis.com/drive/v3/files?q='${consoleFolderId}'+in+parents+and+trashed=false+and+mimeType='application/json'&fields=files(id,name)&orderBy=name`
    );
    const data = await res.json();
    driveFiles = data.files || [];
    return driveFiles;
}

async function initDrive() {
    try {
        await listFiles();
        populateDropdown();

        // restore last used file
        const lastFileId = sessionStorage.getItem("currentFileId");
        if (lastFileId && driveFiles.find(f => f.id === lastFileId)) {
            currentFileId = lastFileId;
            document.getElementById("file-dropdown").value = currentFileId;
            await loadFile(currentFileId);
        } else if (driveFiles.length > 0) {
            currentFileId = driveFiles[0].id;
            document.getElementById("file-dropdown").value = currentFileId;
            await loadFile(currentFileId);
        } else {
            // no files yet, start with blank slate
            render();
            renderStats();
        }
    } catch (err) {
        console.error("Drive init error:", err);
    }
}

function populateDropdown() {
    const dropdown = document.getElementById("file-dropdown");
    dropdown.innerHTML = "";
    driveFiles.forEach(f => {
        const opt = document.createElement("option");
        opt.value = f.id;
        opt.textContent = f.name.replace(".json", "");
        dropdown.appendChild(opt);
    });
}

async function loadFile(fileId) {
    try {
        // set currentFileId immediately so any pending save goes to right file
        currentFileId = fileId;
        sessionStorage.setItem("currentFileId", fileId);
        document.getElementById("file-dropdown").value = fileId;

        const res = await driveRequest(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
        );
        const doc = await res.json();
        entries = doc.entries || [];
        collapsed = new Set(doc.collapsed || []);
        activeFilters = new Set();
        if (entries.length === 0) entries.push(createEntry(""));
        saveLocal();
        render();
        renderStats();
        updateLayout();
        markClean();
    } catch (err) {
        console.error("Load file error:", err);
    }
}

async function saveToDrive() {
    if (!currentFileId) return;
    const doc = {
        savedAt: new Date().toISOString(),
        entries: entries,
        collapsed: [...collapsed]
    };
    const content = JSON.stringify(doc, null, 2);
    try {
        await driveRequest(
            `https://www.googleapis.com/upload/drive/v3/files/${currentFileId}?uploadType=media`,
            {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: content
            }
        );
        markClean();
        const btn = document.getElementById("btn-save");
        const orig = btn.textContent;
        btn.textContent = "Saved ✓";
        setTimeout(() => btn.textContent = orig, 1500);
    } catch (err) {
        console.error("Save error:", err);
        alert("Save failed. You may need to sign in again.");
    }
}

async function createNewFile(name) {
    await getOrCreateFolder();
    const fileName = name.endsWith(".json") ? name : name + ".json";
    const doc = { savedAt: new Date().toISOString(), entries: [{ id: Date.now(), text: "", indent: 0 }], collapsed: [] };
    const content = JSON.stringify(doc, null, 2);
    const meta = { name: fileName, mimeType: "application/json", parents: [consoleFolderId] };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
    form.append("file", new Blob([content], { type: "application/json" }));
    const res = await driveRequest(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
        { method: "POST", body: form }
    );
    const file = await res.json();
    driveFiles.push({ id: file.id, name: fileName });
    driveFiles.sort((a, b) => a.name.localeCompare(b.name));
    populateDropdown();
    await loadFile(file.id);
}

function promptNewFile(required = false) {
    const popup = document.createElement("div");
    popup.id = "new-file-popup";

    const label = document.createElement("div");
    label.className = "tag-rename-label";
    label.textContent = "New file name:";

    const input = document.createElement("input");
    input.className = "tag-rename-input";
    input.placeholder = "e.g. 2026";
    input.spellcheck = false;

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;margin-top:6px;";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "dash-btn";
    confirmBtn.textContent = "Create";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "dash-btn";
    cancelBtn.textContent = "Cancel";
    if (required) cancelBtn.style.display = "none";

    row.appendChild(confirmBtn);
    row.appendChild(cancelBtn);
    popup.appendChild(label);
    popup.appendChild(input);
    popup.appendChild(row);
    document.body.appendChild(popup);

    popup.style.left = (window.innerWidth / 2 - 100) + "px";
    popup.style.top = (window.innerHeight / 2 - 60) + "px";
    input.focus();

    async function confirm() {
        const name = input.value.trim();
        if (!name) return;
        popup.remove();
        await createNewFile(name);
    }

    confirmBtn.addEventListener("mousedown", (e) => { e.preventDefault(); confirm(); });
    cancelBtn.addEventListener("mousedown", (e) => { e.preventDefault(); popup.remove(); });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); confirm(); }
        if (e.key === "Escape" && !required) { popup.remove(); }
    });
}

// ---- Dropdown switch ----
function initDropdownListener() {
    document.getElementById("file-dropdown").addEventListener("change", async (e) => {
        if (isDirty) {
            if (!confirm("You have unsaved changes. Switch anyway?")) {
                document.getElementById("file-dropdown").value = currentFileId;
                return;
            }
        }
        await loadFile(e.target.value);
    });
}

// ---- Button handlers ----
function initDashboardButtons() {
    document.getElementById("btn-save").addEventListener("click", () => saveToDrive());
    document.getElementById("btn-refresh").addEventListener("click", async () => {
        if (isDirty && !confirm("Refresh will discard unsaved changes. Continue?")) return;
        if (currentFileId) await loadFile(currentFileId);
    });
    document.getElementById("btn-new").addEventListener("click", () => promptNewFile(false));
}

// ---- Init ----
window.addEventListener("load", () => {
    const interval = setInterval(() => {
        if (window.google && google.accounts) {
            clearInterval(interval);
            initGoogleAuth();
        }
    }, 100);
});
