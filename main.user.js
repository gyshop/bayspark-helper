// ==UserScript==
// @name         BaySpark Helper
// @namespace    bayspark-helper
// @version      1.44
// @description  BaySpark商品管理画面の一括処理を補助するツール
// @match        https://bridgemencalendar.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      api.anthropic.com
// @updateURL    https://raw.githubusercontent.com/gyshop/bayspark-helper/main/main.user.js
// @downloadURL  https://raw.githubusercontent.com/gyshop/bayspark-helper/main/main.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ======================================================================
   * 設定管理
   * ==================================================================== */

  const SETTINGS_KEY = 'bayspark_helper_settings';

  const DEFAULT_SETTINGS = {
    categoryName: 'Bags',
    categoryWaitMs: 8000,
    specificsWaitMs: 8000,
    claudeApiKey: '',
    rankSystemName: 'Rank',
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch (e) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  let settings = loadSettings();

  /* ======================================================================
   * ログ管理
   * ==================================================================== */

  let logEl = null;
  const LOG_STORAGE_KEY = 'bayspark_helper_log';

  function log(message) {
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${message}`;
    console.log(`[BaySpark Helper] ${line}`);
    if (logEl) {
      const div = document.createElement('div');
      div.textContent = line;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    }
    // ページ遷移をまたいでログを保持する
    try {
      const stored = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || '[]');
      stored.push(line);
      if (stored.length > 80) stored.splice(0, stored.length - 80);
      localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(stored));
    } catch (e) {}
  }

  function restoreLogs() {
    if (!logEl) return;
    try {
      const stored = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || '[]');
      if (stored.length === 0) return;
      stored.forEach((line) => {
        const div = document.createElement('div');
        div.textContent = line;
        div.style.color = '#999';
        logEl.appendChild(div);
      });
      logEl.scrollTop = logEl.scrollHeight;
    } catch (e) {}
  }

  function clearLog() {
    if (logEl) logEl.innerHTML = '';
    try { localStorage.removeItem(LOG_STORAGE_KEY); } catch (e) {}
  }

  /* ======================================================================
   * 進捗表示 / ボタンロック
   * ==================================================================== */

  let progressEl = null;
  let actionButtons = [];

  function setProgress(text) {
    if (progressEl) progressEl.textContent = text || '';
  }

  function lockButtons(locked) {
    actionButtons.forEach((btn) => {
      btn.disabled = locked;
    });
  }

  /* ======================================================================
   * 汎用ユーティリティ
   * ==================================================================== */

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // checkFn が真値を返すまでintervalMsごとに再試行する（Livewireのサーバー往復で
  // 要素がすぐに現れない場合への対応）
  async function waitFor(checkFn, timeoutMs = 5000, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = checkFn();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  function fireFullClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: document.defaultView };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    el.click();
  }

  // テキストの完全一致を優先し、見つからない場合のみ includes で検索する
  function findMenuCandidate(text) {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="menuitem"], li'));
    let target = candidates.find((el) => el.textContent.trim() === text);
    if (!target) {
      target = candidates.find((el) => el.textContent.includes(text));
    }
    return target;
  }

  // 「販売価格提案」「販売価格に応じてShippingを割り当て」「ストアカテゴリー一括変更」は
  // 「商品情報編集」ドロップダウンの中にあり、閉じている間は非表示（offsetParentがnull）になる。
  // 非表示の項目を見えないままクリックすると何も起きないことがあるため、ドロップダウンを開いた後、
  // 実際に表示されるまで待ってからクリックする
  async function openMenuItem(text) {
    let target = findMenuCandidate(text);

    if (target && target.offsetParent !== null) {
      fireFullClick(target);
      return true;
    }

    const dropdownTrigger = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === '商品情報編集'
    );

    if (dropdownTrigger) {
      fireFullClick(dropdownTrigger);
      target = await waitFor(() => {
        const candidate = findMenuCandidate(text);
        return candidate && candidate.offsetParent !== null ? candidate : null;
      }, 3000, 150);
    }

    if (!target) {
      log(`メニュー項目が見つかりません: ${text}`);
      return false;
    }

    fireFullClick(target);
    return true;
  }

  // メニューを開いて確認ボタンが現れるまで待機し、確認をクリックする
  // onOpened を渡すと、モーダル表示後・待機前に追加操作（例: カテゴリ選択）を実行できる
  async function menuConfirm(menuText, waitMs, onOpened) {
    log(`実行: ${menuText}`);
    const opened = await openMenuItem(menuText);
    if (!opened) return false;

    if (typeof onOpened === 'function') {
      await sleep(500);
      await onOpened();
    }

    await sleep(waitMs);

    // 部分一致だと「フィルターを保存」等の無関係なボタンを誤検出するため完全一致のみ対象にする。
    // さらに、前のモーダルが閉じきらず古い確定ボタンが残っているケースを避けるため、
    // 「キャンセル」ボタンと同じ並び（同じ親要素）にある確定ボタンのみを対象にする
    const CONFIRM_TEXTS = ['確定', '確認', '適用', '保存', '実行', 'OK', 'はい'];

    function findConfirmButton() {
      const cancelButtons = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.offsetParent !== null && b.textContent.trim() === 'キャンセル'
      );

      if (cancelButtons.length > 0) {
        const activeCancel = cancelButtons[cancelButtons.length - 1];
        const found = Array.from(activeCancel.parentElement.querySelectorAll('button')).find(
          (b) => CONFIRM_TEXTS.includes(b.textContent.trim())
        );
        if (found) return found;
      }

      const confirmButtons = Array.from(document.querySelectorAll('button')).filter(
        (b) => b.offsetParent !== null && CONFIRM_TEXTS.includes(b.textContent.trim())
      );
      return confirmButtons[confirmButtons.length - 1] || null;
    }

    // クリック後、モーダルが実際に閉じた（確定ボタンが消えた）ことを確認する。
    // 消えていなければ古いボタンを誤クリックしていた可能性があるため再試行する
    for (let attempt = 0; attempt < 3; attempt++) {
      const confirmButton = findConfirmButton();

      if (!confirmButton) {
        log(`${menuText} に確認ボタンが見つかりませんでした（待機のみ実施）`);
        break;
      }

      fireFullClick(confirmButton);
      log(`${menuText} の確認ボタンをクリックしました（${attempt + 1}回目）`);

      const closed = await waitFor(() => (findConfirmButton() ? null : true), 4000, 200);
      if (closed) {
        break;
      }
      log(`${menuText} のモーダルが閉じませんでした。再試行します`);
    }

    await sleep(1200);
    return true;
  }

  /* ======================================================================
   * SKU欄の特定とSKU連番入力
   *
   * 表ヘッダーの「SKU」列インデックスを特定し、その列の直下にある
   * input.fi-input[type="text"] のみを対象にする。
   * 検索欄やステータス欄を誤って対象にしないための制約。
   * ==================================================================== */

  function findSkuColumnIndex() {
    const headerCells = Array.from(document.querySelectorAll('table thead th'));
    for (let i = 0; i < headerCells.length; i++) {
      if (headerCells[i].textContent.trim() === 'SKU') {
        return i;
      }
    }
    return -1;
  }

  function findSkuInputs() {
    const colIndex = findSkuColumnIndex();
    if (colIndex === -1) {
      log('SKU列が見つかりませんでした');
      return [];
    }

    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const inputs = [];

    rows.forEach((row) => {
      const cells = row.querySelectorAll('td');
      const cell = cells[colIndex];
      if (!cell) return;
      const input = cell.querySelector('input.fi-input[type="text"]');
      if (input) inputs.push(input);
    });

    return inputs;
  }

  function setInputValue(input, value) {
    const proto = input.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // SKU欄を見つけてスクロールしてから、連番でSKUコードを入力する（例: AI260627-1, AI260627-2 ...）
  async function fillSkuSequence(skuCode, startNumber) {
    const inputs = findSkuInputs();
    if (inputs.length === 0) {
      log('入力対象のSKU欄が見つかりませんでした');
      return;
    }

    log(`SKU欄 ${inputs.length} 件に連番入力します（開始番号: ${startNumber}）`);

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(100);

      const seq = startNumber + i;
      const value = `${skuCode}-${seq}`;
      setInputValue(input, value);

      setProgress(`SKU入力中: ${i + 1} / ${inputs.length}`);
      await sleep(150);
    }

    log('SKU連番入力が完了しました');
    setProgress('');
  }

  /* ======================================================================
   * 各処理本体
   * ==================================================================== */

  async function runPriceSuggestion() {
    await menuConfirm('販売価格提案', 8000);
  }

  // 1つの一括操作が完了すると行の選択がリセットされるため、次の操作の前にページ上の
  // 行を再選択する（チェックボックスの見た目は残るが実際の選択は空になっていることがある）。
  // 外す→入れ直すクリックの間にLivewireの状態更新が追いつく時間を空ける
  async function reselectAllRowsOnPage() {
    const checkbox = document.querySelector('.fi-ta-page-checkbox');
    if (!checkbox) {
      log('全選択チェックボックスが見つかりませんでした');
      return;
    }
    if (!checkbox.checked) {
      fireFullClick(checkbox);
    } else {
      // 一度外して入れ直すことで、見た目はチェック済みでも実体が空の状態を復元する
      fireFullClick(checkbox);
      await sleep(400);
      fireFullClick(checkbox);
    }
    await sleep(400);
    log('行の選択を再設定しました');
  }

  async function runShippingAssignment() {
    await reselectAllRowsOnPage();
    await sleep(500);
    await menuConfirm('販売価格に応じてShippingを割り当て', 8000);
  }

  // Store Categoryの隠しselect(id末尾がstore_category_name)から、Choices.jsの
  // クリック対象（.choices__inner = selectの直接の親）と、検索欄/候補を探す範囲（その親）を取得する
  function findStoreCategoryParts() {
    const selects = Array.from(document.querySelectorAll('select[id$="store_category_name"]'));

    for (const select of selects) {
      const inner = select.closest('.choices__inner') || select.parentElement;
      if (inner && inner.offsetParent !== null) {
        const outer = inner.parentElement || inner;
        return { inner, outer };
      }
    }
    return null;
  }

  // Store Categoryコンボボックスを開き、検索欄に入力して候補をクリックする
  async function setStoreCategory(categoryName) {
    log(`Store Categoryを「${categoryName}」に設定します`);

    // モーダルはLivewireのサーバー往復を経て描画されるため、即座には現れないことがある
    const parts = await waitFor(() => findStoreCategoryParts(), 10000, 200);
    if (!parts) {
      const count = document.querySelectorAll('select[id$="store_category_name"]').length;
      log(`Store Category欄が見つかりませんでした（select候補: ${count}件）`);
      return false;
    }

    fireFullClick(parts.inner);
    await sleep(300);

    const searchInput = parts.outer.querySelector('input.choices__input--cloned, input[type="search"]');
    if (searchInput) {
      setInputValue(searchInput, categoryName);
      await sleep(500);
    } else {
      log('カテゴリ検索欄が見つかりませんでした（候補一覧から直接探します）');
    }

    const options = Array.from(parts.outer.querySelectorAll('.choices__item--choice')).filter(
      (el) => el.textContent.trim() === categoryName
    );

    if (options.length === 0) {
      log(`カテゴリ候補「${categoryName}」が見つかりませんでした`);
      return false;
    }

    fireFullClick(options[0]);
    log(`Store Categoryを「${categoryName}」に設定しました`);
    await sleep(300);
    return true;
  }

  const CATEGORY_LIST = [
    'Bags',
    'Wallets & Small Leather Goods',
    'Clothing',
    'Watches',
    'Accessories',
    'Pokemon',
    'Dust Bags / Storage Bags',
    'Other',
  ];

  function promptCategoryName() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'width:100%', 'height:100%',
        'background:rgba(0,0,0,0.4)', 'z-index:2000000',
        'display:flex', 'align-items:center', 'justify-content:center',
      ].join(';');

      const box = document.createElement('div');
      box.style.cssText = [
        'background:#fff', 'padding:20px', 'border-radius:8px',
        'width:300px', 'font-family:sans-serif', 'font-size:14px',
      ].join(';');

      const title = document.createElement('div');
      title.textContent = '👜 ストアカテゴリーを選択';
      title.style.cssText = 'font-weight:bold;font-size:15px;margin-bottom:12px;';
      box.appendChild(title);

      CATEGORY_LIST.forEach((cat) => {
        const btn = document.createElement('button');
        btn.textContent = cat;
        const isDefault = cat === settings.categoryName;
        btn.style.cssText = [
          'display:block', 'width:100%', 'margin:4px 0', 'padding:8px 10px',
          'font-size:13px', 'text-align:left', 'border-radius:4px', 'cursor:pointer',
          isDefault
            ? 'background:#2563eb;color:#fff;border:2px solid #2563eb;font-weight:bold;'
            : 'background:#f7f7f7;color:#333;border:1px solid #ccc;',
        ].join(';');
        btn.addEventListener('click', () => { overlay.remove(); resolve(cat); });
        box.appendChild(btn);
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'キャンセル';
      cancelBtn.style.cssText = [
        'display:block', 'width:100%', 'margin-top:10px', 'padding:8px',
        'font-size:13px', 'border:1px solid #ccc', 'border-radius:4px',
        'background:#fff', 'cursor:pointer', 'color:#555',
      ].join(';');
      cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });
      box.appendChild(cancelBtn);

      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }

  async function runCategoryChange() {
    const categoryName = await promptCategoryName();
    if (!categoryName) {
      log('カテゴリ選択がキャンセルされました');
      return;
    }
    await reselectAllRowsOnPage();
    await sleep(500);
    await menuConfirm('ストアカテゴリー一括変更', settings.categoryWaitMs, async () => {
      await setStoreCategory(categoryName);
    });
  }

  async function runItemSpecifics() {
    await reselectAllRowsOnPage();
    await sleep(500);
    await menuConfirm('Item Specificsを作成', settings.specificsWaitMs);
  }

  /* ======================================================================
   * AI コンディション入力
   * ==================================================================== */

  const AI_CONDITION_SYSTEM_PROMPT = `You are analyzing product condition reference data for a second-hand goods eBay listing.

TASK: From the provided reference data, extract two things:

1. CONDITION TEXT (for eBay buyers):
   - Include ONLY condition-relevant information explicitly stated in the data:
     scratches, scuffs, stains, discoloration, fading, corner wear, tears, cracks,
     peeling, stickiness, deformation, hardware damage, interior/exterior condition,
     handle/strap condition, zipper/closure function, odor, missing parts, functional issues
   - Organize by part when possible: Exterior:, Interior:, Handle:, Bottom:, Hardware:, Odor:, etc.
   - EXCLUDE: brand, model, size, color, material, accessories list, shipping, authenticity disclaimers,
     rank criteria tables, boilerplate phrases like "please check photos"
   - Use ONLY what is explicitly stated — never infer or speculate
   - Output English only, no Japanese, no preamble — ready to paste directly

2. RANK GRADE:
   Valid grades (choose one if clearly stated): S, A, AB, B, BC, C, D
   - Only output if the data explicitly states this item's grade
   - Do NOT infer rank from condition wording
   - Do NOT extract rank from a grade criteria table

Output format — condition text first, then optionally one RANK line at the end:
[condition text]
RANK: [grade]

Omit the RANK line if no grade is clearly stated.`;

  async function callClaudeAPI(productDescription) {
    const apiKey = settings.claudeApiKey;
    if (!apiKey) {
      throw new Error('Claude APIキーが設定されていません。⚙設定からAPIキーを入力してください。');
    }

    // 前処理: HTMLタグ・連続空白を除去してトークン数を削減する
    const cleaned = productDescription
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!cleaned || cleaned.length < 10) {
      throw new Error('商品説明が空か短すぎます');
    }

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        data: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          system: AI_CONDITION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `Product description:\n${cleaned}` }],
        }),
        onload(res) {
          if (res.status !== 200) {
            reject(new Error(`API エラー (${res.status}): ${res.responseText.slice(0, 200)}`));
            return;
          }
          try {
            const data = JSON.parse(res.responseText);
            const text = data.content?.[0]?.text?.trim();
            if (!text) { reject(new Error('AIから有効な回答が得られませんでした')); return; }
            resolve(text);
          } catch (e) {
            reject(new Error(`APIレスポンス解析エラー: ${e.message}`));
          }
        },
        onerror() {
          reject(new Error('API通信エラーが発生しました'));
        },
      });
    });
  }

  // 商品説明欄を取得する。FilamentのリッチテキストエディタはTipTap等のcontenteditable、
  // またはtextareaの場合がある。labelテキスト「商品説明」で紐付け、なければ最大の入力欄を返す
  function getProductDescription() {
    const labels = Array.from(document.querySelectorAll('label'));
    const descLabel = labels.find((l) => l.textContent.trim().includes('商品説明'));

    if (descLabel) {
      const forId = descLabel.getAttribute('for');
      if (forId) {
        const el = document.getElementById(forId);
        if (el) return el.value || el.innerText || '';
      }
      const parent = descLabel.closest('.fi-fo-field-wrp, .fi-fo-field, [data-field], div');
      if (parent) {
        const ta = parent.querySelector('textarea');
        if (ta && ta.offsetParent !== null) return ta.value;
        const ce = parent.querySelector('[contenteditable="true"]');
        if (ce && ce.offsetParent !== null) return ce.innerText;
      }
    }

    // フォールバック: 表示中の最大 textarea
    const textareas = Array.from(document.querySelectorAll('textarea')).filter(
      (t) => t.offsetParent !== null
    );
    if (textareas.length > 0) {
      const largest = textareas.reduce((a, b) => (a.value.length >= b.value.length ? a : b));
      if (largest.value.length > 20) return largest.value;
    }

    // フォールバック: 表示中の最大 contenteditable
    const editables = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(
      (e) => e.offsetParent !== null
    );
    if (editables.length > 0) {
      const largest = editables.reduce((a, b) => (a.innerText.length >= b.innerText.length ? a : b));
      if (largest.innerText.length > 20) return largest.innerText;
    }

    return null;
  }

  // ランク情報タブを探す
  function findRankInfoTab() {
    const candidates = Array.from(document.querySelectorAll('[role="tab"], button, a, li, span'));
    return candidates.find(
      (el) => el.textContent.trim() === 'ランク情報' && el.offsetParent !== null
    ) || null;
  }

  function setSelectValue(select, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    nativeSetter.call(select, value);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // labelテキストからフィールドの input/textarea/select を取得する汎用ヘルパー
  function findFieldByLabel(labelText, tag) {
    const labels = Array.from(document.querySelectorAll('label')).filter(
      (l) => l.offsetParent !== null && l.textContent.replace('*', '').trim() === labelText
    );
    for (const label of labels) {
      const forId = label.getAttribute('for');
      if (forId) {
        const el = document.getElementById(forId);
        if (el && (!tag || el.tagName === tag)) return el;
      }
      const parent = label.closest('.fi-fo-field-wrp, .fi-fo-field, [data-field], div');
      if (parent) {
        const el = tag
          ? parent.querySelector(tag.toLowerCase())
          : parent.querySelector('input[type="text"], textarea, select');
        if (el) return el;
      }
    }
    return null;
  }

  // 項目名inputを起点にDOM上方向に探索し、ランクselectと補足情報inputを持つコンテナを特定する
  function getEntryFieldsFromItemNameInput(itemNameInput) {
    let container = itemNameInput.parentElement;
    while (container && container !== document.body) {
      const visibleLabels = Array.from(container.querySelectorAll('label')).filter(
        (l) => l.offsetParent !== null
      );
      const rankLbl = visibleLabels.find((l) => l.textContent.replace('*', '').trim() === 'ランク');
      const suppLbl = visibleLabels.find((l) => l.textContent.trim() === '補足情報');
      if (rankLbl || suppLbl) {
        const getByLabel = (lbl) => {
          if (!lbl) return null;
          const forId = lbl.getAttribute('for');
          if (forId) {
            const el = document.getElementById(forId);
            if (el) return el;
          }
          const wrapper = lbl.closest('.fi-fo-field-wrp, .fi-fo-field, [data-field]') || lbl.parentElement;
          return wrapper ? (wrapper.querySelector('select, textarea, input[type="text"]') || null) : null;
        };
        return {
          itemNameInput,
          rankSelect: getByLabel(rankLbl),
          suppInput: getByLabel(suppLbl),
        };
      }
      container = container.parentElement;
    }
    return { itemNameInput, rankSelect: null, suppInput: null };
  }

  // 全ての「項目名」inputを取得してエントリ一覧を返す
  function findAllRankEntries() {
    // 「項目名」ラベルに対応する全 input を探す
    const itemNameInputs = Array.from(document.querySelectorAll('label'))
      .filter((l) => l.offsetParent !== null && l.textContent.replace('*', '').trim() === '項目名')
      .map((l) => {
        const forId = l.getAttribute('for');
        if (forId) return document.getElementById(forId);
        const wrapper = l.closest('.fi-fo-field-wrp, .fi-fo-field, [data-field]') || l.parentElement;
        return wrapper ? wrapper.querySelector('input[type="text"]') : null;
      })
      .filter(Boolean);

    log(`findAllRankEntries: 項目名input ${itemNameInputs.length}件, 値=[${itemNameInputs.map((i) => `"${i.value}"`).join(', ')}]`);

    return itemNameInputs.map((input) => getEntryFieldsFromItemNameInput(input));
  }

  // ランク情報フォーム内の3フィールドをまとめて返す（最後のエントリ）
  function findRankInfoFields() {
    const entries = findAllRankEntries();
    return entries.length > 0 ? entries[entries.length - 1] : { itemNameInput: null, rankSelect: null, suppInput: null };
  }

  // AI参照データタブを開いてフォームフィールドの値を収集する
  async function getAiReferenceData() {
    const tab = Array.from(document.querySelectorAll('[role="tab"], button, a, li, span')).find(
      (el) => el.textContent.trim() === 'AI参照データ' && el.offsetParent !== null
    );
    if (!tab) { log('AI参照データタブが見つかりませんでした'); return null; }

    fireFullClick(tab);
    await sleep(1000); // Filament/Alpine の表示切替を待つ

    // フォームフィールド（input.value, textarea.value, contenteditable.innerText）から値を収集する
    // panel.innerText では input/textarea の値が取れないため
    const allFields = Array.from(document.querySelectorAll(
      'input[type="text"], input[type="number"], textarea, [contenteditable="true"]'
    )).filter((el) => {
      if (el.offsetParent === null) return false; // 非表示要素を除外
      if (el.closest('#bsh-panel')) return false; // BaySpark Helper自身のパネルは除外
      return true;
    });

    log(`AI参照データ: 可視フィールド ${allFields.length}件検出`);

    const parts = [];
    for (const el of allFields) {
      const value = el.value !== undefined ? el.value : (el.innerText || el.textContent || '');
      if (value.trim().length < 3) continue;

      // ラベルテキストを探す
      let labelText = '';
      if (el.id) {
        try {
          const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lbl) labelText = lbl.textContent.replace('*', '').trim();
        } catch (e) {}
      }
      if (!labelText) {
        const wrapper = el.closest('.fi-fo-field-wrp, .fi-fo-field, [data-field]');
        if (wrapper) {
          const lbl = wrapper.querySelector('label');
          if (lbl) labelText = lbl.textContent.replace('*', '').trim();
        }
      }

      parts.push(labelText ? `${labelText}:\n${value.trim()}` : value.trim());
    }

    if (parts.length > 0) {
      return parts.join('\n\n---\n\n');
    }

    // フォールバック: 表示中のテキスト全体から "AI参照データ" 以降を取得
    const allText = document.body.innerText;
    const idx = allText.indexOf('AI参照データ');
    if (idx !== -1) {
      const chunk = allText.slice(idx + 7, idx + 5000).trim();
      if (chunk.length > 10) return chunk;
    }

    return null;
  }

  // 「使用するランク」をFilamentカスタムセレクトとnative selectの両方に対応して設定する
  async function setRankSystemSelect(targetName) {
    // Strategy 1: native <select> 要素
    const nativeSel = findFieldByLabel('使用するランク', 'SELECT');
    if (nativeSel) {
      log(`使用するランク: native selectが見つかりました（選択肢: ${Array.from(nativeSel.options).map((o) => o.text).join(', ')}）`);
      const opt = Array.from(nativeSel.options).find((o) => o.text.trim() === targetName);
      if (opt) { setSelectValue(nativeSel, opt.value); return; }
    }

    // Strategy 2: Filamentカスタムセレクト（クリックして開き、候補を選ぶ）
    const label = Array.from(document.querySelectorAll('label')).find(
      (l) => l.offsetParent !== null && l.textContent.trim().includes('使用するランク')
    );
    if (!label) { log('使用するランクのラベルが見つかりませんでした'); return; }

    const wrapper = label.closest('.fi-fo-field-wrp, .fi-fo-field, [data-field], div');
    if (!wrapper) { log('使用するランクのラッパーが見つかりませんでした'); return; }

    // ドロップダウントリガー（button, select, div等）をクリック
    const trigger = wrapper.querySelector('[role="combobox"], button, select');
    fireFullClick(trigger || wrapper);
    await sleep(400);

    // 展開された候補から選択
    const option = Array.from(document.querySelectorAll('[role="option"], li, .fi-select-option')).find(
      (el) => el.offsetParent !== null && el.textContent.trim() === targetName
    );
    if (option) {
      fireFullClick(option);
      log(`使用するランクを「${targetName}」に設定しました`);
      await sleep(300);
    } else {
      log(`「${targetName}」の候補が見つかりませんでした（Escで閉じます）`);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(200);
    }
  }

  async function runAiConditionInput() {
    log('AIコンディション入力を開始します');

    // Step 1: AI参照データを先に取得する（タブ切り替えが発生するため最初に行う）
    setProgress('AI参照データを読み取り中...');
    log('Step1: AI参照データを読み取ります');
    const refData = await getAiReferenceData();
    if (!refData || refData.trim().length < 10) {
      throw new Error('AI参照データが取得できませんでした。商品個別編集画面で実行してください。');
    }
    log(`Step1 完了: AI参照データ取得（${refData.trim().length}文字）`);

    // Step 2: Claude API 呼び出し
    setProgress('AIでコンディションを解析中...');
    log('Step2: Claude APIを呼び出します');
    const aiResponse = await callClaudeAPI(refData);
    log('Step2 完了: AI解析完了');

    // Step 3: RANK行を抽出して本文から除去
    let conditionText = aiResponse;
    let detectedRank = null;
    const rankMatch = aiResponse.match(/^RANK:\s*([A-Za-z]+)\s*$/m);
    if (rankMatch) {
      detectedRank = rankMatch[1].trim().toUpperCase();
      conditionText = aiResponse.replace(/^RANK:\s*[A-Za-z]+\s*\n?/m, '').trim();
      log(`Step3: ランクを検出しました: ${detectedRank}`);
    } else {
      log('Step3: ランク記載なし');
    }

    // Step 4: ランク情報タブを開く
    log('Step4: ランク情報タブを探します');
    const rankTab = findRankInfoTab();
    if (!rankTab) throw new Error('ランク情報タブが見つかりませんでした');
    fireFullClick(rankTab);
    log('Step4 完了: ランク情報タブを開きました');
    await sleep(800);

    // Step 5: 使用するランクを設定する（これによりエントリフォームが表示される）
    const rankSystemName = settings.rankSystemName || DEFAULT_SETTINGS.rankSystemName;
    log(`Step5: 使用するランクを「${rankSystemName}」に設定します`);
    await setRankSystemSelect(rankSystemName);
    log('Step5 完了');
    await sleep(800); // フォームが表示されるのを待つ

    // Step 6: 使用するランク設定後に既存エントリを確認し、なければ追加
    log('Step6: 既存のRankエントリを確認します');
    const existingItemInput = Array.from(document.querySelectorAll('input[type="text"]')).find(
      (el) => el.offsetParent !== null && el.value.trim() === rankSystemName
    );

    if (existingItemInput) {
      log(`Step6: 既存の「${rankSystemName}」エントリが見つかりました（追加スキップ）`);
    } else {
      const addRankBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.offsetParent !== null && b.textContent.trim().includes('ランク情報を追加')
      );
      if (addRankBtn) {
        fireFullClick(addRankBtn);
        log('Step6 完了: ランク情報を追加をクリックしました');
        await sleep(1000);
      } else {
        log('Step6: ランク情報を追加ボタンが見つかりませんでした');
      }
    }

    // Step 7: フォームフィールドを取得（補足情報が出るまで待つ）
    log('Step7: フォームフィールドを待ちます');
    const fields = await waitFor(() => {
      // 項目名=rankSystemName の input を起点に関連フィールドを探す
      const targetInput = Array.from(document.querySelectorAll('input[type="text"]')).find(
        (el) => el.offsetParent !== null && el.value.trim() === rankSystemName
      );
      if (targetInput) {
        const entry = getEntryFieldsFromItemNameInput(targetInput);
        if (entry.suppInput) return entry;
      }
      // 新規追加の場合: 最後の空の 項目名 input を使う
      const allEntries = findAllRankEntries();
      const last = allEntries[allEntries.length - 1];
      return (last && last.suppInput) ? last : null;
    }, 5000, 300);
    if (!fields || !fields.suppInput) throw new Error('補足情報入力欄が見つかりませんでした');
    log('Step7 完了: フォームフィールドが見つかりました');

    // Step 8: 既存値がある場合は上書き確認
    const existingValue = fields.suppInput.value || '';
    if (existingValue.trim()) {
      const overwrite = window.confirm(
        `補足情報に既存の内容があります。上書きしますか？\n\n現在の内容:\n${existingValue.trim().slice(0, 300)}`
      );
      if (!overwrite) { log('上書きをキャンセルしました'); return; }
    }

    // Step 9: 補足情報を入力
    setInputValue(fields.suppInput, conditionText);
    log('Step9 完了: 補足情報を入力しました');

    // Step 9b: 項目名が空なら設定する（新規追加時にBaySparkが自動入力しない場合）
    if (fields.itemNameInput && !fields.itemNameInput.value.trim()) {
      setInputValue(fields.itemNameInput, rankSystemName);
      log(`Step9b: 項目名を「${rankSystemName}」に設定しました`);
    }

    // Step 10: ランクドロップダウンを設定（"C（Poor）"→"C" で照合）
    if (detectedRank && fields.rankSelect) {
      const opt = Array.from(fields.rankSelect.options).find((o) => {
        const key = o.text.replace(/[（(].*/, '').trim().toUpperCase();
        return key === detectedRank || o.value.toUpperCase() === detectedRank;
      });
      if (opt) {
        setSelectValue(fields.rankSelect, opt.value);
        log(`Step10 完了: ランクを「${detectedRank}」に設定しました`);
      } else {
        log(`Step10: ランク「${detectedRank}」が見つかりません（選択肢: ${Array.from(fields.rankSelect.options).map((o) => o.text).join(', ')}）`);
      }
    } else if (detectedRank) {
      log(`Step10: ランク「${detectedRank}」を検出しましたが、選択欄が見つかりませんでした`);
    }

    log('コンディションを入力しました ✓');
  }

  /* ======================================================================
   * AI コンディション一括入力（リストページ → 編集ページを順番に自動処理）
   * ==================================================================== */

  const AUTORUN_KEY = 'bayspark_helper_autorun_queue';

  // チェックされた行から編集ページURLを収集する
  function getCheckedEditUrls() {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const urls = [];

    rows.forEach((row) => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (!checkbox || !checkbox.checked) return;

      const links = Array.from(row.querySelectorAll('a[href]'));

      // /edit を含むリンクを優先
      let editLink = links.find((a) => a.href.includes('/edit'));
      // なければ /products/数字 パターン
      if (!editLink) editLink = links.find((a) => /\/\d+/.test(new URL(a.href).pathname));
      // なければ行の data-href
      if (!editLink) {
        const dataHref = row.getAttribute('data-href');
        if (dataHref) { urls.push(new URL(dataHref, location.origin).href); return; }
      }

      if (editLink) urls.push(editLink.href);
      else log(`行のリンクが取得できませんでした: ${row.textContent.trim().slice(0, 40)}`);
    });

    return urls;
  }

  // 保存ボタンをクリックして保存完了を待つ
  async function saveProductForm() {
    const saveBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === '保存' && b.offsetParent !== null && !b.disabled
    );
    if (!saveBtn) { log('保存ボタンが見つかりませんでした'); return false; }
    fireFullClick(saveBtn);
    log('保存しました');
    await sleep(2500);
    return true;
  }

  // リストページでチェック済み商品を同じタブで順番に処理する
  async function runBulkAiConditionInput() {
    const urls = getCheckedEditUrls();
    if (urls.length === 0) {
      throw new Error(
        'チェックされた商品の編集URLが取得できませんでした。\n' +
        '商品管理リストでチェックボックスを選択した状態で実行してください。'
      );
    }
    log(`${urls.length}件を順番に処理します`);
    localStorage.setItem(AUTORUN_KEY, JSON.stringify({
      urls,
      index: 0,
      returnUrl: window.location.href,
    }));
    log('1件目に移動します...');
    await sleep(300);
    window.location.href = urls[0];
  }

  // 編集ページ起動時にキューをチェックし、該当する場合は自動処理する
  async function checkAutorunQueue() {
    const raw = localStorage.getItem(AUTORUN_KEY);
    if (!raw) return;

    let queue;
    try { queue = JSON.parse(raw); } catch (e) { localStorage.removeItem(AUTORUN_KEY); return; }
    if (!queue.urls || queue.index >= queue.urls.length) { localStorage.removeItem(AUTORUN_KEY); return; }

    const normalize = (url) => new URL(url, window.location.href).pathname.replace(/\/$/, '');
    if (normalize(window.location.href) !== normalize(queue.urls[queue.index])) return;

    const current = queue.index;
    const total = queue.urls.length;

    // 処理開始直前にインデックスを進める（保存後のページリロードで二重実行を防ぐ）
    const nextIndex = current + 1;
    if (nextIndex < total) {
      queue.index = nextIndex;
      localStorage.setItem(AUTORUN_KEY, JSON.stringify(queue));
    } else {
      localStorage.removeItem(AUTORUN_KEY);
    }

    log(`AI一括処理: ${current + 1} / ${total} 件目`);
    setProgress(`AI一括処理中 (${current + 1}/${total})...`);

    await sleep(3000);

    try {
      await runAiConditionInput();
      await sleep(500);
      await saveProductForm();
      log(`${current + 1}件目の処理が完了しました`);
    } catch (e) {
      log(`エラー（スキップして次へ）: ${e.message}`);
    }

    // 保存後のFilamentリダイレクトより先に次URLへ移動する（遅延なし）
    if (nextIndex < total) {
      log(`次の商品へ移動します (${nextIndex + 1}/${total})`);
      window.location.href = queue.urls[nextIndex];
    } else {
      log('全件の処理が完了しました。リストに戻ります...');
      await sleep(500);
      if (queue.returnUrl) window.location.href = queue.returnUrl;
    }
  }

  /* ======================================================================
   * SKU入力プロンプト
   * ==================================================================== */

  let pendingSkuInfo = null;

  // 今日の日付をYYMMDD形式で返す（SKUコードの初期値に使用）
  function getTodayCode() {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yy}${mm}${dd}`;
  }

  function promptSkuInfo() {
    const defaultSkuCode = pendingSkuInfo ? pendingSkuInfo.skuCode : `AI${getTodayCode()}`;
    const skuCode = window.prompt('SKUコードを入力してください', defaultSkuCode);
    if (skuCode === null) return null;

    const startStr = window.prompt('開始番号を入力してください', pendingSkuInfo ? String(pendingSkuInfo.startNumber) : '1');
    if (startStr === null) return null;

    const startNumber = parseInt(startStr, 10);
    if (Number.isNaN(startNumber)) {
      window.alert('開始番号は数値で入力してください');
      return null;
    }

    pendingSkuInfo = { skuCode, startNumber };
    return pendingSkuInfo;
  }

  async function runSkuOnly() {
    const info = promptSkuInfo();
    if (!info) {
      log('SKU入力がキャンセルされました');
      return;
    }
    await fillSkuSequence(info.skuCode, info.startNumber);
  }

  /* ======================================================================
   * 一括処理（全工程をまとめて実行）
   * ==================================================================== */

  async function runBatchProcess() {
    const info = promptSkuInfo();
    if (!info) {
      log('SKU入力がキャンセルされたため、一括処理を中止しました');
      return;
    }

    const categoryName = await promptCategoryName();
    if (!categoryName) {
      log('カテゴリ選択がキャンセルされたため、一括処理を中止しました');
      return;
    }

    log('一括処理を開始します');

    // SKU入力ポップアップを閉じた直後はページ側の状態が不安定なため、少し待機する
    await sleep(800);

    // 各処理の直後は行選択状態の同期がまだ追いついていないことがあるため、間に待機を入れる
    await runPriceSuggestion();
    await sleep(2500);

    await runShippingAssignment();
    await sleep(2500);

    await reselectAllRowsOnPage();
    await sleep(500);
    await menuConfirm('ストアカテゴリー一括変更', settings.categoryWaitMs, async () => {
      await setStoreCategory(categoryName);
    });
    await sleep(2500);

    await runItemSpecifics();
    await sleep(2500);

    log('SKU連番入力を実行します');
    await fillSkuSequence(info.skuCode, info.startNumber);

    log('一括処理が完了しました');
  }

  /* ======================================================================
   * 処理実行ラッパー（ロック・進捗・エラー処理）
   * ==================================================================== */

  function wrapAction(label, fn) {
    return async function () {
      lockButtons(true);
      setProgress(`${label} 実行中...`);
      try {
        await fn();
      } catch (e) {
        log(`エラー: ${label} - ${e.message}`);
      } finally {
        setProgress('');
        lockButtons(false);
      }
    };
  }

  /* ======================================================================
   * UI構築
   * ==================================================================== */

  function createButton(label, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = [
      'display:block',
      'width:100%',
      'margin:4px 0',
      'padding:8px',
      'font-size:13px',
      'border:1px solid #ccc',
      'border-radius:4px',
      'background:#f7f7f7',
      'cursor:pointer',
    ].join(';');
    btn.addEventListener('click', onClick);
    btn.addEventListener('mouseenter', () => {
      if (!btn.disabled) btn.style.background = '#eaeaea';
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.disabled) btn.style.background = '#f7f7f7';
    });
    return btn;
  }

  function openSettingsPanel() {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'width:100%',
      'height:100%',
      'background:rgba(0,0,0,0.4)',
      'z-index:1000000',
      'display:flex',
      'align-items:center',
      'justify-content:center',
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
      'background:#fff',
      'padding:20px',
      'border-radius:8px',
      'width:320px',
      'font-family:sans-serif',
      'font-size:13px',
    ].join(';');

    box.innerHTML = `
      <h3 style="margin:0 0 12px;font-size:15px;">⚙ 設定</h3>
      <label style="display:block;margin-bottom:8px;">
        ストアカテゴリ名
        <input id="bsh-set-category" type="text" style="width:100%;box-sizing:border-box;margin-top:4px;padding:4px;">
      </label>
      <label style="display:block;margin-bottom:8px;">
        カテゴリ反映待機時間（ミリ秒）
        <input id="bsh-set-category-wait" type="number" style="width:100%;box-sizing:border-box;margin-top:4px;padding:4px;">
      </label>
      <label style="display:block;margin-bottom:8px;">
        Item Specifics待機時間（ミリ秒）
        <input id="bsh-set-specifics-wait" type="number" style="width:100%;box-sizing:border-box;margin-top:4px;padding:4px;">
      </label>
      <label style="display:block;margin-bottom:8px;">
        使用するランク（例: Rank / Rank (サイズ有)）
        <input id="bsh-set-rank-system-name" type="text" style="width:100%;box-sizing:border-box;margin-top:4px;padding:4px;">
      </label>
      <label style="display:block;margin-bottom:4px;">
        Claude APIキー（AIコンディション入力で使用）
        <input id="bsh-set-api-key" type="password" placeholder="sk-ant-..." style="width:100%;box-sizing:border-box;margin-top:4px;padding:4px;font-family:monospace;">
      </label>
      <div style="font-size:11px;color:#888;margin-bottom:12px;">
        ※ Anthropic Console で発行した APIキーを入力してください
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="bsh-set-cancel" style="padding:6px 12px;">キャンセル</button>
        <button id="bsh-set-save" style="padding:6px 12px;">保存</button>
      </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    box.querySelector('#bsh-set-category').value = settings.categoryName;
    box.querySelector('#bsh-set-category-wait').value = settings.categoryWaitMs;
    box.querySelector('#bsh-set-specifics-wait').value = settings.specificsWaitMs;
    box.querySelector('#bsh-set-rank-system-name').value = settings.rankSystemName || DEFAULT_SETTINGS.rankSystemName;
    box.querySelector('#bsh-set-api-key').value = settings.claudeApiKey || '';

    box.querySelector('#bsh-set-cancel').addEventListener('click', () => overlay.remove());

    box.querySelector('#bsh-set-save').addEventListener('click', () => {
      settings.categoryName = box.querySelector('#bsh-set-category').value || DEFAULT_SETTINGS.categoryName;
      settings.categoryWaitMs = parseInt(box.querySelector('#bsh-set-category-wait').value, 10) || DEFAULT_SETTINGS.categoryWaitMs;
      settings.specificsWaitMs = parseInt(box.querySelector('#bsh-set-specifics-wait').value, 10) || DEFAULT_SETTINGS.specificsWaitMs;
      settings.rankSystemName = box.querySelector('#bsh-set-rank-system-name').value.trim() || DEFAULT_SETTINGS.rankSystemName;
      settings.claudeApiKey = box.querySelector('#bsh-set-api-key').value.trim();
      saveSettings(settings);
      log('設定を保存しました');
      overlay.remove();
    });
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.style.cssText = [
      'position:fixed',
      'top:100px',
      'right:10px',
      'width:260px',
      'max-height:50vh',
      'overflow-y:auto',
      'background:#fff',
      'border:1px solid #999',
      'border-radius:8px',
      'box-shadow:0 4px 12px rgba(0,0,0,0.2)',
      'padding:12px',
      'font-family:sans-serif',
      'font-size:13px',
      'z-index:999999',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'BaySpark Helper パネル';
    title.style.cssText = 'font-weight:bold;margin-bottom:8px;';
    panel.appendChild(title);

    const buttonDefs = [
      ['🚀 一括処理', wrapAction('一括処理', runBatchProcess)],
      ['🏷 SKUのみ入力', wrapAction('SKUのみ入力', runSkuOnly)],
      ['📦 Shippingのみ設定', wrapAction('Shippingのみ設定', runShippingAssignment)],
      ['👜 カテゴリのみ変更', wrapAction('カテゴリのみ変更', runCategoryChange)],
      ['📝 Item Specificsのみ作成', wrapAction('Item Specificsのみ作成', runItemSpecifics)],
      ['💰 販売価格提案のみ', wrapAction('販売価格提案のみ', runPriceSuggestion)],
      ['🤖 AIコンディション入力', wrapAction('AIコンディション入力', runAiConditionInput)],
      ['🤖 AI一括（選択商品）', wrapAction('AI一括コンディション入力', runBulkAiConditionInput)],
      ['⚙ 設定', () => openSettingsPanel()],
      ['🧹 ログクリア', () => clearLog()],
    ];

    actionButtons = [];
    buttonDefs.forEach(([label, handler]) => {
      const btn = createButton(label, handler);
      panel.appendChild(btn);
      actionButtons.push(btn);
    });

    const progress = document.createElement('div');
    progress.style.cssText = 'margin-top:8px;font-size:12px;color:#555;min-height:16px;';
    panel.appendChild(progress);
    progressEl = progress;

    const logTitle = document.createElement('div');
    logTitle.textContent = '処理ログ';
    logTitle.style.cssText = 'margin-top:8px;font-weight:bold;font-size:12px;';
    panel.appendChild(logTitle);

    const logBox = document.createElement('div');
    logBox.style.cssText = [
      'margin-top:4px',
      'height:140px',
      'overflow-y:auto',
      'background:#f5f5f5',
      'border:1px solid #ddd',
      'border-radius:4px',
      'padding:6px',
      'font-size:11px',
      'white-space:pre-wrap',
    ].join(';');
    panel.appendChild(logBox);
    logEl = logBox;
    restoreLogs();

    return panel;
  }

  // document.body直下に固定表示する。BaySpark側（Livewire）が管理するDOMの内部に置くと、
  // 定期的な再描画（お知らせのwire:poll等）でボタンが消えてしまうため、body直下に置く
  function createToggleButton() {
    const btn = document.createElement('button');
    btn.textContent = 'BaySpark Helper';
    btn.style.cssText = [
      'position:fixed',
      'top:56px',
      'right:10px',
      'padding:8px 14px',
      'background:#2563eb',
      'color:#fff',
      'border:none',
      'border-radius:6px',
      'font-size:13px',
      'font-weight:bold',
      'cursor:pointer',
      'z-index:999999',
      'box-shadow:0 2px 6px rgba(0,0,0,0.3)',
    ].join(';');

    let panel = null;

    btn.addEventListener('click', () => {
      if (panel) {
        panel.remove();
        panel = null;
        return;
      }
      panel = buildPanel();
      document.body.appendChild(panel);
    });

    return btn;
  }

  /* ======================================================================
   * 初期化
   * ==================================================================== */

  function init() {
    const toggleBtn = createToggleButton();
    document.body.appendChild(toggleBtn);
    console.log('[BaySpark Helper] 起動しました (v1.29)');
    // 編集ページで自動実行キューが残っていれば処理を続行する
    checkAutorunQueue();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
