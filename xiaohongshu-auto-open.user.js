// ==UserScript==
// @name         小红书自动跳转App
// @namespace    xhs-auto-open
// @version      3.1
// @description  Android/iOS 手机端自动打开小红书App查看笔记、用户主页；保留完整 xsec_token/xsec_source 等鉴权参数杜绝跳转后一直转圈；自动处理“当前内容仅支持在小红书APP内查看”拦截页
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

  // 记录是否已成功触发过唤起，避免重复高频执行
  let launched = false;

  // ── 1. 深度提取 Note ID / User ID ──────────────────────────────────────────
  function extractTargetInfo() {
    const href = location.href;
    const pathname = location.pathname;

    // 1.1 检查是否为用户个人主页
    const userMatch = pathname.match(/\/user\/profile\/([a-f0-9]{24})/i);
    if (userMatch) {
      return { type: 'user', id: userMatch[1] };
    }

    // 1.2 从 pathname 提取笔记 ID（如 /explore/xxx, /discovery/item/xxx, /item/xxx, /share/xxx）
    const pathMatch = pathname.match(/(?:explore|item|discovery\/item|share)\/([a-f0-9]{24})/i) ||
                      pathname.match(/\/([a-f0-9]{24})/i);
    if (pathMatch) {
      return { type: 'note', id: pathMatch[1] };
    }

    // 1.3 从 URL Query 参数提取（如 ?note_id=xxx 或 target_id=xxx）
    const searchMatch = location.search.match(/[?&](?:note_?id|target_?id|id)=([a-f0-9]{24})/i);
    if (searchMatch) {
      return { type: 'note', id: searchMatch[1] };
    }

    // 1.4 从 window.__INITIAL_STATE__ 提取
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

    // 1.5 从整个 URL 中提取 24 位十六进制 ID（排除常见的非笔记哈希）
    const urlMatch = href.match(/([a-f0-9]{24})/i);
    if (urlMatch) {
      return { type: 'note', id: urlMatch[1] };
    }

    return null;
  }

  // ── 2. 收集并恢复关键鉴权参数（彻底解决跳转后一直转圈的核心） ─────────────
  function collectFullQueryParams() {
    const params = new URLSearchParams(location.search);

    // 尝试从 window.__INITIAL_STATE__ 恢复被中转页或短链截断的参数
    try {
      const state = window.__INITIAL_STATE__ || window.__INITIAL_SSR_STATE__;
      if (state) {
        // 2.1 从 routeQuery.originalUrl 恢复原分享链接的全部参数
        const origUrl = state.noteData?.routeQuery?.originalUrl || state.routeQuery?.originalUrl;
        if (origUrl) {
          try {
            const u = new URL(origUrl, location.href);
            u.searchParams.forEach((val, key) => {
              if (!params.has(key)) params.set(key, val);
            });
          } catch (_) {}
        }

        // 2.2 恢复 xsec_token
        const xsecToken = state.noteData?.data?.noteData?.xsecToken ||
                          state.noteData?.xsecToken ||
                          state.note?.xsecToken;
        if (xsecToken && !params.has('xsec_token')) {
          params.set('xsec_token', xsecToken);
        }

        // 2.3 恢复 xsec_source
        const xsecSource = state.noteData?.routeQuery?.source ||
                           state.noteData?.data?.noteData?.xsecSource ||
                           state.note?.xsecSource;
        if (xsecSource && !params.has('xsec_source')) {
          params.set('xsec_source', xsecSource);
        }
      }
    } catch (_) {}

    // 2.4 从页面原始文本中正则兜底匹配 xsec_token
    if (!params.has('xsec_token')) {
      const tokenMatch = location.href.match(/[?&]xsec_token=([^&#]+)/i) ||
                         document.documentElement?.innerHTML?.match(/["']xsec_token["']\s*:\s*["']([^"']+)["']/i);
      if (tokenMatch) {
        params.set('xsec_token', decodeURIComponent(tokenMatch[1]));
      }
    }

    // 2.5 确保外部分享唤起必需参数
    if (!params.has('ug_dp_source')) {
      params.set('ug_dp_source', 'share');
    }

    return params;
  }

  // ── 3. 构造精准 DeepLink 与 Universal Link ─────────────────────────────────
  function buildTargetDeepLink(target) {
    if (!target) return null;

    const params = collectFullQueryParams();
    const queryStr = params.toString();
    const queryString = queryStr ? `?${queryStr}` : '';

    if (target.type === 'user') {
      return `xhsdiscover://user/${target.id}${queryString}`;
    }

    // 判断是否为视频笔记
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
    return `${prefix}${target.id}${queryString}`;
  }

  // ── 4. 执行多通道唤起 ──────────────────────────────────────────────────────
  function launchUrl(url) {
    if (!url || launched) return;
    launched = true;

    // 优先使用隐藏 <a> 标签模拟真实用户点击（兼容 Android Chrome / WebView / Telegram）
    try {
      const a = document.createElement('a');
      a.href = url;
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
    } catch (_) {
      window.location.href = url;
    }
  }

  // ── 5. 拦截页原生唤起按钮自动检测与模拟点击 ──────────────────────────────
  // 当页面被“当前内容仅支持在小红书 APP 内查看”或中转引导拦截时，直接激活官方按钮
  function checkAndClickNativeOpenButtons() {
    if (launched) return;

    // 常见小红书唤起按钮特征文本
    const targetTexts = [
      '打开 APP 查看',
      'App内打开',
      '打开APP查看',
      '打开 App 查看',
      '立即打开',
      '在小红书内打开',
      '去小红书 APP 查看',
      '在 APP 内打开'
    ];

    const candidateNodes = document.querySelectorAll(
      'button, a, div[role="button"], [class*="open"], [class*="btn"], [class*="launch"], [class*="jump"]'
    );

    for (const node of candidateNodes) {
      if (node.dataset?.xhsAutoClicked) continue;

      const text = (node.textContent || '').trim();
      const hasTargetText = targetTexts.some(t => text.includes(t));

      const href = node.getAttribute?.('href') || '';
      const isXhsScheme = href.startsWith('xhsdiscover://') || href.startsWith('https://oia.xiaohongshu.com');

      if (hasTargetText || isXhsScheme) {
        node.dataset.xhsAutoClicked = 'true';

        if (isXhsScheme) {
          launchUrl(href);
          return;
        }

        try {
          node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          if (typeof node.click === 'function') node.click();
          launched = true;
          return;
        } catch (_) {}
      }
    }
  }

  // ── 6. 核心智能调度机制 ───────────────────────────────────────────────────
  function tryImmediateLaunch() {
    // 关键优化：检查当前 URL 是否已经包含 xsec_token
    // 如果已经包含，说明在 document-start 时即可形成完整的带鉴权 DeepLink，直接秒级唤起！
    // 如果不包含，绝不能在 document-start 发起裸跳转（否则必导致一直转圈），等待 DOM/State 解析
    const hasToken = /[?&]xsec_token=/i.test(location.search);
    const target = extractTargetInfo();

    if (target && hasToken) {
      const deepLink = buildTargetDeepLink(target);
      if (deepLink) {
        launchUrl(deepLink);
        return true;
      }
    }
    return false;
  }

  function tryFullLaunch() {
    if (launched) return true;

    // 尝试构建完整带参 DeepLink
    const target = extractTargetInfo();
    if (target) {
      const deepLink = buildTargetDeepLink(target);
      if (deepLink) {
        // 如果成功获取到了 xsec_token 或者用户已在就绪阶段，执行唤起
        const params = collectFullQueryParams();
        if (params.has('xsec_token')) {
          launchUrl(deepLink);
          return true;
        }
      }
    }

    // 如果无法提取到参数，优先触发官方原生“打开 APP”按钮（官方自带预载加密参数）
    checkAndClickNativeOpenButtons();
    if (launched) return true;

    // 最终兜底：如果依然没有触发，使用已有信息唤起
    if (target) {
      const deepLink = buildTargetDeepLink(target);
      if (deepLink) {
        launchUrl(deepLink);
        return true;
      }
    }
    return false;
  }

  // ── 7. 生命周期挂载 ───────────────────────────────────────────────────────
  // 7.1 阶段一：document-start 时，仅在凭据齐全时执行即时跳转
  tryImmediateLaunch();

  // 7.2 阶段二：DOM 解析与变化监听（适配拦截页渲染与异步 State）
  function initObserver() {
    if (launched) return;
    tryFullLaunch();

    const observer = new MutationObserver(() => {
      if (launched) {
        observer.disconnect();
        return;
      }
      tryFullLaunch();
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });

    // 多轮定时检测，确保 Telegram / 移动端各浏览器下完全覆盖
    [100, 300, 600, 1200, 2500].forEach(ms => {
      setTimeout(() => {
        if (!launched) {
          tryFullLaunch();
        }
      }, ms);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObserver);
  } else {
    initObserver();
  }

  window.addEventListener('load', () => {
    if (!launched) {
      tryFullLaunch();
    }
  });
})();
