// ==UserScript==
// @name         小红书自动跳转App
// @namespace    xhs-auto-open
// @version      3.7
// @description  手机端极速打开小红书App查看笔记、用户主页；完美支持 Telegram 推送的 oia 直链与普通网页直达；彻底净化安全拦截参数防转圈假死；全屏触控秒开兜底并自动关闭当前标签页
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

  try {
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    let isClosing = false;
    let isNavigating = false;
    let cachedDeepLink = null;

    // ── 0. 安全关闭当前标签页 ─────────────────────────────────────────────────
    function safeCloseTab() {
      if (isClosing) return;
      isClosing = true;

      // 0.1 Tampermonkey 高权限接口
      try {
        window.close();
      } catch (_) {}

      // 0.2 原生 unsafeWindow
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

      // 延时兜底关闭（预留给操作系统派发 Intent 的缓冲期）
      setTimeout(() => {
        if (document.hidden) {
          safeCloseTab();
        }
      }, 1000);
    }

    // ── 1. 深度提纯直达协议 DeepLink ──────────────────────────────────────────
    function resolveDeepLink() {
      if (cachedDeepLink) return cachedDeepLink;

      try {
        const search = location.search || '';
        const searchParams = new URLSearchParams(search);
        const pathname = location.pathname || '';
        const decodedHref = decodeURIComponent(location.href);

        // 1.1 优先提取 Telegram 推送的 oia 直链中的原始 deeplink 参数
        let rawDl = searchParams.get('deeplink');
        if (!rawDl && search.includes('deeplink=')) {
          const m = search.match(/[?&]deeplink=([^&]+)/);
          if (m) rawDl = decodeURIComponent(m[1]);
        }
        if (rawDl) {
          const decoded = decodeURIComponent(rawDl);
          if (decoded.startsWith('xhsdiscover://')) {
            const qIdx = decoded.indexOf('?');
            let base = decoded;
            let query = '';
            if (qIdx !== -1) {
              base = decoded.substring(0, qIdx);
              const p = new URLSearchParams(decoded.substring(qIdx + 1));
              ['source', 'xsec_source', 'originalUrl', 'redirectPath', 'redirect_url', 'error_code'].forEach(k => {
                if (p.get(k) === 'xhs_sec_server' || k === 'originalUrl' || k === 'redirectPath') p.delete(k);
              });
              if (!p.has('ug_dp_source')) p.set('ug_dp_source', 'share');
              query = p.toString() ? '?' + p.toString() : '';
            } else {
              query = '?ug_dp_source=share';
            }
            cachedDeepLink = base + query;
            return cachedDeepLink;
          }
        }

        // 1.2 提取 Target (Note ID / User ID)
        let target = null;
        const userMatch = pathname.match(/\/user\/profile\/([a-f0-9]{24})/i);
        if (userMatch) target = { type: 'user', id: userMatch[1] };

        const noteMatch = pathname.match(/(?:explore|item|discovery\/item|share)\/([a-f0-9]{24})/i);
        if (noteMatch) target = { type: 'note', id: noteMatch[1] };

        const searchMatch = search.match(/[?&](?:originalUrl|redirectPath|redirect_url|note_?id|target_?id|id)=([^&]+)/i);
        if (searchMatch) {
          try {
            const dec = decodeURIComponent(searchMatch[1]);
            const m = dec.match(/(?:explore|item|share)\/([a-f0-9]{24})/i) || dec.match(/(?:^|[^a-f0-9])([a-f0-9]{24})(?:[^a-f0-9]|$)/i);
            if (m) target = { type: 'note', id: m[1] };
          } catch (_) {}
        }

        // 从 window.__INITIAL_STATE__ 恢复
        try {
          const state = win.__INITIAL_STATE__ || win.__INITIAL_SSR_STATE__ || window.__INITIAL_STATE__;
          if (state) {
            if (state.note?.currentNoteId) target = { type: 'note', id: state.note.currentNoteId };
            else if (state.noteData?.data?.noteData?.id) target = { type: 'note', id: state.noteData.data.noteData.id };
            else if (state.noteData?.data?.noteData?.noteId) target = { type: 'note', id: state.noteData.data.noteData.noteId };
          }
        } catch (_) {}

        if (!target) {
          const m = decodedHref.match(/(?:item|explore|share)\/([a-f0-9]{24})/i) || decodedHref.match(/(?:^|[^a-f0-9])([a-f0-9]{24})(?:[^a-f0-9]|$)/i);
          if (m) target = { type: 'note', id: m[1] };
        }

        if (!target) return null;

        // 1.3 提取并净化鉴权参数
        const params = new URLSearchParams(search);
        const origRaw = params.get('originalUrl') || params.get('redirectPath');
        if (origRaw) {
          try {
            const origU = new URL(decodeURIComponent(origRaw), location.origin);
            origU.searchParams.forEach((v, k) => { if (!params.has(k)) params.set(k, v); });
          } catch (_) {}
        }

        ['originalUrl', 'redirectPath', 'redirect_url', 'error_code'].forEach(k => params.delete(k));
        if (params.get('source') === 'xhs_sec_server') params.delete('source');
        if (params.get('xsec_source') === 'xhs_sec_server') params.delete('xsec_source');
        if (!params.has('ug_dp_source')) params.set('ug_dp_source', 'share');

        let isVideo = false;
        try {
          if (pathname.includes('/video/') || search.includes('type=video')) isVideo = true;
        } catch (_) {}

        const prefix = target.type === 'user' ? 'xhsdiscover://user/' : (isVideo ? 'xhsdiscover://video_feed/' : 'xhsdiscover://item/');
        cachedDeepLink = `${prefix}${target.id}?${params.toString()}`;
        return cachedDeepLink;
      } catch (e) {
        console.error('[xhs-auto-open] resolve error:', e);
        return null;
      }
    }

    // ── 2. 稳健唤起引擎（单次幂等击发，绝不反复取消） ─────────────────────────
    function executeNavigation(deepLink, autoClose = true) {
      if (!deepLink || isNavigating) return;
      isNavigating = true;

      // 2.1 原生 Scheme 击发
      try {
        window.location.replace(deepLink);
      } catch (_) {
        try {
          window.location.href = deepLink;
        } catch (_) {}
      }

      // 2.2 隐式 <a> 标签兜底触发
      try {
        const a = document.createElement('a');
        a.href = deepLink;
        a.style.display = 'none';
        if (document.body) document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 1000);
      } catch (_) {}

      // 2.3 Android Intent 兜底
      if (navigator.userAgent.includes('Android')) {
        try {
          const raw = deepLink.replace(/^xhsdiscover:\/\//, '');
          const intentUrl = `intent://${raw}#Intent;scheme=xhsdiscover;package=com.xingin.xhs;category=android.intent.category.BROWSABLE;end;`;
          setTimeout(() => {
            if (!document.hidden) {
              try {
                window.location.href = intentUrl;
              } catch (_) {}
            }
          }, 350);
        } catch (_) {}
      }

      if (autoClose) {
        setupAppSwitchCloser();
      }
    }

    // ── 3. 全屏触控秒开（解决 Chromium 内核强制要求真实手势的问题） ───────────
    function setupOneTapShield(deepLink) {
      if (!deepLink) return;

      const onUserGesture = () => {
        executeNavigation(deepLink, true);
      };

      // 捕获任何触摸与点击，一触即发，无需寻找任何特定按钮
      window.addEventListener('touchstart', onUserGesture, { capture: true, passive: true });
      window.addEventListener('touchend', onUserGesture, { capture: true, passive: true });
      window.addEventListener('click', onUserGesture, { capture: true });
      window.addEventListener('pointerdown', onUserGesture, { capture: true, passive: true });
    }

    // ── 4. 改写与接管页面所有原生跳转按钮 ─────────────────────────────────────
    function hijackButtons(deepLink) {
      if (!deepLink) return;

      const targetTexts = ['打开 APP 查看', 'App内打开', '直接在 App 内打开', '打开APP查看', '打开 App 查看', '立即打开'];
      const candidates = document.querySelectorAll('button, div[class*="bottom-btn"], .bottom-btn, .reds-button, a, #in-browser, #download_btn');

      for (const el of candidates) {
        const txt = (el.textContent || '').trim();
        const isMatch = targetTexts.some(t => txt.includes(t)) || el.id === 'in-browser' || el.id === 'download_btn';

        if (isMatch) {
          if (el.tagName.toLowerCase() === 'a') {
            el.href = deepLink;
          }
          el.onclick = (e) => {
            e.preventDefault();
            executeNavigation(deepLink, true);
          };
        }
      }
    }

    // ── 5. 注入高可视度辅助条 ─────────────────────────────────────────────────
    function injectHelperBar(deepLink) {
      if (!deepLink || document.getElementById('xhs-auto-jump-banner')) return;

      const banner = document.createElement('div');
      banner.id = 'xhs-auto-jump-banner';
      banner.style.cssText = [
        'position: fixed',
        'bottom: 16px',
        'left: 50%',
        'transform: translateX(-50%)',
        'width: calc(100% - 24px)',
        'max-width: 480px',
        'background: linear-gradient(135deg, #ff2442 0%, #e01935 100%)',
        'color: #ffffff',
        'padding: 12px 16px',
        'border-radius: 14px',
        'box-shadow: 0 8px 24px rgba(255, 36, 66, 0.45)',
        'z-index: 2147483647',
        'display: flex',
        'flex-direction: column',
        'gap: 8px',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        'box-sizing: border-box'
      ].join(';');

      banner.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:14px; font-weight:600;">⚡ 轻触屏幕任意位置，立即秒开小红书</span>
          <span id="xhs-banner-close" style="font-size:16px; cursor:pointer; opacity:0.8; padding:0 4px;">✕</span>
        </div>
        <button id="xhs-btn-open-app" style="height:40px; border:none; border-radius:10px; background:#fff; color:#ff2442; font-size:14px; font-weight:bold; cursor:pointer;">
          📱 点击立即打开 App 并关页
        </button>
      `;

      if (document.body) {
        document.body.appendChild(banner);
      } else if (document.documentElement) {
        document.documentElement.appendChild(banner);
      }

      document.getElementById('xhs-banner-close')?.addEventListener('click', () => banner.remove());
      document.getElementById('xhs-btn-open-app')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = document.getElementById('xhs-btn-open-app');
        if (btn) btn.textContent = '🚀 正在唤起小红书...';
        executeNavigation(deepLink, true);
      });
    }

    // ── 6. 核心调度生命周期 ───────────────────────────────────────────────────

    // 6.1 document-start 立即触发：尝试在上下文活跃时直接静默拉起
    const initialDeepLink = resolveDeepLink();
    if (initialDeepLink) {
      executeNavigation(initialDeepLink, true);
    }

    // 6.2 挂载 DOM 级响应与全屏触控兜底
    function setupDomPhase() {
      const deepLink = resolveDeepLink();
      if (!deepLink) return;

      setupOneTapShield(deepLink);
      hijackButtons(deepLink);
      injectHelperBar(deepLink);

      // 监听 DOM 树动态渲染
      const observer = new MutationObserver(() => {
        const curDl = resolveDeepLink();
        if (curDl) {
          setupOneTapShield(curDl);
          hijackButtons(curDl);
          injectHelperBar(curDl);
        }
      });

      if (document.body || document.documentElement) {
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
      }

      // 毫秒级梯度轮询接管按钮
      [30, 100, 300, 700, 1500].forEach(delay => {
        setTimeout(() => {
          const curDl = resolveDeepLink();
          if (curDl) {
            hijackButtons(curDl);
            injectHelperBar(curDl);
          }
        }, delay);
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setupDomPhase);
    } else {
      setupDomPhase();
    }

  } catch (err) {
    console.error('[xhs-auto-open] Fatal error:', err);
  }
})();