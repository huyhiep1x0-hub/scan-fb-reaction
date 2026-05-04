(async () => {
  const CONFIG = {
    scanAllTab: false, // false = only per-reaction tabs; true = include "Tat ca"
    delayMs: 750,
    maxLoopsPerTab: 500,
    stableRoundsToStop: 12,
    filePrefix: "facebook-reactions",
    askFileNameAtStart: true,
    downloadCsv: true
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const sanitizeFileName = (name) =>
    String(name || "")
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .slice(0, 180);

  const ensureExtension = (name, extension) => {
    const cleanExtension = extension.startsWith(".") ? extension : `.${extension}`;
    return name.toLowerCase().endsWith(cleanExtension.toLowerCase()) ? name : `${name}${cleanExtension}`;
  };

  const stripJsonOrCsvExtension = (name) => String(name || "").replace(/\.(json|csv)$/i, "");

  const csvEscape = (value) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const toCsv = (rows) => {
    const headers = ["reaction", "name", "profile_url", "dedupe_key", "is_virtual_profile"];
    return [
      headers.join(","),
      ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))
    ].join("\r\n");
  };

  const downloadTextFile = (content, fileName, type) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const requestedBaseName = CONFIG.askFileNameAtStart
    ? prompt("Nhap ten file ket qua muon tai ve:", `${CONFIG.filePrefix}-${ts}`)
    : "";
  const outputBaseName =
    sanitizeFileName(stripJsonOrCsvExtension(requestedBaseName)) || `${CONFIG.filePrefix}-${ts}`;

  const normalizeCount = (input) => {
    const s = String(input || "").trim();
    const m = s.match(/([\d.,]+)\s*([KkNn]?)/);
    if (!m) return null;

    const raw = m[1];
    const suffix = m[2];

    if (/[KkNn]/.test(suffix)) {
      return Math.round(parseFloat(raw.replace(",", ".")) * 1000);
    }

    // Vietnamese thousands format: 2.650 or 2,650
    if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) {
      return Number(raw.replace(/[.,]/g, ""));
    }

    return Math.round(parseFloat(raw.replace(",", ".")));
  };

  const cleanUrl = (href) => {
    const url = new URL(href, location.href);
    for (const key of [...url.searchParams.keys()]) {
      if (key !== "id") url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  };

  const dedupeKey = (href) => {
    const url = new URL(href, location.href);
    const id = url.searchParams.get("id");
    if (id) return id;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "profile.php") return cleanUrl(href);

    return parts[0] || cleanUrl(href);
  };

  const isVirtualProfileUrl = (href) => {
    const url = new URL(href, location.href);
    return url.pathname === "/profile.php" && /^\d+$/.test(url.searchParams.get("id") || "");
  };

  const getReactionDialog = () =>
    [...document.querySelectorAll('[role="dialog"]')].find((dialog) =>
      [...dialog.querySelectorAll('[role="tab"]')].some((tab) =>
        /bày tỏ cảm xúc/i.test(tab.getAttribute("aria-label") || "")
      )
    );

  const getScroller = (dialog) => {
    const candidates = [...dialog.querySelectorAll("*")]
      .filter((el) => {
        const style = getComputedStyle(el);
        return /(auto|scroll)/.test(style.overflowY) && el.clientHeight > 100;
      })
      .sort((a, b) => {
        const da = a.scrollHeight - a.clientHeight;
        const db = b.scrollHeight - b.clientHeight;
        return db - da;
      });

    return candidates[0] || dialog;
  };

  const parseTabs = (dialog) => {
    const tabs = [...dialog.querySelectorAll('[role="tab"]')].map((el) => {
      const label = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();

      const reaction =
        label
          .replace(/^Hiển thị\s+[\d.,]+\s+người\s+đã\s+bày\s+tỏ\s+cảm\s+xúc\s*/i, "")
          .trim() || text;

      const fromLabel = normalizeCount(label.match(/Hiển thị\s+([\d.,]+)/i)?.[1]);
      const fromText = normalizeCount(text);

      return {
        el,
        reaction,
        label,
        text,
        expected: fromLabel && fromLabel > 0 ? fromLabel : fromText
      };
    });

    // Facebook can report the Like tab as aria-label "0" while the visible text is "2,5K".
    // If only one per-reaction tab is approximate/missing, infer it from the "Tat ca" total.
    const all = tabs.find((tab) => tab.reaction === "Tất cả" && tab.expected);
    const reactionTabs = tabs.filter((tab) => tab.reaction !== "Tất cả");

    if (all) {
      const exactSum = reactionTabs
        .filter((tab) => tab.expected && !/[KkNn]/.test(tab.text))
        .reduce((sum, tab) => sum + tab.expected, 0);

      const fuzzy = reactionTabs.filter((tab) => !tab.expected || /[KkNn]/.test(tab.text));
      if (fuzzy.length === 1) {
        fuzzy[0].expected = all.expected - exactSum;
      }
    }

    return tabs.filter((tab) => CONFIG.scanAllTab || tab.reaction !== "Tất cả");
  };

  const extractRows = (dialog, reaction) => {
    const rows = [];
    const seen = new Set();

    for (const link of [...dialog.querySelectorAll('a[href*="facebook.com/"]')]) {
      let name = (link.innerText || "").replace(/\s+/g, " ").trim();
      const aria = (link.getAttribute("aria-label") || "").trim();

      if (!name && /^Ảnh đại diện của\s+/i.test(aria)) {
        name = aria
          .replace(/^Ảnh đại diện của\s+/i, "")
          .replace(/,\s*xem tin$/i, "")
          .trim();
      }

      if (!name || /^Ảnh đại diện của/i.test(name)) continue;
      if (/^(Facebook|Tất cả|Thích|Yêu thích|Thương thương|Haha|Wow|Buồn|Phẫn nộ|Xem thêm)$/i.test(name)) {
        continue;
      }

      const profileUrl = cleanUrl(link.href);
      if (/\/photo\.php|\/groups\//i.test(profileUrl)) continue;

      const key = dedupeKey(profileUrl);
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        reaction,
        name,
        profile_url: profileUrl,
        dedupe_key: key,
        is_virtual_profile: isVirtualProfileUrl(profileUrl)
      });
    }

    return rows;
  };

  async function scanTab(tab, index, total) {
    console.log(`[${index}/${total}] Scanning ${tab.reaction}. Expected: ${tab.expected}`);

    tab.el.click();
    await sleep(1200);

    let dialog = getReactionDialog();
    let scroller = getScroller(dialog);
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(CONFIG.delayMs);

    const rowMap = new Map();
    let stable = 0;
    let lastCount = -1;
    let lastHeight = -1;
    let lastHundredLogged = 0;

    for (let i = 0; i < CONFIG.maxLoopsPerTab; i++) {
      dialog = getReactionDialog();

      for (const row of extractRows(dialog, tab.reaction)) {
        rowMap.set(row.dedupe_key, row);
      }

      scroller = getScroller(dialog);
      const rect = scroller.getBoundingClientRect();

      scroller.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: 1100,
          clientX: rect.left + 20,
          clientY: rect.top + Math.min(scroller.clientHeight - 10, 350)
        })
      );

      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));

      await sleep(CONFIG.delayMs);

      const count = rowMap.size;
      const height = scroller.scrollHeight;
      const hundredMark = Math.floor(count / 100) * 100;

      if (i % 10 === 0 || count >= tab.expected) {
        console.log(`${tab.reaction}: ${count}/${tab.expected || "?"}, scrollHeight=${height}`);
      }

      if (hundredMark >= 100 && hundredMark > lastHundredLogged) {
        lastHundredLogged = hundredMark;
        console.log(
          `[PROGRESS] ${tab.reaction}: da quet ${count}/${tab.expected || "?"} dong, ` +
            `nick ao=${[...rowMap.values()].filter((row) => row.is_virtual_profile).length}, ` +
            `scrollHeight=${height}`
        );
      }

      stable = count === lastCount && height === lastHeight ? stable + 1 : 0;
      lastCount = count;
      lastHeight = height;

      if (tab.expected && count >= tab.expected) break;
      if (stable >= CONFIG.stableRoundsToStop) break;
    }

    dialog = getReactionDialog();
    for (const row of extractRows(dialog, tab.reaction)) {
      rowMap.set(row.dedupe_key, row);
    }

    return {
      stats: {
        reaction: tab.reaction,
        expected: tab.expected || null,
        count: rowMap.size,
        addedRows: rowMap.size,
        scrollHeight: getScroller(dialog).scrollHeight,
        virtualProfileCount: [...rowMap.values()].filter((row) => row.is_virtual_profile).length
      },
      rows: [...rowMap.values()]
    };
  }

  const dialog = getReactionDialog();
  if (!dialog) {
    throw new Error("Khong thay modal reaction. Hay mo danh sach reaction truoc roi chay lai script.");
  }

  const tabs = parseTabs(dialog);
  const stats = [];
  const rows = [];

  for (let i = 0; i < tabs.length; i++) {
    const result = await scanTab(tabs[i], i + 1, tabs.length);
    stats.push(result.stats);
    rows.push(...result.rows);
  }

  const output = { stats, rows };
  output.virtual_profiles = rows.filter((row) => row.is_virtual_profile);
  output.virtual_profile_count = output.virtual_profiles.length;
  window.__fbReactionScanResult = output;

  const json = JSON.stringify(output, null, 2);
  const csv = toCsv(rows);
  console.log("DONE", output);

  try {
    await navigator.clipboard.writeText(json);
    console.log("Da copy JSON vao clipboard.");
  } catch {
    console.log("Clipboard bi chan. Co the dung: copy(JSON.stringify(window.__fbReactionScanResult, null, 2))");
  }

  const shouldDownload = confirm(
    `Quet xong ${rows.length} dong.\n` +
      stats.map((stat) => `${stat.reaction}: ${stat.count}/${stat.expected ?? "?"}`).join("\n") +
      `\nNick ao dang profile.php?id=: ${output.virtual_profile_count}` +
      "\n\nTai file JSON ve may?"
  );

  if (shouldDownload) {
    downloadTextFile(json, ensureExtension(outputBaseName, ".json"), "application/json;charset=utf-8");
    if (CONFIG.downloadCsv) {
      await sleep(300);
      downloadTextFile(csv, ensureExtension(outputBaseName, ".csv"), "text/csv;charset=utf-8");
    }
  }
})();
