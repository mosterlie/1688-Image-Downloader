/**
 * 1688 SKU 采集与解析独立模块 (1688_sku_collector.js)
 * 
 * 专门用于在 1688 商品详情页加载完成后解析全局变量 window.__INIT_DATA
 * 或从 DOM <script> 标签中提取并结构化商品 SKU 矩阵、规格属性及阶梯价格。
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SkuCollector1688 = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 清理图片 URL，剥离 1688 CDN 压缩与缩略图后缀
   */
  function cleanImageUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) {
      url = 'https:' + url;
    }
    return url
      .replace(/\.(jpg|png|gif|jpeg)_[^.]+\.(jpg|png|webp|jpeg)$/gi, '.$1')
      .replace(/\.(jpg|png|gif|jpeg)_.*/gi, '.$1')
      .replace(/_b\.jpg$/i, '.jpg')
      .replace(/_\d+x\d+[^.]*\.(jpg|png|webp|jpeg|gif)/gi, '');
  }

  /**
   * 从给定的 __INIT_DATA 对象或 JSON 字符串中解构全量 SKU 数据
   */
  function parseInitData(initData) {
    if (typeof initData === 'string') {
      try {
        initData = JSON.parse(initData);
      } catch (e) {
        return null;
      }
    }

    if (!initData || typeof initData !== 'object') {
      return null;
    }

    // 适配 1688 多种可能挂载的数据根路径
    var globalData = initData.globalData || initData.data || initData;
    var tempModel = globalData.tempModel || globalData.componentData || globalData;
    var offerDetail = globalData.offerDetail || globalData.productInfo || {};

    // 1. 基础元数据
    var title = globalData.title || offerDetail.title || (tempModel.productTitle ? tempModel.productTitle.title : '') || '';
    var offerId = globalData.offerId || offerDetail.offerId || tempModel.offerId || '';

    // 2. 解析阶梯定价与价格模型
    var priceModel = {
      price: '',
      unit: '元',
      priceRanges: []
    };

    var rawPriceModel = globalData.priceModel || tempModel.priceModel || offerDetail.priceModel || {};
    if (rawPriceModel.price) {
      priceModel.price = String(rawPriceModel.price);
    }

    // 解析阶梯价格区间
    var priceRangeList = rawPriceModel.priceRange || rawPriceModel.priceDisplay || rawPriceModel.priceRanges || [];
    if (Array.isArray(priceRangeList)) {
      priceRangeList.forEach(function (item) {
        if (Array.isArray(item) && item.length >= 2) {
          priceModel.priceRanges.push({
            minQty: parseInt(item[0], 10) || 1,
            price: String(item[1])
          });
        } else if (item && typeof item === 'object') {
          priceModel.priceRanges.push({
            minQty: parseInt(item.startQuantity || item.minQty || item.beginAmount || 1, 10),
            price: String(item.price || item.unitPrice || '')
          });
        }
      });
    }

    // 3. 解析 SKU 规格属性列表 (skuProps)
    var skuProps = [];
    var rawSkuProps = globalData.skuProps || tempModel.skuProps || offerDetail.skuProps || (globalData.skuModel ? globalData.skuModel.skuProps : null) || (tempModel.skuModel ? tempModel.skuModel.skuProps : null) || [];
    if (!Array.isArray(rawSkuProps) && initData.skuProps) rawSkuProps = initData.skuProps;

    if (Array.isArray(rawSkuProps)) {
      rawSkuProps.forEach(function (propItem) {
        var propName = propItem.prop || propItem.name || propItem.attributeName || '';
        var values = [];

        var valList = propItem.value || propItem.values || propItem.attributeValues || [];
        if (Array.isArray(valList)) {
          valList.forEach(function (v) {
            var valName = v.name || v.value || v.nameValue || '';
            var rawImg = v.imageUrl || v.imgUrl || v.imageUrlFull || v.cutFeedUrl || '';
            var cleanImg = cleanImageUrl(rawImg);
            values.push({
              name: valName,
              imageUrl: cleanImg,
              specId: v.specId || v.id || ''
            });
          });
        }

        if (propName && values.length > 0) {
          skuProps.push({
            prop: propName,
            values: values
          });
        }
      });
    }

    // 4. 解析 SKU 组合映射矩阵 (skuVal / skuMap / skuInfoMap / skus)
    var skuMatrix = [];
    var rawSkuVal = globalData.skuVal || globalData.skuMap || globalData.skuInfoMap || tempModel.skuVal || tempModel.skuMap || offerDetail.skuVal || (globalData.skuModel ? (globalData.skuModel.skuVal || globalData.skuModel.skuInfoMap || globalData.skuModel.skus) : null) || {};

    if (rawSkuVal && typeof rawSkuVal === 'object') {
      Object.keys(rawSkuVal).forEach(function (key) {
        var item = rawSkuVal[key];
        if (!item || typeof item !== 'object') return;

        var skuId = item.skuId || item.id || key;
        var price = item.price || item.discountPrice || item.skuPrice || priceModel.price || '';
        var stock = item.canBookCount !== undefined ? item.canBookCount : (item.stock !== undefined ? item.stock : (item.saleCount || 0));
        var cargoNumber = item.cargoNumber || item.articleNo || item.skuCode || '';
        var specId = item.specId || item.specAttrs || key;

        var cleanKey = key.replace(/&gt;/g, '&');
        
        // Find matching image and name from skuProps
        var matchedImageUrl = '';
        var matchedImageName = '';
        var keyParts = cleanKey.split('&');
        
        if (skuProps && skuProps.length > 0) {
          for (var pIdx = 0; pIdx < skuProps.length; pIdx++) {
            var propValues = skuProps[pIdx].values || [];
            for (var vIdx = 0; vIdx < propValues.length; vIdx++) {
              var val = propValues[vIdx];
              if (val.imageUrl && keyParts.indexOf(val.name) !== -1) {
                matchedImageUrl = val.imageUrl;
                matchedImageName = val.name;
                break;
              }
            }
            if (matchedImageUrl) break;
          }
        }

        skuMatrix.push({
          skuId: String(skuId),
          specAttributes: cleanKey, // 例: "颜色&尺码" 或 "黑色&XL"
          price: String(price),
          stock: parseInt(stock, 10) || 0,
          cargoNumber: String(cargoNumber),
          specId: String(specId),
          skuImageUrl: matchedImageUrl,
          skuImageName: matchedImageName
        });
      });
    }

    // 若未显式挂载 skuMatrix 组合项，但解析到了多维度 skuProps，自动自动触发笛卡尔积全量矩阵计算！
    if (skuMatrix.length === 0 && skuProps.length > 0) {
      skuMatrix = generateCartesianMatrix(skuProps, priceModel);
    }
    
    // 按照页面原始 skuProps 中定义的维度顺序进行层级排序 (如：颜色优先，其次尺码)
    if (skuMatrix && skuMatrix.length > 0) {
      var sortIndices = {};
      if (skuProps && skuProps.length > 0) {
        skuProps.forEach(function(prop, dimIndex) {
          var values = prop.values || [];
          sortIndices[dimIndex] = {};
          values.forEach(function(val, valIndex) {
            if (val.name) {
              sortIndices[dimIndex][val.name] = valIndex;
            }
          });
        });
      }

      skuMatrix.sort(function(a, b) {
        if (skuProps && skuProps.length > 0) {
          var aSpecs = (a.specAttributes || '').split('&');
          var bSpecs = (b.specAttributes || '').split('&');
          
          for (var i = 0; i < skuProps.length; i++) {
            var aVal = aSpecs[i] || '';
            var bVal = bSpecs[i] || '';
            var aIndex = (sortIndices[i] && sortIndices[i][aVal] !== undefined) ? sortIndices[i][aVal] : 9999;
            var bIndex = (sortIndices[i] && sortIndices[i][bVal] !== undefined) ? sortIndices[i][bVal] : 9999;
            
            if (aIndex !== bIndex) {
              return aIndex - bIndex;
            }
          }
        }
        
        // 如果属性完全一样或不存在，回退到按 skuId 升序兜底
        return (a.skuId || '').localeCompare(b.skuId || '', undefined, {numeric: true});
      });
    }

    return {
      title: title,
      offerId: String(offerId),
      priceModel: priceModel,
      skuProps: skuProps,
      skuMatrix: skuMatrix,
      summary: {
        propDimensions: skuProps.length,
        totalSkus: skuMatrix.length,
        priceTierCount: priceModel.priceRanges.length
      }
    };
  }

  /**
   * 计算多维度 SKU 属性的笛卡尔全量矩阵组合 (Dim 1 × Dim 2 × ... × Dim N)
   */
  function generateCartesianMatrix(skuProps, priceModel) {
    if (!Array.isArray(skuProps) || skuProps.length === 0) {
      return [];
    }

    var validDims = skuProps.map(function (propItem) {
      var pName = propItem.prop || propItem.name || '规格';
      var rawVals = propItem.values || propItem.value || [];
      var cleanVals = [];

      if (Array.isArray(rawVals)) {
        rawVals.forEach(function (v) {
          var name = typeof v === 'string' ? v : (v.name || v.value || '');
          var img = typeof v === 'object' ? (v.imageUrl || v.imgUrl || '') : '';
          var specId = typeof v === 'object' ? (v.specId || v.id || '') : '';
          if (name) {
            cleanVals.push({ name: name, imageUrl: img, specId: specId });
          }
        });
      }

      return { propName: pName, values: cleanVals };
    }).filter(function (dim) { return dim.values.length > 0; });

    if (validDims.length === 0) return [];

    function cartesian(args) {
      var r = [];
      var max = args.length - 1;
      function helper(arr, i) {
        for (var j = 0, l = args[i].values.length; j < l; j++) {
          var a = arr.slice(0);
          a.push({
            propName: args[i].propName,
            valName: args[i].values[j].name,
            imageUrl: args[i].values[j].imageUrl,
            specId: args[i].values[j].specId,
            price: args[i].values[j].price || '',
            stock: args[i].values[j].stock || 0
          });
          if (i === max) r.push(a);
          else helper(a, i + 1);
        }
      }
      helper([], 0);
      return r;
    }

    var combos = cartesian(validDims);
    var defaultPrice = priceModel ? (priceModel.price || '') : '';

    return combos.map(function (combo, index) {
      var specAttrs = combo.map(function (c) { return c.valName; }).join('&');
      var mainImg = '';
      var mainImgName = '';
      var comboPrice = '';
      var comboStock = 0;
      combo.forEach(function (c) {
        if (c.imageUrl && !mainImg) {
          mainImg = c.imageUrl;
          mainImgName = c.valName;
        }
        if (c.price && !comboPrice) comboPrice = c.price;
        if (c.stock && !comboStock) comboStock = c.stock;
      });

      return {
        skuId: String(index + 1),
        specAttributes: specAttrs,
        price: comboPrice || String(defaultPrice),
        stock: comboStock,
        cargoNumber: '',
        specId: String(index + 1),
        skuImageUrl: mainImg,
        skuImageName: mainImgName
      };
    });
  }

  /**
   * 动态向 Main World 注入脚本以提取主窗口 window.__INIT_DATA 对象
   */
  function getInitDataFromMainWorld() {
    if (typeof document === 'undefined') return null;
    try {
      var script = document.createElement('script');
      script.textContent = `
        (function() {
          try {
            var data = window.__INIT_DATA || window._pageData || window.__i18nData || window.detailData || null;
            if (data) {
              document.documentElement.setAttribute('data-1688-init-data', JSON.stringify(data));
            }
          } catch(e) {}
        })();
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();

      var raw = document.documentElement.getAttribute('data-1688-init-data');
      if (raw) {
        document.documentElement.removeAttribute('data-1688-init-data');
        return JSON.parse(raw);
      }
    } catch (e) {
      // 捕获权限异常
    }
    return null;
  }

  /**
   * 从 DOM 的 <script> 标签中正则表达式提取 window.__INIT_DATA
   */
  function extractInitDataFromDom() {
    if (typeof document === 'undefined') return null;

    function extractJsonBlock(text, key) {
      var searchStr = '"' + key + '"';
      var keyIndex = text.indexOf(searchStr);
      if (keyIndex === -1) return null;
      var colonIndex = text.indexOf(':', keyIndex + searchStr.length);
      if (colonIndex === -1) return null;
      
      var startBracketIndex = -1;
      var bracketType = '';
      var closingBracket = '';
      
      for (var i = colonIndex + 1; i < text.length; i++) {
        var char = text.charAt(i);
        if (char === ' ' || char === '\t' || char === '\n' || char === '\r') continue;
        if (char === '{') {
          startBracketIndex = i;
          bracketType = '{'; closingBracket = '}';
          break;
        }
        if (char === '[') {
          startBracketIndex = i;
          bracketType = '['; closingBracket = ']';
          break;
        }
        break;
      }
      
      if (startBracketIndex === -1) return null;
      
      var bracketCount = 0;
      var inString = false;
      var escapeNext = false;
      
      for (var j = startBracketIndex; j < text.length; j++) {
        var c = text.charAt(j);
        if (escapeNext) { escapeNext = false; continue; }
        if (c === '\\') { escapeNext = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (!inString) {
          if (c === bracketType) bracketCount++;
          else if (c === closingBracket) {
            bracketCount--;
            if (bracketCount === 0) return text.substring(startBracketIndex, j + 1);
          }
        }
      }
      return null;
    }

    var scripts = document.querySelectorAll('script');
    
    // First pass: look for __INIT_DATA or globalData specifically
    for (var i = 0; i < scripts.length; i++) {
      var content = scripts[i].textContent || '';
      if (content.includes('__INIT_DATA')) {
        var match = content.match(/(?:window\.)?__INIT_DATA\s*=\s*(\{[\s\S]*?\n?\s*\});?/);
        if (match && match[1]) {
          try {
            return JSON.parse(match[1]);
          } catch (e) {}
        }
      }
    }
    
    // Second pass: deep extraction of skuModel and skuInfoMap (1688 newer format)
    try {
      var html = document.documentElement.outerHTML || document.documentElement.innerHTML || document.body.innerHTML || '';
      if (html.includes('skuModel') || html.includes('skuInfoMap')) {
        var mockData = { globalData: { skuModel: {} } };
        var foundAny = false;
        
        var skuInfoMapStr = extractJsonBlock(html, 'skuInfoMap');
        if (skuInfoMapStr) {
          mockData.globalData.skuModel.skuInfoMap = JSON.parse(skuInfoMapStr);
          foundAny = true;
        }
        
        var skuPropsStr = extractJsonBlock(html, 'skuProps');
        if (skuPropsStr) {
          mockData.globalData.skuModel.skuProps = JSON.parse(skuPropsStr);
          foundAny = true;
        }
        
        if (foundAny) {
          return mockData;
        }
      }
    } catch (e) {
      // ignore
    }
    
    return null;
  }

  /**
   * 自动就绪检测并提取 SKU 数据
   * @param {Object} options 包含 maxWaitMs (默认 3000ms), intervalMs (默认 200ms)
   * @returns {Promise<Object>} 解析后的标准化 SKU 对象
   */
  function collect(options) {
    options = options || {};
    var maxWaitMs = options.maxWaitMs || 3000;
    var intervalMs = options.intervalMs || 200;

    return new Promise(function (resolve) {
      var startTime = Date.now();

      function check() {
        var initData = null;

        // 1. 尝试从 Window 变量提取
        if (typeof window !== 'undefined' && window.__INIT_DATA) {
          initData = window.__INIT_DATA;
        }

        // 2. 尝试向 Main World 注入以读取主页面全局变量
        if (!initData) {
          initData = getInitDataFromMainWorld();
        }

        // 3. 尝试从 DOM 脚本匹配提取
        if (!initData) {
          initData = extractInitDataFromDom();
        }

        if (initData) {
          var parsed = parseInitData(initData);
          if (parsed && (parsed.skuProps.length > 0 || parsed.skuMatrix.length > 0)) {
            resolve({ success: true, data: parsed });
            return;
          }
        }

        if (Date.now() - startTime >= maxWaitMs) {
          // 超时兜底尝试最后一次提取
          if (initData) {
            resolve({ success: true, data: parseInitData(initData) });
          } else {
            resolve({ success: false, error: 'TIMEOUT_INIT_DATA_NOT_FOUND', data: null });
          }
          return;
        }

        setTimeout(check, intervalMs);
      }

      check();
    });
  }

  return {
    parseInitData: parseInitData,
    extractInitDataFromDom: extractInitDataFromDom,
    generateCartesianMatrix: generateCartesianMatrix,
    collect: collect
  };
}));
