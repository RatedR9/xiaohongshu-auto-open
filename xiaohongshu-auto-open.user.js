// ==UserScript==
// @name         小红书自动跳转App
// @namespace    xhs-auto-open
// @version      2.0
// @description  Android/iOS 自动打开小红书笔记
// @match        *://www.xiaohongshu.com/explore/*
// @match        *://xiaohongshu.com/explore/*
// @match        *://www.xiaohongshu.com/discovery/item/*
// @match        *://xiaohongshu.com/discovery/item/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const match = location.pathname.match(
    /^\/(?:explore|discovery\/item)\/([a-f0-9]{24})/i
  );

  if (!match) return;

  const noteId = match[1];
  const deepLink = `xhsdiscover://item/${noteId}`;

  // 页面加载时直接尝试唤起App
  window.location.replace(deepLink);
})();
