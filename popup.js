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

// --- State ---
var scanData = null;

// Selected items pool for Filter / Popup mode
var selectedPool = {
  gallery: new Set(),
  sku: new Set(),
  detail: new Set()
};

function getSelectedTotalCount() {
  return selectedPool.gallery.size + selectedPool.sku.size + selectedPool.detail.size;
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
      titleEl.textContent = item.name || item.url || '';
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
  populateThumbs(skuThumbs, scanData.sku, 'sku');
  populateThumbs(detailThumbs, scanData.detail, 'detail');
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
 * Show title preview with two copyable lines: title and URL.
 */
function showTitlePreview(title, pageUrl) {
  titlePreview.replaceChildren();

  if (title) {
    titlePreview.appendChild(createCopyableRow('\u6807\u9898\uff1a', title, false));
  }

  if (pageUrl) {
    titlePreview.appendChild(createCopyableRow('\u7f51\u5740\uff1a', pageUrl, true));
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
      files: ['content.js']
    });

    if (results && results[0] && results[0].result) {
      scanData = results[0].result;

      var s = scanData.summary;

      // Reset selectedPool
      selectedPool.gallery.clear();
      selectedPool.sku.clear();
      selectedPool.detail.clear();

      // Popup mode: default all unchecked; Filter mode: default all checked
      if (currentWorkMode !== 'popup') {
        if (scanData.gallery) {
          for (var g = 0; g < scanData.gallery.length; g++) selectedPool.gallery.add(g);
        }
        if (scanData.sku) {
          for (var k = 0; k < scanData.sku.length; k++) selectedPool.sku.add(k);
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

      // Show title preview
      showTitlePreview(scanData.title, scanData.pageUrl);

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
    detail: scanData.detail
  };

  // Filter / Popup mode -> only send selected items
  if (isFilterLikeMode()) {
    downloadPayload.gallery = scanData.gallery.filter(function (_, idx) {
      return selectedPool.gallery.has(idx);
    });
    downloadPayload.sku = scanData.sku.filter(function (_, idx) {
      return selectedPool.sku.has(idx);
    });
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
