/**
 * Popup Script v1.0.0
 * Handles: scan 4 data areas, preview results, trigger batch download.
 * Uses chrome.scripting API to inject content.js.
 * Communicates with background.js for downloads.
 */

'use strict';

// --- Authorization State ---
var isAuthorizedSession = false;
var SECRET_KEY = "1688_PIC_DOWNLOADER_SUPER_SECRET_2026_!@#"; 

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyLicense(machineId, actCodeBase64) {
  try {
    const raw = atob(actCodeBase64);
    const parts = raw.split('|');
    if (parts.length !== 2) return false;
    const expireTs = parseInt(parts[0], 10);
    const signature = parts[1];
    if (Date.now() > expireTs) return false;
    const payload = machineId + expireTs + SECRET_KEY;
    const expectedSig = await sha256(payload);
    if (expectedSig === signature) return { valid: true, expireTs: expireTs };
    return false;
  } catch(e) {
    return false;
  }
}

function formatDate(ts) {
  if (ts > 2000000000000) return "永久授权";
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,'0') + "-" + String(d.getDate()).padStart(2,'0');
}

// --- DOM Elements ---
var btnScan = document.getElementById('btn-scan');
var btnDownload = document.getElementById('btn-download');
var btnOpenFolder = document.getElementById('btn-open-folder');
var actionsSecondary = document.getElementById('actions-secondary');

var statusArea = document.getElementById('status-area');
var statusText = document.getElementById('status-text');
var resultsArea = document.getElementById('results-area');
var progressArea = document.getElementById('progress-area');
var progressBarFill = document.getElementById('progress-bar-fill');
var progressText = document.getElementById('progress-text');

// Badges
var badgeTitle = document.getElementById('badge-title');
var badgeGallery = document.getElementById('badge-gallery');
var badgeSku = document.getElementById('badge-sku');
var badgeDetail = document.getElementById('badge-detail');

// SKU Actions & Panel
var btnToggleSkuView = document.getElementById('btn-toggle-sku-view');
var btnCopySkuJson = document.getElementById('btn-copy-sku-json');
var btnExportSkuCsv = document.getElementById('btn-export-sku-csv');
var skuDataPanel = document.getElementById('sku-data-panel');
var skuTabContentTable = document.getElementById('sku-tab-content-table');
var skuTabContentJson = document.getElementById('sku-tab-content-json');
var skuJsonCode = document.getElementById('sku-json-code');

// Preview areas
var titlePreview = document.getElementById('title-preview');
var galleryThumbs = document.getElementById('gallery-thumbs');
var skuThumbs = document.getElementById('sku-thumbs');
var detailThumbs = document.getElementById('detail-thumbs');

/// Mode Select DOM
var selectPreviewMode = document.getElementById('select-preview-mode');
var selectWorkMode = document.getElementById('select-work-mode');

// Detect if running inside popup window mode (via URL param)
var urlParams = new URLSearchParams(window.location.search);
var isPopupWindowMode = urlParams.get('mode') === 'popup';
var targetTabId = urlParams.get('tabId') ? parseInt(urlParams.get('tabId'), 10) : null;
if (isPopupWindowMode) {
  document.body.classList.add('popup-window-mode');
  
  if (!sessionStorage.getItem('resized') && window.screen) {
    sessionStorage.setItem('resized', 'true');
    var targetW = Math.round((window.screen.availWidth / 3) * 1.1); // increased width by 10%
    var targetH = Math.round(window.screen.availHeight / 2);
    targetW = Math.max(targetW, 500); // Sanity check
    targetH = Math.max(targetH, 500);
    var targetX = Math.max(0, window.screen.availWidth - targetW - 40); // Top-right with 40px margin
    var targetY = 40;
    
    // Compute slider value for exactly 5 items per row
    var assumedInnerW = targetW - 45; // Safely account for Windows borders (~16px) and vertical scrollbar (~17px) + extra buffer
    var containerW = assumedInnerW - 24; // #result-container padding: 12px on both sides
    var totalGap = 4 * 12; // 5 items have 4 gaps of 12px
    // Add a safety margin to prevent wrapping
    var idealSize = Math.floor((containerW - totalGap) / 5);
    sessionStorage.setItem('ideal_card_size', String(idealSize));
    
    chrome.windows.getCurrent(function(win) {
      if (win) {
        chrome.windows.update(win.id, {
          width: targetW,
          height: targetH,
          left: targetX,
          top: targetY
        });
      }
    });
  }
}

// Init preview mode from localStorage (default: 'box')
var currentPreviewMode = localStorage.getItem('preview_mode') || 'box';
if (selectPreviewMode) {
  selectPreviewMode.value = currentPreviewMode;
  selectPreviewMode.addEventListener('change', function () {
    currentPreviewMode = selectPreviewMode.value;
    localStorage.setItem('preview_mode', currentPreviewMode);
  });
}

function updatePreviewModeVisibility() {
  if (selectPreviewMode) {
    selectPreviewMode.style.display = (currentWorkMode === 'all') ? '' : 'none';
  }
}

// Determine effective work mode
// In popup window: always force 'popup' (renders like filter but unchecked)
// Otherwise: read from localStorage
var currentWorkMode = isPopupWindowMode ? 'popup' : (localStorage.getItem('work_mode') || 'all');
if (selectWorkMode) {
  selectWorkMode.value = isPopupWindowMode ? 'popup' : currentWorkMode;
  selectWorkMode.addEventListener('change', function () {
    var val = selectWorkMode.value;

    if (val === 'popup' && !isPopupWindowMode) {
      // Open a new resizable browser window, passing along the target tab
      findTargetTab().then(function (tab) {
        var tid = (tab && tab.id) ? tab.id : '';
        var popupUrl = chrome.runtime.getURL('popup.html?mode=popup&tabId=' + tid);
        chrome.windows.create({
          url: popupUrl,
          type: 'popup',
          width: 900,
          height: 700,
          focused: true
        });
      });
      // Reset dropdown to previous value
      selectWorkMode.value = currentWorkMode;
      return;
    }

    currentWorkMode = val;
    if (!isPopupWindowMode) {
      localStorage.setItem('work_mode', val);
    }
    updatePreviewModeVisibility();
    renderAllThumbnails();
  });
  updatePreviewModeVisibility();
}

// --- Image Size Slider ---
var sizeSliderBar = document.getElementById('size-slider-bar');
var sizeSlider = document.getElementById('size-slider');
var sizeSliderValue = document.getElementById('size-slider-value');

// Default card size: popup window gets dynamically calculated ideal size for 5 columns
var storedIdeal = sessionStorage.getItem('ideal_card_size');
var defaultCardSize = (isPopupWindowMode && storedIdeal) ? parseInt(storedIdeal, 10) : (isPopupWindowMode ? 200 : 120);

// We force the ideal size on first load in this window session to ensure 5 items per row
var savedSize = localStorage.getItem('card_size');
var currentCardSize = (isPopupWindowMode && !sessionStorage.getItem('size_initialized')) 
                        ? defaultCardSize 
                        : parseInt(savedSize || String(defaultCardSize), 10);
sessionStorage.setItem('size_initialized', 'true');

function applyCardSize(size) {
  currentCardSize = size;
  localStorage.setItem('card_size', String(size));
  if (sizeSlider) sizeSlider.value = size;
  if (sizeSliderValue) sizeSliderValue.textContent = size + 'px';

  // Set CSS custom properties on #results-area so all grids inherit
  var resultsEl = document.getElementById('results-area');
  if (resultsEl) {
    resultsEl.style.setProperty('--card-min-width', size + 'px');
    resultsEl.style.setProperty('--card-img-height', size + 'px');
  }
}

function updateSliderVisibility() {
  if (sizeSliderBar) {
    if (isFilterLikeMode()) {
      sizeSliderBar.classList.remove('hidden');
    } else {
      sizeSliderBar.classList.add('hidden');
    }
  }
}

if (sizeSlider) {
  sizeSlider.value = currentCardSize;
  sizeSlider.addEventListener('input', function () {
    applyCardSize(parseInt(sizeSlider.value, 10));
  });
}
applyCardSize(currentCardSize);

// --- Large Grid size adjustment ---
var LARGE_GRID_BASE = 240;
var largeGridSizeKey = 'skuLargeGridCardSize';

function applyLargeGridSize(size) {
  if (typeof size !== 'number' || isNaN(size)) size = LARGE_GRID_BASE;
  localStorage.setItem(largeGridSizeKey, size);
  var container = document.getElementById('sku-large-grid-content');
  if (!container) return;
  var ratio = size / LARGE_GRID_BASE;           // column width ratio (unlimited)
  var textRatio = Math.min(ratio, 1.5);          // text size capped at 1.5x
  container.style.setProperty('--large-grid-min-col', size + 'px');
  container.style.setProperty('--large-grid-img-h', Math.round(LARGE_GRID_BASE * ratio) + 'px');
  container.style.setProperty('--large-grid-gap', Math.round(20 * ratio) + 'px');
  container.style.setProperty('--large-grid-pad', Math.round(20 * ratio) + 'px');
  container.style.setProperty('--large-grid-font-title', Math.round(16 * textRatio) + 'px');
  container.style.setProperty('--large-grid-font-specs', Math.round(13 * textRatio) + 'px');
  container.style.setProperty('--large-grid-font-price', Math.round(18 * textRatio) + 'px');
  container.style.setProperty('--large-grid-font-stock', Math.round(14 * textRatio) + 'px');
  var valSpan = document.getElementById('sku-large-grid-size-value');
  if (valSpan) valSpan.textContent = size + 'px';
  var slider = document.getElementById('sku-large-grid-size-slider');
  if (slider) slider.value = size;
}

