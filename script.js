const app = document.getElementById("app");
let entries = [];
let selectedIndices = new Set();
let lastSelectedIndex = null;
let collapsed = new Set();
let activeFilters = new Set();
let archivedTags = new Set();
let showArchivedTags = false; // active [TAG] filters

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const DAYS = ["SUN","MON","TUE","WED","THU","FRI","SAT"];

function formatDate(date) {
    const y = date.getFullYear();
    const mon = MONTHS[date.getMonth()];
    const d = String(date.getDate()).padStart(2, "0");
    const day = DAYS[date.getDay()];
    return `${y} ${mon} ${d} ${day}`;
}

function isTodayLine(text) {
    return text.startsWith(formatDate(new Date()));
}

const REP_REGEX = /\b(\d+)R\b/g;
const MIN_REGEX = /\b(\d+)M\b/g;

function getDayStats(realIndex) {
    let reps = 0, mins = 0;
    for (let i = realIndex + 1; i < entries.length; i++) {
        if (entries[i].indent === 0) break;
        for (const m of entries[i].text.matchAll(REP_REGEX)) reps += parseInt(m[1]);
        for (const m of entries[i].text.matchAll(MIN_REGEX)) mins += parseInt(m[1]);
    }
    return { reps, mins };
}

function createEntry(text, indent = 0) {
    return { id: Date.now() + Math.random(), text, indent, type: "normal" };
}

function isSection(entry) {
    return /^#{1,3}\s/.test(entry.text) || /^#{1,3}$/.test(entry.text.trim());
}

function getSectionLevel(entry) {
    const match = entry.text.match(/^(#{1,3})/);
    return match ? match[1].length : 0;
}

function saveLocal() {
    localStorage.setItem("entries", JSON.stringify(entries));
    localStorage.setItem("collapsed", JSON.stringify([...collapsed]));
}

function save() {
    saveLocal();
    if (typeof renderStats === "function") renderStats();
    if (typeof markDirty === "function") markDirty();
}

function getEntryEl(vi) {
    return app.children[vi]?.querySelector(".entry") || null;
}

function focusEntry(vi) {
    clearSelection();
    const el = getEntryEl(vi);
    if (!el) {
        const sl = app.children[vi]?.querySelector(".section-label");
        if (sl) { sl.focus(); placeCaretAtEnd(sl); }
        return;
    }
    el.focus();
    placeCaretAtEnd(el);
}

function placeCaretAtEnd(el) {
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
}

function clearSelection() {
    selectedIndices.clear();
    lastSelectedIndex = null;
    document.querySelectorAll(".line.selected").forEach(r => r.classList.remove("selected"));
}

function applySelectionClasses() {
    [...app.children].filter(r => !r.classList.contains("phantom-line"))
        .forEach((r, i) => r.classList.toggle("selected", selectedIndices.has(i)));
}

function selectRange(from, to) {
    const min = Math.min(from, to);
    const max = Math.max(from, to);
    selectedIndices.clear();
    for (let i = min; i <= max; i++) selectedIndices.add(i);
    applySelectionClasses();
}

function hasChildren(realIndex) {
    const next = entries[realIndex + 1];
    return next && next.indent > entries[realIndex].indent;
}

function countDescendants(realIndex) {
    let count = 0;
    for (let i = realIndex + 1; i < entries.length; i++) {
        if (entries[i].indent > entries[realIndex].indent) count++;
        else break;
    }
    return count;
}

// Extract all [TAG] from a line
function extractTags(text) {
    const matches = text.match(/\[([^\]]+)\]/g);
    if (!matches) return [];
    return matches.map(m => m.slice(1, -1));
}

// Parse HHMM-HHMM, returns minutes or null
function parseTimeBlock(text) {
    const match = text.match(/\b([0-2]\d[0-5]\d)-([0-2]\d[0-5]\d)\b/);
    if (!match) return null;
    const startH = parseInt(match[1].slice(0, 2));
    const startM = parseInt(match[1].slice(2));
    const endH = parseInt(match[2].slice(0, 2));
    const endM = parseInt(match[2].slice(2));
    if (startH > 23 || startM > 59 || endH > 23 || endM > 59) return null;
    let startMins = startH * 60 + startM;
    let endMins = endH * 60 + endM;
    if (endMins <= startMins) endMins += 24 * 60;
    return endMins - startMins;
}

// Find the nearest ancestor day line (indent 0, not section) for a given realIndex
function findParentDay(realIndex) {
    for (let i = realIndex - 1; i >= 0; i--) {
        if (entries[i].indent === 0 && !isSection(entries[i])) return i;
        if (isSection(entries[i])) break;
    }
    return null;
}

// Get visible entries, respecting collapse and active filters
function getVisibleEntries() {
    const visible = [];
    let skipAbove = null;
    let skipSection = false;
    let skipSectionLevel = 0;

    // if filters active, collect matching real indices + their parent day lines
    let filterSet = null;
    if (activeFilters.size > 0) {
        filterSet = new Set();
        for (let i = 0; i < entries.length; i++) {
            const tags = extractTags(entries[i].text);
            const matches = tags.some(t => activeFilters.has(t));
            if (matches) {
                filterSet.add(i);
                // add parent day line for context
                const parentDay = findParentDay(i);
                if (parentDay !== null) filterSet.add(parentDay);
            }
        }
    }

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];

        if (skipSection) {
            if (isSection(entry) && getSectionLevel(entry) <= skipSectionLevel) {
                skipSection = false;
            } else {
                continue;
            }
        }

        if (skipAbove !== null) {
            if (entry.indent > skipAbove) continue;
            else skipAbove = null;
        }

        // filter check
        if (filterSet !== null && !filterSet.has(i)) continue;

        visible.push({ entry, realIndex: i });

        if (isSection(entry) && collapsed.has(entry.id)) {
            skipSection = true;
            skipSectionLevel = getSectionLevel(entry);
            continue;
        }

        if (collapsed.has(entry.id) && hasChildren(i)) {
            // if filter active and this day has matching children, force expand
            if (filterSet !== null && filterSet.has(i)) {
                // check if any child matches filter
                const hasMatchingChild = Array.from(filterSet).some(ri => ri > i && entries[ri]?.indent > entries[i].indent);
                if (!hasMatchingChild) skipAbove = entry.indent;
            } else {
                skipAbove = entry.indent;
            }
        }
    }
    return visible;
}

