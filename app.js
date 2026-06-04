"use strict";

// 医薬品卸倉庫向け棚検索アプリ
// products.csv を固定の商品マスターとして読み込み、JAN/GS1コードとあいまい検索に対応する。

var App = (function () {
  var CSV_PATH = "products.csv";
  var MAX_RESULTS = 50;
  var SCAN_INTERVAL_MS = 280;
  var BARCODE_FORMAT_CANDIDATES = [
    "ean_13",
    "ean_8",
    "code_128",
    "data_matrix",
    "qr_code",
    "pdf417",
    "itf"
  ];

  var products = [];
  var currentStream = null;
  var scanTimer = null;
  var barcodeDetector = null;
  var zxingReader = null;
  var scannerMode = "";
  var scanCanvas = null;
  var scanContext = null;
  var elements = {};

  function init() {
    elements.searchInput = document.getElementById("searchInput");
    elements.clearButton = document.getElementById("clearButton");
    elements.reloadButton = document.getElementById("reloadButton");
    elements.scanButton = document.getElementById("scanButton");
    elements.manualJanButton = document.getElementById("manualJanButton");
    elements.selectCsvButton = document.getElementById("selectCsvButton");
    elements.csvFileInput = document.getElementById("csvFileInput");
    elements.stopScanButton = document.getElementById("stopScanButton");
    elements.cameraPanel = document.getElementById("cameraPanel");
    elements.cameraPreview = document.getElementById("cameraPreview");
    elements.statusText = document.getElementById("statusText");
    elements.deployInfo = document.getElementById("deployInfo");
    elements.productCount = document.getElementById("productCount");
    elements.resultCount = document.getElementById("resultCount");
    elements.results = document.getElementById("results");
    elements.emptyMessage = document.getElementById("emptyMessage");
    elements.logList = document.getElementById("logList");
    elements.template = document.getElementById("resultTemplate");
    elements.cameraPreview.setAttribute("autoplay", "autoplay");
    elements.cameraPreview.setAttribute("playsinline", "playsinline");
    elements.cameraPreview.setAttribute("webkit-playsinline", "webkit-playsinline");
    elements.cameraPreview.muted = true;

    elements.searchInput.addEventListener("input", function () {
      runSearch(elements.searchInput.value);
    });
    elements.clearButton.addEventListener("click", clearSearch);
    elements.reloadButton.addEventListener("click", loadProducts);
    elements.scanButton.addEventListener("click", startScanner);
    elements.stopScanButton.addEventListener("click", stopScanner);
    elements.manualJanButton.addEventListener("click", askManualCode);
    elements.selectCsvButton.addEventListener("click", function () {
      elements.csvFileInput.click();
    });
    elements.csvFileInput.addEventListener("change", handleCsvFileSelect);

    setupPwa();
    showDeployInfo();
    loadProducts();
  }

  function showDeployInfo() {
    var mode = window.SINGLE_FILE_APP ? "単体HTML" : "分割ファイル";
    var embeddedSize = window.EMBEDDED_PRODUCTS_CSV_BASE64 ? window.EMBEDDED_PRODUCTS_CSV_BASE64.length : 0;
    var buildLabel = window.APP_BUILD_LABEL || "local";
    var embeddedRows = window.EMBEDDED_PRODUCTS_ROW_COUNT || "";
    var cameraContext = isCameraAllowedContext() ? "カメラ可" : "カメラ不可";

    if (elements.deployInfo) {
      elements.deployInfo.textContent =
        "配信状態: " + mode +
        " / 埋込CSV: " + embeddedSize +
        (embeddedRows ? " / Rows: " + embeddedRows : "") +
        " / Build: " + buildLabel +
        " / " + cameraContext +
        " / " + location.protocol;
    }

    writeLog(
      "配信状態: mode=" + mode +
      " embeddedCsvBase64Length=" + embeddedSize +
      " embeddedRows=" + embeddedRows +
      " build=" + buildLabel +
      " cameraContext=" + cameraContext +
      " protocol=" + location.protocol +
      " origin=" + location.origin
    );
  }

  function setupPwa() {
    if (window.SINGLE_FILE_APP) {
      unregisterServiceWorkersForSingleFile();
      return;
    }

    if (
      "serviceWorker" in navigator &&
      (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")
    ) {
      navigator.serviceWorker.register("sw.js").catch(function (error) {
        writeLog("PWA登録エラー: " + error.message);
      });
    }
  }

  function unregisterServiceWorkersForSingleFile() {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      registrations.forEach(function (registration) {
        registration.unregister();
      });
      if (registrations.length > 0) {
        writeLog("単体HTMLのため既存PWAキャッシュを解除しました。次回再読込で最新化されます。");
      }
    }).catch(function (error) {
      writeLog("PWAキャッシュ解除エラー: " + error.message);
    });
  }

  function loadProducts() {
    stopScanner();
    setStatus("商品マスターを読み込み中です。");
    writeLog("商品マスター読込開始");

    if (window.EMBEDDED_PRODUCTS_CSV_BASE64) {
      try {
        writeLog("埋込CSV検出: base64 length=" + window.EMBEDDED_PRODUCTS_CSV_BASE64.length);
        applyProductsCsv(
          decodeCsvBuffer(base64ToArrayBuffer(window.EMBEDDED_PRODUCTS_CSV_BASE64)),
          "埋込商品マスター読込成功"
        );
      } catch (error) {
        resetProducts();
        setStatus("埋込商品マスター読込に失敗しました。ログを確認してください。");
        writeLog("埋込商品マスター読込エラー: " + error.message);
      }
      return;
    }

    if (location.protocol === "file:") {
      setStatus("直接開いているため自動読込できません。CSV選択から products.csv を選択してください。");
      writeLog("自動読込スキップ: file://で起動");
      return;
    }

    fetch(CSV_PATH + "?v=" + Date.now(), { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("products.csv を取得できません。HTTP " + response.status);
        }
        return response.arrayBuffer();
      })
      .then(decodeCsvBuffer)
      .then(function (csvText) {
        applyProductsCsv(csvText, "商品マスター読込成功");
      })
      .catch(function (error) {
        resetProducts();
        setStatus("商品マスター読込に失敗しました。ログを確認してください。");
        writeLog("商品マスター読込エラー: " + error.message);
      });
  }

  function handleCsvFileSelect(event) {
    var file = event.target.files[0];
    if (!file) {
      return;
    }

    setStatus("選択したCSVを読み込み中です。");
    writeLog("CSV手動選択: " + file.name);

    file.arrayBuffer()
      .then(decodeCsvBuffer)
      .then(function (csvText) {
        applyProductsCsv(csvText, "CSV手動読込成功");
      })
      .catch(function (error) {
        resetProducts();
        setStatus("選択したCSVを読み込めませんでした。ログを確認してください。");
        writeLog("CSV手動読込エラー: " + error.message);
      });
  }

  function applyProductsCsv(csvText, logLabel) {
    products = buildProducts(parseDelimitedText(csvText));
    elements.productCount.textContent = String(products.length);
    setStatus("商品マスターを読み込みました。");
    writeLog(logLabel + ": " + products.length + "件");
    runSearch(elements.searchInput.value);
  }

  function resetProducts() {
    products = [];
    elements.productCount.textContent = "0";
    elements.resultCount.textContent = "0";
    renderResults([]);
  }

  function decodeCsvBuffer(buffer) {
    var bytes = new Uint8Array(buffer);
    var utf8Text;

    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder("utf-16le", { fatal: false }).decode(buffer);
    }

    utf8Text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    if (utf8Text.indexOf("\uFFFD") === -1) {
      return utf8Text;
    }

    try {
      return new TextDecoder("shift_jis", { fatal: false }).decode(buffer);
    } catch (error) {
      writeLog("Shift-JIS変換エラー: " + error.message);
      return utf8Text;
    }
  }

  function base64ToArrayBuffer(base64Text) {
    var binary = atob(base64Text);
    var bytes = new Uint8Array(binary.length);
    var i;

    for (i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes.buffer;
  }

  function parseDelimitedText(text) {
    var firstLine = String(text || "").split(/\r\n|\n|\r/, 1)[0] || "";
    var delimiter = countText(firstLine, "\t") > countText(firstLine, ",") ? "\t" : ",";
    var rows = [];
    var row = [];
    var value = "";
    var inQuotes = false;
    var i;
    var char;
    var nextChar;

    for (i = 0; i < text.length; i += 1) {
      char = text.charAt(i);
      nextChar = text.charAt(i + 1);

      if (char === "\"") {
        if (inQuotes && nextChar === "\"") {
          value += "\"";
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === delimiter && !inQuotes) {
        row.push(value);
        value = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && nextChar === "\n") {
          i += 1;
        }
        row.push(value);
        if (row.some(function (cell) { return String(cell || "").trim() !== ""; })) {
          rows.push(row);
        }
        row = [];
        value = "";
      } else {
        value += char;
      }
    }

    if (value !== "" || row.length > 0) {
      row.push(value);
      rows.push(row);
    }

    return rows;
  }

  function countText(text, needle) {
    return String(text || "").split(needle).length - 1;
  }

  function buildProducts(rows) {
    var headers;
    var headerMap = {};

    if (rows.length < 2) {
      throw new Error("CSVにデータ行がありません。");
    }

    headers = rows[0].map(function (header) { return String(header || "").trim(); });
    headers.forEach(function (header, index) {
      headerMap[header] = index;
    });

    requireColumns(headerMap, [
      "jan_code",
      "product_code",
      "product_name",
      "product_kana",
      "maker",
      "package",
      "shelf_no",
      "search_words"
    ]);

    return rows.slice(1).map(function (row, index) {
      var product = {
        id: index + 1,
        janCode: getCell(row, headerMap.jan_code),
        productCode: getCell(row, headerMap.product_code),
        productName: getCell(row, headerMap.product_name),
        productKana: getCell(row, headerMap.product_kana),
        maker: getCell(row, headerMap.maker),
        package: getCell(row, headerMap.package),
        shelfNo: getCell(row, headerMap.shelf_no),
        searchWords: getCell(row, headerMap.search_words),
        gs1Code: getOptionalCell(row, headerMap, "gs1_code"),
        gtin14Code: getOptionalCell(row, headerMap, "gtin14")
      };

      product.normalizedJan = normalizeDigits(product.janCode);
      product.gtin14 = toGtin14(product.normalizedJan);
      product.gs1Aliases = buildGs1Aliases(product);
      product.gs1AliasText = product.gs1Aliases.map(compactGs1Text).join(" ");
      product.searchText = normalizeSearchText([
        product.janCode,
        product.gtin14,
        product.gs1Code,
        product.gtin14Code,
        product.productCode,
        product.productName,
        product.productKana,
        product.maker,
        product.package,
        product.shelfNo,
        product.searchWords
      ].join(" "));
      product.compactSearchText = compactSearchText(product.searchText);

      return product;
    }).filter(function (product) {
      return product.productName !== "" || product.janCode !== "" || product.productCode !== "";
    });
  }

  function requireColumns(headerMap, requiredColumns) {
    var missing = requiredColumns.filter(function (column) {
      return typeof headerMap[column] !== "number";
    });

    if (missing.length > 0) {
      throw new Error("CSV列不足: " + missing.join(", "));
    }
  }

  function getCell(row, index) {
    return String(row[index] || "").trim();
  }

  function getOptionalCell(row, headerMap, columnName) {
    if (typeof headerMap[columnName] !== "number") {
      return "";
    }
    return getCell(row, headerMap[columnName]);
  }

  function runSearch(rawQuery) {
    var extractedCode = extractSearchCode(rawQuery);
    var queryForText = extractedCode || rawQuery;
    var query = normalizeSearchText(queryForText);
    var codeQuery = normalizeDigits(extractedCode || rawQuery);
    var gtin14Query = toGtin14(codeQuery);
    var gs1Query = compactGs1Text(rawQuery);
    var results;

    if (query === "" && codeQuery === "") {
      elements.resultCount.textContent = "0";
      renderResults([]);
      elements.emptyMessage.hidden = true;
      setStatus("JAN/GS1コードまたは商品名を入力してください。");
      return;
    }

    results = products.map(function (product) {
      return {
        product: product,
        score: scoreProduct(product, query, codeQuery, gtin14Query, gs1Query)
      };
    }).filter(function (item) {
      return item.score > 0;
    }).sort(function (a, b) {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (hasShelfNo(a.product) !== hasShelfNo(b.product)) {
        return hasShelfNo(b.product) - hasShelfNo(a.product);
      }
      return a.product.shelfNo.localeCompare(b.product.shelfNo, "ja");
    }).slice(0, MAX_RESULTS).map(function (item) {
      return item.product;
    });

    elements.resultCount.textContent = String(results.length);
    renderResults(results);
    elements.emptyMessage.hidden = results.length > 0;
    setStatus(results.length + "件見つかりました。");
    writeLog("検索: " + rawQuery + " / 抽出コード: " + (extractedCode || "-") + " / " + results.length + "件");
  }

  function scoreProduct(product, query, codeQuery, gtin14Query, gs1Query) {
    var score = 0;
    var words;
    var matchedWords;
    var compactQuery = compactSearchText(query);

    if (codeQuery !== "" && product.normalizedJan === codeQuery) {
      return 1200;
    }
    if (gtin14Query !== "" && product.gtin14 === gtin14Query) {
      return 1150;
    }
    if (gtin14Query !== "" && normalizeDigits(product.gtin14Code) === gtin14Query) {
      return 1140;
    }
    if (gs1Query !== "" && product.gs1AliasText.indexOf(gs1Query) !== -1) {
      return 1130;
    }
    if (codeQuery.length === 14 && codeQuery.charAt(0) === "0" && product.normalizedJan === codeQuery.slice(1)) {
      return 1100;
    }
    if (codeQuery !== "" && product.normalizedJan.indexOf(codeQuery) !== -1) {
      score += 500;
    }
    if (normalizeSearchText(product.productCode) === query) {
      score += 420;
    }
    if (normalizeSearchText(product.productName).indexOf(query) !== -1) {
      score += 320;
    }
    if (product.searchText.indexOf(query) !== -1) {
      score += 180;
    }
    if (compactQuery !== "" && product.compactSearchText.indexOf(compactQuery) !== -1) {
      score += 120;
    }
    if (score > 0 && hasShelfNo(product)) {
      score += 60;
    }

    words = query.split(" ").filter(Boolean);
    if (words.length > 1) {
      matchedWords = words.filter(function (word) {
        return product.searchText.indexOf(word) !== -1;
      });
      if (matchedWords.length === words.length) {
        score += 140;
      }
    }

    return score;
  }

  function hasShelfNo(product) {
    return String(product && product.shelfNo || "").trim() !== "";
  }

  function renderResults(items) {
    elements.results.innerHTML = "";

    items.forEach(function (product) {
      var node = elements.template.content.firstElementChild.cloneNode(true);
      node.querySelector(".shelf-no").textContent = product.shelfNo || "未登録";
      node.querySelector(".product-name").textContent = product.productName || "商品名未登録";
      node.querySelector(".product-code").textContent = product.productCode || "-";
      node.querySelector(".jan-code").textContent = product.janCode || "-";
      node.querySelector(".maker").textContent = product.maker || "-";
      node.querySelector(".package").textContent = product.package || "-";
      elements.results.appendChild(node);
    });
  }

  function normalizeSearchText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\u3041-\u3096]/g, function (char) {
        return String.fromCharCode(char.charCodeAt(0) + 0x60);
      })
      .toLowerCase()
      .replace(/[‐‑‒–—―ーｰ]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  }

  function compactSearchText(value) {
    return normalizeSearchText(value).replace(/[\s-]/g, "");
  }

  function normalizeDigits(value) {
    return String(value || "").normalize("NFKC").replace(/\D/g, "");
  }

  function toGtin14(digits) {
    var value = normalizeDigits(digits);
    if (value.length === 14) {
      return value;
    }
    if (value.length === 13) {
      return "0" + value;
    }
    if (value.length === 8) {
      return "000000" + value;
    }
    return "";
  }

  function buildGs1Aliases(product) {
    var aliases = [];
    var jan = normalizeDigits(product.janCode);
    var gtin14 = normalizeDigits(product.gtin14Code) || product.gtin14;
    var extractedFromGs1 = extractSearchCode(product.gs1Code);

    addAlias(aliases, product.gs1Code);
    addAlias(aliases, gtin14);
    addAlias(aliases, extractedFromGs1);
    addAlias(aliases, jan);

    if (gtin14) {
      addAlias(aliases, "(01)" + gtin14);
      addAlias(aliases, "01" + gtin14);
    }

    return aliases;
  }

  function addAlias(aliases, value) {
    var normalized = String(value || "").trim();
    if (normalized !== "" && aliases.indexOf(normalized) === -1) {
      aliases.push(normalized);
    }
  }

  function compactGs1Text(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\u001d/g, "")
      .replace(/[\s()（）\[\]\/\-.]/g, "")
      .toLowerCase();
  }

  function extractSearchCode(rawValue) {
    var raw = String(rawValue || "").normalize("NFKC");
    var digits = normalizeDigits(raw);
    var match;
    var gtinCandidates;

    // 表示形式: (17)290100(10)0406(01)14987171762100 のようにAI(01)が後ろでも抽出する。
    match = raw.match(/\(01\)\s*(\d{14})/);
    if (match) {
      return normalizeGtinForSearch(match[1]);
    }

    // FNC1/GS区切り形式: ]d2010498712829740517... または 010498...
    match = raw.match(/(?:^|[\x1D\]\w])01(\d{14})/);
    if (match) {
      return normalizeGtinForSearch(match[1]);
    }

    // 数字のみのGS1。AI 01 + GTIN14 が途中にあっても抽出する。
    if (digits.length > 14) {
      gtinCandidates = extractGtinCandidatesFromDigits(digits);
      if (gtinCandidates.length > 0) {
        return normalizeGtinForSearch(gtinCandidates[0]);
      }
    }

    if (digits.length === 8 || digits.length === 12 || digits.length === 13 || digits.length === 14) {
      return normalizeGtinForSearch(digits);
    }

    return "";
  }

  function extractGtinCandidatesFromDigits(digits) {
    var value = normalizeDigits(digits);
    var candidates = [];
    var index;
    var gtin;

    for (index = 0; index <= value.length - 16; index += 1) {
      if (value.substr(index, 2) === "01") {
        gtin = value.substr(index + 2, 14);
        if (isValidGtin(gtin)) {
          candidates.push(gtin);
        }
      }
    }

    return candidates;
  }

  function isValidGtin(value) {
    var digits = normalizeDigits(value);
    var sum = 0;
    var index;
    var digit;
    var checkDigit;
    var calculated;

    if (!/^\d{14}$/.test(digits)) {
      return false;
    }

    for (index = 0; index < 13; index += 1) {
      digit = Number(digits.charAt(index));
      sum += digit * (index % 2 === 0 ? 3 : 1);
    }

    checkDigit = Number(digits.charAt(13));
    calculated = (10 - (sum % 10)) % 10;
    return checkDigit === calculated;
  }

  function normalizeGtinForSearch(digits) {
    var value = normalizeDigits(digits);
    if (value.length === 14 && value.charAt(0) === "0") {
      return value.slice(1);
    }
    return value;
  }

  function clearSearch() {
    elements.searchInput.value = "";
    runSearch("");
    elements.searchInput.focus();
  }

  function askManualCode() {
    var code = window.prompt("JANコードまたはGS1コードを入力してください。");
    var extracted;
    if (code === null) {
      return;
    }
    extracted = extractSearchCode(code) || normalizeDigits(code);
    elements.searchInput.value = extracted || code;
    runSearch(code);
  }

  function startScanner() {
    if (!isCameraAllowedContext()) {
      setStatus("\u3053\u306e\u958b\u304d\u65b9\u3067\u306f\u30ab\u30e1\u30e9\u3092\u4f7f\u7528\u3067\u304d\u307e\u305b\u3093\u3002HTTPS\u914d\u4fe1\u3055\u308c\u305fURL\u3067\u958b\u3044\u3066\u304f\u3060\u3055\u3044\u3002");
      writeLog("\u30ab\u30e1\u30e9\u4e0d\u53ef: \u5b89\u5168\u306aHTTPS\u30da\u30fc\u30b8\u3067\u306f\u3042\u308a\u307e\u305b\u3093\u3002protocol=" + location.protocol + " origin=" + location.origin);
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("\u3053\u306e\u30d6\u30e9\u30a6\u30b6\u3067\u306f\u30ab\u30e1\u30e9\u3092\u5229\u7528\u3067\u304d\u307e\u305b\u3093\u3002\u30b3\u30fc\u30c9\u624b\u5165\u529b\u3092\u4f7f\u3063\u3066\u304f\u3060\u3055\u3044\u3002");
      writeLog("\u30ab\u30e1\u30e9\u975e\u5bfe\u5fdc: mediaDevices\u306a\u3057");
      return;
    }

    stopScanner();
    setStatus("\u30ab\u30e1\u30e9\u3092\u8d77\u52d5\u3057\u3066\u3044\u307e\u3059\u3002");
    writeLog("\u30ab\u30e1\u30e9\u8d77\u52d5\u958b\u59cb");

    createScannerReader().then(function () {
      return openCameraStream();
    }).then(function (stream) {
      return attachCameraStream(stream);
    }).then(function () {
      return applyCameraEnhancements();
    }).then(function () {
      setStatus("JANまたはGS1コードを枠内に入れてください。");
      scanTimer = window.setInterval(detectBarcode, SCAN_INTERVAL_MS);
      writeLog("\u30ab\u30e1\u30e9\u8d77\u52d5\u6210\u529f: scanner=" + scannerMode);
    }).catch(function (error) {
      stopScanner();
      setStatus("\u30ab\u30e1\u30e9\u3092\u8d77\u52d5\u3067\u304d\u307e\u305b\u3093\u3002\u6a29\u9650\u3001HTTPS\u914d\u4fe1\u3001ZXing\u8aad\u307f\u8fbc\u307f\u72b6\u614b\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
      writeLog("\u30ab\u30e1\u30e9\u8d77\u52d5\u30a8\u30e9\u30fc: " + error.message);
    });
  }

  function isCameraAllowedContext() {
    if (location.protocol === "https:") {
      return true;
    }
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      return true;
    }
    return false;
  }

  function openCameraStream() {
    var rearCamera = {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      },
      audio: false
    };

    return navigator.mediaDevices.getUserMedia(rearCamera).catch(function (error) {
      writeLog("\u80cc\u9762\u30ab\u30e1\u30e9\u6307\u5b9a\u3067\u8d77\u52d5\u3067\u304d\u307e\u305b\u3093\u3002\u901a\u5e38\u30ab\u30e1\u30e9\u3067\u518d\u8a66\u884c: " + error.message);
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    });
  }

  function attachCameraStream(stream) {
    currentStream = stream;
    elements.cameraPanel.hidden = false;
    elements.cameraPreview.srcObject = stream;
    elements.cameraPreview.load();

    return elements.cameraPreview.play().then(function () {
      return waitForVideoReady();
    });
  }

  function waitForVideoReady() {
    return new Promise(function (resolve) {
      var startedAt = Date.now();

      function checkVideo() {
        if (elements.cameraPreview.videoWidth > 0 && elements.cameraPreview.videoHeight > 0) {
          writeLog(
            "カメラ映像表示: " +
            elements.cameraPreview.videoWidth + "x" + elements.cameraPreview.videoHeight
          );
          resolve();
          return;
        }

        if (Date.now() - startedAt > 3000) {
          writeLog("カメラ映像が黒画面の可能性: videoWidth=0。ブラウザ、添付HTML、HTTPS配信を確認してください。");
          setStatus("カメラ映像が表示されません。別ブラウザ、HTTPS配信、端末のカメラ権限を確認してください。");
          resolve();
          return;
        }

        window.setTimeout(checkVideo, 150);
      }

      checkVideo();
    });
  }

  function createBarcodeDetector() {
    if (BarcodeDetector.getSupportedFormats) {
      return BarcodeDetector.getSupportedFormats().then(function (supportedFormats) {
        var formats = BARCODE_FORMAT_CANDIDATES.filter(function (format) {
          return supportedFormats.indexOf(format) !== -1;
        });
        if (formats.length === 0) {
          throw new Error("対応バーコード形式がありません。");
        }
        writeLog("読取形式: " + formats.join(", "));
        if (formats.indexOf("data_matrix") === -1 && formats.indexOf("code_128") === -1) {
          writeLog("注意: このブラウザは医薬品GS1で使うDataMatrix/Code128に未対応の可能性があります。");
        }
        writeLog("注意: 医薬品包装のGS1 DataBar系はブラウザ標準機能で読めない端末があります。");
        return new BarcodeDetector({ formats: formats });
      });
    }

    return Promise.resolve(new BarcodeDetector({ formats: BARCODE_FORMAT_CANDIDATES }));
  }

  function createScannerReader() {
    barcodeDetector = null;
    zxingReader = null;
    scannerMode = "";

    if (window.ZXing && window.ZXing.BrowserMultiFormatReader) {
      createZxingReader();
      scannerMode = "ZXing RSS_14/RSS_EXPANDED";
      writeLog("ZXing読取を使用: RSS_14, RSS_EXPANDED, EAN_13, EAN_8, CODE_128, DATA_MATRIX, QR_CODE, ITF");
      writeLog("注意: RSS_EXPANDEDはZXing JS版で読取精度にばらつきがあります。Expanded StackedはRSS_EXPANDEDとして試行します。");
      return Promise.resolve();
    }

    if ("BarcodeDetector" in window) {
      return createBarcodeDetector().then(function (detector) {
        barcodeDetector = detector;
        scannerMode = "BarcodeDetector fallback";
      });
    }

    throw new Error("ZXingライブラリを読み込めません。ネット接続またはCDN読込を確認してください。");
  }

  function createZxingReader() {
    var ZX = window.ZXing;
    var formats = [
      ZX.BarcodeFormat.RSS_14,
      ZX.BarcodeFormat.RSS_EXPANDED,
      ZX.BarcodeFormat.EAN_13,
      ZX.BarcodeFormat.EAN_8,
      ZX.BarcodeFormat.CODE_128,
      ZX.BarcodeFormat.DATA_MATRIX,
      ZX.BarcodeFormat.QR_CODE,
      ZX.BarcodeFormat.ITF
    ].filter(function (format) {
      return format !== undefined && format !== null;
    });
    var hints = new Map();

    hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, formats);
    hints.set(ZX.DecodeHintType.TRY_HARDER, true);
    zxingReader = new ZX.BrowserMultiFormatReader(hints, SCAN_INTERVAL_MS);
  }

  function applyCameraEnhancements() {
    var track;
    var capabilities;
    var constraints = { advanced: [] };
    var zoomValue;

    if (!currentStream) {
      return Promise.resolve();
    }

    track = currentStream.getVideoTracks()[0];
    if (!track || !track.getCapabilities || !track.applyConstraints) {
      writeLog("カメラ詳細制御非対応: autofocus/zoomをスキップ");
      return Promise.resolve();
    }

    capabilities = track.getCapabilities();
    if (capabilities.focusMode && capabilities.focusMode.indexOf("continuous") !== -1) {
      constraints.advanced.push({ focusMode: "continuous" });
    }

    if (capabilities.zoom && typeof capabilities.zoom.max === "number") {
      zoomValue = Math.min(capabilities.zoom.max, Math.max(capabilities.zoom.min || 1, 1.6));
      constraints.advanced.push({ zoom: zoomValue });
    }

    if (constraints.advanced.length === 0) {
      writeLog("カメラ詳細制御なし: autofocus/zoom未設定");
      return Promise.resolve();
    }

    return track.applyConstraints(constraints).then(function () {
      writeLog("カメラ補正適用: " + JSON.stringify(constraints.advanced));
    }).catch(function (error) {
      writeLog("カメラ補正を適用できません: " + error.message);
    });
  }

  function detectBarcode() {
    if (!elements.cameraPreview.videoWidth) {
      return;
    }

    if (zxingReader) {
      detectZxingBarcode();
      return;
    }

    if (!barcodeDetector) {
      return;
    }

    barcodeDetector.detect(elements.cameraPreview).then(function (barcodes) {
      var rawValue;
      var extractedCode;
      if (!barcodes || barcodes.length === 0) {
        return;
      }

      rawValue = String(barcodes[0].rawValue || "");
      extractedCode = extractSearchCode(rawValue);
      if (extractedCode === "") {
        elements.searchInput.value = rawValue;
        runSearch(rawValue);
        setStatus("コードを読み取りました。GS1列または検索語で照合しました。");
        writeLog("JAN/GTIN抽出なし。読取値で検索: " + rawValue);
        stopScanner();
        return;
      }

      elements.searchInput.value = extractedCode;
      runSearch(rawValue);
      setStatus("コードを読み取りました: " + extractedCode);
      writeLog("コード読取成功: " + rawValue + " -> " + extractedCode);
      stopScanner();
    }).catch(function (error) {
      writeLog("コード読取エラー: " + error.message);
    });
  }

  function detectZxingBarcode() {
    var attempts;
    var result = null;
    var i;

    if (!zxingReader || !elements.cameraPreview.videoWidth) {
      return;
    }

    ensureScanCanvas();
    attempts = buildScanAttempts();

    for (i = 0; i < attempts.length; i += 1) {
      drawScanAttempt(attempts[i]);
      try {
        result = zxingReader.decodeFromCanvas(scanCanvas);
      } catch (error) {
        if (!isZxingNotFound(error)) {
          writeLog("ZXing読取エラー: " + error.message);
        }
      }

      if (result) {
        handleScannedCode(String(result.getText ? result.getText() : result.text || ""));
        return;
      }
    }
  }

  function ensureScanCanvas() {
    if (!scanCanvas) {
      scanCanvas = document.createElement("canvas");
      scanContext = scanCanvas.getContext("2d", { willReadFrequently: true });
    }
  }

  function buildScanAttempts() {
    var video = elements.cameraPreview;
    var width = video.videoWidth;
    var height = video.videoHeight;
    var cropWidth = Math.floor(width * 0.86);
    var cropHeight = Math.floor(height * 0.42);
    var cropX = Math.floor((width - cropWidth) / 2);
    var cropY = Math.floor((height - cropHeight) / 2);

    return [
      { x: cropX, y: cropY, width: cropWidth, height: cropHeight, rotate: 0 },
      { x: cropX, y: cropY, width: cropWidth, height: cropHeight, rotate: 90 },
      { x: 0, y: 0, width: width, height: height, rotate: 0 },
      { x: 0, y: 0, width: width, height: height, rotate: 90 }
    ];
  }

  function drawScanAttempt(attempt) {
    var rotate = attempt.rotate === 90;

    scanCanvas.width = rotate ? attempt.height : attempt.width;
    scanCanvas.height = rotate ? attempt.width : attempt.height;
    scanContext.save();
    scanContext.clearRect(0, 0, scanCanvas.width, scanCanvas.height);

    if (rotate) {
      scanContext.translate(scanCanvas.width, 0);
      scanContext.rotate(Math.PI / 2);
    }

    scanContext.drawImage(
      elements.cameraPreview,
      attempt.x,
      attempt.y,
      attempt.width,
      attempt.height,
      0,
      0,
      attempt.width,
      attempt.height
    );
    scanContext.restore();
  }

  function isZxingNotFound(error) {
    return (
      error &&
      (
        error.name === "NotFoundException" ||
        error.name === "ChecksumException" ||
        error.name === "FormatException" ||
        /not.?found|checksum|format/i.test(String(error.message || ""))
      )
    );
  }

  function handleScannedCode(rawValue) {
    var extractedCode = extractSearchCode(rawValue);

    if (extractedCode === "") {
      elements.searchInput.value = rawValue;
      runSearch(rawValue);
      setStatus("コードを読み取りました。GS1列または検索語で照合しました。");
      writeLog("JAN/GTIN抽出なし。読取値で検索: " + rawValue);
      stopScanner();
      return;
    }

    elements.searchInput.value = extractedCode;
    runSearch(rawValue);
    setStatus("コードを読み取りました: " + extractedCode);
    writeLog("コード読取成功: " + rawValue + " -> " + extractedCode);
    stopScanner();
  }

  function stopScanner() {
    if (scanTimer) {
      window.clearInterval(scanTimer);
      scanTimer = null;
    }

    if (zxingReader && zxingReader.reset) {
      zxingReader.reset();
    }
    zxingReader = null;
    barcodeDetector = null;
    scannerMode = "";

    if (currentStream) {
      currentStream.getTracks().forEach(function (track) {
        track.stop();
      });
      currentStream = null;
    }

    if (elements.cameraPreview) {
      elements.cameraPreview.srcObject = null;
    }

    if (elements.cameraPanel) {
      elements.cameraPanel.hidden = true;
    }
  }

  function setStatus(message) {
    elements.statusText.textContent = message;
  }

  function writeLog(message) {
    var item = document.createElement("li");
    var now = new Date();
    item.textContent = formatTime(now) + " " + message;
    elements.logList.prepend(item);

    while (elements.logList.children.length > 80) {
      elements.logList.removeChild(elements.logList.lastElementChild);
    }

    if (window.console && console.info) {
      console.info("[棚検索] " + message);
    }
  }

  function formatTime(date) {
    return [
      pad2(date.getHours()),
      pad2(date.getMinutes()),
      pad2(date.getSeconds())
    ].join(":");
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  return {
    init: init
  };
}());

document.addEventListener("DOMContentLoaded", App.init);
