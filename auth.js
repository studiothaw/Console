// ---- Google Auth + Drive Sync ----

const CLIENT_ID = "610473872-eufjj87q02u997kdt2bo5kpld1prps4m.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FILE_NAME = "console-data.json";

let accessToken = null;
let driveFileId = null;
let tokenClient = null;

function initGoogleAuth() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: onTokenReceived,
    });

    // check if we have a saved token
    const savedToken = sessionStorage.getItem("gAccessToken");
    if (savedToken) {
        accessToken = savedToken;
        showApp();
        loadFromDrive();
    }

    document.getElementById("signin-btn").addEventListener("click", () => {
        tokenClient.requestAccessToken();
    });

    document.getElementById("btn-signout").addEventListener("click", () => {
        if (accessToken) google.accounts.oauth2.revoke(accessToken);
        accessToken = null;
        driveFileId = null;
        sessionStorage.removeItem("gAccessToken");
        document.getElementById("main-app").style.display = "none";
        document.getElementById("signin-screen").style.display = "flex";
    });
}

function onTokenReceived(response) {
    if (response.error) { console.error(response); return; }
    accessToken = response.access_token;
    sessionStorage.setItem("gAccessToken", accessToken);
    showApp();
    loadFromDrive();
}

function showApp() {
    document.getElementById("signin-screen").style.display = "none";
    document.getElementById("main-app").style.display = "block";
    // init the app
    initApp();
}

async function findDriveFile() {
    const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=name='${DRIVE_FILE_NAME}'+and+trashed=false&fields=files(id,name)`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    if (data.files && data.files.length > 0) {
        driveFileId = data.files[0].id;
        return driveFileId;
    }
    return null;
}

async function loadFromDrive() {
    try {
        const fileId = await findDriveFile();
        if (!fileId) {
            // no file yet, start fresh
            console.log("No Drive file found, starting fresh");
            return;
        }
        const res = await fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const doc = await res.json();
        if (doc.entries) {
            entries = doc.entries;
            collapsed = new Set(doc.collapsed || []);
            if (doc.name) {
                document.getElementById("doc-title").value = doc.name;
                localStorage.setItem("docTitle", doc.name);
            }
            if (entries.length === 0) entries.push(createEntry(""));
            saveLocal();
            render();
            renderStats();
        }
    } catch (err) {
        console.error("Drive load error:", err);
    }
}

async function saveToDrive() {
    const doc = {
        name: document.getElementById("doc-title").value || "Untitled",
        savedAt: new Date().toISOString(),
        entries: entries,
        collapsed: [...collapsed]
    };
    const content = JSON.stringify(doc, null, 2);
    const blob = new Blob([content], { type: "application/json" });

    try {
        if (driveFileId) {
            // update existing file
            await fetch(
                `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`,
                {
                    method: "PATCH",
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json"
                    },
                    body: content
                }
            );
        } else {
            // create new file
            const meta = { name: DRIVE_FILE_NAME, mimeType: "application/json" };
            const form = new FormData();
            form.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
            form.append("file", blob);
            const res = await fetch(
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
                {
                    method: "POST",
                    headers: { Authorization: `Bearer ${accessToken}` },
                    body: form
                }
            );
            const data = await res.json();
            driveFileId = data.id;
        }
        // flash the save button to confirm
        const btn = document.getElementById("btn-save");
        btn.textContent = "Saved ✓";
        setTimeout(() => btn.textContent = "Save", 1500);
    } catch (err) {
        console.error("Drive save error:", err);
        alert("Save failed. You may need to sign in again.");
    }
}

// wait for Google script to load then init
window.addEventListener("load", () => {
    const interval = setInterval(() => {
        if (window.google && google.accounts) {
            clearInterval(interval);
            initGoogleAuth();
        }
    }, 100);
});