// ---- Calendar popup ----
let calendarTarget = null;

function showCalendar(anchorEl, realIndex) {
    hideCalendar();
    calendarTarget = { realIndex };
    const today = new Date();
    let viewYear = today.getFullYear();
    let viewMonth = today.getMonth();

    const popup = document.createElement("div");
    popup.id = "cal-popup";

    function buildCalendar() {
        popup.innerHTML = "";
        const header = document.createElement("div");
        header.className = "cal-header";

        const prev = document.createElement("button");
        prev.className = "cal-nav";
        prev.textContent = "‹";
        prev.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } buildCalendar(); });

        const next = document.createElement("button");
        next.className = "cal-nav";
        next.textContent = "›";
        next.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } buildCalendar(); });

        const title = document.createElement("span");
        title.className = "cal-title";
        title.textContent = `${MONTHS[viewMonth]} ${viewYear}`;

        header.appendChild(prev); header.appendChild(title); header.appendChild(next);
        popup.appendChild(header);

        const grid = document.createElement("div");
        grid.className = "cal-grid";
        ["Su","Mo","Tu","We","Th","Fr","Sa"].forEach(d => {
            const lbl = document.createElement("div");
            lbl.className = "cal-daylabel";
            lbl.textContent = d;
            grid.appendChild(lbl);
        });

        const firstDay = new Date(viewYear, viewMonth, 1).getDay();
        const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
        for (let i = 0; i < firstDay; i++) grid.appendChild(document.createElement("div"));

        for (let d = 1; d <= daysInMonth; d++) {
            const cell = document.createElement("div");
            cell.className = "cal-day";
            cell.textContent = d;
            const cellDate = new Date(viewYear, viewMonth, d);
            if (cellDate.toDateString() === today.toDateString()) cell.classList.add("cal-today");
            cell.addEventListener("mousedown", (e) => {
                e.preventDefault();
                entries[calendarTarget.realIndex].text = formatDate(cellDate);
                save(); render(); hideCalendar();
            });
            grid.appendChild(cell);
        }
        popup.appendChild(grid);
    }

    buildCalendar();
    document.body.appendChild(popup);
    const rect = anchorEl.getBoundingClientRect();
    popup.style.top = (rect.bottom + window.scrollY + 4) + "px";
    popup.style.left = rect.left + "px";
    setTimeout(() => document.addEventListener("mousedown", onOutsideClick), 0);
}

function onOutsideClick(e) {
    const popup = document.getElementById("cal-popup");
    if (popup && !popup.contains(e.target)) hideCalendar();
}

function hideCalendar() {
    const popup = document.getElementById("cal-popup");
    if (popup) popup.remove();
    document.removeEventListener("mousedown", onOutsideClick);
    calendarTarget = null;
}

let statsDebounce = null;

