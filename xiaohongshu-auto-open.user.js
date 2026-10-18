// ==UserScript==
// @name         小红书自动跳转App
// @namespace    xhs-auto-open
// @version      3.0
// @description  Android/iOS 手机端自动打开小红书App查看笔记、用户主页及处理“当前内容仅支持在小红书APP内查看”拦截页
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

  // ── 1. 深度多源 Note ID 提取器 ───────────────────────────────────────────
  function extractNoteId() {
    // 1.1 从 pathname 提取（如 /explore/xxx, /discovery/item/xxx, /item/xxx）
    const pathMatch = location.pathname.match(/(?:explore|item|discovery\/item|share)\/([a-f0-9]{24})/i) ||
                      location.pathname.match(/\/([a-f0-9]{24})/i);
    if (pathMatch) return pathMatch[1];

    // 1.2 从 URL Query 参数提取（如 ?note_id=xxx 或 target_id=xxx）
    const searchMatch = location.search.match(/[?&](?:note_?id|target_?id|id)=([a-f0-9]{24})/i);
    if (searchMatch) return searchMatch[1];

    // 1.3 从整个 URL 中提取任意匹配的 24 位十六进制 ID
    const urlMatch = location.href.match(/([a-f0-9]{24})/i);
    if (urlMatch) return urlMatch[1];

    // 1.4 从 meta 标签中提取
    const ogUrl = document.querySelector('meta[property="og:url"]')?.content ||
                  document.querySelector('link[rel="canonical"]')?.href || '';
    const metaMatch = ogUrl.match(/([a-f0-9]{24})/i);
    if (metaMatch) return metaMatch[1];

    // 1.5 从 window.__INITIAL_STATE__ 提取
    try {
      const state = window.__INITIAL_STATE__ || window.__INITIAL_SSR_STATE__;
      if (state) {
        if (state.note?.currentNoteId) return state.note.currentNoteId;
        if (state.note?.noteDetailMap) {
          const keys = Object.keys(state.note.noteDetailMap);
          if (keys.length > 0 && /^[a-f0-9]{24}$/i.test(keys[0])) return keys[0];
        }
      }
    } catch (_) {}

    return null;
  }

  // ── 2. Scheme 直接唤起引擎 ────────────────────────────────────────────────
  function launchScheme(url) {
    if (!url || launched) return;
    launched = true;

    // 优先使用 location.href 直接导航唤起
    try {
      window.location.href = url;
    } catch (_) {
      // 降级使用 <a> 标签触发
      const a = document.createElement('a');
      a.href = url;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
    }
  }

  function tryDirectLaunch() {
    const noteId = extractNoteId();
    if (noteId) {
      const deepLink = `xhsdiscover://item/${noteId}`;
      launchScheme(deepLink);
      return true;
    }
    return false;
  }

  // ── 3. 拦截页原生唤起按钮自动检测与模拟点击 ──────────────────────────────
  // 专门解决“当前内容仅支持在小红书 APP 内查看”及各种中转引导页
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

    // 常见可能作为按钮的容器选择器
    const candidateNodes = document.querySelectorAll(
      'button, a, div[role="button"], [class*="open"], [class*="btn"], [class*="launch"], [class*="jump"]'
    );

    for (const node of candidateNodes) {
      if (node.dataset?.xhsAutoClicked) continue;

      const text = (node.textContent || '').trim();
      const hasTargetText = targetTexts.some(t => text.includes(t));

      // 检查链接 href 是否本身就是 xhsdiscover:// 协议
      const href = node.getAttribute?.('href') || '';
      const isXhsScheme = href.startsWith('xhsdiscover://');

      if (hasTargetText || isXhsScheme) {
        node.dataset.xhsAutoClicked = 'true';

        // 如果该节点直接是 scheme 链接
        if (isXhsScheme) {
          launchScheme(href);
          return;
        }

        // 模拟真实触摸与点击事件，激活小红书官方绑定的唤起逻辑
        try {
          node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          if (typeof node.click === 'function') node.click();
          launched = true;
          return;
        } catch (_) {}
      }
    }
  }

  // ── 4. 生命周期调度 ───────────────────────────────────────────────────────
  // 4.1 阶段一：document-start 立即尝试识别并唤起
  tryDirectLaunch();

  // 4.2 阶段二：DOM 解析中及就绪后，启动多轮轮询与 MutationObserver 监听
  function initObserver() {
    if (tryDirectLaunch()) return;
    checkAndClickNativeOpenButtons();

    // 监听 DOM 树动态加载（适配 Vue/React 异步渲染阻断遮罩）
    const observer = new MutationObserver(() => {
      if (launched) {
        observer.disconnect();
        return;
      }
      if (tryDirectLaunch()) {
        observer.disconnect();
        return;
      }
      checkAndClickNativeOpenButtons();
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });

    // 兜底定时检测（100ms, 300ms, 800ms, 1500ms），防止 observer 遗漏静态组件
    const intervals = [100, 300, 800, 1500, 3000];
    intervals.forEach(ms => {
      setTimeout(() => {
        if (!launched) {
          tryDirectLaunch();
          checkAndClickNativeOpenButtons();
        }
      }, ms);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObserver);
  } else {
    initObserver();
  }

  // 页面完全加载时再次兜底触发
  window.addEventListener('load', () => {
    if (!launched) {
      tryDirectLaunch();
      checkAndClickNativeOpenButtons();
    }
  });

})();
