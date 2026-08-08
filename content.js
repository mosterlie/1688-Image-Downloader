/**
 * Content Script: Extract 4 types of data from 1688 product pages.
 *
 * 1. productTitle (#productTitle h1) -> title text
 * 2. gallery (#gallery li.v-image-cover) -> background-image URLs
 * 3. skuSelection (#skuSelection .expand-view-item) -> img src + span title
 * 4. detail (Shadow DOM: v-detail-9 > #detail img) -> img src
 *
 * Returns a structured object to popup.js via chrome.scripting.executeScript.
 */

(function () {
  'use strict';

  // =============================================
  // 1. Extract Product Title
  // =============================================
  function extractTitle() {
    var titleEl = document.querySelector('#productTitle h1');
    if (titleEl) {
      return (titleEl.textContent || '').trim();
    }
    return '';
  }

  // =============================================
  // 2. Extract Page URL
  // =============================================
  function extractPageUrl() {
    return window.location.href || '';
  }

  // =============================================
  // 3. Extract Gallery Images
  //    Gallery uses CSS background-image on <li> elements,
  //    NOT <img> tags. URLs end with _b.jpg (thumbnail).
  //    Remove _b.jpg suffix to get the full-size image.
  // =============================================
  /**
   * Helper to check if an image URL is a UI Icon / Navigation Arrow.
   */
  function isUiIcon(url) {
    if (!url) return true;
    var lower = url.toLowerCase();
    if (
      lower.includes('tps-') ||
      lower.includes('arrow') ||
      lower.includes('chevron') ||
      lower.includes('down_') ||
      lower.includes('icon_') ||
      lower.includes('.svg') ||
      lower.includes('blank.gif') ||
      lower.includes('transparent.png') ||
      lower.includes('space.gif')
    ) {
      return true;
    }
    return false;
  }

  function extractGallery() {
    var results = [];
    var index = 1;

    // 策略 1: 优先精准遍历主图图册的具体列表 <ul> / <li> 元素
    var listContainer = document.querySelector('#gallery .od-picture-gallery-list') || 
                        document.querySelector('.od-picture-gallery-list') ||
                        document.querySelector('.vertical-img-list');

    if (listContainer) {
      var lis = listContainer.querySelectorAll('li');
      for (var i = 0; i < lis.length; i++) {
        var li = lis[i];

        // 精确剔除视频与讲解节点
        if (li.querySelector('.video-type-name') || (li.textContent && (li.textContent.includes('视频') || li.textContent.includes('讲解')))) {
          continue;
        }

        var bgImage = li.style.backgroundImage || '';
        var match = bgImage.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
        if (match && match[1]) {
          var rawUrl = match[1].replace(/_b\.jpg$/, '');
          var fullUrl = cleanOriginalUrl(rawUrl);
          if (fullUrl && !isUiIcon(fullUrl)) {
            results.push({
              url: fullUrl,
              name: 'gallery_' + index
            });
            index++;
          }
        }
      }
    }

    // 策略 2: 兜底逻辑：如果不是上述结构，抓取图片并排除箭头与图标
    if (results.length === 0) {
      var seen = new Set();
      var galleryImgs = document.querySelectorAll(
        '.module-od-picture-gallery img, .vertical-img-list img, #dt-tab img, .detail-gallery img, [data-module="od_picture_gallery"] img, #productTitle img'
      );
      for (var g = 0; g < galleryImgs.length; g++) {
        var img = galleryImgs[g];
        if (img.closest && img.closest('button')) continue;
        var alt = img.getAttribute('alt') || '';
        if (alt.includes('向下') || alt.includes('向上') || alt.includes('滚动')) continue;

        var raw = img.getAttribute('data-src') || img.getAttribute('lazy-src') || img.src || img.getAttribute('src') || '';
        if (!raw || !raw.startsWith('http')) continue;
        var clean = cleanOriginalUrl(raw);
        if (clean && !seen.has(clean) && !isUiIcon(clean)) {
          seen.add(clean);
          results.push({
            url: clean,
            name: 'gallery_' + index
          });
          index++;
        }
      }
    }

    return results;
  }

  // =============================================
  // 4. Extract SKU Selection Images (全量死角无缝覆盖)
  // =============================================
  function extractSku() {
    var results = [];
    var seen = new Set();
    var index = 1;

    function addSkuItem(item) {
      if (!item) return;
      var imgEl = item.querySelector('img.ant-image-img') || item.querySelector('img') || (item.tagName === 'IMG' ? item : null);
      if (!imgEl) return;

      var rawUrl =
        imgEl.getAttribute('data-src') ||
        imgEl.getAttribute('lazy-src') ||
        imgEl.src ||
        imgEl.getAttribute('src') ||
        '';

      if (!rawUrl || !rawUrl.startsWith('http')) return;

      var fullUrl = cleanOriginalUrl(rawUrl);

      var labelEl = item.querySelector('.label-name') || item.querySelector('span.item-label') || item.querySelector('.gyp-pro-table-title p') || item.querySelector('span');
      var title = '';
      if (labelEl) {
        title = labelEl.getAttribute('title') || labelEl.textContent || '';
        title = title.trim();
      }

      var safeName = title
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
        .replace(/\s+/g, '_')
        .trim();

      if (!safeName) {
        safeName = 'sku_item';
      }

      var skuKey = fullUrl + '_' + safeName;
      if (!fullUrl || seen.has(skuKey) || isUiIcon(fullUrl)) return;
      seen.add(skuKey);

      results.push({
        url: fullUrl,
        name: 'sku_' + index + '_' + safeName
      });
      index++;
    }

    // 策略 1: 遍历页面中所有 .feature-item 及下属按钮
    var featureItems = document.querySelectorAll('.feature-item, [class*="feature-item"]');
    for (var f = 0; f < featureItems.length; f++) {
      var feature = featureItems[f];
      var buttons = feature.querySelectorAll(
        'button.sku-filter-button, .sku-filter-button, .expand-view-item, [class*="sku-item"]'
      );
      for (var b = 0; b < buttons.length; b++) {
        addSkuItem(buttons[b]);
      }
    }

    // 策略 2: 全量捕捉 #skuSelection、.module-od-sku-selection、.gyp-pro-table 中的所有规格图片
    var allSkuContainers = document.querySelectorAll(
      '#skuSelection .expand-view-item, .module-od-sku-selection .expand-view-item, .gyp-pro-table tr, .gyp-pro-table-title'
    );
    for (var c = 0; c < allSkuContainers.length; c++) {
      addSkuItem(allSkuContainers[c]);
    }

    return results;
  }

  // =============================================
  // 5. Extract Detail Images (inside Shadow DOM)
  //    <v-detail-9 class="html-description">
  //      #shadow-root (open)
  //        <div id="detail">
  //          <img src="...">
  // =============================================
  function extractDetail() {
    var imgs = [];

    // Strategy 1: Known shadow host elements
    var selectors = [
      '[class="html-description"]',
      'v-detail-9',
      'v-detail-10',
      'v-detail-11',
      'v-detail-12'
    ];

    for (var s = 0; s < selectors.length; s++) {
      var hosts = document.querySelectorAll(selectors[s]);
      for (var h = 0; h < hosts.length; h++) {
        var host = hosts[h];
        if (host.shadowRoot) {
          var detail = host.shadowRoot.querySelector('#detail');
          if (detail) {
            imgs = collectDetailImgs(detail);
            if (imgs.length > 0) {
              return imgs;
            }
          }
        }
      }
    }

    // Strategy 2: Recursive shadow root walk
    imgs = findDetailRecursive(document);
    if (imgs.length > 0) {
      return imgs;
    }

    // Strategy 3: Fallback direct DOM
    var detailEl = document.getElementById('detail');
    if (detailEl) {
      return collectDetailImgs(detailEl);
    }

    return [];
  }

  function findDetailRecursive(root) {
    var detail = root.querySelector('#detail');
    if (detail) {
      var imgs = collectDetailImgs(detail);
      if (imgs.length > 0) {
        return imgs;
      }
    }
    var allEls = root.querySelectorAll('*');
    for (var i = 0; i < allEls.length; i++) {
      if (allEls[i].shadowRoot) {
        var result = findDetailRecursive(allEls[i].shadowRoot);
        if (result.length > 0) {
          return result;
        }
      }
    }
    return [];
  }

  /**
   * Remove Alibaba CDN thumbnail & compression parameters to restore full original image.
   */
  function cleanOriginalUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) {
      url = 'https:' + url;
    }
    return url
      .replace(/_\d+x\d+[^.]*\.(jpg|png|webp|jpeg|gif)/gi, '')
      .replace(/\.(jpg|png|gif|jpeg)_[^.]+\.(jpg|png|webp|jpeg)$/gi, '.$1')
      .replace(/\.(jpg|png|gif|jpeg)_.*/gi, '.$1');
  }

  function collectDetailImgs(container) {
    var imgEls = container.querySelectorAll('img');
    var results = [];
    var seen = new Set();
    var index = 1;

    for (var i = 0; i < imgEls.length; i++) {
      var img = imgEls[i];
      var rawUrl =
        img.getAttribute('data-src') ||
        img.getAttribute('lazy-src') ||
        img.getAttribute('data-original') ||
        img.src ||
        img.getAttribute('src') ||
        '';

      var url = cleanOriginalUrl(rawUrl);

      if (!url || !url.startsWith('https://') || seen.has(url)) {
        continue;
      }
      if (url.includes('blank.gif') || url.includes('transparent.png') || url.includes('space.gif')) {
        continue;
      }
      seen.add(url);

      results.push({
        url: url,
        name: 'detail_' + index
      });
      index++;
    }

    return results;
  }

  // =============================================
  // Full Monitor Screen Lightbox Preview Handler
  // =============================================
  if (!window.__1688_downloader_listener) {
    window.__1688_downloader_listener = true;
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (message.action === 'previewImageFull') {
        showFullMonitorPreview(message.url, message.title);
        sendResponse({ success: true });
      }
    });
  }

  function showFullMonitorPreview(url, title) {
    var oldModal = document.getElementById('downloader-full-lightbox');
    if (oldModal) {
      oldModal.remove();
    }

    var modal = document.createElement('div');
    modal.id = 'downloader-full-lightbox';
    modal.style.cssText =
      'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(15,23,42,0.88);backdrop-filter:blur(8px);padding:20px;box-sizing:border-box;font-family:sans-serif;';

    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText =
      'position:absolute;top:20px;right:25px;width:40px;height:40px;border-radius:50%;background:#ef4444;color:#fff;border:none;font-size:26px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,0.5);transition:transform 0.2s;z-index:2147483647;';
    closeBtn.onmouseover = function () {
      closeBtn.style.transform = 'scale(1.1)';
    };
    closeBtn.onmouseout = function () {
      closeBtn.style.transform = 'scale(1)';
    };

    var img = document.createElement('img');
    img.src = url;
    img.style.cssText =
      'max-width:90vw;max-height:85vh;object-fit:contain;border-radius:8px;box-shadow:0 20px 50px rgba(0,0,0,0.8);background:#000;';

    var titleEl = document.createElement('div');
    titleEl.textContent = title || '';
    titleEl.style.cssText =
      'margin-top:14px;color:#cbd5e1;font-size:14px;font-weight:600;text-align:center;max-width:80vw;word-break:break-all;text-shadow:0 2px 4px rgba(0,0,0,0.8);';

    modal.appendChild(closeBtn);
    modal.appendChild(img);
    modal.appendChild(titleEl);

    function removeModal() {
      if (modal && modal.parentNode) {
        modal.parentNode.removeChild(modal);
      }
      document.removeEventListener('keydown', onKeyDown);
    }

    closeBtn.onclick = removeModal;
    modal.onclick = function (e) {
      if (e.target === modal) {
        removeModal();
      }
    };

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        removeModal();
      }
    }
    document.addEventListener('keydown', onKeyDown);

    document.body.appendChild(modal);
  }

  // =============================================
  // Execute all extractions and return result
  // =============================================
  var title = extractTitle();
  var pageUrl = extractPageUrl();
  var gallery = extractGallery();
  var sku = extractSku();
  var detail = extractDetail();

  return {
    title: title,
    pageUrl: pageUrl,
    gallery: gallery,
    sku: sku,
    detail: detail,
    summary: {
      galleryCount: gallery.length,
      skuCount: sku.length,
      detailCount: detail.length,
      totalImages: gallery.length + sku.length + detail.length
    }
  };
})();