function render() {
    app.innerHTML = "";
    const visible = getVisibleEntries();

    visible.forEach(({ entry, realIndex }, vi) => {
        const row = document.createElement("div");
        row.dataset.realIndex = realIndex;

        // ---- SECTION HEADER ----
        if (isSection(entry)) {
            row.className = "line section-header";
            if (selectedIndices.has(vi)) row.classList.add("selected");

            const isSectionCollapsed = collapsed.has(entry.id);

            const toggle = document.createElement("span");
            toggle.className = "section-toggle";
            toggle.textContent = isSectionCollapsed ? "▶" : "▼";

            const label = document.createElement("div");
            label.className = "section-label";
            label.contentEditable = true;
            label.innerText = entry.text;

            label.addEventListener("input", () => {
                entries[realIndex].text = label.innerText;
                save();
            });

            label.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    entries.splice(realIndex + 1, 0, createEntry("", 0));
                    save(); render();
                    setTimeout(() => focusEntry(vi + 1), 0);
                }
                if (e.key === "Backspace" && label.innerText.trim() === "" && entries.length > 1) {
                    e.preventDefault();
                    entries.splice(realIndex, 1);
                    save(); render();
                    setTimeout(() => focusEntry(Math.max(0, vi - 1)), 0);
                }
                if (e.key === "ArrowUp") { e.preventDefault(); if (vi > 0) focusEntry(vi - 1); }
                if (e.key === "ArrowDown") { e.preventDefault(); if (vi < visible.length - 1) focusEntry(vi + 1); }
            });

            toggle.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                toggle.setPointerCapture(e.pointerId);
                let didMove = false;

                function onPointerMove(e) {
                    didMove = true;
                    row.classList.add("dragging");
                    document.querySelectorAll(".drag-over").forEach(r => r.classList.remove("drag-over"));
                    document.querySelectorAll(".drag-over-bottom").forEach(r => r.classList.remove("drag-over-bottom"));
                    const target = document.elementFromPoint(e.clientX, e.clientY);
                    const targetRow = target?.closest(".line");
                    if (targetRow && targetRow !== row) {
                        const rows = [...app.children];
                        const isLast = rows.indexOf(targetRow) === rows.length - 1;
                        const rect = targetRow.getBoundingClientRect();
                        if (isLast && e.clientY > rect.top + rect.height / 2) {
                            targetRow.classList.add("drag-over-bottom");
                        } else {
                            targetRow.classList.add("drag-over");
                        }
                    }
                }

                function onPointerUp(e) {
                    toggle.removeEventListener("pointermove", onPointerMove);
                    toggle.removeEventListener("pointerup", onPointerUp);
                    row.classList.remove("dragging");
                    document.querySelectorAll(".drag-over").forEach(r => r.classList.remove("drag-over"));
                    document.querySelectorAll(".drag-over-bottom").forEach(r => r.classList.remove("drag-over-bottom"));

                    if (!didMove) {
                        if (collapsed.has(entry.id)) collapsed.delete(entry.id);
                        else collapsed.add(entry.id);
                        save(); render();
                        return;
                    }

                    const target = document.elementFromPoint(e.clientX, e.clientY);
                    const targetRow = target?.closest(".line");
                    const targetRealIndex = targetRow ? parseInt(targetRow.dataset.realIndex) : null;

                    const realIndicesToMove = new Set();
                    realIndicesToMove.add(realIndex);
                    for (let i = realIndex + 1; i < entries.length; i++) {
                        if (isSection(entries[i])) break;
                        realIndicesToMove.add(i);
                    }

                    const toMove = [...realIndicesToMove].sort((a, b) => a - b).map(i => entries[i]);
                    const remaining = entries.filter((_, i) => !realIndicesToMove.has(i));
                    let insertAt = targetRealIndex === null ? remaining.length : remaining.indexOf(entries[targetRealIndex]);
                    if (insertAt === -1) insertAt = remaining.length;
                    remaining.splice(insertAt, 0, ...toMove);
                    entries = remaining;
                    save(); render();
                }

                toggle.addEventListener("pointermove", onPointerMove);
                toggle.addEventListener("pointerup", onPointerUp);
            });

            row.addEventListener("mousedown", (e) => {
                if (e.target === toggle) return;
                clearSelection();
                selectedIndices.add(vi);
                lastSelectedIndex = vi;
                applySelectionClasses();
            });

            row.appendChild(toggle);
            row.appendChild(label);
            app.appendChild(row);
            return;
        }

        // ---- NORMAL LINE ----
        row.className = "line";
        if (selectedIndices.has(vi)) row.classList.add("selected");

        // today highlight
        if (entry.indent === 0 && !isSection(entry)) {
            if (isTodayLine(entry.text)) row.classList.add("today");
        }

        // context day line during filter
        if (activeFilters.size > 0 && entry.indent === 0 && !isSection(entry)) {
            const tags = extractTags(entry.text);
            const directMatch = tags.some(t => activeFilters.has(t));
            if (!directMatch) row.classList.add("filter-context");
        }

        row.addEventListener("mousedown", (e) => {
            if (e.target.closest(".dot")) return;
            if (e.shiftKey && lastSelectedIndex !== null) {
                selectRange(lastSelectedIndex, vi);
            } else if (e.metaKey || e.ctrlKey) {
                if (selectedIndices.has(vi)) selectedIndices.delete(vi);
                else { selectedIndices.add(vi); lastSelectedIndex = vi; }
                applySelectionClasses();
            } else {
                clearSelection();
                selectedIndices.add(vi);
                lastSelectedIndex = vi;
                applySelectionClasses();
            }
        });

        if (entry.indent > 0) {
            const spacer = document.createElement("div");
            spacer.style.cssText = `width:${entry.indent * 20}px;flex-shrink:0`;
            row.appendChild(spacer);
        }

        const dot = document.createElement("div");
        dot.className = "dot";
        const kids = hasChildren(realIndex);
        const isCollapsed = collapsed.has(entry.id);
        dot.textContent = kids ? (isCollapsed ? "▶" : "▼") : "•";
        if (kids) dot.classList.add("has-children");

        dot.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            dot.setPointerCapture(e.pointerId);

            if (e.shiftKey && lastSelectedIndex !== null) {
                selectRange(lastSelectedIndex, vi);
                return;
            }
            if (!selectedIndices.has(vi)) {
                clearSelection();
                selectedIndices.add(vi);
                lastSelectedIndex = vi;
                applySelectionClasses();
            }

            let didMove = false;

            function onPointerMove(e) {
                didMove = true;
                [...app.children].filter(r => !r.classList.contains("phantom-line")).forEach((r, i) => {
                    if (selectedIndices.has(i)) r.classList.add("dragging");
                });
                document.querySelectorAll(".drag-over").forEach(r => r.classList.remove("drag-over"));
                const target = document.elementFromPoint(e.clientX, e.clientY);
                const targetRow = target?.closest(".line:not(.phantom-line)");
                if (targetRow) {
                    const realChildren = [...app.children].filter(r => !r.classList.contains("phantom-line"));
                    const tvi = realChildren.indexOf(targetRow);
                    if (!selectedIndices.has(tvi)) {
                        document.querySelectorAll(".drag-over-bottom").forEach(r => r.classList.remove("drag-over-bottom"));
                        const isLast = tvi === realChildren.length - 1;
                        const rect = targetRow.getBoundingClientRect();
                        const midpoint = rect.top + rect.height / 2;
                        if (isLast && e.clientY > midpoint) {
                            targetRow.classList.add("drag-over-bottom");
                        } else {
                            targetRow.classList.add("drag-over");
                        }
                    }
                }
            }

            function onPointerUp(e) {
                dot.removeEventListener("pointermove", onPointerMove);
                dot.removeEventListener("pointerup", onPointerUp);
                document.querySelectorAll(".line.dragging").forEach(r => r.classList.remove("dragging"));
                document.querySelectorAll(".drag-over").forEach(r => r.classList.remove("drag-over"));
                document.querySelectorAll(".drag-over-bottom").forEach(r => r.classList.remove("drag-over-bottom"));

                if (!didMove) {
                    if (kids) {
                        if (collapsed.has(entry.id)) collapsed.delete(entry.id);
                        else collapsed.add(entry.id);
                        save(); render();
                    }
                    return;
                }

                const target = document.elementFromPoint(e.clientX, e.clientY);
                const targetRow = target?.closest(".line:not(.phantom-line)");

                let targetRealIndex;
                if (!targetRow) {
                    targetRealIndex = null;
                } else {
                    const tvi = [...app.children].filter(r => !r.classList.contains("phantom-line")).indexOf(targetRow);
                    if (selectedIndices.has(tvi)) return;
                    targetRealIndex = parseInt(targetRow.dataset.realIndex);
                }

                const vis = getVisibleEntries();
                const realIndicesToMove = new Set();
                for (const svi of [...selectedIndices].sort((a, b) => a - b)) {
                    const ri = vis[svi]?.realIndex;
                    if (ri == null) continue;
                    realIndicesToMove.add(ri);
                    for (let i = ri + 1; i < entries.length; i++) {
                        if (entries[i].indent > entries[ri].indent) realIndicesToMove.add(i);
                        else break;
                    }
                }

                const toMove = [...realIndicesToMove].sort((a, b) => a - b).map(i => entries[i]);
                const remaining = entries.filter((_, i) => !realIndicesToMove.has(i));

                let insertAt;
                if (targetRealIndex === null) {
                    insertAt = remaining.length;
                } else {
                    const targetEntry = entries[targetRealIndex];
                    insertAt = remaining.indexOf(targetEntry);
                    if (insertAt === -1) insertAt = remaining.length;
                }

                remaining.splice(insertAt, 0, ...toMove);
                entries = remaining;

                const movedIds = new Set(toMove.map(e => e.id));
                const newVis = getVisibleEntries();
                const newSelectedClean = new Set();
                for (let i = 0; i < newVis.length; i++) {
                    if (movedIds.has(newVis[i].entry.id)) newSelectedClean.add(i);
                }
                selectedIndices = newSelectedClean;

                save(); render();
            }

            dot.addEventListener("pointermove", onPointerMove);
            dot.addEventListener("pointerup", onPointerUp);
        });

        const div = document.createElement("div");
        div.className = "entry";
        div.contentEditable = true;
        div.innerText = entry.text;
        if (entry.indent > 0) div.style.color = "#7c7c7c";
        if (entry.indent === 0) div.style.flex = "0 1 auto";

        // calendar click on day lines
        if (entry.indent === 0 && !isSection(entry)) {
            div.addEventListener("click", () => showCalendar(div, realIndex));
        }

        div.addEventListener("input", () => {
            entries[realIndex].text = div.innerText;
            if (entry.indent === 0) {
                const text = div.innerText.trim();
                if (MONTHS.some(m => text.toUpperCase() === m)) showCalendar(div, realIndex);
            }
            if (/^#{1,3}/.test(div.innerText)) {
                save(); render();
                setTimeout(() => {
                    const el = app.children[vi]?.querySelector(".section-label");
                    if (el) { el.focus(); placeCaretAtEnd(el); }
                }, 0);
                return;
            }
            markDirty();
            // debounce stats update — fires 400ms after you stop typing
            clearTimeout(statsDebounce);
            statsDebounce = setTimeout(() => {
                saveLocal();
                if (typeof renderStats === "function") renderStats();
            }, 400);
        });

        div.addEventListener("keydown", (e) => {
            if (e.key === "Backspace" && selectedIndices.size > 1) {
                e.preventDefault();
                const vis = getVisibleEntries();
                const toDelete = new Set([...selectedIndices].map(i => vis[i]?.realIndex).filter(x => x != null));
                entries = entries.filter((_, i) => !toDelete.has(i));
                if (entries.length === 0) entries.push(createEntry(""));
                clearSelection();
                save(); render();
                setTimeout(() => focusEntry(0), 0);
                return;
            }

            if (e.key === "Tab") {
                e.preventDefault();
                if (e.shiftKey) entries[realIndex].indent = Math.max(0, (entries[realIndex].indent || 0) - 1);
                else entries[realIndex].indent = Math.min(10, (entries[realIndex].indent || 0) + 1);
                save(); render();
                setTimeout(() => focusEntry(vi), 0);
                return;
            }

            if (e.key === "Enter") {
                e.preventDefault();
                entries.splice(realIndex + 1, 0, createEntry("", entries[realIndex].indent || 0));
                save(); render();
                setTimeout(() => focusEntry(vi + 1), 0);
                return;
            }

            if (e.key === "Backspace" && div.innerText.trim() === "" && entries.length > 1) {
                e.preventDefault();
                entries.splice(realIndex, 1);
                save(); render();
                setTimeout(() => focusEntry(Math.max(0, vi - 1)), 0);
                return;
            }

            if (e.key === "ArrowUp" && e.shiftKey) {
                e.preventDefault();
                if (lastSelectedIndex === null) lastSelectedIndex = vi;
                const newEnd = Math.max(0, vi - 1);
                selectRange(lastSelectedIndex, newEnd);
                getEntryEl(newEnd)?.focus();
                return;
            }

            if (e.key === "ArrowDown" && e.shiftKey) {
                e.preventDefault();
                if (lastSelectedIndex === null) lastSelectedIndex = vi;
                const newEnd = Math.min(visible.length - 1, vi + 1);
                selectRange(lastSelectedIndex, newEnd);
                getEntryEl(newEnd)?.focus();
                return;
            }

            if (e.key === "ArrowUp") { e.preventDefault(); if (vi > 0) focusEntry(vi - 1); return; }
            if (e.key === "ArrowDown") { e.preventDefault(); if (vi < visible.length - 1) focusEntry(vi + 1); return; }
        });

        row.appendChild(dot);

        if (entry.indent === 0) {
            const wrapper = document.createElement("div");
            wrapper.style.cssText = "display:flex;align-items:center;flex:1;min-width:0;overflow:hidden;";
            wrapper.appendChild(div);
            const count = countDescendants(realIndex);
            const { reps, mins } = getDayStats(realIndex);

            // count child lines starting with -
            let incompleteCount = 0;
            for (let i = realIndex + 1; i < entries.length; i++) {
                if (entries[i].indent === 0) break;
                if (entries[i].text.startsWith("-")) incompleteCount++;
            }

            const badge = document.createElement("span");
            badge.className = "child-count";
            let badgeText = count > 0 ? `— ${String(count).padStart(2, "0")}` : "";
            if (reps > 0 || mins > 0) {
                badgeText += badgeText ? " | " : "| ";
                if (reps > 0) badgeText += `${reps}R `;
                if (mins > 0) badgeText += `${mins}M`;
                badgeText = badgeText.trimEnd();
            }
            badge.textContent = badgeText;

            wrapper.appendChild(badge);
            if (incompleteCount > 0) {
                const circle = document.createElement("span");
                circle.className = "incomplete-circle";
                circle.textContent = incompleteCount;
                wrapper.appendChild(circle);
            }
            
            row.appendChild(wrapper);
        } else {
            row.appendChild(div);
        }

        app.appendChild(row);
    });
        // always render one blank line at the very bottom
        const phantom = document.createElement("div");
        phantom.className = "line phantom-line";
        const phantomDiv = document.createElement("div");
        phantomDiv.className = "entry";
        phantomDiv.contentEditable = true;
        phantomDiv.style.flex = "1";

        phantomDiv.addEventListener("focus", () => {
            // on focus, create a real entry and focus it
            const newEntry = createEntry("", 0);
            entries.push(newEntry);
            save();
            render();
            setTimeout(() => focusEntry(app.children.length - 2), 0);
        });

        phantomDiv.addEventListener("mousedown", (e) => e.stopPropagation());
        phantom.appendChild(phantomDiv);
        app.appendChild(phantom);
}

