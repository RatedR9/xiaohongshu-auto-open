// ==UserScript==
// @name         小红书自动跳转App
// @namespace    xhs-auto-open
// @version      3.4
// @description  Android/iOS 手机端自动打开小红书App查看笔记、用户主页；点击打开App后自动秒关当前标签页；完美净化安全拦截参数防转圈；完整提取并保留 xsec_token 等鉴权参数；全自动穿透“当前内容仅支持在小红书APP内查看”拦截页与原生 Universal Link 兜底
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
  let hasNavigated = false;
  let isClosing = false;

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

  // ── 4. 稳健唤起（兼容 Android 各类浏览器与 WebView，并自动关闭标签页） ──
  function executeNavigation(deepLink, autoClose = false) {
    if (!deepLink) return;

    try {
      window.location.replace(deepLink);
    } catch (_) {
      try {
        window.location.href = deepLink;
      } catch (_) {}
    }

    if (autoClose) {
      // 1. 延时定时器触发关闭（预留 700ms 让操作系统 Intent / URL Scheme 完成唤起派发）
      setTimeout(() => {
        safeCloseTab();
      }, 700);

      // 2. 页面进入后台（App 成功切出前台瞬间）立即秒关当前标签
      const onHidden = () => {
        if (document.hidden) {
          safeCloseTab();
          document.removeEventListener('visibilitychange', onHidden);
        }
      };
      document.addEventListener('visibilitychange', onHidden);
      window.addEventListener('pagehide', safeCloseTab, { once: true });
    }
  }

  // ── 5. 自动穿透拦截页与官方按钮模拟（接管点击并触发关闭） ───────────────
  function triggerNativeLaunch() {
    const target = extractTarget();
    const deepLink = target ? buildDeepLink(target) : '';

    const targetTexts = ['打开 APP 查看', 'App内打开', '打开APP查看', '打开 App 查看', '立即打开'];
    const candidates = document.querySelectorAll('button, a, div[role="button"], [class*="open"], [class*="btn"], [class*="bottom-btn"]');

    for (const node of candidates) {
      const text = (node.textContent || '').trim();
      const match = targetTexts.some(t => text.includes(t));
      const href = node.getAttribute?.('href') || '';
      const isXhs = href.startsWith('xhsdiscover://');

      if (match || isXhs) {
        if (deepLink) {
          // 接管原生按钮点击，直接发射清洗后的 deepLink，并附带点击后关闭标签页
          node.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            executeNavigation(deepLink, true);
          };
        }
        try {
          node.click();
          return true;
        } catch (_) {}
      }
    }
    return false;
  }

  // ── 6. 注入快捷免转圈辅助条（附带一键唤起+自动关页） ────────────────────
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
        <span style="font-size:14px; font-weight:600; letter-spacing:0.3px;">⚡ 小红书自动跳转助手</span>
        <span id="xhs-banner-close" style="font-size:16px; cursor:pointer; opacity:0.8; padding:0 4px;">✕</span>
      </div>
      <div style="display:flex; gap:8px;">
        <button id="xhs-btn-open-app" style="flex:1; height:38px; border:none; border-radius:10px; background:#fff; color:#ff2442; font-size:13px; font-weight:bold; cursor:pointer;">
          📱 打开 App 并关页
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
      executeNavigation(deepLink || uLink, true);
    });
    document.getElementById('xhs-btn-search-app')?.addEventListener('click', () => {
      const btn = document.getElementById('xhs-btn-search-app');
      if (btn) btn.textContent = '🔍 搜索中并关闭...';
      executeNavigation(searchScheme, true);
    });
  }

  // ── 7. 核心触发逻辑 ───────────────────────────────────────────────────────
  function tryWakeup() {
    const target = extractTarget();
    if (!target) return;

    const deepLink = buildDeepLink(target);
    if (!deepLink) return;

    if (!hasNavigated) {
      hasNavigated = true;
      executeNavigation(deepLink, false);

      // 若自动唤起成功触发了页面退火（切换到小红书 App），则无感秒关标签页
      const onAutoHidden = () => {
        if (document.hidden) {
          safeCloseTab();
          document.removeEventListener('visibilitychange', onAutoHidden);
        }
      };
      document.addEventListener('visibilitychange', onAutoHidden);
    }
  }

  // ── 8. 多阶段执行生命周期 ─────────────────────────────────────────────────

  // 8.1 阶段一：document-start 立即触发
  tryWakeup();

  // 8.2 阶段二：DOM 变化监听与定时轮询（当页面出现拦截页或异步注入参数时再次激活）
  function setupDomWatchers() {
    const target = extractTarget();
    if (target) {
      injectHelperBar(target);
    }

    // 监听 DOM 树
    const observer = new MutationObserver(() => {
      const curTarget = extractTarget();
      if (curTarget) {
        injectHelperBar(curTarget);
      }
      // 只要页面存在拦截文案或按钮，立即再次提取并接管
      if (document.body && document.body.textContent.includes('小红书 APP 内查看')) {
        tryWakeup();
        triggerNativeLaunch();
      }
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });

    // 梯度定时器轮询接管按钮
    [30, 100, 300, 700, 1500].forEach(delay => {
      setTimeout(() => {
        tryWakeup();
        triggerNativeLaunch();
        const t = extractTarget();
        if (t) injectHelperBar(t);
      }, delay);
    });

    // 8.3 用户手势代理拦截：如果浏览器策略拦截了自动跳转，用户点击屏幕任何位置均可直接秒开 App 并关闭
    const handleUserGesture = () => {
      tryWakeup();
      triggerNativeLaunch();
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
