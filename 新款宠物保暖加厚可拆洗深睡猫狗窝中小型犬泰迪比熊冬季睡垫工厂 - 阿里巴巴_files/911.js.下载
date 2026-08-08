(function (d) {
    try {
        var records = {};
        var selectors = [
            { selector: '.ap-ext-1688', target: 'aliprice', log: '/WORK_Ying_Xiao.1688_smart_assistant.install_aliprice', desc: 'AliPrice插件' },
            { selector: '#zzb_rightSoutuBtn2', target: 'zzb', log: '/WORK_Ying_Xiao.1688_smart_assistant.install_zzb', desc: '至尊宝插件' },
            { selector: '#zzb-tb1688DetailAreaNew', target: 'zzb', log: '/WORK_Ying_Xiao.1688_smart_assistant.install_zzb', desc: '至尊宝插件' },
            { selector: '.hsq-tooltip__trigger', target: 'hsq', log: '/WORK_Ying_Xiao.1688_smart_assistant.install_hsq', desc: '哈士奇插件' },
            { selector: '#Offer', target: 'dts', log: '/WORK_Ying_Xiao.1688_smart_assistant.install_dts', desc: '店透视插件' },
            { selector: '#Offer_dts', target: 'dts', log: '/WORK_Ying_Xiao.1688_smart_assistant.install_dts', desc: '店透视插件' },
            { selector: '[id="1688-extension-entry"]', target: 'haobangshou', log: '/WORK_Ying_Xiao.1688_smart_assistant.install_haobangshou', desc: '1688官方插件' },
            { selector: '[id="market-mate-for-1688"]', target: 'haobangshou', log: '/WORK_Ying_Xiao.1688_smart_assistant.install_haobangshou', desc: '1688官方插件' },
            { selector: '.sellersprite-check-sales-anchor', target: 'mjjl_bjzs', log: '/WORK_Ying_Xiao.1688_smart_assistant.install_mjjl_bjzs', desc: '卖家精灵-比价助手插件' },
            { selector: 'input[name="1688-aibuy-extension"]', target: 'aibuy', log: '/WORK_Ying_Xiao.1688_smart_assistant.install_aibuy', desc: 'AIBUY插件' },
            { selector: 'div[data-wxt-integrated]', target: 'mserp', log: '/WORK_Ying_Xiao.1688_smart_assistant.install_mserp', desc: '妙手插件' },
        ];
    
        function slog(log, desc) {
            console.warn('success:', log);

            if (Object.prototype.hasOwnProperty.call(records, log)) {
                return;
            }

            records[log] = true;

            try {
                window.dispatchEvent(new CustomEvent('pcPluginActiveMessage', {
                    detail: {
                        type: "pluginActive",
                        plugin: log.split('.')[2],
                        desc: desc
                    }
                }));   
            } catch (e) {
                console.warn(e);
            }

            if (window.goldlog) {
                window.goldlog.record(
                    log,
                    'EXP',
                    '',
                    'GET'
                );
            }
        }
    
        function precheck() {
            return selectors.filter((selectorConfig) => {
                var injected = document.querySelector(selectorConfig.selector);
                if (injected) {
                    slog(selectorConfig.log, selectorConfig.desc);
                }
                return !injected;
            });
        }
    
        var b = document.querySelector("\u0023\u0061\u0070\u002d\u0063\u0075\u0073\u0074\u006f\u006d\u002d\u0073\u0074\u0079\u006c\u0065");
        if(b){
            b.remove();
        }
    
        selectors = precheck();
    
        function cb(mutations) {
            mutations.forEach(mutation => {
                if (mutation.addedNodes.length) {
                    for (let i = 0; i < mutation.addedNodes.length; i++) {
                        const addedNode = mutation.addedNodes[i];
                        if (addedNode.nodeType === Node.ELEMENT_NODE) {
                            selectors.some((selectorConfig) => {
                                if (addedNode.matches(selectorConfig.selector)) {
                                    slog(selectorConfig.log, selectorConfig.desc);
                                }
                            });
                            if(addedNode.matches("\u0023\u0061\u0070\u002d\u0063\u0075\u0073\u0074\u006f\u006d\u002d\u0073\u0074\u0079\u006c\u0065")){
                                addedNode.remove();
                            }
                        }
                    }
                }
            });
        }
    
        var __observer__ = new MutationObserver(cb);
        try {
            __observer__.observe(d, { childList: true, subtree: true });
        } catch (error) {
            console.warn(error);
        }
  
        function handleCustomEvent (e) {
            if (e.detail && e.detail.type === 'register' && e.detail.name === 'geekbi') {
                slog('/WORK_Ying_Xiao.1688_smart_assistant.install_jjy', '极鲸云下属插件（Temu选品助手、Shein选品助手等）');
            }
        }
  
        window.addEventListener('service-plugin-dock-event', handleCustomEvent);
    
        setTimeout(() => {
            __observer__.disconnect();
            window.removeEventListener('service-plugin-dock-event', handleCustomEvent)
        }, 60000);
    } catch (e) {
        console.warn(e);
    }
  })(document);