// ---- Dashboard ----


// ---- Timer system (~Word) ----

function parseTimerEntries() {
    // Returns map of word -> { currentStartMs, longestMins, stopped }
    const TILDE_RE = /~([A-Za-z]+)(~)?/g;
    const timers = {};

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        let match;
        TILDE_RE.lastIndex = 0;
        while ((match = TILDE_RE.exec(entry.text)) !== null) {
            const word = match[1];
            const stopped = !!match[2]; // ~Word~ stops timer

            // find parent day line
            let parentDay = null;
            for (let j = i - 1; j >= 0; j--) {
                if (entries[j].indent === 0 && !isSection(entries[j])) {
                    parentDay = entries[j];
                    break;
                }
            }
            if (!parentDay) continue;

            // parse date from parent day text: YYYY MMM DD DAY
            const dateMatch = parentDay.text.match(/^(\d{4})\s+([A-Z]{3})\s+(\d{2})/);
            if (!dateMatch) continue;
            const year = parseInt(dateMatch[1]);
            const month = MONTHS.indexOf(dateMatch[2]);
            const day = parseInt(dateMatch[3]);
            if (month === -1) continue;

            // check for HHMM on same line
            const timeMatch = entry.text.match(/\b(\d{2})(\d{2})\b/);
            let startMs;
            if (timeMatch) {
                const h = parseInt(timeMatch[1]);
                const m = parseInt(timeMatch[2]);
                if (h <= 23 && m <= 59) {
                    startMs = new Date(year, month, day, h, m).getTime();
                } else {
                    startMs = new Date(year, month, day, 0, 0).getTime();
                }
            } else {
                startMs = new Date(year, month, day, 0, 0).getTime();
            }

            if (!timers[word]) {
                timers[word] = { currentStartMs: null, longestMins: 0, stopped: false };
            }

            const t = timers[word];

            if (stopped) {
                if (t.currentStartMs !== null) {
                    const durMins = Math.floor((startMs - t.currentStartMs) / 60000);
                    if (durMins > t.longestMins) t.longestMins = durMins;
                    t.currentStartMs = null;
                    t.stopped = true;
                }
            } else if (t.currentStartMs !== null) {
                const durMins = Math.floor((startMs - t.currentStartMs) / 60000);
                if (durMins > t.longestMins) t.longestMins = durMins;
                t.currentStartMs = startMs;
                t.stopped = false;
            } else {
                t.currentStartMs = startMs;
                t.stopped = false;
            }
        }
    }
    return timers;
}

