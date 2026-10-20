// ==UserScript==
// @name         小红书自动跳转App
// @namespace    xhs-auto-open
// @version      3.5
// @description  Android/iOS 手机端自动打开小红书App查看笔记、用户主页；全自动模拟点击秒开APP无需手动点击；完美净化安全拦截参数防转圈；完整提取并保留 xsec_token 等鉴权参数；全自动穿透“当前内容仅支持在小红书APP内查看”拦截页与原生 Universal Link 兜底并自动关闭当前标签页
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
  let autoNavigated = false;
  let autoClickedNative = false;

  // ── 0. 安全关闭当前标签页 ───────────────────────────────────────────────────
  function safeCloseTab() {
    if (isClosing) return;
    isClosing = true;

    // 0.1 Tampermonkey 赋予的高权限 window.close()
    try {
      window.close();
    } catch (_) {}

    // 0.2 原生页面上下文 close
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow.close) {
        unsafeWindow.close();
      }
    } catch (_) {}

    // 0.3 移动端浏览器沙箱逃逸兜底
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

    // 延时兜底关页（针对部分浏览器切换后台不触发 visibilitychange 的情况）
    setTimeout(() => {
      if (document.hidden) {
        safeCloseTab();
      }
    }, 1800);
  }

  // ── 1. 深度提取 Target (Note ID / User ID) ─────────────────────────────────
  function extractTarget() {
    const pathname = location.pathname;

    // 1.1 用户主页
    const userMatch = pathname.match(/\/user\/profile\/([a-f0-9]{24})/i);
    if (userMatch) return { type: 'user', id: userMatch[1] };

    // 1.2 笔记 Pathname（如 /explore/xxx, /discovery/item/xxx, /item/xxx, /share/xxx）
    const noteMatch = pathname.match(/(?:explore|item|discovery\/item|share)\/([a-f0-9]{24})/i);
    if (noteMatch) return { type: 'note', id: noteMatch[1] };

    // 1.3 404安全拦截页 /404/sec_xxx：从 redirectPath 或 originalUrl 提取
    const searchMatch = location.search.match(/[?&](?:originalUrl|redirectPath|redirect_url|note_?id|target_?id|id)=([^&]+)/i);
    if (searchMatch) {
      try {
        const decoded = decodeURIComponent(searchMatch[1]);
        const idMatch = decoded.match(/([a-f0-9]{24})/i);
        if (idMatch) return { type: 'note', id: idMatch[1] };
      } catch (_) {}
    }

    // 1.4 从 window.__INITIAL_STATE__ 恢复
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

    // 1.5 URL 全文正则 fallback
    const urlMatch = location.href.match(/(?:[a-f0-9]{24})/i);
    if (urlMatch) return { type: 'note', id: urlMatch[0] };

    return null;
  }

  // ── 2. 全量提取并恢复所有鉴权与追踪参数（严格过滤阻断性毒药参数） ────────
  function extractAllParams() {
    const params = new URLSearchParams(location.search);

    // 2.1 拦截页 originalUrl / redirectPath 二次参数释放
    try {
      const origRaw = params.get('originalUrl') || params.get('redirectPath');
      if (origRaw) {
        const u = new URL(decodeURIComponent(origRaw), location.href);
        u.searchParams.forEach((val, key) => {
          if (!params.has(key)) params.set(key, val);
        });
      }
    } catch (_) {}

    // 2.2 从 window.__INITIAL_STATE__ 提取参数
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

    // 2.3 从 DOM 文本提取可能存在的 xsec_token
    if (!params.has('xsec_token')) {
      try {
        const rawHtml = document.documentElement ? document.documentElement.innerHTML : '';
        const m = rawHtml.match(/[?&]xsec_token=([A-Za-z0-9_\-\+=]+)/i) ||
                  rawHtml.match(/["']xsec_token["']\s*:\s*["']([^"']+)["']/i);
        if (m) params.set('xsec_token', decodeURIComponent(m[1]));
      } catch (_) {}
    }

    // 2.4 【核心避坑】严格剔除安全拦截页带来的污染参数，杜绝 App 内部 404/转圈假死
    const POISON_KEYS = ['originalUrl', 'redirectPath', 'redirect_url', 'error_code'];
    POISON_KEYS.forEach(k => params.delete(k));

    if (params.get('source') === 'xhs_sec_server') {
      params.delete('source');
    }
    if (params.get('xsec_source') === 'xhs_sec_server') {
      params.delete('xsec_source');
    }

    // 2.5 必须标记外部分享来源，确保 App 端以 share 渠道正常加载
    if (!params.has('ug_dp_source')) {
      params.set('ug_dp_source', 'share');
    }

    return params;
  }

  // ── 3. 构造最优唤起链接 ───────────────────────────────────────────────────
  function buildDeepLink(target) {
    if (!target) return null;

    const params = extractAllParams();
    const query = params.toString();
    const queryStr = query ? `?${query}` : '';

    if (target.type === 'user') {
      return `xhsdiscover://user/${target.id}${queryStr}`;
    }

    // 检查是否为视频笔记
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

  // 构造 Universal Link 官方链接
  function buildUniversalLink(deepLink) {
    if (!deepLink) return '';
    return `https://oia.xiaohongshu.com/oia?deeplink=${encodeURIComponent(deepLink)}`;
  }

  // ── 4. 全事件模拟点击引擎（突破移动端 Touch / Pointer 监听限制） ─────────
  function simulateFullClick(element) {
    if (!element) return;
    try {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      // 4.1 Pointer Events
      try {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      } catch (_) {}

      // 4.2 Touch Events (针对移动端 Vue/React 绑定的 touchstart/touchend)
      try {
        if (typeof Touch !== 'undefined' && typeof TouchEvent !== 'undefined') {
          const touch = new Touch({ identifier: Date.now(), target: element, clientX: x, clientY: y, screenX: x, screenY: y });
          element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
          element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [touch] }));
        }
      } catch (_) {}

      // 4.3 Mouse Events & Native Click
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

  // ── 5. 核心：全自动无感直达引擎（无需手动点击） ─────────────────────────
  function tryAutoNavigate() {
    if (autoNavigated) return;
    const target = extractTarget();
    if (!target) return;

    const deepLink = buildDeepLink(target);
    if (!deepLink) return;

    const uLink = buildUniversalLink(deepLink);
    autoNavigated = true;

    // 5.1 隐式创建 <a> 标签击发 Universal Link（HTTPS 协议，手机浏览器绝对放行）
    try {
      const a = document.createElement('a');
      a.href = uLink || deepLink;
      a.rel = 'noopener';
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
    } catch (_) {}

    // 5.2 location 导航双向注入
    try {
      if (uLink) {
        window.location.href = uLink;
      } else {
        window.location.replace(deepLink);
      }
    } catch (_) {}

    setupAppSwitchCloser();
  }

  // 自动搜寻页面上的“打开 APP 查看” / “小红书 App内打开”原生按钮并自动击发
  function tryAutoClickNative() {
    if (autoClickedNative) return;

    const targetTexts = ['打开 APP 查看', 'App内打开', '打开APP查看', '打开 App 查看', '立即打开'];
    const candidates = document.querySelectorAll('button, div[class*="bottom-btn"], .bottom-btn, .reds-button, a');

    for (const el of candidates) {
      const txt = (el.textContent || '').trim();
      if (targetTexts.some(t => txt.includes(t))) {
        autoClickedNative = true;
        simulateFullClick(el);
        setupAppSwitchCloser();
        break;
      }
    }
  }

  function autoOpen() {
    tryAutoNavigate();
    tryAutoClickNative();
  }

  // ── 6. 注入轻量状态辅助条（自动打开状态提示与手动兜底） ─────────────────
  function injectHelperBar(target) {
    if (!target || target.type !== 'note') return;
    if (document.getElementById('xhs-auto-jump-banner')) return;

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

    const deepLink = buildDeepLink(target);
    const uLink = buildUniversalLink(deepLink);
    const searchScheme = `xhsdiscover://search/result?keyword=${encodeURIComponent(target.id)}`;

    banner.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:14px; font-weight:600; letter-spacing:0.3px;">⚡ 正在自动秒开 App 并关闭页面...</span>
        <span id="xhs-banner-close" style="font-size:16px; cursor:pointer; opacity:0.8; padding:0 4px;">✕</span>
      </div>
      <div style="display:flex; gap:8px;">
        <button id="xhs-btn-open-app" style="flex:1; height:38px; border:none; border-radius:10px; background:#fff; color:#ff2442; font-size:13px; font-weight:bold; cursor:pointer;">
          📱 再次打开 App
        </button>
        <button id="xhs-btn-search-app" style="flex:1; height:38px; border:1px solid rgba(255,255,255,0.7); border-radius:10px; background:transparent; color:#fff; font-size:13px; font-weight:bold; cursor:pointer;">
          🔍 精准搜索(免转圈)
        </button>
      </div>
    `;

    document.body.appendChild(banner);

    document.getElementById('xhs-banner-close')?.addEventListener('click', () => banner.remove());
    document.getElementById('xhs-btn-open-app')?.addEventListener('click', () => {
      const btn = document.getElementById('xhs-btn-open-app');
      if (btn) btn.textContent = '🚀 打开中并关闭...';
      autoNavigated = false;
      tryAutoNavigate();
      tryAutoClickNative();
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

  // ── 7. 多阶段执行生命周期 ─────────────────────────────────────────────────

  // 7.1 阶段一：document-start 立即触发（趁跳转上下文活跃直接拉起）
  autoOpen();

  // 7.2 阶段二：DOM 变化监听与定时梯度轮询（一旦拦截按钮出现立即自动模拟点击）
  function setupDomWatchers() {
    const target = extractTarget();
    if (target) {
      injectHelperBar(target);
    }

    autoOpen();

    // 监听 DOM 树（只要拦截页文字或按钮挂载，立即全自动触发点击）
    const observer = new MutationObserver(() => {
      const curTarget = extractTarget();
      if (curTarget) {
        injectHelperBar(curTarget);
      }
      autoOpen();
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });

    // 梯度毫秒级轮询，确保在 React/Vue 渲染出的第一毫秒内直接自动点击！
    [20, 50, 100, 200, 400, 800, 1500].forEach(delay => {
      setTimeout(() => {
        autoOpen();
        const t = extractTarget();
        if (t) injectHelperBar(t);
      }, delay);
    });

    // 7.3 用户手势安全代理：点击屏幕任何地方均作为备用兜底
    const handleUserGesture = () => {
      autoOpen();
    };
    document.addEventListener('click', handleUserGesture, true);
    document.addEventListener('touchend', handleUserGesture, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupDomWatchers);
  } else {
    setupDomWatchers();
  }
})();