// --- State ---
var scanData = null;

// Selected items pool for Filter / Popup mode
var selectedPool = {
  gallery: new Set(),
  sku: new Set(),
  detail: new Set(),
  skuRows: new Set()
};

function getSelectedTotalCount() {
  var skuImageSet = new Set();
  if (scanData && scanData.skuData && scanData.skuData.skuMatrix) {
    selectedPool.skuRows.forEach(function(index) {
      var item = scanData.skuData.skuMatrix[index];
      if (item && item.skuImageUrl) {
        skuImageSet.add(item.skuImageUrl);
      }
    });
  }
  return selectedPool.gallery.size + skuImageSet.size + selectedPool.detail.size;
}

function isFilterLikeMode() {
  return currentWorkMode === 'filter' || currentWorkMode === 'popup';
}

function updateDownloadButtonState() {
  if (!scanData) return;
  var totalScan = (scanData.gallery ? scanData.gallery.length : 0) +
                  (scanData.sku ? scanData.sku.length : 0) +
                  (scanData.detail ? scanData.detail.length : 0);

  if (isFilterLikeMode()) {
    var count = getSelectedTotalCount();
    if (count > 0) {
      btnDownload.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> \u4e0b\u8f7d\u5df2\u9009\u56fe\u7247 (' + count + ')';
      btnDownload.disabled = false;
      btnDownload.classList.remove('hidden');
    } else {
      btnDownload.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> \u8bf7\u5148\u52fe\u9009\u56fe\u7247 (0)';
      btnDownload.disabled = true;
      btnDownload.classList.remove('hidden');
    }
  } else {
    btnDownload.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> \u5168\u90e8\u4e0b\u8f7d (' + totalScan + ')';
    btnDownload.disabled = (totalScan === 0 && !scanData.title);
    btnDownload.classList.remove('hidden');
  }
}

// --- Helpers ---

function setStatus(className, text) {
  statusArea.className = className;
  statusText.textContent = text;
}

// --- Lightbox Navigation State ---
function formatSpecs(text) {
  if (!text) return '-';
  var safeText = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return safeText.replace(/&/g, '<span class="spec-amp">&amp;</span>');
}

var currentLightboxList = [];
var currentLightboxIndex = 0;

function showLightboxAt(index) {
  if (!currentLightboxList || currentLightboxList.length === 0) return;
  if (index < 0) {
    index = currentLightboxList.length - 1;
  } else if (index >= currentLightboxList.length) {
    index = 0;
  }
  currentLightboxIndex = index;

  var item = currentLightboxList[currentLightboxIndex];
  var modal = document.getElementById('lightbox-modal');
  var img = document.getElementById('lightbox-img');
  var titleEl = document.getElementById('lightbox-title');
  var counterEl = document.getElementById('lightbox-counter');

  if (modal && img) {
    img.src = item.url || '';
    if (titleEl) {
      if (item._skuDetails) {
        var d = item._skuDetails;
        var sColor = d.stock < 10 ? '#f87171' : (d.stock < 50 ? '#fde047' : '#a5b4fc');
        var price = d.price ? '￥' + d.price : '-';
        var stock = d.stock !== undefined ? d.stock : '-';
        titleEl.innerHTML = '<div style="display:flex; flex-direction:column; gap:6px; line-height:1.2;">' +
          '<div style="font-weight:700; font-size:15px; color:#e2e8f0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + (item.name || item.url || '') + '</div>' +
          '<div style="font-size:13px; color:#94a3b8; display:flex; gap:12px; flex-wrap:wrap;">' +
            '<span><strong style="color:#f472b6;">规格：</strong>' + formatSpecs(d.specs) + '</span>' +
            '<span><strong style="color:#38bdf8;">价格：</strong>' + price + '</span>' +
            '<span><strong style="color:#f472b6;">库存：</strong><span style="color:' + sColor + '; font-weight:bold;">' + stock + '</span></span>' +
            '<span><strong style="color:#94a3b8;">SKU ID：</strong>' + (d.skuId || '-') + '</span>' +
          '</div></div>';
      } else {
        titleEl.innerHTML = '';
        titleEl.textContent = item.name || item.url || '';
      }
    }
    if (counterEl) {
      counterEl.textContent = (currentLightboxIndex + 1) + ' / ' + currentLightboxList.length;
    }
    
    // Reset zoom scale and pan when changing images
    if (typeof lightboxScale !== 'undefined') {
      lightboxScale = 1;
      lightboxTranslateX = 0;
      lightboxTranslateY = 0;
      img.style.transform = 'none';
      if (typeof updateLightboxZoomUI === 'function') updateLightboxZoomUI(true);
    }
    
    // Update Selection Styling
    if (isFilterLikeMode() && item._groupName && typeof item._originalIndex === 'number') {
      img.setAttribute('data-group', item._groupName);
      if (selectedPool[item._groupName] && selectedPool[item._groupName].has(item._originalIndex)) {
        img.classList.add('is-selected');
      } else {
        img.classList.remove('is-selected');
      }
      img.title = '点击图片切换选中状态';
    } else {
      img.removeAttribute('data-group');
      img.classList.remove('is-selected');
      img.title = '';
    }
    
    modal.classList.remove('hidden');
  }
}

/**
 * Trigger Lightbox preview based on configured mode ('screen' vs 'box')
 */
function openLightbox(list, index) {
  if (typeof list === 'string') {
    list = [{ url: list, name: arguments[1] || '' }];
    index = 0;
  }
  currentLightboxList = list || [];
  currentLightboxIndex = index || 0;

  // If large grid modal is visible, boost lightbox z-index above it
  var largeGridModal = document.getElementById('sku-large-grid-modal');
  if (largeGridModal && !largeGridModal.classList.contains('hidden')) {
    var lightbox = document.getElementById('lightbox-modal');
    if (lightbox) {
      lightbox.style.zIndex = '9999';
      lightbox.setAttribute('data-zboost', '1');
    }
  }

  var currentItem = currentLightboxList[currentLightboxIndex] || { url: '', name: '' };

  if (currentPreviewMode === 'box') {
    // Mode 1: Box Preview (In-Popup Center Lightbox)
    showLightboxAt(currentLightboxIndex);
  } else {
    // Mode 2: Screen Preview (Full Screen Monitor Web Page Lightbox)
    findTargetTab().then(function (tab) {
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'previewImageFull',
          url: currentItem.url,
          title: currentItem.name
        });
      }
    });
  }
}

function prevLightbox() {
  if (currentLightboxList && currentLightboxList.length > 0) {
    showLightboxAt(currentLightboxIndex - 1);
  }
}

function nextLightbox() {
  if (currentLightboxList && currentLightboxList.length > 0) {
    showLightboxAt(currentLightboxIndex + 1);
  }
}

function closeLightbox() {
  var modal = document.getElementById('lightbox-modal');
  var img = document.getElementById('lightbox-img');
  var titleEl = document.getElementById('lightbox-title');
  var counterEl = document.getElementById('lightbox-counter');

  if (modal) {
    modal.classList.add('hidden');
    if (img) img.src = '';
    if (titleEl) titleEl.textContent = '';
    if (counterEl) counterEl.textContent = '';
    // Restore z-index if boosted for large grid overlay
    if (modal.hasAttribute('data-zboost')) {
      modal.style.zIndex = '1000';
      modal.removeAttribute('data-zboost');
    }
  }
}

document.addEventListener('DOMContentLoaded', function () {
  var overlay = document.getElementById('lightbox-overlay');
  var btnClose = document.getElementById('btn-lightbox-close');
  var btnPrev = document.getElementById('btn-lightbox-prev');
  var btnNext = document.getElementById('btn-lightbox-next');

  if (overlay) overlay.addEventListener('click', closeLightbox);
  if (btnClose) btnClose.addEventListener('click', closeLightbox);
  if (btnPrev) btnPrev.addEventListener('click', prevLightbox);
  if (btnNext) btnNext.addEventListener('click', nextLightbox);

  // Group batch actions
  var batchActions = document.querySelectorAll('.group-batch-actions');
  batchActions.forEach(function (actionWrap) {
    var btnAll = actionWrap.querySelector('.btn-group-select-all');
    var btnClear = actionWrap.querySelector('.btn-group-clear-all');

    if (btnAll) {
      btnAll.addEventListener('click', function (e) {
        e.stopPropagation();
        var target = btnAll.getAttribute('data-target');
        if (scanData && scanData[target]) {
          for (var i = 0; i < scanData[target].length; i++) {
            selectedPool[target].add(i);
          }
          renderAllThumbnails();
        }
      });
    }

    if (btnClear) {
      btnClear.addEventListener('click', function (e) {
        e.stopPropagation();
        var target = btnClear.getAttribute('data-target');
        if (selectedPool[target]) {
          selectedPool[target].clear();
          renderAllThumbnails();
        }
      });
    }
  });

  // SKU Table batch actions
  var btnSkuSelectSafe = document.getElementById('btn-sku-select-safe');
  var btnSkuClear = document.getElementById('btn-sku-clear');
  
  if (btnSkuSelectSafe) {
    btnSkuSelectSafe.addEventListener('click', function(e) {
      e.stopPropagation();
      if (scanData && scanData.skuData && scanData.skuData.skuMatrix) {
        selectedPool.skuRows.clear();
        scanData.skuData.skuMatrix.forEach(function(item, idx) {
          if (item.stock >= 50) {
            selectedPool.skuRows.add(idx);
          }
        });
        updateDownloadButtonState();
        if (typeof renderSkuDataPanel === 'function') {
          renderSkuDataPanel(scanData.skuData);
        }
      }
    });
  }

  if (btnSkuClear) {
    btnSkuClear.addEventListener('click', function(e) {
      e.stopPropagation();
      selectedPool.skuRows.clear();
      updateDownloadButtonState();
      if (typeof renderSkuDataPanel === 'function') {
        renderSkuDataPanel(scanData.skuData);
      }
    });
  }
});

