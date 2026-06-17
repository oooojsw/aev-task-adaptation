const LIMIT_DEFAULT = Number("__MONITOR_LIMIT__");
    const INTERVAL_DEFAULT = Number("__MONITOR_INTERVAL_SECONDS__");
    const summaryEl = document.getElementById("summary");
    const rowsEl = document.getElementById("rows");
    const factsEl = document.getElementById("facts");
    const detailBodyEl = document.getElementById("detail-body");
    const detailTitleEl = document.getElementById("detail-title");
    const detailSubEl = document.getElementById("detail-sub");
    const detailStatusEl = document.getElementById("detail-status");
    const lastUpdatedEl = document.getElementById("last-updated");
    const intervalEl = document.getElementById("interval");
    const limitEl = document.getElementById("limit");
    const refreshBtn = document.getElementById("refresh");
    const filtersEl = document.getElementById("filters");
    const wallMetaEl = document.getElementById("wall-meta");
    const splitRoot = document.getElementById("split-root");
    const splitter = document.getElementById("splitter");

    const state = {
      rows: [],
      selectedId: null,
      filter: "pipeline",
      timer: null,
      refreshing: false,
      pendingRefresh: false,
      leftWidth: 44,
    };

    function esc(input) {
      return String(input ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function shortText(input, max = 120) {
      const text = String(input ?? "").replace(/\s+/g, " ").trim();
      if (!text) return "";
      return text.length > max ? text.slice(0, max - 3) + "..." : text;
    }

    function shortId(input) {
      const text = String(input ?? "");
      if (!text) return "";
      return text.length > 18 ? text.slice(0, 8) + "..." + text.slice(-6) : text;
    }

    function timeText(timestamp) {
      return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
    }

    function statusClass(status) {
      return "status-" + status;
    }

    function rowTrack(row) {
      const kind = row.monitorKind || (row.task ? "pipeline" : "ad_hoc");
      return kind === "pipeline" ? "PIPELINE" : "AD HOC";
    }

    function phaseLabel(row) {
      return [row.task?.kind, row.task?.phase].filter(Boolean).join(" / ") || row.step || "idle";
    }

    function getDisplayRows(rows) {
      const visible = state.filter === "all"
        ? [...rows]
        : rows.filter((row) => (row.monitorKind || (row.task ? "pipeline" : "ad_hoc")) === "pipeline");
      return visible.sort((a, b) => b.updated - a.updated);
    }

    function getRowsForLimit() {
      return getDisplayRows(state.rows).slice(0, Math.max(1, Number(limitEl.value || LIMIT_DEFAULT)));
    }

    function renderFilters() {
      const items = [
        ["pipeline", "Pipeline only"],
        ["all", "All sessions"],
      ];
      filtersEl.innerHTML = items.map(([value, label]) =>
        '<button class="chip ' + (state.filter === value ? "active" : "") + '" data-filter="' + esc(value) + '">' + esc(label) + '</button>'
      ).join("");
      filtersEl.querySelectorAll("[data-filter]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.filter = btn.getAttribute("data-filter") || "pipeline";
          renderFilters();
          renderAll();
        });
      });
    }

    function renderSummary(rows) {
      const counts = {
        total: rows.length,
        active: rows.filter((row) => row.status === "running" || row.status === "retry").length,
        running: rows.filter((row) => row.status === "running").length,
        retry: rows.filter((row) => row.status === "retry").length,
        done: rows.filter((row) => row.status === "done").length,
        error: rows.filter((row) => row.status === "error").length,
        archived: rows.filter((row) => row.status === "archived").length,
      };
      summaryEl.innerHTML = [
        ["Active", counts.active],
        ["Total", counts.total],
        ["Running", counts.running],
        ["Retry", counts.retry],
        ["Done", counts.done],
        ["Error", counts.error],
        ["Archived", counts.archived],
      ].map(([label, value]) => (
        '<div class="stat"><div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + value + '</div></div>'
      )).join("");
    }

    function tileDetail(row) {
      return shortText(
        row.statusReason ||
        row.nextStepReason ||
        row.whyStarted ||
        row.detail ||
        row.lastUser ||
        "No short detail yet.",
        120,
      );
    }

    function renderRows(rows) {
      const displayRows = getRowsForLimit();
      wallMetaEl.textContent = displayRows.length + " shown / " + getDisplayRows(state.rows).length + " visible / " + state.rows.length + " total";
      if (!displayRows.length) {
        rowsEl.innerHTML = '<div class="empty">No sessions match the current filter.</div>';
        return;
      }
      rowsEl.innerHTML = displayRows.map((row) => {
        const kind = rowTrack(row);
        const selected = row.id === state.selectedId ? " selected" : "";
        const title = esc(row.title || row.id);
        const detail = esc(tileDetail(row));
        return (
          '<button class="tile ' + statusClass(row.status) + selected + '" data-id="' + esc(row.id) + '">' +
            '<div class="tile-top">' +
              '<span class="badge ' + statusClass(row.status) + '">' + esc(row.status) + '</span>' +
              '<span class="badge kind-' + esc((row.monitorKind || (row.task ? "pipeline" : "ad_hoc")).replace(/[^a-z_]/g, "")) + '">' + esc(kind) + '</span>' +
            '</div>' +
            '<div class="tile-title">' + title + '</div>' +
            '<div class="tile-detail">' + detail + '</div>' +
            '<div class="tile-footer">' +
              '<span>' + esc(phaseLabel(row)) + '</span>' +
              '<span>' + esc(timeText(row.updated)) + '</span>' +
            '</div>' +
            '<div class="tile-footer">' +
              '<span class="mono">' + esc(shortId(row.id)) + '</span>' +
              '<span class="mono">' + esc(shortText(row.directory, 40)) + '</span>' +
            '</div>' +
          '</button>'
        );
      }).join("");

      rowsEl.querySelectorAll("[data-id]").forEach((tile) => {
        tile.addEventListener("click", () => {
          state.selectedId = tile.getAttribute("data-id");
          renderDetail();
          renderRows(state.rows);
        });
      });
    }

    function renderFacts(row) {
      const facts = [
        ["Status", row.status],
        ["Step", row.step || "idle"],
        ["Type", rowTrack(row)],
        ["Phase", row.task?.phase || row.task?.kind || "n/a"],
        ["Case", row.task?.caseID || "n/a"],
        ["Attempt", row.task?.attempt ?? "n/a"],
        ["Round", row.task?.maintenanceRound ?? "n/a"],
        ["Method", row.task?.methodID || "n/a"],
      ];
      factsEl.innerHTML = facts.map(([label, value]) => (
        '<div class="fact"><div class="fact-label">' + esc(label) + '</div><div class="fact-value">' + esc(value) + '</div></div>'
      )).join("");
    }

    function renderSection(title, body) {
      return (
        '<section class="section">' +
          '<div class="section-title">' + esc(title) + '</div>' +
          '<div class="section-body">' + body + '</div>' +
        '</section>'
      );
    }

    function renderActionList(actions) {
      if (!actions?.length) return '<div class="empty">No recent actions recorded.</div>';
      return '<div class="actions">' + actions.map((action) => (
        '<div class="action">' +
          '<div class="action-label">' + esc(action.label) + '</div>' +
          (action.detail ? '<div class="action-detail">' + esc(action.detail) + '</div>' : '') +
        '</div>'
      )).join("") + '</div>';
    }

    function renderDetail() {
      const row = state.rows.find((item) => item.id === state.selectedId) || getRowsForLimit()[0];
      if (!row) {
        detailTitleEl.textContent = "Select a session";
        detailSubEl.textContent = "Choose a tile on the left to inspect why this session exists and what it did last.";
        detailStatusEl.className = "status-pill idle";
        detailStatusEl.innerHTML = '<span class="dot idle"></span><span>idle</span>';
        factsEl.innerHTML = "";
        detailBodyEl.innerHTML = '<div class="empty">No session selected yet.</div>';
        return;
      }

      state.selectedId = row.id;
      detailTitleEl.textContent = row.title;
      detailSubEl.textContent = row.titleSource ? ("Title source: " + row.titleSource + " / updated " + timeText(row.updated)) : timeText(row.updated);
      detailStatusEl.className = "status-pill " + row.status;
      detailStatusEl.innerHTML = '<span class="dot ' + row.status + '"></span><span>' + esc(row.status) + '</span>';
      renderFacts(row);

      const parts = [];
      parts.push(renderSection("Why this session exists", esc(row.whyStarted || "No start narrative recorded.")));
      parts.push(renderSection("Status reason", esc(row.statusReason || row.detail || "No status narrative recorded.")));
      parts.push(renderSection(
        "Next stage",
        row.nextStepTitle
          ? esc(row.nextStepTitle) + (row.nextStepReason ? '<div style="margin-top:8px;color:var(--muted);line-height:1.6;">' + esc(row.nextStepReason) + '</div>' : "")
          : esc(row.nextStepReason || "No explicit next-stage transition recorded.")
      ));
      parts.push(renderSection(
        "Decision trail",
        row.reasonTrail?.length
          ? '<div style="display:grid;gap:8px;">' + row.reasonTrail.map((line) => '<div class="action"><div class="action-detail" style="margin:0;color:var(--text);">' + esc(line) + '</div></div>').join("") + '</div>'
          : '<div class="empty">No retry, decision, or follow-up explanation was recorded for this session.</div>'
      ));
      parts.push(renderSection("Recent actions", renderActionList(row.recentActions)));
      parts.push(renderSection(
        "Context",
        '<div class="context-grid">' + [
          ["Session ID", row.id],
          ["Parent ID", row.parentID || "n/a"],
          ["Directory", row.directory],
          ["Last user", row.lastUser || "n/a"],
        ].map(([label, value]) => (
          '<div class="context-item"><div class="context-label">' + esc(label) + '</div><div class="context-value mono">' + esc(value) + '</div></div>'
        )).join("") + '</div>'
      ));
      detailBodyEl.innerHTML = parts.join("");
    }

    function renderAll() {
      renderSummary(state.rows);
      renderRows(state.rows);
      renderDetail();
    }

    async function load() {
      if (state.refreshing) {
        state.pendingRefresh = true;
        return;
      }
      state.refreshing = true;
      try {
        const requestLimit = Math.max(240, Math.max(1, Number(limitEl.value || LIMIT_DEFAULT)) * 12);
        const response = await fetch("/api/sessions?limit=" + requestLimit, { cache: "no-store" });
        if (!response.ok) throw new Error(await response.text());
        const payload = await response.json();
        const previousSelected = state.selectedId;
        state.rows = payload.rows || [];
        if (!state.selectedId || !state.rows.some((row) => row.id === state.selectedId)) {
          state.selectedId = state.rows[0]?.id || null;
        }
        renderAll();
        state.selectedId = state.selectedId || previousSelected || null;
        lastUpdatedEl.textContent = "Last updated: " + new Date(payload.generatedAt).toLocaleString("zh-CN", { hour12: false });
      } catch (err) {
        lastUpdatedEl.textContent = "Refresh failed: " + (err?.message || err);
      } finally {
        state.refreshing = false;
        if (state.pendingRefresh) {
          state.pendingRefresh = false;
          load().catch(() => {});
        }
      }
    }

    function restartTimer() {
      if (state.timer) clearInterval(state.timer);
      const seconds = Math.max(1, Number(intervalEl.value || INTERVAL_DEFAULT));
      state.timer = setInterval(() => {
        load().catch(() => {});
      }, seconds * 1000);
    }

    intervalEl.addEventListener("change", restartTimer);
    limitEl.addEventListener("change", () => load().catch(() => {}));
    refreshBtn.addEventListener("click", () => load().catch(() => {}));

    let dragStartX = 0;
    let dragStartLeft = 0;
    splitter.addEventListener("pointerdown", (event) => {
      dragStartX = event.clientX;
      dragStartLeft = state.leftWidth;
      splitter.setPointerCapture(event.pointerId);
    });
    splitter.addEventListener("pointermove", (event) => {
      if (!splitter.hasPointerCapture(event.pointerId)) return;
      const width = splitRoot.getBoundingClientRect().width;
      const delta = ((event.clientX - dragStartX) / width) * 100;
      state.leftWidth = Math.min(60, Math.max(30, dragStartLeft + delta));
      splitRoot.style.setProperty("--left-width", state.leftWidth + "%");
    });
    splitter.addEventListener("pointerup", (event) => {
      if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
    });
    splitter.addEventListener("pointercancel", (event) => {
      if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
    });

    renderFilters();
    load().catch(() => {});
    restartTimer();
  
