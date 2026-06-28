// ==UserScript==
// @name         BaySpark Helper
// @namespace    bayspark-helper
// @version      1.23
// @description  BaySpark商品管理画面の一括処理を補助するツール
// @match        https://bridgemencalendar.com/*
// @run-at       document-idle
// @grant        none
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
  }

  function clearLog() {
    if (logEl) logEl.innerHTML = '';
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
    const opts = { bubbles: true, cancelable: true, view: window };
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
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
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

  async function runCategoryChange() {
    await reselectAllRowsOnPage();
    await sleep(500);
    await menuConfirm('ストアカテゴリー一括変更', settings.categoryWaitMs, async () => {
      await setStoreCategory(settings.categoryName);
    });
  }

  async function runItemSpecifics() {
    await reselectAllRowsOnPage();
    await sleep(500);
    await menuConfirm('Item Specificsを作成', settings.specificsWaitMs);
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

    log('一括処理を開始します');

    // SKU入力ポップアップを閉じた直後はページ側の状態が不安定なため、少し待機する
    await sleep(800);

    // 各処理の直後は行選択状態の同期がまだ追いついていないことがあるため、間に待機を入れる
    await runPriceSuggestion();
    await sleep(2500);

    await runShippingAssignment();
    await sleep(2500);

    await runCategoryChange();
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
      <label style="display:block;margin-bottom:12px;">
        Item Specifics待機時間（ミリ秒）
        <input id="bsh-set-specifics-wait" type="number" style="width:100%;box-sizing:border-box;margin-top:4px;padding:4px;">
      </label>
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

    box.querySelector('#bsh-set-cancel').addEventListener('click', () => overlay.remove());

    box.querySelector('#bsh-set-save').addEventListener('click', () => {
      settings.categoryName = box.querySelector('#bsh-set-category').value || DEFAULT_SETTINGS.categoryName;
      settings.categoryWaitMs = parseInt(box.querySelector('#bsh-set-category-wait').value, 10) || DEFAULT_SETTINGS.categoryWaitMs;
      settings.specificsWaitMs = parseInt(box.querySelector('#bsh-set-specifics-wait').value, 10) || DEFAULT_SETTINGS.specificsWaitMs;
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
    console.log('[BaySpark Helper] 起動しました (v1.6)');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
