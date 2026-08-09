/**
 * Background Service Worker
 * Handles batch image downloads + txt file creation.
 * Receives structured download requests from popup.js.
 */

'use strict';

var SECRET_KEY = "1688_PIC_DOWNLOADER_SUPER_SECRET_2026_!@#"; 

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyLicenseBackground() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['machine_id', 'act_code'], async function(result) {
      const mid = result.machine_id;
      const actCodeBase64 = result.act_code;
      if (!mid || !actCodeBase64) return resolve(false);
      try {
        const raw = atob(actCodeBase64);
        const parts = raw.split('|');
        if (parts.length !== 2) return resolve(false);
        const expireTs = parseInt(parts[0], 10);
        const signature = parts[1];
        if (Date.now() > expireTs) return resolve(false);
        const payload = mid + expireTs + SECRET_KEY;
        const expectedSig = await sha256(payload);
        resolve(expectedSig === signature);
      } catch(e) {
        resolve(false);
      }
    });
  });
}

/**
 * When the extension icon is clicked, open a resizable popup window directly.
 * Passes the current tab ID so the popup knows which page to scan.
 */
chrome.action.onClicked.addListener(function (tab) {
  var tabId = (tab && tab.id) ? tab.id : '';
  var popupUrl = chrome.runtime.getURL('popup.html?mode=popup&tabId=' + tabId);
  chrome.windows.create({
    url: popupUrl,
    type: 'popup',
    width: 900,
    height: 700,
    focused: true
  });
});

/**
 * Get the file extension from a URL.
 * Defaults to .jpg if unable to determine.
 */
function getExtension(url) {
  try {
    var pathname = new URL(url).pathname;
    var lastSegment = pathname.split('/').pop() || '';
    var dotIndex = lastSegment.lastIndexOf('.');
    if (dotIndex > -1) {
      var ext = lastSegment.substring(dotIndex).toLowerCase();
      // Remove query parameters from extension
      var qIndex = ext.indexOf('?');
      if (qIndex > -1) {
        ext = ext.substring(0, qIndex);
      }
      // Only return known image extensions
      if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].indexOf(ext) !== -1) {
        return ext;
      }
    }
  } catch (e) {
    // Ignore parse errors
  }
  return '.jpg';
}

var mainFolderDownloadId = null;

/**
 * Download a single image with a custom filename.
 */
