// ==UserScript==
// @name         小红书自动跳转App
// @namespace    xhs-auto-open
// @version      3.6
// @description  全自动免手动点击打开小红书App查看笔记、用户主页；完美支持 Telegram 推送的 oia 直链与普通网页直达；彻底净化安全拦截参数防转圈假死；全屏触控秒开兜底并自动关闭当前标签页
// @author       RatedR9 & Antigravity
// @match        *://www.xiaohongshu.com/*
// @match        *://xiaohongshu.com/*
// @match        *://*.xiaohongshu.com/*
// @match        *://xhslink.com/*
// @match        *://*.xhslink.com/*
// @match        *://rednote.com/*
// @match        *://*.rednote.com/*
// @run-at       document-start
// @grant        window.close
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  let isClosing = false;
  let hasLaunched = false;
  let activeDeepLink = null;

  // ── 0. 安全关闭当前标签页 ───────────────────────────────────────────────────
  function safeCloseTab() {
    if (isClosing) return;
    isClosing = true;

    // 0.1 Tampermonkey 高权限接口
    try {
      window.close();
    } catch (_) {}

    // 0.2 原生窗口对象
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow.close) {
        unsafeWindow.close();
      }
    } catch (_) {}

    // 0.3 移动端沙箱逃逸
    try {
      window.open('', '_self', '');
      window.close();
    } catch (_) {}
  }

  // 监听切到后台后自动秒关当前标签页
  function setupAppSwitchCloser() {
    const onAppSwitched = () => {
      if (document.hidden) {
        safeCloseTab();
        document.removeEventListener('visibilitychange', onAppSwitched);
      }
    };
    document.addEventListener('visibilitychange', onAppSwitched);
    window.addEventListener('pagehide', safeCloseTab, { once: true });

    // 延时兜底关闭（针对部分 Android 浏览器切出时不触发 visibilitychange 的情况）
    setTimeout(() => {
      if (document.hidden) {
        safeCloseTab();
      }
    }, 1500);
  }

  // ── 1. 深度提取 Direct DeepLink (优先捕获 Telegram 推送的 oia 链接) ───────
  function extractDirectDeepLink() {
    try {
      const searchParams = new URLSearchParams(location.search);
      let rawDeepLink = searchParams.get('deeplink');

      if (!rawDeepLink && location.search.includes('deeplink=')) {
        const m = location.search.match(/[?&]deeplink=([^&]+)/);
        if (m) rawDeepLink = decodeURIComponent(m[1]);
      }

      if (rawDeepLink) {
        try {
          const decoded = decodeURIComponent(rawDeepLink);
          if (decoded.startsWith('xhsdiscover://')) {
            // 解析并彻底净化毒药参数
            const qIdx = decoded.indexOf('?');
            let base = decoded;
            let query = '';
            if (qIdx !== -1) {
              base = decoded.substring(0, qIdx);
              const qStr = decoded.substring(qIdx + 1);
              const p = new URLSearchParams(qStr);

              // 剔除导致转圈假死的毒药参数
              ['source', 'xsec_source', 'originalUrl', 'redirectPath', 'redirect_url', 'error_code'].forEach(k => {
                if (p.get(k) === 'xhs_sec_server' || k === 'originalUrl' || k === 'redirectPath') {
                  p.delete(k);
                }
              });

              if (!p.has('ug_dp_source')) p.set('ug_dp_source', 'share');
              query = p.toString() ? `?${p.toString()}` : '';
            } else {
              query = '?ug_dp_source=share';
            }
            return `${base}${query}`;
          }
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  // ── 2. 深度提取 Target (Note ID / User ID) ─────────────────────────────────
  function extractTarget() {
    const pathname = location.pathname;

    // 2.1 用户主页
    const userMatch = pathname.match(/\/user\/profile\/([a-f0-9]{24})/i);
    if (userMatch) return { type: 'user', id: userMatch[1] };

    // 2.2 笔记 Pathname（如 /explore/xxx, /discovery/item/xxx, /item/xxx, /share/xxx）
    const noteMatch = pathname.match(/(?:explore|item|discovery\/item|share)\/([a-f0-9]{24})/i);
    if (noteMatch) return { type: 'note', id: noteMatch[1] };

    // 2.3 404安全拦截页 /404/sec_xxx：从 redirectPath 或 originalUrl 提取
    const searchMatch = location.search.match(/[?&](?:originalUrl|redirectPath|redirect_url|note_?id|target_?id|id)=([^&]+)/i);
    if (searchMatch) {
      try {
        const decoded = decodeURIComponent(searchMatch[1]);
        const idMatch = decoded.match(/([a-f0-9]{24})/i);
        if (idMatch) return { type: 'note', id: idMatch[1] };
      } catch (_) {}
    }

    // 2.4 从 window.__INITIAL_STATE__ 恢复
    try {
      const state = win.__INITIAL_STATE__ || win.__INITIAL_SSR_STATE__ || window.__INITIAL_STATE__;
      if (state) {
        if (state.note?.currentNoteId) return { type: 'note', id: state.note.currentNoteId };
        if (state.noteData?.data?.noteData?.id) return { type: 'note', id: state.noteData.data.noteData.id };
        if (state.noteData?.data?.noteData?.noteId) return { type: 'note', id: state.noteData.data.noteData.noteId };

        const origUrl = state.noteData?.routeQuery?.originalUrl ||
                        state.noteData?.routeQuery?.redirectPath ||
                        state.routeQuery?.originalUrl;
        if (origUrl) {
          const m = String(origUrl).match(/([a-f0-9]{24})/i);
          if (m) return { type: 'note', id: m[1] };
        }
      }
    } catch (_) {}

    // 2.5 URL 全文正则 fallback
    const urlMatch = location.href.match(/(?:[a-f0-9]{24})/i);
    if (urlMatch) return { type: 'note', id: urlMatch[0] };

    return null;
  }

  // ── 3. 全量提取并恢复鉴权参数（过滤阻断性毒药参数） ─────────────────────────
  function extractAllParams() {
    const params = new URLSearchParams(location.search);

    // 3.1 拦截页 originalUrl / redirectPath 二次释放
    try {
      const origRaw = params.get('originalUrl') || params.get('redirectPath');
      if (origRaw) {
        const u = new URL(decodeURIComponent(origRaw), location.href);
        u.searchParams.forEach((val, key) => {
          if (!params.has(key)) params.set(key, val);
        });
      }
    } catch (_) {}

    // 3.2 从 window.__INITIAL_STATE__ 提取参数
    try {
      const state = win.__INITIAL_STATE__ || win.__INITIAL_SSR_STATE__ || window.__INITIAL_STATE__;
      if (state) {
        const origUrl = state.noteData?.routeQuery?.originalUrl ||
                        state.noteData?.routeQuery?.redirectPath ||
                        state.routeQuery?.originalUrl;
        if (origUrl) {
          try {
            const u = new URL(origUrl, location.href);
            u.searchParams.forEach((val, key) => {
              if (!params.has(key)) params.set(key, val);
            });
          } catch (_) {}
        }

        const xsecToken = state.noteData?.data?.noteData?.xsecToken ||
                          state.noteData?.xsecToken ||
                          state.note?.xsecToken;
        if (xsecToken && !params.has('xsec_token')) {
          params.set('xsec_token', xsecToken);
        }

        const xsecSource = state.noteData?.data?.noteData?.xsecSource ||
                           state.note?.xsecSource;
        if (xsecSource && xsecSource !== 'xhs_sec_server' && !params.has('xsec_source')) {
          params.set('xsec_source', xsecSource);
        }
      }
    } catch (_) {}

    // 3.3 严格剔除安全拦截页带来的污染参数
    const POISON_KEYS = ['originalUrl', 'redirectPath', 'redirect_url', 'error_code'];
    POISON_KEYS.forEach(k => params.delete(k));

    if (params.get('source') === 'xhs_sec_server') params.delete('source');
    if (params.get('xsec_source') === 'xhs_sec_server') params.delete('xsec_source');

    // 必须标记外部分享来源
    if (!params.has('ug_dp_source')) params.set('ug_dp_source', 'share');

    return params;
  }

  // ── 4. 构造完整唤起 DeepLink 与 Android Intent ─────────────────────────────
  function resolveDeepLink() {
    // 4.1 优先提取 Telegram 推送的直连 deeplink
    const direct = extractDirectDeepLink();
    if (direct) return direct;

    // 4.2 从页面 Target 动态组装
    const target = extractTarget();
    if (!target) return null;

    const params = extractAllParams();
    const query = params.toString();
    const queryStr = query ? `?${query}` : '';

    if (target.type === 'user') {
      return `xhsdiscover://user/${target.id}${queryStr}`;
    }

    let isVideo = false;
    try {
      if (location.pathname.includes('/video/') || location.search.includes('type=video')) {
        isVideo = true;
      }
      const state = win.__INITIAL_STATE__ || win.__INITIAL_SSR_STATE__ || window.__INITIAL_STATE__;
      if (state?.noteData?.data?.noteData?.type === 'video' || state?.noteData?.note?.type === 'video') {
        isVideo = true;
      }
    } catch (_) {}

    const prefix = isVideo ? 'xhsdiscover://video_feed/' : 'xhsdiscover://item/';
    return `${prefix}${target.id}${queryStr}`;
  }

  function buildAndroidIntent(deepLink) {
    if (!deepLink) return '';
    try {
      const stripped = deepLink.replace(/^xhsdiscover:\/\//, '');
      return `intent://${stripped}#Intent;scheme=xhsdiscover;package=com.xingin.xhs;category=android.intent.category.BROWSABLE;end;`;
    } catch (_) {
      return '';
    }
  }

  // ── 5. 全事件模拟点击引擎（突破 Vue/React 移动端触摸监听） ──────────────────
  function simulateFullClick(element) {
    if (!element) return;
    try {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      // Pointer Events
      try {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      } catch (_) {}

      // Touch Events
      try {
        if (typeof Touch !== 'undefined' && typeof TouchEvent !== 'undefined') {
          const touch = new Touch({ identifier: Date.now(), target: element, clientX: x, clientY: y, screenX: x, screenY: y });
          element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
          element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [touch] }));
        }
      } catch (_) {}

      // Mouse Events & Click
      try {
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      } catch (_) {}

      element.click();
    } catch (_) {
      try {
        element.click();
      } catch (_) {}
    }
  }

  // ── 6. 核心击发引擎（多协议并发拉起，绝不跳转死页面） ───────────────────────
  function executeAppLaunch(deepLink, autoClose = true) {
    if (!deepLink) return;
    activeDeepLink = deepLink;
    hasLaunched = true;

    // 6.1 主通道：原生私有协议 xhsdiscover:// 击发
    try {
      window.location.href = deepLink;
    } catch (_) {
      try {
        window.location.replace(deepLink);
      } catch (_) {}
    }

    // 6.2 隐式 <a> 标签击发
    try {
      const a = document.createElement('a');
      a.href = deepLink;
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
    } catch (_) {}

    // 6.3 针对 Android 浏览器的 Intent 协议兜底
    if (navigator.userAgent.includes('Android')) {
      const intentUrl = buildAndroidIntent(deepLink);
      if (intentUrl) {
        setTimeout(() => {
          if (!document.hidden) {
            try {
              const aIntent = document.createElement('a');
              aIntent.href = intentUrl;
              aIntent.style.display = 'none';
              (document.body || document.documentElement).appendChild(aIntent);
              aIntent.click();
              setTimeout(() => aIntent.remove(), 1000);
            } catch (_) {}
          }
        }, 350);
      }
    }

    // 6.4 调度切出后自动关闭标签页
    if (autoClose) {
      setupAppSwitchCloser();
    }
  }

  // ── 7. 接管并改写页面原生按钮（oia / 拦截页 / 笔记详情） ──────────────────
  function hijackNativeButtons(deepLink) {
    if (!deepLink) return;

    // 7.1 oia 官方落地页特殊元素
    const oiaInBrowser = document.getElementById('in-browser');
    if (oiaInBrowser) {
      oiaInBrowser.href = deepLink;
      oiaInBrowser.onclick = (e) => {
        e.preventDefault();
        executeAppLaunch(deepLink, true);
      };
      simulateFullClick(oiaInBrowser);
    }

    const downloadBtn = document.getElementById('download_btn');
    if (downloadBtn) {
      downloadBtn.onclick = (e) => {
        e.preventDefault();
        executeAppLaunch(deepLink, true);
      };
    }

    // 7.2 详情页与拦截页原生按钮
    const targetTexts = ['打开 APP 查看', 'App内打开', '直接在 App 内打开', '打开APP查看', '打开 App 查看', '立即打开'];
    const candidates = document.querySelectorAll('button, div[class*="bottom-btn"], .bottom-btn, .reds-button, a, div[role="button"]');

    for (const el of candidates) {
      const txt = (el.textContent || '').trim();
      if (targetTexts.some(t => txt.includes(t))) {
        if (el.tagName.toLowerCase() === 'a') {
          el.href = deepLink;
        }
        el.onclick = (e) => {
          e.preventDefault();
          executeAppLaunch(deepLink, true);
        };
        simulateFullClick(el);
      }
    }
  }

  // ── 8. 全屏触控秒开兜底（解决 Chromium 内核强阻断 isTrusted:false） ────────
  function setupGlobalTouchShield(deepLink) {
    if (!deepLink) return;

    const onUserTouchAnywhere = () => {
      executeAppLaunch(deepLink, true);
    };

    // 在捕获阶段绑定，无论用户碰触屏幕任意像素，立即秒开 App 并关闭页面
    window.addEventListener('touchstart', onUserTouchAnywhere, { capture: true, once: true });
    window.addEventListener('pointerdown', onUserTouchAnywhere, { capture: true, once: true });
    window.addEventListener('click', onUserTouchAnywhere, { capture: true, once: true });
  }

  // ── 9. 注入轻量状态辅助条 ─────────────────────────────────────────────────
  function injectHelperBar(deepLink, targetId) {
    if (!deepLink || document.getElementById('xhs-auto-jump-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'xhs-auto-jump-banner';
    banner.style.cssText = [
      'position: fixed',
      'bottom: 12px',
      'left: 50%',
      'transform: translateX(-50%)',
      'width: calc(100% - 32px)',
      'max-width: 480px',
      'background: rgba(255, 36, 66, 0.96)',
      'backdrop-filter: blur(10px)',
      'color: #ffffff',
      'padding: 12px 16px',
      'border-radius: 16px',
      'box-shadow: 0 8px 32px rgba(255, 36, 66, 0.35)',
      'z-index: 9999999',
      'display: flex',
      'flex-direction: column',
      'gap: 8px',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'box-sizing: border-box'
    ].join(';');

    const searchScheme = targetId ? `xhsdiscover://search/result?keyword=${encodeURIComponent(targetId)}` : deepLink;

    banner.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:14px; font-weight:600; letter-spacing:0.3px;">⚡ 正在为你秒开小红书 App...</span>
        <span id="xhs-banner-close" style="font-size:16px; cursor:pointer; opacity:0.8; padding:0 4px;">✕</span>
      </div>
      <div style="display:flex; gap:8px;">
        <button id="xhs-btn-open-app" style="flex:1; height:38px; border:none; border-radius:10px; background:#fff; color:#ff2442; font-size:13px; font-weight:bold; cursor:pointer;">
          📱 点击立即打开 App
        </button>
        <button id="xhs-btn-search-app" style="flex:1; height:38px; border:1px solid rgba(255,255,255,0.7); border-radius:10px; background:transparent; color:#fff; font-size:13px; font-weight:bold; cursor:pointer;">
          🔍 精准搜索(免转圈)
        </button>
      </div>
    `;

    (document.body || document.documentElement).appendChild(banner);

    document.getElementById('xhs-banner-close')?.addEventListener('click', () => banner.remove());
    document.getElementById('xhs-btn-open-app')?.addEventListener('click', () => {
      const btn = document.getElementById('xhs-btn-open-app');
      if (btn) btn.textContent = '🚀 打开中并关闭...';
      executeAppLaunch(deepLink, true);
    });
    document.getElementById('xhs-btn-search-app')?.addEventListener('click', () => {
      const btn = document.getElementById('xhs-btn-search-app');
      if (btn) btn.textContent = '🔍 搜索中并关闭...';
      try {
        window.location.href = searchScheme;
      } catch (_) {}
      setupAppSwitchCloser();
    });
  }

  // ── 10. 全生命周期自驱动调度 ──────────────────────────────────────────────
  function runAutoJump() {
    const deepLink = resolveDeepLink();
    if (!deepLink) return;

    // 10.1 如果尚未击发，立即在当前阶段直接拉起
    if (!hasLaunched) {
      executeAppLaunch(deepLink, true);
    }

    // 10.2 接管所有原生按钮
    hijackNativeButtons(deepLink);

    // 10.3 挂载全屏触控拦截
    setupGlobalTouchShield(deepLink);

    // 10.4 注入辅助条
    const target = extractTarget();
    injectHelperBar(deepLink, target?.id || '');
  }

  // 阶段 1：document-start 立即触发（趁上下文活跃抢先直达）
  runAutoJump();

  // 阶段 2：DOM 加载与异步节点监听
  function setupDomWatchers() {
    runAutoJump();

    const observer = new MutationObserver(() => {
      runAutoJump();
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });

    // 毫秒级梯度轮询，确保在 React/Vue 挂载完第一毫秒完成接管与点击
    [20, 60, 120, 250, 500, 900, 1600].forEach(delay => {
      setTimeout(runAutoJump, delay);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupDomWatchers);
  } else {
    setupDomWatchers();
  }
})();