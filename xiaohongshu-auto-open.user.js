// ==UserScript==
// @name         小红书自动跳转App
// @namespace    xhs-auto-open
// @version      3.2
// @description  Android/iOS 手机端自动打开小红书App查看笔记、用户主页；完整提取并保留 xsec_token 等鉴权参数杜绝转圈；全自动穿透“当前内容仅支持在小红书APP内查看”拦截页
// @author       RatedR9 & Antigravity
// @match        *://www.xiaohongshu.com/*
// @match        *://xiaohongshu.com/*
// @match        *://*.xiaohongshu.com/*
// @match        *://xhslink.com/*
// @match        *://*.xhslink.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  let hasNavigated = false;

  // ── 1. 深度提取 Target (Note ID / User ID) ─────────────────────────────────
  function extractTarget() {
    const pathname = location.pathname;

    // 1.1 用户主页
    const userMatch = pathname.match(/\/user\/profile\/([a-f0-9]{24})/i);
    if (userMatch) return { type: 'user', id: userMatch[1] };

    // 1.2 笔记 Pathname（如 /explore/xxx, /discovery/item/xxx, /item/xxx, /share/xxx）
    const noteMatch = pathname.match(/(?:explore|item|discovery\/item|share)\/([a-f0-9]{24})/i) ||
                      pathname.match(/\/([a-f0-9]{24})/i);
    if (noteMatch) return { type: 'note', id: noteMatch[1] };

    // 1.3 Query 参数
    const searchMatch = location.search.match(/[?&](?:note_?id|target_?id|id)=([a-f0-9]{24})/i);
    if (searchMatch) return { type: 'note', id: searchMatch[1] };

    // 1.4 从 window.__INITIAL_STATE__ 恢复
    try {
      const state = window.__INITIAL_STATE__ || window.__INITIAL_SSR_STATE__;
      if (state) {
        if (state.note?.currentNoteId) return { type: 'note', id: state.note.currentNoteId };
        if (state.noteData?.data?.noteData?.id) return { type: 'note', id: state.noteData.data.noteData.id };
        if (state.noteData?.data?.noteData?.noteId) return { type: 'note', id: state.noteData.data.noteData.noteId };
        const origUrl = state.noteData?.routeQuery?.originalUrl || state.routeQuery?.originalUrl;
        if (origUrl) {
          const m = origUrl.match(/([a-f0-9]{24})/i);
          if (m) return { type: 'note', id: m[1] };
        }
      }
    } catch (_) {}

    // 1.5 URL 全文正则
    const urlMatch = location.href.match(/([a-f0-9]{24})/i);
    if (urlMatch) return { type: 'note', id: urlMatch[1] };

    return null;
  }

  // ── 2. 全量提取并恢复所有鉴权与追踪参数 ────────────────────────────────────
  function extractAllParams() {
    const params = new URLSearchParams(location.search);

    // 2.1 从 window.__INITIAL_STATE__ 提取（尤其是拦截页包含的原始分享 URL）
    try {
      const state = window.__INITIAL_STATE__ || window.__INITIAL_SSR_STATE__;
      if (state) {
        const origUrl = state.noteData?.routeQuery?.originalUrl || state.routeQuery?.originalUrl;
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

        const xsecSource = state.noteData?.routeQuery?.source ||
                           state.noteData?.data?.noteData?.xsecSource ||
                           state.note?.xsecSource;
        if (xsecSource && !params.has('xsec_source')) {
          params.set('xsec_source', xsecSource);
        }
      }
    } catch (_) {}

    // 2.2 从 DOM 文本提取可能存在的 xsec_token
    if (!params.has('xsec_token')) {
      try {
        const rawHtml = document.documentElement ? document.documentElement.innerHTML : '';
        const m = rawHtml.match(/[?&]xsec_token=([A-Za-z0-9_\-\+=]+)/i) ||
                  rawHtml.match(/["']xsec_token["']\s*:\s*["']([^"']+)["']/i);
        if (m) params.set('xsec_token', decodeURIComponent(m[1]));
      } catch (_) {}
    }

    // 2.3 必须标记外部分享来源，防止 App 拒绝加载 feed
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
      const state = window.__INITIAL_STATE__ || window.__INITIAL_SSR_STATE__;
      if (state?.noteData?.data?.noteData?.type === 'video' || state?.noteData?.note?.type === 'video') {
        isVideo = true;
      }
    } catch (_) {}

    const prefix = isVideo ? 'xhsdiscover://video_feed/' : 'xhsdiscover://item/';
    return `${prefix}${target.id}${queryStr}`;
  }

  // ── 4. 稳健唤起（兼容 Android 各类浏览器与 WebView） ───────────────────────
  function executeNavigation(deepLink) {
    if (!deepLink) return;

    try {
      window.location.replace(deepLink);
    } catch (_) {
      window.location.href = deepLink;
    }
  }

  // ── 5. 自动穿透拦截页与官方按钮模拟 ───────────────────────────────────────
  function triggerNativeLaunch() {
    const targetTexts = ['打开 APP 查看', 'App内打开', '打开APP查看', '打开 App 查看', '立即打开'];
    const candidates = document.querySelectorAll('button, a, div[role="button"], [class*="open"], [class*="btn"], [class*="bottom-btn"]');

    for (const node of candidates) {
      const text = (node.textContent || '').trim();
      const match = targetTexts.some(t => text.includes(t));
      const href = node.getAttribute?.('href') || '';
      const isXhs = href.startsWith('xhsdiscover://');

      if (match || isXhs) {
        if (isXhs) {
          executeNavigation(href);
          return true;
        }
        try {
          node.click();
          return true;
        } catch (_) {}
      }
    }
    return false;
  }

  // ── 6. 核心触发逻辑 ───────────────────────────────────────────────────────
  function tryWakeup() {
    const target = extractTarget();
    if (!target) return;

    const deepLink = buildDeepLink(target);
    if (!deepLink) return;

    hasNavigated = true;
    executeNavigation(deepLink);
  }

  // ── 7. 多阶段执行生命周期 ─────────────────────────────────────────────────

  // 7.1 阶段一：document-start 立即触发（趁浏览器页面跳转上下文活跃，成功率最高）
  tryWakeup();

  // 7.2 阶段二：DOM 变化监听与定时轮询（当页面出现拦截页或异步注入参数时再次激活）
  function setupDomWatchers() {
    // 监听 DOM 树（用于捕获拦截页弹框与 State 载入）
    const observer = new MutationObserver(() => {
      // 只要页面存在拦截文案或按钮，立即再次提取并唤起
      if (document.body && document.body.textContent.includes('小红书 APP 内查看')) {
        tryWakeup();
        triggerNativeLaunch();
      }
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });

    // 梯度定时器轮询
    [50, 150, 300, 600, 1200].forEach(delay => {
      setTimeout(() => {
        tryWakeup();
        triggerNativeLaunch();
      }, delay);
    });

    // 7.3 用户手势代理拦截：如果浏览器策略拦截了自动跳转，用户点击屏幕任何位置均可直接秒开 App
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