document.addEventListener('keydown', function (e) {
  var modal = document.getElementById('lightbox-modal');
  if (!modal || modal.classList.contains('hidden')) return;

  if (e.key === 'Escape') {
    closeLightbox();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    prevLightbox();
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    nextLightbox();
  }
});

/**
 * Create a standard small thumbnail element.
 */
function createThumb(url, label, list, index) {
  var div = document.createElement('div');
  div.className = 'thumb';
  div.title = (label || url) + ' (\u70b9\u51fb\u9884\u89c6\u5927\u56fe)';
  div.style.cursor = 'pointer';

  var img = document.createElement('img');
  img.src = url;
  img.alt = label || 'image';
  img.addEventListener('error', function () {
    img.style.display = 'none';
  });

  div.appendChild(img);

  if (label) {
    var labelEl = document.createElement('span');
    labelEl.className = 'thumb-label';
    labelEl.textContent = label;
    div.appendChild(labelEl);
  }

  div.addEventListener('click', function () {
    openLightbox(list, index);
  });

  return div;
}

/**
 * Create a large Filter Card with Checkbox for Filter Mode.
 */
function createFilterCard(url, label, groupName, index, list) {
  var card = document.createElement('div');
  card.className = 'filter-card';

  var isSel = selectedPool[groupName] && selectedPool[groupName].has(index);
  if (isSel) {
    card.classList.add('is-selected');
  }

  var imgWrap = document.createElement('div');
  imgWrap.className = 'filter-card-img-wrap';

  var img = document.createElement('img');
  img.src = url;
  img.alt = label || 'image';

  var badge = document.createElement('div');
  badge.className = 'filter-card-badge';
  badge.textContent = '\u2713'; // ✓

  imgWrap.appendChild(img);
  imgWrap.appendChild(badge);

  var footer = document.createElement('div');
  footer.className = 'filter-card-footer';

  var chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.className = 'filter-card-checkbox';
  chk.checked = isSel;

  var nameSpan = document.createElement('span');
  nameSpan.className = 'filter-card-name';
  nameSpan.textContent = label || ('img_' + (index + 1));
  nameSpan.title = label || url;

  var previewBtn = document.createElement('button');
  previewBtn.className = 'filter-card-preview-btn';
  previewBtn.title = '全屏预览';
  previewBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
  previewBtn.addEventListener('click', function(e) {
    e.stopPropagation(); // prevent triggering toggleSelect
    openLightbox(list, index);
  });

  footer.appendChild(chk);
  footer.appendChild(nameSpan);
  footer.appendChild(previewBtn);

  card.appendChild(imgWrap);
  card.appendChild(footer);

  function toggleSelect() {
    var set = selectedPool[groupName];
    if (set.has(index)) {
      set.delete(index);
      card.classList.remove('is-selected');
      chk.checked = false;
    } else {
      set.add(index);
      card.classList.add('is-selected');
      chk.checked = true;
    }
    updateDownloadButtonState();
  }

  chk.addEventListener('change', function (e) {
    e.stopPropagation();
    var set = selectedPool[groupName];
    if (chk.checked) {
      set.add(index);
      card.classList.add('is-selected');
    } else {
      set.delete(index);
      card.classList.remove('is-selected');
    }
    updateDownloadButtonState();
  });

  imgWrap.addEventListener('click', function (e) {
    toggleSelect();
  });

  return card;
}

/**
 * Populate a thumbnail container depending on active work mode.
 */
function populateThumbs(container, items, groupName) {
  container.replaceChildren();
  if (!items) return;

  var batchActions = container.parentElement ? container.parentElement.querySelector('.group-batch-actions') : null;

  if (isFilterLikeMode()) {
    container.classList.add('filter-mode-grid');
    if (batchActions) batchActions.classList.remove('hidden');

    for (var i = 0; i < items.length; i++) {
      items[i]._groupName = groupName;
      items[i]._originalIndex = i;
      container.appendChild(createFilterCard(items[i].url, items[i].name, groupName, i, items));
    }
  } else {
    container.classList.remove('filter-mode-grid');
    if (batchActions) batchActions.classList.add('hidden');

    for (var j = 0; j < items.length; j++) {
      container.appendChild(createThumb(items[j].url, items[j].name, items, j));
    }
  }
}

function renderAllThumbnails() {
  if (!scanData) return;
  updateSliderVisibility();
  applyCardSize(currentCardSize);
  populateThumbs(galleryThumbs, scanData.gallery, 'gallery');
  populateThumbs(detailThumbs, scanData.detail, 'detail');
  
  var skuBatchActions = document.getElementById('sku-table-batch-actions');
  if (skuBatchActions) {
    if (isFilterLikeMode()) {
      skuBatchActions.classList.remove('hidden');
    } else {
      skuBatchActions.classList.add('hidden');
    }
  }

  // Update SKU Table UI if visible
  var table = document.querySelector('.sku-table');
  if (table) {
    var rowChks = table.querySelectorAll('.sku-table-check-row');
    var availableCount = 0;
    var checkedCount = 0;
    rowChks.forEach(function(chk) {
      if (!chk.disabled) {
        availableCount++;
        var idx = parseInt(chk.getAttribute('data-index'), 10);
        var tr = chk.closest('tr');
        var gridCard = document.querySelector('.sku-grid-card[data-index="' + idx + '"]');
        var largeGridCard = document.querySelector('.sku-large-grid-card[data-index="' + idx + '"]');
        if (selectedPool.skuRows.has(idx)) {
          chk.checked = true;
          if (tr) tr.classList.add('sku-row-selected');
          if (gridCard) gridCard.classList.add('sku-row-selected');
          if (largeGridCard) largeGridCard.classList.add('sku-row-selected');
          checkedCount++;
        } else {
          chk.checked = false;
          if (tr) tr.classList.remove('sku-row-selected');
          if (gridCard) gridCard.classList.remove('sku-row-selected');
          if (largeGridCard) largeGridCard.classList.remove('sku-row-selected');
        }
      }
    });
    var allChk = document.getElementById('sku-table-check-all');
    if (allChk) {
      allChk.checked = (availableCount > 0 && checkedCount === availableCount);
    }
  }

  updateDownloadButtonState();
}

/**
 * Helper to create a title/URL line with a Copy button.
 */
function createCopyableRow(labelText, fullText, isUrl) {
  var row = document.createElement('div');
  row.className = 'title-line-row';

  var label = document.createElement('span');
  label.className = 'title-line-label';
  label.textContent = labelText;

  var val = document.createElement('span');
  val.className = 'title-line-val';
  val.textContent = isUrl && fullText.length > 50 ? fullText.substring(0, 50) + '...' : fullText;
  val.title = fullText;

  var ICON_COPY = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  var ICON_CHECK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

  var btnCopy = document.createElement('button');
  btnCopy.type = 'button';
  btnCopy.className = 'btn-copy';
  btnCopy.title = '\u70b9\u5f80\u590d\u5636';
  btnCopy.innerHTML = ICON_COPY;

  btnCopy.addEventListener('click', function (e) {
    e.stopPropagation();
    navigator.clipboard.writeText(fullText).then(function () {
      btnCopy.innerHTML = ICON_CHECK;
      btnCopy.classList.add('copied');
      btnCopy.title = '\u5df2\u590d\u5636!';
      setTimeout(function () {
        btnCopy.innerHTML = ICON_COPY;
        btnCopy.classList.remove('copied');
        btnCopy.title = '\u70b9\u5f80\u590d\u5636';
      }, 1500);
    });
  });

  row.appendChild(label);
  row.appendChild(val);
  row.appendChild(btnCopy);
  return row;
}

/**
 * Convert structured SKU data into CSV string format (with UTF-8 BOM)
 */