function downloadImage(url, folder, filename) {
  return new Promise(function (resolve, reject) {
    var ext = getExtension(url);
    var savePath = folder + '/' + filename + ext;

    chrome.downloads.download(
      {
        url: url,
        filename: savePath,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      function (downloadId) {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError.message);
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

/**
 * Create and download a txt file using a data URL.
 * Stores mainFolderDownloadId because the txt file lives directly inside the main folder.
 */
function downloadTxtFile(content, folder, filename) {
  return new Promise(function (resolve, reject) {
    var dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content);
    var savePath = folder + '/' + filename + '.txt';

    chrome.downloads.download(
      {
        url: dataUrl,
        filename: savePath,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      function (downloadId) {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError.message);
        } else {
          if (downloadId) {
            mainFolderDownloadId = downloadId;
          }
          resolve(downloadId);
        }
      }
    );
  });
}

/**
 * Create and download a JSON file using a data URL.
 */
function downloadJsonFile(content, folder, filename) {
  return new Promise(function (resolve, reject) {
    var jsonStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    var dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonStr);
    var savePath = folder + '/' + filename + '.json';

    chrome.downloads.download(
      {
        url: dataUrl,
        filename: savePath,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      function (downloadId) {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError.message);
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

/**
 * Delay helper.
 */
function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * Send progress update to popup (ignore if closed).
 */
function sendProgress(data) {
  try {
    chrome.runtime.sendMessage(data);
  } catch (e) {
    // Popup may be closed
  }
}

/**
 * Message listener for download requests.
 */
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.action === 'openFolder') {
    var targetFolder = message.folder || '';
    if (mainFolderDownloadId) {
      chrome.downloads.show(mainFolderDownloadId);
      sendResponse({ success: true });
    } else if (targetFolder) {
      chrome.downloads.search({ limit: 50 }, function (items) {
        var matchedItem = null;
        if (items && items.length > 0) {
          // Priority 1: Search for the .txt file directly under the main folder
          for (var i = 0; i < items.length; i++) {
            if (items[i].filename && items[i].filename.indexOf(targetFolder) !== -1) {
              if (items[i].filename.indexOf('.txt') !== -1) {
                matchedItem = items[i];
                break;
              }
            }
          }
          // Priority 2: Fallback to any file in that folder
          if (!matchedItem) {
            for (var j = 0; j < items.length; j++) {
              if (items[j].filename && items[j].filename.indexOf(targetFolder) !== -1) {
                matchedItem = items[j];
                break;
              }
            }
          }
        }
        if (matchedItem) {
          chrome.downloads.show(matchedItem.id);
        } else {
          chrome.downloads.showDefaultFolder();
        }
        sendResponse({ success: true });
      });
    } else {
      chrome.downloads.showDefaultFolder();
      sendResponse({ success: true });
    }
    return true;
  }

  if (message.action === 'copyFolderPath') {
    var targetFolder = message.folder || '';
    if (targetFolder) {
      chrome.downloads.search({ limit: 50 }, function (items) {
        var matchedItem = null;
        if (items && items.length > 0) {
          for (var i = 0; i < items.length; i++) {
            if (items[i].filename && items[i].filename.indexOf(targetFolder) !== -1) {
              if (items[i].filename.indexOf('.txt') !== -1) {
                matchedItem = items[i];
                break;
              }
            }
          }
          if (!matchedItem) {
            for (var j = 0; j < items.length; j++) {
              if (items[j].filename && items[j].filename.indexOf(targetFolder) !== -1) {
                matchedItem = items[j];
                break;
              }
            }
          }
        }
        if (matchedItem) {
          var fName = matchedItem.filename;
          var idx = fName.indexOf(targetFolder);
          if (idx !== -1) {
            var rootPath = fName.substring(0, idx + targetFolder.length);
            sendResponse({ success: true, path: rootPath });
            return;
          }
        }
        sendResponse({ success: false, error: '找不到对应文件路径，可能已被移动或未下载' });
      });
    } else {
      sendResponse({ success: false, error: '暂无文件夹信息' });
    }
    return true;
  }

  if (message.action === 'downloadAll') {
    mainFolderDownloadId = null; // Reset for new download batch
    var data = message.data;
    var folder = message.folder;

    (async function () {
      var isAuth = await verifyLicenseBackground();
      if (!isAuth) {
        sendResponse({ success: false, failed: 0, completed: 0, error: 'Auth failed' });
        return;
      }

      var completed = 0;
      var failed = 0;

      // --- Step 1: Create txt file and optional SKU JSON file ---
      var rawBaseName = (data.title || 'product_info')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
        .replace(/\s+/g, '_')
        .trim() || 'product_info';

      try {
        var txtContent = '\u6807\u9898\uff1a' + (data.title || '') + '\r\n\u7f51\u5740\uff1a' + (data.pageUrl || '');
        var txtFilename = '1.' + rawBaseName;

        await downloadTxtFile(txtContent, folder, txtFilename);
        completed++;
      } catch (err) {
        failed++;
      }

      if (data.skuData) {
        try {
          var skuFolder = folder + '/2.sku';
          var jsonFilename = '1.' + rawBaseName + '_SKU\u6570\u636e';
          await downloadJsonFile(data.skuData, skuFolder, jsonFilename);
          completed++;
        } catch (err) {
          failed++;
        }
      }

      // --- Step 2: Collect all image tasks ---
      var tasks = [];
      var categories = [
        { items: data.gallery || [], subfolder: '1.gallery' },
        { items: data.sku || [], subfolder: '2.sku' },
        { items: data.detail || [], subfolder: '3.detail' }
      ];

      for (var c = 0; c < categories.length; c++) {
        var cat = categories[c];
        var catItems = cat.items;
        var catFolder = folder + '/' + cat.subfolder;
        for (var i = 0; i < catItems.length; i++) {
          tasks.push({
            url: catItems[i].url,
            folder: catFolder,
            name: catItems[i].name
          });
        }
      }

      var total = (data.skuData ? 2 : 1) + tasks.length; // +1 for txt file, +1 for JSON if exists

      sendProgress({
        action: 'downloadProgress',
        completed: completed,
        failed: failed,
        total: total,
        phase: 'txt'
      });

      // --- Step 3: 8-Worker High-Speed Concurrent Pool for Images ---
      var CONCURRENCY = 8;
      var taskIndex = 0;

      async function worker() {
        while (taskIndex < tasks.length) {
          var currTask = tasks[taskIndex++];
          try {
            await downloadImage(currTask.url, currTask.folder, currTask.name);
            completed++;
          } catch (err) {
            failed++;
          }

          sendProgress({
            action: 'downloadProgress',
            completed: completed,
            failed: failed,
            total: total,
            phase: currTask.name
          });
        }
      }

      var workers = [];
      for (var w = 0; w < Math.min(CONCURRENCY, tasks.length); w++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      // --- Done ---
      sendProgress({
        action: 'downloadComplete',
        completed: completed,
        failed: failed,
        total: total
      });

      sendResponse({
        success: true,
        completed: completed,
        failed: failed,
        total: total
      });
    })();

    return true; // async sendResponse
  }
});