function formatDuration(mins) {
    const d = Math.floor(mins / (60 * 24));
    const h = Math.floor((mins % (60 * 24)) / 60);
    const m = mins % 60;
    return `${String(d).padStart(3, "0")}D ${String(h).padStart(2, "0")}H ${String(m).padStart(2, "0")}M`;
}

function initApp() {
    // Load from localStorage as fallback
    const saved = localStorage.getItem("entries");
    if (saved) entries = JSON.parse(saved);
    const savedCollapsed = localStorage.getItem("collapsed");
    if (savedCollapsed) collapsed = new Set(JSON.parse(savedCollapsed));
    if (entries.length === 0) entries.push(createEntry("", 0));

const dashboard = document.getElementById("dashboard");
const toggle = document.getElementById("dashboard-toggle");

let dashOpen = true;

function updateLayout() {
    dashboard.style.maxHeight = dashOpen ? dashboard.scrollHeight + "px" : "6px";
    toggle.style.top = (dashOpen ? dashboard.scrollHeight : 6) + "px";
    toggle.textContent = dashOpen ? "▲" : "▼";
    document.getElementById("app").style.paddingTop = (dashOpen ? dashboard.scrollHeight + 6 : 14) + "px";
}

toggle.addEventListener("click", () => {
    dashOpen = !dashOpen;
    dashboard.classList.toggle("collapsed", !dashOpen);
    updateLayout();
});

setTimeout(updateLayout, 100);
window.addEventListener("resize", updateLayout);

// ---- Stats + Tag Filter ----

function computeStats() {
    const tagTotals = {};
    for (const entry of entries) {
        const tags = extractTags(entry.text);
        if (tags.length === 0) continue;
        const mins = parseTimeBlock(entry.text);
        for (const tag of tags) {
            if (!(tag in tagTotals)) tagTotals[tag] = 0;
            if (mins !== null) tagTotals[tag] += mins;
        }
    }
    return tagTotals;
}

function formatHours(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h}H` : `${h}H ${m}M`;
}

// ---- Tag context menu ----

function hideTagContextMenu() {
    const existing = document.getElementById("tag-context-menu");
    if (existing) existing.remove();
    document.removeEventListener("mousedown", onContextOutsideClick);
}

function onContextOutsideClick(e) {
    const menu = document.getElementById("tag-context-menu");
    if (menu && !menu.contains(e.target)) hideTagContextMenu();
}

function showTagContextMenu(x, y, tag) {
    hideTagContextMenu();

    const menu = document.createElement("div");
    menu.id = "tag-context-menu";

    const renameBtn = document.createElement("div");
    renameBtn.className = "ctx-item";
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        hideTagContextMenu();
        showTagRename(tag);
    });

    const deleteBtn = document.createElement("div");
    deleteBtn.className = "ctx-item ctx-item-danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        hideTagContextMenu();
        // remove only the [TAG] brackets, keep the word
        entries.forEach(entry => {
            entry.text = entry.text.replace(new RegExp(`\\[${tag}\\]`, "g"), tag).replace(/\s+/g, " ").trim();
        });
        activeFilters.delete(tag);
        archivedTags.delete(tag);
        save(); render();
    });

    const archiveBtn = document.createElement("div");
    archiveBtn.className = "ctx-item";
    archiveBtn.textContent = archivedTags.has(tag) ? "Unarchive" : "Archive";
    archiveBtn.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        hideTagContextMenu();
        if (archivedTags.has(tag)) {
            archivedTags.delete(tag);
        } else {
            archivedTags.add(tag);
            activeFilters.delete(tag);
        }
        renderStats();
        updateLayout();
    });

    menu.appendChild(renameBtn);
    menu.appendChild(archiveBtn);
    menu.appendChild(deleteBtn);
    document.body.appendChild(menu);

    // position
    const menuW = 120;
    const left = Math.min(x, window.innerWidth - menuW - 8);
    menu.style.left = left + "px";
    menu.style.top = y + "px";

    setTimeout(() => document.addEventListener("mousedown", onContextOutsideClick), 0);
}

function showTagRename(oldTag) {
    // remove any existing rename popup
    const existing = document.getElementById("tag-rename-popup");
    if (existing) existing.remove();

    const popup = document.createElement("div");
    popup.id = "tag-rename-popup";

    const label = document.createElement("div");
    label.className = "tag-rename-label";
    label.textContent = `Rename [${oldTag}]`;

    const input = document.createElement("input");
    input.className = "tag-rename-input";
    input.value = oldTag;
    input.spellcheck = false;

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;margin-top:6px;";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "dash-btn";
    confirmBtn.textContent = "OK";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "dash-btn";
    cancelBtn.textContent = "Cancel";

    row.appendChild(confirmBtn);
    row.appendChild(cancelBtn);
    popup.appendChild(label);
    popup.appendChild(input);
    popup.appendChild(row);
    document.body.appendChild(popup);

    // center on screen
    popup.style.left = (window.innerWidth / 2 - 100) + "px";
    popup.style.top = (window.innerHeight / 2 - 50) + "px";

    input.focus();
    input.select();

    function commit() {
        const newTag = input.value.trim();
        popup.remove();
        if (newTag && newTag !== oldTag) {
            entries.forEach(entry => {
                entry.text = entry.text.replace(new RegExp(`\\[${oldTag}\\]`, "g"), `[${newTag}]`);
            });
            if (activeFilters.has(oldTag)) {
                activeFilters.delete(oldTag);
                activeFilters.add(newTag);
            }
            save(); render();
        } else {
            renderStats();
        }
    }

    confirmBtn.addEventListener("mousedown", (e) => { e.preventDefault(); commit(); });
    cancelBtn.addEventListener("mousedown", (e) => { e.preventDefault(); popup.remove(); renderStats(); });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { popup.remove(); renderStats(); }
    });
}

function renderStats() {
    const statsEl = document.getElementById("dashboard-stats");
    const tagTotals = computeStats();
    const sortedTags = Object.keys(tagTotals).sort();

    let html = "";

    // Add Week + eye toggle buttons
    const eyeIcon = showArchivedTags ? "👁" : "·";
    const eyeActive = showArchivedTags ? " btn-circle-active" : "";
    html += `<div class="stat-row"><button class="dash-btn btn-circle" id="btn-add-week-inline">+W</button><button class="dash-btn btn-circle${eyeActive}" id="btn-toggle-archived" title="Show archived tags">${eyeIcon}</button></div>`;

    // Timer display (~Word)
    const timers = parseTimerEntries();
    const timerWords = Object.keys(timers).sort();
    if (timerWords.length > 0) {
        html += `<div class="stat-row timer-row">`;
        for (const word of timerWords) {
            const t = timers[word];
            let currentMins = 0;
            let isStopped = t.stopped || t.currentStartMs === null;
            if (!isStopped) {
                currentMins = Math.floor((Date.now() - t.currentStartMs) / 60000);
            } else {
                // use longestMins as the completed duration if stopped with no new run
                currentMins = t.longestMins;
            }
            const current = formatDuration(currentMins);
            let timerHtml = `<span class="timer-item">`;
            if (isStopped) {
                timerHtml += `<span class="timer-current timer-stopped">${word} ${current} ✓</span>`;
            } else {
                timerHtml += `<span class="timer-current">${word} ${current}</span>`;
                if (t.longestMins > 0) {
                    timerHtml += ` <span class="timer-longest">| ${formatDuration(t.longestMins)}</span>`;
                }
            }
            timerHtml += `</span>`;
            html += timerHtml;
        }
        html += `</div>`;
    }

    if (sortedTags.length > 0) {
        const visibleTags = sortedTags.filter(t => showArchivedTags || !archivedTags.has(t));
        const hiddenTags = sortedTags.filter(t => archivedTags.has(t));
        if (visibleTags.length > 0) {
            html += `<div class="stat-row">`;
            for (const tag of visibleTags) {
                const active = activeFilters.has(tag);
                const archived = archivedTags.has(tag);
                html += `<span class="stat-item stat-filter${active ? " stat-filter-active" : ""}${archived ? " stat-filter-archived" : ""}" data-tag="${tag}">`;
                html += `<span class="stat-tag">${tag}</span>${tagTotals[tag] > 0 ? " " + formatHours(tagTotals[tag]) : ""}`;
                html += `</span>`;
            }
            html += `</div>`;
        }
    }

    if (sortedTags.length === 0) html += `<span class="stat-empty">no tracked entries</span>`;
    statsEl.innerHTML = html;

    // Add Week handler
    document.getElementById("btn-add-week-inline").addEventListener("click", () => {
        const today = new Date();
        for (let i = 0; i < 7; i++) {
            const d = new Date(today);
            d.setDate(today.getDate() + i);
            const formatted = formatDate(d);
            const exists = entries.some(e => e.indent === 0 && !isSection(e) && e.text.startsWith(formatted));
            if (!exists) entries.push(createEntry(formatted, 0));
        }
        save(); render();
    });

    document.getElementById("btn-toggle-archived").addEventListener("click", () => {
        showArchivedTags = !showArchivedTags;
        renderStats();
        updateLayout();
    });

    // attach filter click + right-click handlers
    statsEl.querySelectorAll(".stat-filter").forEach(el => {
        el.addEventListener("click", () => {
            const tag = el.dataset.tag;
            if (activeFilters.has(tag)) activeFilters.delete(tag);
            else activeFilters.add(tag);
            render(); renderStats(); updateLayout();
        });

        el.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            showTagContextMenu(e.clientX, e.clientY, el.dataset.tag);
        });
    });

    setTimeout(updateLayout, 0);
}

renderStats();
initDropdownListener();

// tick timer display every minute
setInterval(() => {
    const timers = parseTimerEntries();
    if (Object.keys(timers).length > 0) renderStats();
}, 60000);
initDashboardButtons();
markClean();
}