function convertSkuDataToCsv(skuData) {
  if (!skuData || !skuData.skuMatrix || !Array.isArray(skuData.skuMatrix)) {
    return '';
  }

  var csv = '\uFEFF';
  
  var dimNames = [];
  if (skuData.skuProps && skuData.skuProps.length > 0) {
    skuData.skuProps.forEach(function(prop) {
      dimNames.push((prop.prop || prop.name || prop.attributeName || '维度').replace(/"/g, '""'));
    });
  }

  var baseHeaders = '"图片名称","图片链接","商品ID","商品标题","SKU_ID"';
  var endHeaders = '"规格编码","单价","库存","货号"\n';
  
  if (dimNames.length > 0) {
    var dimHeaders = dimNames.map(function(n) { return '"' + n + '"'; }).join(',');
    csv += baseHeaders + ',' + dimHeaders + ',' + endHeaders;
  } else {
    csv += baseHeaders + ',"规格组合",' + endHeaders;
  }

  var title = (skuData.title || '').replace(/"/g, '""');
  var offerId = (skuData.offerId || '').replace(/"/g, '""');

  skuData.skuMatrix.forEach(function (item) {
    var skuId = (item.skuId || '').replace(/"/g, '""');
    var specAttrs = (item.specAttributes || '').replace(/"/g, '""');
    var specId = (item.specId || '').replace(/"/g, '""');
    var price = (item.price || '').replace(/"/g, '""');
    var stock = item.stock !== undefined ? item.stock : 0;
    var cargoNumber = (item.cargoNumber || '').replace(/"/g, '""');
    var skuImageName = (item.skuImageName || '').replace(/"/g, '""');
    var skuImageUrl = (item.skuImageUrl || '').replace(/"/g, '""');

    var baseVals = '"' + skuImageName + '","' + skuImageUrl + '","' + offerId + '","' + title + '","' + skuId + '"';
    var endVals = ',"' + specId + '","' + price + '","' + stock + '","' + cargoNumber + '"\n';
    
    if (dimNames.length > 0) {
      var specs = specAttrs.split('&');
      var dimVals = dimNames.map(function(n, idx) {
        var v = (specs[idx] || '').replace(/"/g, '""');
        return '"' + v + '"';
      }).join(',');
      csv += baseVals + ',' + dimVals + endVals;
    } else {
      csv += baseVals + ',"' + specAttrs + '"' + endVals;
    }
  });

  return csv;
}

function triggerDownloadCsv(content, filename) {
  var blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

if (btnCopySkuJson) {
  btnCopySkuJson.addEventListener('click', function () {
    if (scanData && scanData.skuData) {
      var jsonStr = JSON.stringify(scanData.skuData, null, 2);
      navigator.clipboard.writeText(jsonStr).then(function () {
        var originalText = btnCopySkuJson.textContent;
        btnCopySkuJson.textContent = '已复制!';
        setTimeout(function () {
          btnCopySkuJson.textContent = originalText;
        }, 1500);
      });
    }
  });
}

if (btnExportSkuCsv) {
  btnExportSkuCsv.addEventListener('click', function () {
    if (scanData && scanData.skuData) {
      var csvContent = convertSkuDataToCsv(scanData.skuData);
      var safeName = sanitizeFolder(scanData.title || '1688_product');
      triggerDownloadCsv(csvContent, safeName + '_SKU矩阵数据.csv');
    }
  });
}

if (btnToggleSkuView) {
  btnToggleSkuView.addEventListener('click', function () {
    if (skuDataPanel) {
      var isHidden = skuDataPanel.classList.contains('hidden');
      if (isHidden) {
        skuDataPanel.classList.remove('hidden');
        btnToggleSkuView.textContent = '收起数据';
      } else {
        skuDataPanel.classList.add('hidden');
        btnToggleSkuView.textContent = '查看数据';
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', function () {
  var tabBtns = document.querySelectorAll('.sku-tab-btn');
  tabBtns.forEach(function (tabBtn) {
    tabBtn.addEventListener('click', function () {
      tabBtns.forEach(function (b) { b.classList.remove('active'); });
      tabBtn.classList.add('active');

      var targetTab = tabBtn.getAttribute('data-tab');
      var skuTabContentTable = document.getElementById('sku-tab-content-table');
      var skuTabContentList = document.getElementById('sku-tab-content-list');
      var skuTabContentJson = document.getElementById('sku-tab-content-json');
      
      if (skuTabContentTable) skuTabContentTable.classList.add('hidden');
      if (skuTabContentList) skuTabContentList.classList.add('hidden');
      if (skuTabContentJson) skuTabContentJson.classList.add('hidden');
      
      if (targetTab === 'table' && skuTabContentTable) skuTabContentTable.classList.remove('hidden');
      if (targetTab === 'list' && skuTabContentList) skuTabContentList.classList.remove('hidden');
      if (targetTab === 'json' && skuTabContentJson) skuTabContentJson.classList.remove('hidden');
      if (targetTab === 'large') {
        if (window._openSkuLargeGrid) window._openSkuLargeGrid();
        tabBtn.classList.remove('active');
        (document.querySelector('.sku-tab-btn[data-tab="list"]') || tabBtns[0]).classList.add('active');
      }
    });
  });
});

/**
 * Render SKU Table View and JSON Code View inside popup panel
 */
function renderSkuDataPanel(skuData) {
  if (!skuData) return;

  // 1. Render Table
  if (skuTabContentTable) {
    skuTabContentTable.replaceChildren();
    if (skuData.skuMatrix && skuData.skuMatrix.length > 0) {
      var table = document.createElement('table');
      table.className = 'sku-table';

      var thead = document.createElement('thead');
      var theadTr = document.createElement('tr');
      theadTr.innerHTML = '<th style="width:30px;"><input type="checkbox" id="sku-table-check-all" title="全选当前所有"></th><th style="width:50px;">图片</th><th>图片名称</th>';
      
      var dimNames = [];
      if (skuData.skuProps && skuData.skuProps.length > 0) {
        skuData.skuProps.forEach(function(prop) {
          var name = prop.prop || prop.name || prop.attributeName || '维度';
          dimNames.push(name);
          var th = document.createElement('th');
          th.textContent = name;
          theadTr.appendChild(th);
        });
      } else {
        var th = document.createElement('th');
        th.textContent = '规格组合';
        theadTr.appendChild(th);
      }
      
      theadTr.innerHTML += '<th>单价</th><th>库存</th><th>货号</th><th>SKU ID</th>';
      thead.appendChild(theadTr);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      var availableRowsCount = 0;
      
      skuData.skuMatrix.forEach(function (item, index) {
        var tr = document.createElement('tr');
        var isOutOfStock = item.stock < 10;
        
        if (!isOutOfStock) {
          availableRowsCount++;
          tr.style.cursor = 'pointer';
        }

        // Checkbox TD
        var checkTd = document.createElement('td');
        var chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.className = 'sku-table-check-row';
        chk.setAttribute('data-index', index);
        if (isOutOfStock) {
          chk.disabled = true;
          selectedPool.skuRows.delete(index); // Ensure it's not selected
        } else {
          var isSel = selectedPool.skuRows.has(index);
          chk.checked = isSel;
          if (isSel) tr.classList.add('sku-row-selected');
        }
        chk.onchange = function(e) {
          if (chk.checked) {
            selectedPool.skuRows.add(index);
            tr.classList.add('sku-row-selected');
          } else {
            selectedPool.skuRows.delete(index);
            tr.classList.remove('sku-row-selected');
          }
          updateDownloadButtonState();
          
          var allChk = document.getElementById('sku-table-check-all');
          if (allChk) {
            allChk.checked = (availableRowsCount > 0 && selectedPool.skuRows.size === availableRowsCount);
          }
          
          var gridCard = document.querySelector('.sku-grid-card[data-index="' + index + '"]');
          if (gridCard) {
            if (chk.checked) gridCard.classList.add('sku-row-selected');
            else gridCard.classList.remove('sku-row-selected');
          }
        };
        checkTd.appendChild(chk);
        tr.appendChild(checkTd);

        // Row click to toggle checkbox (ignore if clicking the checkbox itself or the image)
        tr.addEventListener('click', function(e) {
          if (!isOutOfStock && e.target.tagName !== 'INPUT' && e.target.tagName !== 'IMG') {
            chk.click();
          }
        });

        var imgTd = document.createElement('td');
        if (item.skuImageUrl) {
          var img = document.createElement('img');
          img.src = item.skuImageUrl;
          img.style.cssText = 'width:40px; height:40px; object-fit:cover; border-radius:4px; display:block; margin:auto; cursor:pointer;';
          img.title = '点击预览大图（支持切换和勾选）';
          img.onclick = function(e) {
            e.stopPropagation();
            if (typeof openLightbox === 'function') {
              var validItems = [];
              var actualStartIdx = 0;
              skuData.skuMatrix.forEach(function(rItem, rIdx) {
                if (rItem.skuImageUrl) { // Map all valid sku images
                  if (rIdx === index) {
                    actualStartIdx = validItems.length;
                  }
                  validItems.push({
                    url: rItem.skuImageUrl,
                    name: rItem.skuImageName || ('SKU_' + rItem.skuId),
                    _groupName: rItem.stock < 10 ? null : 'skuRows', // if out of stock, do not allow selection
                    _originalIndex: rIdx,
                    _skuDetails: {
                      price: rItem.price,
                      stock: rItem.stock,
                      specs: rItem.specAttributes,
                      skuId: rItem.skuId
                    }
                  });
                }
              });
              openLightbox(validItems, actualStartIdx);
            } else {
              window.open(item.skuImageUrl, '_blank');
            }
          };
          imgTd.appendChild(img);
        } else {
          imgTd.textContent = '-';
          imgTd.style.textAlign = 'center';
        }
        tr.appendChild(imgTd);
        
        var imgNameTd = document.createElement('td');
        imgNameTd.textContent = item.skuImageName || '-';
        tr.appendChild(imgNameTd);

        if (dimNames.length > 0) {
          var specs = (item.specAttributes || '').split('&');
          dimNames.forEach(function(dim, index) {
            var td = document.createElement('td');
            td.textContent = specs[index] || '-';
            tr.appendChild(td);
          });
        } else {
          var specTd = document.createElement('td');
          specTd.innerHTML = formatSpecs(item.specAttributes);
          tr.appendChild(specTd);
        }

        var priceTd = document.createElement('td');
        priceTd.textContent = item.price ? ('￥' + item.price) : '-';

        var stockTd = document.createElement('td');
        stockTd.textContent = item.stock !== undefined ? item.stock : '-';
        
        // Stock highlighting applied ONLY to the stock cell
        if (item.stock < 10) {
          stockTd.style.backgroundColor = 'rgba(248, 113, 113, 0.8)';
          stockTd.style.color = '#fff';
          stockTd.style.fontWeight = 'bold';
        } else if (item.stock < 50) {
          stockTd.style.backgroundColor = 'rgba(253, 224, 71, 0.8)';
          stockTd.style.color = '#333';
          stockTd.style.fontWeight = 'bold';
        }

        var cargoTd = document.createElement('td');
        cargoTd.textContent = item.cargoNumber || '-';

        var skuIdTd = document.createElement('td');
        skuIdTd.textContent = item.skuId || '-';

        tr.appendChild(priceTd);
        tr.appendChild(stockTd);
        tr.appendChild(cargoTd);
        tr.appendChild(skuIdTd);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      skuTabContentTable.appendChild(table);

      // Bind select all checkbox
      var chkAll = document.getElementById('sku-table-check-all');
      if (chkAll) {
        chkAll.checked = (availableRowsCount > 0 && selectedPool.skuRows.size === availableRowsCount);
        chkAll.addEventListener('change', function() {
          var isChecked = this.checked;
          var rowChks = table.querySelectorAll('.sku-table-check-row:not(:disabled)');
          rowChks.forEach(function(chk) {
            chk.checked = isChecked;
            var idx = parseInt(chk.getAttribute('data-index'), 10);
            var row = chk.closest('tr');
            var gridCard = document.querySelector('.sku-grid-card[data-index="' + idx + '"]');
            if (isChecked) {
              selectedPool.skuRows.add(idx);
              if (row) row.classList.add('sku-row-selected');
              if (gridCard) gridCard.classList.add('sku-row-selected');
            } else {
              selectedPool.skuRows.delete(idx);
              if (row) row.classList.remove('sku-row-selected');
              if (gridCard) gridCard.classList.remove('sku-row-selected');
            }
          });
          updateDownloadButtonState();
        });
      }
    } else {
      var emptyNotice = document.createElement('div');
      emptyNotice.style.cssText = 'padding:12px; color:#94a3b8; text-align:center; font-size:11px;';
      emptyNotice.textContent = '暂无结构化 SKU 规格组合数据';
      skuTabContentTable.appendChild(emptyNotice);
    }
  }

  // 2. Render SKU Grid List (大图模式)
  var skuTabContentList = document.getElementById('sku-tab-content-list');
  if (skuTabContentList) {
    skuTabContentList.replaceChildren();
    if (skuData.skuMatrix && skuData.skuMatrix.length > 0) {
      var gridContainer = document.createElement('div');
      gridContainer.className = 'sku-grid-container';
      
      skuData.skuMatrix.forEach(function (item, index) {
        var isOutOfStock = item.stock < 10;
        var card = document.createElement('div');
        card.className = 'sku-grid-card';
        card.setAttribute('data-index', index);
        if (isOutOfStock) card.classList.add('disabled');
        
        var isSel = selectedPool.skuRows.has(index);
        if (isSel && !isOutOfStock) card.classList.add('sku-row-selected');
        
        var imgWrap = document.createElement('div');
        imgWrap.className = 'sku-grid-img-wrap';
        
        var img = document.createElement('img');
        img.className = 'sku-grid-img';
        img.src = item.skuImageUrl || 'https://via.placeholder.com/150/0f172a/94a3b8?text=No+Image';
        
        var badge = document.createElement('div');
        badge.className = 'sku-grid-badge';
        badge.innerHTML = '&#10003;'; // Checkmark
        
        imgWrap.appendChild(img);
        imgWrap.appendChild(badge);
        
        var info = document.createElement('div');
        info.className = 'sku-grid-info';
        
        var title = document.createElement('div');
        title.className = 'sku-grid-title';
        title.textContent = item.skuImageName || ('SKU_' + item.skuId);
        title.title = title.textContent;
        
        var specs = document.createElement('div');
        specs.className = 'sku-grid-specs';
        specs.innerHTML = formatSpecs(item.specAttributes);
        
        var priceStock = document.createElement('div');
        priceStock.className = 'sku-grid-price-stock';
        
        var price = document.createElement('div');
        price.className = 'sku-grid-price';
        price.textContent = item.price ? ('￥' + item.price) : '-';
        
        var stock = document.createElement('div');
        stock.className = 'sku-grid-stock';
        stock.textContent = item.stock !== undefined ? ('库存: ' + item.stock) : '-';
        if (item.stock < 10) stock.style.color = '#ef4444';
        else if (item.stock < 50) stock.style.color = '#eab308';
        
        priceStock.appendChild(price);
        priceStock.appendChild(stock);
        
        info.appendChild(title);
        info.appendChild(specs);
        info.appendChild(priceStock);
        // Tooltip shows full content on hover
        info.setAttribute('data-tooltip',
          (item.skuImageName || ('SKU_' + item.skuId)) + '\n' +
          (item.specAttributes || '-') + '\n' +
          (item.price ? ('￥' + item.price) : '-') + '  ' + (item.stock !== undefined ? ('库存: ' + item.stock) : '-'));
        specs.title = item.specAttributes || '-';
        
        card.appendChild(imgWrap);
        card.appendChild(info);
        
        card.addEventListener('click', function(e) {
          if (isOutOfStock) return;
          // Toggle selection
          if (selectedPool.skuRows.has(index)) {
             selectedPool.skuRows.delete(index);
          } else {
             selectedPool.skuRows.add(index);
          }
          updateDownloadButtonState();
          
          // Re-sync UI for this item in both Table and Grid
          var tableRowChk = document.querySelector('.sku-table-check-row[data-index="' + index + '"]');
          if (tableRowChk) {
             tableRowChk.checked = selectedPool.skuRows.has(index);
             var tr = tableRowChk.closest('tr');
             if (tr) {
               if (tableRowChk.checked) tr.classList.add('sku-row-selected');
               else tr.classList.remove('sku-row-selected');
             }
          }
          if (selectedPool.skuRows.has(index)) {
             card.classList.add('sku-row-selected');
          } else {
             card.classList.remove('sku-row-selected');
          }
          
          var allChk = document.getElementById('sku-table-check-all');
          if (allChk) {
             var avail = skuData.skuMatrix.filter(function(i) { return i.stock >= 10; }).length;
             allChk.checked = (avail > 0 && selectedPool.skuRows.size === avail);
          }
        });
        
        // Add a preview button on the image
        var previewBtn = document.createElement('div');
        previewBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
        previewBtn.style.cssText = 'position:absolute; bottom:4px; right:4px; width:22px; height:22px; background:rgba(0,0,0,0.6); color:#fff; border-radius:4px; display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:3; transition:background 0.2s;';
        previewBtn.title = "全屏预览";
        previewBtn.onmouseenter = function() { previewBtn.style.background = 'rgba(99,102,241,0.8)'; };
        previewBtn.onmouseleave = function() { previewBtn.style.background = 'rgba(0,0,0,0.6)'; };
        
        var openPreview = function(e) {
          e.stopPropagation();
          if (typeof openLightbox === 'function') {
            var validItems = [];
            var actualStartIdx = 0;
            skuData.skuMatrix.forEach(function(rItem, rIdx) {
              if (rItem.skuImageUrl) {
                if (rIdx === index) {
                  actualStartIdx = validItems.length;
                }
                validItems.push({
                  url: rItem.skuImageUrl,
                  name: rItem.skuImageName || ('SKU_' + rItem.skuId),
                  _groupName: rItem.stock < 10 ? null : 'skuRows',
                  _originalIndex: rIdx,
                  _skuDetails: {
                    price: rItem.price,
                    stock: rItem.stock,
                    specs: rItem.specAttributes,
                    skuId: rItem.skuId
                  }
                });
              }
            });
            openLightbox(validItems, actualStartIdx);
          }
        };
        previewBtn.onclick = openPreview;
        imgWrap.appendChild(previewBtn);
        
        gridContainer.appendChild(card);
      });
      skuTabContentList.appendChild(gridContainer);
    }
  }

  // 3. Render JSON Code
  if (skuJsonCode) {
    skuJsonCode.textContent = JSON.stringify(skuData, null, 2);
  }
  
  // 4. Setup Large Grid Modal
  var largeModal = document.getElementById('sku-large-grid-modal');
  var largeCloseBtn = document.getElementById('btn-sku-large-close');
  var largeContent = document.getElementById('sku-large-grid-content');
  var largeGridSizeKey = 'picDownload_largeGridSize';
  var largeSizeSlider = document.getElementById('sku-large-grid-size-slider');
  var largeSizeValue = document.getElementById('sku-large-grid-size-value');
  
  function applyLargeGridSize(val) {
    if (largeContent) {
      largeContent.style.setProperty('--large-grid-min-col', val + 'px');
      largeContent.style.setProperty('--large-grid-img-h', val + 'px');
    }
    if (largeSizeSlider && largeSizeSlider.value != val) largeSizeSlider.value = val;
    if (largeSizeValue) largeSizeValue.textContent = val + 'px';
    localStorage.setItem(largeGridSizeKey, val);
  }

  if (largeModal && largeContent) {
    if (skuData.skuMatrix && skuData.skuMatrix.length > 0) {
      // Store populator function for tab click to invoke
      window._openSkuLargeGrid = function() {
        largeContent.replaceChildren();
        skuData.skuMatrix.forEach(function(item, index) {
        var isOutOfStock = item.stock < 10;
        var card = document.createElement('div');
        card.className = 'sku-large-grid-card';
        card.setAttribute('data-index', index);
        if (isOutOfStock) card.classList.add('disabled');
        
        var isSel = selectedPool.skuRows.has(index);
        if (isSel && !isOutOfStock) card.classList.add('sku-row-selected');
        
        var imgWrap = document.createElement('div');
        imgWrap.className = 'sku-grid-img-wrap';
        var img = document.createElement('img');
        img.className = 'sku-grid-img';
        img.src = item.skuImageUrl || 'https://via.placeholder.com/150/0f172a/94a3b8?text=No+Image';
        
        var badge = document.createElement('div');
        badge.className = 'sku-grid-badge';
        badge.innerHTML = '&#10003;';
        imgWrap.appendChild(img);
        imgWrap.appendChild(badge);
        
        var info = document.createElement('div');
        info.className = 'sku-grid-info';
        
        var title = document.createElement('div');
        title.className = 'sku-large-grid-title';
        title.textContent = item.skuImageName || ('SKU_' + item.skuId);
        title.title = title.textContent;
        
        var specs = document.createElement('div');
        specs.className = 'sku-large-grid-specs';
        specs.innerHTML = formatSpecs(item.specAttributes);
        
        var priceStock = document.createElement('div');
        priceStock.className = 'sku-grid-price-stock';
        
        var price = document.createElement('div');
        price.className = 'sku-large-grid-price';
        price.textContent = item.price ? ('￥' + item.price) : '-';
        
        var stock = document.createElement('div');
        stock.className = 'sku-large-grid-stock';
        stock.textContent = item.stock !== undefined ? ('库存: ' + item.stock) : '-';
        if (item.stock < 10) stock.style.color = '#ef4444';
        else if (item.stock < 50) stock.style.color = '#eab308';
        
        priceStock.appendChild(price);
        priceStock.appendChild(stock);
        info.appendChild(title);
        info.appendChild(specs);
        info.appendChild(priceStock);
        
        var cargoSkuId = document.createElement('div');
        cargoSkuId.className = 'sku-large-grid-ext';
        cargoSkuId.style.fontSize = '11px';
        cargoSkuId.style.color = '#64748b';
        cargoSkuId.style.marginTop = '4px';
        cargoSkuId.style.display = 'flex';
        cargoSkuId.style.justifyContent = 'space-between';
        var cargoText = item.cargoNumber ? ('货号: ' + item.cargoNumber) : '';
        var skuIdText = item.skuId ? ('ID: ' + item.skuId) : '';
        cargoSkuId.textContent = [cargoText, skuIdText].filter(Boolean).join(' | ');
        info.appendChild(cargoSkuId);
        
        card.appendChild(imgWrap);
        card.appendChild(info);

        // Preview button on image
        var previewBtn = document.createElement('div');
        previewBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
        previewBtn.style.cssText = 'position:absolute; bottom:4px; right:4px; width:24px; height:24px; background:rgba(0,0,0,0.6); color:#fff; border-radius:4px; display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:3; transition:background 0.2s;';
        previewBtn.title = "全屏预览";
        previewBtn.onmouseenter = function() { previewBtn.style.background = 'rgba(236,72,153,0.8)'; };
        previewBtn.onmouseleave = function() { previewBtn.style.background = 'rgba(0,0,0,0.6)'; };

        var openPreview = function(e) {
          e.stopPropagation();
          if (typeof openLightbox === 'function') {
            var validItems = [];
            var actualStartIdx = 0;
            skuData.skuMatrix.forEach(function(rItem, rIdx) {
              if (rItem.skuImageUrl) {
                if (rIdx === index) actualStartIdx = validItems.length;
                validItems.push({
                  url: rItem.skuImageUrl,
                  name: rItem.skuImageName || ('SKU_' + rItem.skuId),
                  _groupName: rItem.stock < 10 ? null : 'skuRows',
                  _originalIndex: rIdx,
                  _skuDetails: {
                    price: rItem.price,
                    stock: rItem.stock,
                    specs: rItem.specAttributes,
                    skuId: rItem.skuId
                  }
                });
              }
            });
            openLightbox(validItems, actualStartIdx);
          }
        };
        previewBtn.onclick = openPreview;
        imgWrap.appendChild(previewBtn);

        // Modal card click sync
        card.addEventListener('click', function(e) {
          if (isOutOfStock) return;
          if (selectedPool.skuRows.has(index)) selectedPool.skuRows.delete(index);
          else selectedPool.skuRows.add(index);
          updateDownloadButtonState();
          
          // Sync large card
          if (selectedPool.skuRows.has(index)) card.classList.add('sku-row-selected');
          else card.classList.remove('sku-row-selected');
          
          // Sync grid card
          var gridCard = document.querySelector('.sku-grid-card[data-index="' + index + '"]');
          if (gridCard) {
            if (selectedPool.skuRows.has(index)) gridCard.classList.add('sku-row-selected');
            else gridCard.classList.remove('sku-row-selected');
          }
          
          // Sync table row
          var tableRowChk = document.querySelector('.sku-table-check-row[data-index="' + index + '"]');
          if (tableRowChk) {
             tableRowChk.checked = selectedPool.skuRows.has(index);
             var tr = tableRowChk.closest('tr');
             if (tr) {
               if (tableRowChk.checked) tr.classList.add('sku-row-selected');
               else tr.classList.remove('sku-row-selected');
             }
          }
          
          // Sync main check all
          var allChk = document.getElementById('sku-table-check-all');
          var avail = skuData.skuMatrix.filter(function(i) { return i.stock >= 10; }).length;
          if (allChk) allChk.checked = (avail > 0 && selectedPool.skuRows.size === avail);
        });
        

        
        largeContent.appendChild(card);
      });
      largeModal.classList.remove('hidden');
      // Restore saved size
      var savedSize = parseInt(localStorage.getItem(largeGridSizeKey), 10);
      if (savedSize && savedSize >= 150 && savedSize <= 450) {
        applyLargeGridSize(savedSize);
      }
    };
    } else {
      window._openSkuLargeGrid = null;
    }

    // Large grid size slider and Alt+Wheel zoom
    if (largeSizeSlider) {
      largeSizeSlider.oninput = function() {
        applyLargeGridSize(parseInt(largeSizeSlider.value, 10));
      };
    }
    
    var largePanel = document.getElementById('sku-large-grid-panel');
    if (largePanel) {
      largePanel.addEventListener('wheel', function(e) {
        if (e.altKey && !largeModal.classList.contains('hidden')) {
          e.preventDefault();
          var currentSize = parseInt(localStorage.getItem(largeGridSizeKey), 10) || parseInt(largeSizeSlider ? largeSizeSlider.value : 240, 10);
          var minSize = 150;
          var maxSize = 1200;
          var step = 10;
          if (e.deltaY < 0) { // Scroll up -> zoom in
            currentSize = Math.min(maxSize, currentSize + step);
          } else { // Scroll down -> zoom out
            currentSize = Math.max(minSize, currentSize - step);
          }
          applyLargeGridSize(currentSize);
        }
      }, { passive: false });
    }
    
    var closeLargeAndSwitch = function() {
      largeModal.classList.add('hidden');
      // Switch active tab to gallery mode (list)
      var allTabs = document.querySelectorAll('.sku-tab-btn');
      allTabs.forEach(function(b) { b.classList.remove('active'); });
      var galleryTab = document.querySelector('.sku-tab-btn[data-tab="list"]') || allTabs[0];
      if (galleryTab) galleryTab.classList.add('active');
      // Show gallery content, hide others
      var skuTabContentTable = document.getElementById('sku-tab-content-table');
      var skuTabContentList = document.getElementById('sku-tab-content-list');
      var skuTabContentJson = document.getElementById('sku-tab-content-json');
      if (skuTabContentTable) skuTabContentTable.classList.add('hidden');
      if (skuTabContentJson) skuTabContentJson.classList.add('hidden');
      if (skuTabContentList) skuTabContentList.classList.remove('hidden');
    };

    if (largeCloseBtn) {
      largeCloseBtn.onclick = closeLargeAndSwitch;
    }

    // Overlay click to close
    var largeOverlay = document.getElementById('sku-large-grid-overlay');
    if (largeOverlay) {
      largeOverlay.onclick = closeLargeAndSwitch;
    }
    
    // Bind modal Select All / Clear All
    var btnLargeSelectSafe = document.getElementById('btn-sku-large-select-safe');
    var btnLargeClear = document.getElementById('btn-sku-large-clear');
    
    if (btnLargeSelectSafe) {
      btnLargeSelectSafe.onclick = function() {
        var btnSelectSafe = document.getElementById('btn-sku-select-safe');
        if (btnSelectSafe) btnSelectSafe.click(); // Reuse existing logic which syncs everything
        
        // Update large cards
        var largeCards = document.querySelectorAll('.sku-large-grid-card:not(.disabled)');
        largeCards.forEach(function(c) {
          var idx = parseInt(c.getAttribute('data-index'), 10);
          if (selectedPool.skuRows.has(idx)) c.classList.add('sku-row-selected');
        });
      };
    }
    if (btnLargeClear) {
      btnLargeClear.onclick = function() {
        var btnClear = document.getElementById('btn-sku-clear');
        if (btnClear) btnClear.click(); // Reuse existing logic
        
        var largeCards = document.querySelectorAll('.sku-large-grid-card');
        largeCards.forEach(function(c) { c.classList.remove('sku-row-selected'); });
      };
    }
  }
}

/**
 * Show title preview with copyable lines: title, URL, and SKU JSON metadata.
 */
function showTitlePreview(title, pageUrl, skuData) {
  titlePreview.replaceChildren();

  if (title) {
    titlePreview.appendChild(createCopyableRow('\u6807\u9898\uff1a', title, false));
  }

  if (pageUrl) {
    titlePreview.appendChild(createCopyableRow('\u7f51\u5740\uff1a', pageUrl, true));
  }

  if (skuData && (skuData.summary || skuData.skuMatrix)) {
    var skuMeta = '已解构 ' + ((skuData.summary && skuData.summary.totalSkus) || (skuData.skuMatrix ? skuData.skuMatrix.length : 0)) + ' 个SKU规格组合 (' +
                  ((skuData.summary && skuData.summary.propDimensions) || (skuData.skuProps ? skuData.skuProps.length : 0)) + ' 维度 / ' +
                  ((skuData.summary && skuData.summary.priceTierCount) || (skuData.priceModel && skuData.priceModel.priceRanges ? skuData.priceModel.priceRanges.length : 0)) + ' 阶梯价)';
    titlePreview.appendChild(createCopyableRow('SKU数据：', skuMeta, false));

    if (btnToggleSkuView) btnToggleSkuView.classList.remove('hidden');
    if (btnCopySkuJson) btnCopySkuJson.classList.remove('hidden');
    if (btnExportSkuCsv) btnExportSkuCsv.classList.remove('hidden');

    renderSkuDataPanel(skuData);
  } else {
    if (btnToggleSkuView) btnToggleSkuView.classList.add('hidden');
    if (btnCopySkuJson) btnCopySkuJson.classList.add('hidden');
    if (btnExportSkuCsv) btnExportSkuCsv.classList.add('hidden');
    if (skuDataPanel) skuDataPanel.classList.add('hidden');
  }
}

/**
 * Sanitize title for use as folder name.
 */
function sanitizeFolder(title) {
  if (!title) {
    return 'download';
  }
  return (
    title
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 80)
      .trim() || 'download'
  );
}

async function findTargetTab() {
  // Priority 0: If we have a specific tabId from URL param, use it directly
  if (targetTabId) {
    try {
      var specificTab = await chrome.tabs.get(targetTabId);
      if (specificTab && specificTab.url && !specificTab.url.startsWith('chrome-extension://')) {
        return specificTab;
      }
    } catch (e) {
      // Tab may have been closed, fall through to other strategies
    }
  }
  // Strategy 1: Current window active tab
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs && tabs.length > 0 && tabs[0].url && !tabs[0].url.startsWith('chrome-extension://')) {
    return tabs[0];
  }
  // Strategy 2: Last focused window
  var focusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focusedTabs && focusedTabs.length > 0 && focusedTabs[0].url && !focusedTabs[0].url.startsWith('chrome-extension://')) {
    return focusedTabs[0];
  }
  // Strategy 3: Any active non-extension tab
  var allActiveTabs = await chrome.tabs.query({ active: true });
  if (allActiveTabs && allActiveTabs.length > 0) {
    for (var i = 0; i < allActiveTabs.length; i++) {
      if (allActiveTabs[i].url && !allActiveTabs[i].url.startsWith('chrome-extension://')) {
        return allActiveTabs[i];
      }
    }
  }
  return (tabs && tabs.length > 0) ? tabs[0] : null;
}

// --- Core: SCAN function ---
async function performScan() {
  if (!isAuthorizedSession) return;
  setStatus('scanning', '\u6b63\u5728\u626b\u63cf\u9875\u9762...');
  btnScan.classList.add('btn-loading');
  btnScan.disabled = true;
  btnDownload.classList.add('hidden');
  if (actionsSecondary) {
    actionsSecondary.classList.add('hidden');
  }
  resultsArea.classList.add('hidden');
  progressArea.classList.add('hidden');

  try {
    var tab = await findTargetTab();
    if (!tab || !tab.id) {
      setStatus('error', '\u65e0\u6cd5\u8bbf\u95ee\u5f53\u524d\u6807\u7b7e\u9875');
      btnScan.classList.remove('btn-loading');
      btnScan.disabled = false;
      return;
    }

    var results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['1688_sku_collector.js', 'content.js']
    });

    if (results && results[0] && results[0].result) {
      scanData = results[0].result;

      var s = scanData.summary;

      // Reset selectedPool
      selectedPool.gallery.clear();
      selectedPool.sku.clear();
      selectedPool.detail.clear();
      selectedPool.skuRows.clear();

      // Popup mode: default all unchecked; Filter mode: default all checked
      if (currentWorkMode !== 'popup') {
        if (scanData.gallery) {
          for (var g = 0; g < scanData.gallery.length; g++) selectedPool.gallery.add(g);
        }
        if (scanData.skuData && scanData.skuData.skuMatrix) {
          for (var r = 0; r < scanData.skuData.skuMatrix.length; r++) {
            if (scanData.skuData.skuMatrix[r].stock >= 10) {
              selectedPool.skuRows.add(r);
            }
          }
        }
        if (scanData.detail) {
          for (var d = 0; d < scanData.detail.length; d++) selectedPool.detail.add(d);
        }
      }

      // Update badges
      badgeTitle.textContent = scanData.title ? '\u2713' : '\u2717';
      badgeGallery.textContent = String(s.galleryCount);
      badgeSku.textContent = String(s.skuCount);
      badgeDetail.textContent = String(s.detailCount);

      // Show title & SKU data preview
      showTitlePreview(scanData.title, scanData.pageUrl, scanData.skuData);

      // Render All Thumbnails based on mode
      renderAllThumbnails();

      // Show results
      resultsArea.classList.remove('hidden');

      if (s.totalImages > 0 || scanData.title) {
        setStatus(
          'found',
          '\u627e\u5230 ' + s.totalImages + ' \u5f20\u56fe\u7247'
        );
        updateDownloadButtonState();
      } else {
        setStatus('error', '\u672a\u627e\u5230\u53ef\u4e0b\u8f7d\u7684\u5185\u5bb9');
      }
    } else {
      setStatus('error', '\u811a\u672c\u6ce8\u5165\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u9875\u9762\u6743\u9650');
    }
  } catch (err) {
    setStatus('error', '\u9519\u8bef\uff1a' + (err.message || 'Unknown'));
  }

  btnScan.classList.remove('btn-loading');
  btnScan.disabled = false;
}

// --- Auto-scan when popup opens (Wrapped with Auth Check) ---
document.addEventListener('DOMContentLoaded', function () {
  chrome.storage.local.get(['machine_id', 'act_code'], async function(result) {
    let mid = result.machine_id;
    if (!mid) {
      mid = 'MID-' + Math.random().toString(36).substr(2, 9).toUpperCase();
      chrome.storage.local.set({machine_id: mid});
    }
    
    let isAuth = false;
    if (result.act_code) {
      const authRes = await verifyLicense(mid, result.act_code);
      if (authRes && authRes.valid) {
        isAuth = true;
        document.getElementById('license-status').textContent = '已激活至: ' + formatDate(authRes.expireTs);
      }
    }
    
    const appEl = document.getElementById('app');
    const authOverlay = document.getElementById('auth-overlay');
    
    if (isAuth) {
      isAuthorizedSession = true;
      if(authOverlay) authOverlay.classList.add('hidden');
      if(appEl) appEl.classList.remove('hidden');
      performScan(); // Only auto-scan if authorized
    } else {
      isAuthorizedSession = false;
      if(authOverlay) authOverlay.classList.remove('hidden');
      if(appEl) appEl.classList.add('hidden');
      const midInput = document.getElementById('auth-machine-id');
      if(midInput) midInput.value = mid;
      const statusEl = document.getElementById('license-status');
      if(statusEl) statusEl.textContent = '未激活';
    }
    
    // Bind Activation Button
    const btnActivate = document.getElementById('btn-activate');
    if (btnActivate) {
      btnActivate.onclick = async function() {
        const code = document.getElementById('auth-code-input').value.trim();
        const errEl = document.getElementById('auth-error');
        if (!code) return errEl.textContent = "请输入激活码";
        errEl.textContent = "验证中...";
        const res = await verifyLicense(mid, code);
        if (res && res.valid) {
          errEl.textContent = "激活成功！";
          errEl.style.color = "#10b981";
          chrome.storage.local.set({act_code: code});
          setTimeout(() => location.reload(), 1000);
        } else {
          errEl.textContent = "激活码无效或已过期，请检查";
        }
      };
    }
    
    const btnCopyMid = document.getElementById('btn-copy-mid');
    if (btnCopyMid) {
      btnCopyMid.onclick = function() {
        navigator.clipboard.writeText(mid);
        const originalTitle = this.title;
        this.title = "已复制";
        setTimeout(() => this.title = originalTitle, 2000);
      };
    }
  });
});

// --- Manual re-scan button ---
btnScan.addEventListener('click', function () {
  performScan();
});

// --- Event: DOWNLOAD ---
btnDownload.addEventListener('click', function () {
  if (!scanData) {
    return;
  }

  var downloadPayload = {
    title: scanData.title,
    pageUrl: scanData.pageUrl,
    gallery: scanData.gallery,
    sku: scanData.sku,
    detail: scanData.detail,
    skuData: scanData.skuData
  };

  // Filter / Popup mode -> only send selected items
  if (isFilterLikeMode()) {
    downloadPayload.gallery = scanData.gallery.filter(function (_, idx) {
      return selectedPool.gallery.has(idx);
    });
    
    var skuImages = [];
    var skuImageUrls = new Set();
    selectedPool.skuRows.forEach(function(idx) {
      if (scanData.skuData && scanData.skuData.skuMatrix) {
        var item = scanData.skuData.skuMatrix[idx];
        if (item && item.skuImageUrl && !skuImageUrls.has(item.skuImageUrl)) {
          skuImageUrls.add(item.skuImageUrl);
          skuImages.push({
            url: item.skuImageUrl,
            name: item.skuImageName || ('sku_' + item.skuId)
          });
        }
      }
    });
    downloadPayload.sku = skuImages;

    downloadPayload.detail = scanData.detail.filter(function (_, idx) {
      return selectedPool.detail.has(idx);
    });

    var selectedTotal = downloadPayload.gallery.length + downloadPayload.sku.length + downloadPayload.detail.length;
    if (selectedTotal === 0 && !scanData.title) {
      setStatus('error', '请至少勾选一张图片后再进行下载');
      return;
    }
  }

  btnDownload.disabled = true;
  btnScan.disabled = true;
  if (actionsSecondary) {
    actionsSecondary.classList.remove('hidden');
  }
  progressArea.classList.remove('hidden');
  progressBarFill.style.width = '0%';
  progressText.textContent = '0 / ?';
  setStatus('scanning', '\u6b63\u5728\u4e0b\u8f7d...');

  var folder = sanitizeFolder(scanData.title);

  chrome.runtime.sendMessage(
    {
      action: 'downloadAll',
      folder: folder,
      data: downloadPayload
    },
    function (response) {
      if (response && response.success) {
        var msg = '\u5b8c\u6210\uff01' + response.completed + ' \u5df2\u4e0b\u8f7d';
        if (response.failed > 0) {
          msg += '\uff0c' + response.failed + ' \u5931\u8d25';
        }
        setStatus('done', msg);
        progressBarFill.style.width = '100%';
        progressText.textContent = response.completed + ' / ' + response.total;
      }
      btnDownload.disabled = false;
      btnScan.disabled = false;
    }
  );
});

// --- Listen for progress updates ---
chrome.runtime.onMessage.addListener(function (message) {
  if (message.action === 'downloadProgress') {
    var pct = Math.round((message.completed / message.total) * 100);
    progressBarFill.style.width = pct + '%';
    progressText.textContent = message.completed + ' / ' + message.total;
  }

  if (message.action === 'downloadComplete') {
    var msg = '\u5b8c\u6210\uff01' + message.completed + ' \u5df2\u4e0b\u8f7d';
    if (message.failed > 0) {
      msg += '\uff0c' + message.failed + ' \u5931\u8d25';
    }
    setStatus('done', msg);
    btnDownload.disabled = false;
    btnScan.disabled = false;
  }
});

// --- Event: OPEN / COPY FOLDER ---
if (btnOpenFolder) {
  btnOpenFolder.addEventListener('click', function () {
    var folder = scanData ? sanitizeFolder(scanData.title) : '';
    chrome.runtime.sendMessage({ action: 'openFolder', folder: folder });
  });
}

var btnCopyFolder = document.getElementById('btn-copy-folder');
if (btnCopyFolder) {
  btnCopyFolder.addEventListener('click', function () {
    var folder = scanData ? sanitizeFolder(scanData.title) : '';
    if (!folder) return;
    chrome.runtime.sendMessage({ action: 'copyFolderPath', folder: folder }, function(res) {
      if (res && res.success && res.path) {
        navigator.clipboard.writeText(res.path).then(function() {
          var originalHTML = btnCopyFolder.innerHTML;
          btnCopyFolder.innerHTML = '<span style="color:#10b981; font-weight:bold;">复制成功!</span>';
          setTimeout(function() { btnCopyFolder.innerHTML = originalHTML; }, 2000);
        }).catch(function(err) {
          alert('复制失败: ' + err);
        });
      } else {
        alert(res ? res.error : '获取路径失败');
      }
    });
  });
}

// --- Event: Alt + Mouse Wheel to adjust image size ---
var lightboxScale = 1;
document.addEventListener('wheel', function(e) {
  if (e.altKey) {
    e.preventDefault(); // Prevent default page scrolling

    // Check large grid modal first
    var largeGridModal = document.getElementById('sku-large-grid-modal');
    if (largeGridModal && !largeGridModal.classList.contains('hidden')) {
      var largeSlider = document.getElementById('sku-large-grid-size-slider');
      if (!largeSlider) return;
      var step = parseInt(largeSlider.step, 10) || 10;
      var cur = parseInt(largeSlider.value, 10);
      var min = parseInt(largeSlider.min, 10) || 150;
      var max = parseInt(largeSlider.max, 10) || 450;
      if (e.deltaY < 0) cur = Math.min(max, cur + step * 2);
      else if (e.deltaY > 0) cur = Math.max(min, cur - step * 2);
      largeSlider.value = cur;
      applyLargeGridSize(cur);
      return;
    }

    var modal = document.getElementById('lightbox-modal');
    if (modal && !modal.classList.contains('hidden')) {
      var img = document.getElementById('lightbox-img');
      if (!img) return;
      if (e.deltaY < 0) {
        lightboxScale += 0.15;
      } else if (e.deltaY > 0) {
        lightboxScale -= 0.15;
      }
      lightboxScale = Math.max(0.5, Math.min(lightboxScale, 5.0));
      img.style.transform = 'translate(' + lightboxTranslateX + 'px, ' + lightboxTranslateY + 'px) scale(' + lightboxScale + ')';
      img.style.transition = 'transform 0.1s ease-out';
      if (typeof updateLightboxZoomUI === 'function') updateLightboxZoomUI();
      return;
    }

    var slider = document.getElementById('size-slider');
    if (!slider) return;
    
    var step = parseInt(slider.step, 10) || 10;
    var currentVal = parseInt(slider.value, 10);
    var min = parseInt(slider.min, 10) || 80;
    var max = parseInt(slider.max, 10) || 640;
    
    if (e.deltaY < 0) {
      // Scroll up -> Increase size
      currentVal = Math.min(max, currentVal + step * 2);
    } else if (e.deltaY > 0) {
      // Scroll down -> Decrease size
      currentVal = Math.max(min, currentVal - step * 2);
    }
    
    slider.value = currentVal;
    slider.dispatchEvent(new Event('input'));
    slider.dispatchEvent(new Event('change'));
  }
}, { passive: false });

// --- Event: Lightbox Image Pan & Click ---
var lightboxTranslateX = 0;
var lightboxTranslateY = 0;
var isDragging = false;
var dragStartX = 0;
var dragStartY = 0;
var initialTranslateX = 0;
var initialTranslateY = 0;
var hasMoved = false;

var lightboxImg = document.getElementById('lightbox-img');
if (lightboxImg) {
  lightboxImg.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return; // Only left click
    e.preventDefault(); // Prevent native image drag
    isDragging = true;
    hasMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    initialTranslateX = lightboxTranslateX;
    initialTranslateY = lightboxTranslateY;
    lightboxImg.style.transition = 'none'; // Disable transition for smooth dragging
  });

  window.addEventListener('mousemove', function(e) {
    if (!isDragging) return;
    var dx = e.clientX - dragStartX;
    var dy = e.clientY - dragStartY;
    
    // Threshold to differentiate click from drag
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      hasMoved = true;
    }

    if (hasMoved) {
      lightboxTranslateX = initialTranslateX + dx;
      lightboxTranslateY = initialTranslateY + dy;
      lightboxImg.style.transform = 'translate(' + lightboxTranslateX + 'px, ' + lightboxTranslateY + 'px) scale(' + lightboxScale + ')';
    }
  });

  window.addEventListener('mouseup', function(e) {
    if (isDragging) {
      isDragging = false;
      lightboxImg.style.transition = 'transform 0.1s ease-out';
    }
  });

  lightboxImg.addEventListener('click', function(e) {
    if (hasMoved) {
      // It was a drag, do not trigger click selection
      hasMoved = false;
      return;
    }
    
    if (!isFilterLikeMode()) return;
    var item = currentLightboxList[currentLightboxIndex];
    if (item && item._groupName && typeof item._originalIndex === 'number') {
      var set = selectedPool[item._groupName];
      if (set.has(item._originalIndex)) {
        set.delete(item._originalIndex);
        lightboxImg.classList.remove('is-selected');
      } else {
        set.add(item._originalIndex);
        lightboxImg.classList.add('is-selected');
      }
      updateDownloadButtonState();
      renderAllThumbnails();
    }
  });
}

// --- Lightbox Zoom UI Sync ---
function updateLightboxZoomUI(skipTransform) {
  var slider = document.getElementById('lightbox-zoom-slider');
  var text = document.getElementById('lightbox-zoom-text');
  var img = document.getElementById('lightbox-img');
  if (slider && text) {
    slider.value = lightboxScale;
    text.textContent = Math.round(lightboxScale * 100) + '%';
  }
  if (!skipTransform && img) {
    img.style.transform = 'translate(' + lightboxTranslateX + 'px, ' + lightboxTranslateY + 'px) scale(' + lightboxScale + ')';
  }
}

var lbZoomSlider = document.getElementById('lightbox-zoom-slider');
if (lbZoomSlider) {
  lbZoomSlider.addEventListener('input', function() {
    lightboxScale = parseFloat(this.value);
    var img = document.getElementById('lightbox-img');
    if (img) img.style.transition = 'none'; // dragging slider should feel instant
    updateLightboxZoomUI();
  });
}
