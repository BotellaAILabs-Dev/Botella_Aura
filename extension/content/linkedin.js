/**
 * LinkedIn content script — the action panel (Sprint 4, Module 2).
 *
 * SAFETY MODEL: this script never logs in, never automates a send, and never
 * runs on a timer or loop. It renders a panel of items the backend prepared,
 * and for each item the HUMAN clicks once. "Insert" places the approved text
 * into LinkedIn's own composer; the human then clicks LinkedIn's native Post
 * button themselves and confirms with "Mark as posted", which syncs status back
 * to Botella Aura. We deliberately do NOT auto-click LinkedIn's submit button —
 * the human's real click on LinkedIn's own UI is the send action.
 */
(() => {
  if (window.__auraPanelMounted) return;
  window.__auraPanelMounted = true;

  const msg = (m) =>
    new Promise((resolve) => chrome.runtime.sendMessage(m, resolve));

  let open = false;
  let items = [];

  // --- launcher + panel shell ---------------------------------------------
  const launcher = document.createElement('button');
  launcher.className = 'aura-launcher';
  launcher.textContent = '✦ Aura';
  launcher.addEventListener('click', togglePanel);
  document.body.appendChild(launcher);

  const panel = document.createElement('div');
  panel.className = 'aura-panel aura-hidden';
  document.body.appendChild(panel);

  async function togglePanel() {
    open = !open;
    panel.classList.toggle('aura-hidden', !open);
    if (open) await refresh();
  }

  async function refresh() {
    panel.innerHTML = `<div class="aura-head">
        <span class="aura-title">✦ Botella Aura</span>
        <button class="aura-x" title="Close">×</button>
      </div>
      <div class="aura-body"><p class="aura-muted">Loading your queue…</p></div>`;
    panel.querySelector('.aura-x').addEventListener('click', togglePanel);

    const state = await msg({ type: 'AURA_GET_STATE' });
    if (!state || !state.hasToken) {
      renderNeedsPairing();
      return;
    }

    const [status, queue] = await Promise.all([
      msg({ type: 'AURA_STATUS' }),
      msg({ type: 'AURA_QUEUE' }),
    ]);

    if (!queue || !queue.ok) {
      const reason =
        queue && queue.status === 401
          ? 'Your extension token is invalid or revoked. Re-pair from Botella Aura settings.'
          : (queue && queue.data && queue.data.error) || 'Could not load your queue.';
      renderError(reason);
      return;
    }

    items = queue.data.items || [];
    render(status && status.rate, status && status.data);
  }

  function renderNeedsPairing() {
    const body = panel.querySelector('.aura-body');
    body.innerHTML = `<p class="aura-muted">Not paired yet.</p>
      <p class="aura-muted">Open the Botella Aura extension popup and paste your pairing token, then reopen this panel.</p>`;
  }

  function renderError(text) {
    const body = panel.querySelector('.aura-body');
    body.innerHTML = `<p class="aura-error"></p>`;
    body.querySelector('.aura-error').textContent = text;
  }

  function render(rate, status) {
    const body = panel.querySelector('.aura-body');
    body.innerHTML = '';

    // Healthy-usage indicator.
    if (rate) {
      const bar = document.createElement('div');
      bar.className = 'aura-usage';
      bar.textContent = `Healthy usage — ${rate.daily}/${rate.dailyCap} today · ${rate.hourly}/${rate.hourlyCap} this hour`;
      body.appendChild(bar);
    }
    if (status && status.company) {
      const w = document.createElement('div');
      w.className = 'aura-muted aura-workspace';
      w.textContent = `Workspace: ${status.company}`;
      body.appendChild(w);
    }

    // Engagement Copilot: draft a comment for the post currently on screen.
    body.appendChild(renderEngageSection());

    const queueHeading = document.createElement('div');
    queueHeading.className = 'aura-muted aura-section-heading';
    queueHeading.textContent = 'Your queue';
    body.appendChild(queueHeading);

    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'aura-muted';
      empty.textContent = 'Nothing waiting. Approve content in Botella Aura and it shows up here.';
      body.appendChild(empty);
      return;
    }

    for (const item of items) {
      body.appendChild(renderItem(item));
    }
  }

  function renderItem(item) {
    const card = document.createElement('div');
    card.className = 'aura-item';

    const title = document.createElement('div');
    title.className = 'aura-item-title';
    title.textContent = item.title || 'Item';
    card.appendChild(title);

    if (item.subtitle) {
      const sub = document.createElement('div');
      sub.className = 'aura-item-sub';
      sub.textContent = item.subtitle;
      card.appendChild(sub);
    }

    const preview = document.createElement('div');
    preview.className = 'aura-item-text';
    preview.textContent = item.text;
    card.appendChild(preview);

    const media = item.media || [];
    if (media.length > 0) {
      card.appendChild(renderMediaStrip(item, media));
    }

    const actions = document.createElement('div');
    actions.className = 'aura-actions';

    const insertBtn = document.createElement('button');
    insertBtn.className = 'aura-btn aura-btn-primary';
    insertBtn.textContent = media.length > 0 ? 'Insert text + image' : 'Insert into composer';
    insertBtn.addEventListener('click', () => onInsert(item, card));
    actions.appendChild(insertBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'aura-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(item.text);
      copyBtn.textContent = 'Copied';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
    });
    actions.appendChild(copyBtn);

    card.appendChild(actions);
    return card;
  }

  /**
   * Thumbnails of the graphics attached to a queued post.
   *
   * The images are fetched one at a time, on demand, through the background
   * worker — the queue listing carries only metadata, so opening the panel does
   * not pull megabytes of pictures the user may never look at.
   */
  function renderMediaStrip(item, media) {
    const strip = document.createElement('div');
    strip.className = 'aura-media-strip';

    for (const m of media) {
      const cell = document.createElement('div');
      cell.className = 'aura-media-cell';
      cell.textContent = '…';
      strip.appendChild(cell);

      loadMedia(m.assetId).then((file) => {
        if (!file) {
          cell.textContent = '⚠';
          cell.title = 'This graphic could not be loaded.';
          return;
        }
        const img = document.createElement('img');
        img.className = 'aura-media-thumb';
        img.src = file.objectUrl;
        img.alt = m.altText || 'Attached graphic';
        cell.textContent = '';
        cell.appendChild(img);
      });
    }

    const hint = document.createElement('p');
    hint.className = 'aura-muted aura-media-hint';
    hint.textContent =
      media.length === 1
        ? '1 graphic attached'
        : `${media.length} graphics attached`;
    strip.appendChild(hint);
    return strip;
  }

  /**
   * Fetch one graphic and turn it into a real File.
   *
   * LinkedIn's uploader is a plain <input type="file">, so a File plus a
   * DataTransfer is all it takes to fill it — the same object the browser would
   * hand it if the human had picked the file themselves. Results are cached per
   * panel session so re-rendering does not re-download.
   */
  const mediaCache = new Map();

  async function loadMedia(assetId) {
    if (mediaCache.has(assetId)) return mediaCache.get(assetId);

    const res = await msg({ type: 'AURA_MEDIA', assetId });
    if (!res || !res.ok || !res.data || !res.data.data) {
      mediaCache.set(assetId, null);
      return null;
    }
    try {
      const binary = atob(res.data.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const mimeType = res.data.mimeType || 'image/png';
      const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
      const blob = new Blob([bytes], { type: mimeType });
      const entry = {
        file: new File([blob], `aura-graphic-${assetId}.${extension}`, { type: mimeType }),
        objectUrl: URL.createObjectURL(blob),
      };
      mediaCache.set(assetId, entry);
      return entry;
    } catch {
      mediaCache.set(assetId, null);
      return null;
    }
  }

  /**
   * Put the graphic into LinkedIn's own image picker.
   *
   * This fills the file input the human would have used; it does NOT submit
   * anything. The safety model is unchanged — the human still reviews the
   * composer and clicks LinkedIn's own Post button.
   */
  function attachImageToComposer(file) {
    const input = document.querySelector(
      'input[type="file"][accept*="image"], .share-box input[type="file"], ' +
        'input[type="file"][name*="image" i]',
    );
    if (!input) return false;
    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  async function onInsert(item, card) {
    const inserted = insertIntoComposer(item.text);
    if (!inserted) {
      navigator.clipboard.writeText(item.text).catch(() => {});
      note(
        card,
        '✓ Text copied. Click LinkedIn’s "Start a post", click inside the box, and press Ctrl+V to paste. (Tip: to post to your OWN profile, use the Publish button in Botella Aura → Content Studio instead — it posts via the API, no copy-paste.)',
        'warn',
      );
      return;
    }

    // Text is in. Now try the graphic, if there is one.
    let mediaNote = '';
    const media = item.media || [];
    if (media.length > 0) {
      const loaded = await loadMedia(media[0].assetId);
      if (!loaded) {
        mediaNote = ' The graphic could not be loaded — download it from Content Studio and add it by hand.';
      } else if (attachImageToComposer(loaded.file)) {
        mediaNote = ' The graphic was added to the composer too.';
      } else {
        // No file input on screen: LinkedIn only renders it once the human
        // clicks the photo button, so tell them that rather than failing.
        mediaNote =
          ' Click the photo icon in LinkedIn’s composer, then press "Insert text + image" again to add the graphic.';
      }
    }

    // The HUMAN reviews and clicks LinkedIn's own Post button, then confirms
    // here to sync status.
    note(
      card,
      `Inserted.${mediaNote} Review it, click LinkedIn’s Post button yourself, then mark it posted below.`,
      'ok',
    );
    if (!card.querySelector('.aura-confirm')) {
      const confirm = document.createElement('button');
      confirm.className = 'aura-btn aura-btn-primary aura-mt aura-confirm';
      confirm.textContent = 'I posted it — mark as posted';
      confirm.addEventListener('click', () => onComplete(item, card));
      card.querySelector('.aura-actions').appendChild(confirm);
    }
  }

  async function onComplete(item, card) {
    const res = await msg({
      type: 'AURA_COMPLETE',
      itemType: item.itemType,
      itemId: item.itemId,
      postedUrl: location.href,
    });
    if (res && res.ok) {
      card.classList.add('aura-done');
      note(card, 'Marked as posted. Synced to Botella Aura.', 'ok');
      setTimeout(refresh, 900);
    } else if (res && res.rateLimited) {
      note(card, res.error, 'warn');
    } else {
      note(card, (res && res.error) || 'Could not sync. Try again.', 'error');
    }
  }

  function note(card, text, kind) {
    let n = card.querySelector('.aura-note');
    if (!n) {
      n = document.createElement('div');
      n.className = 'aura-note';
      card.appendChild(n);
    }
    n.className = `aura-note aura-note-${kind}`;
    n.textContent = text;
  }

  // --- Engagement Copilot -------------------------------------------------

  function renderEngageSection() {
    const wrap = document.createElement('div');
    wrap.className = 'aura-engage';
    const btn = document.createElement('button');
    btn.className = 'aura-btn aura-btn-primary';
    btn.textContent = '💬 Draft a comment for this post';
    btn.addEventListener('click', () => onEngage(wrap, btn));
    wrap.appendChild(btn);
    const hint = document.createElement('p');
    hint.className = 'aura-muted aura-engage-hint';
    hint.textContent =
      'Reads only the post already on your screen. We never fetch LinkedIn.';
    wrap.appendChild(hint);

    // Sprint 5 — sync the metrics visible on your OWN post page.
    const metricsBtn = document.createElement('button');
    metricsBtn.className = 'aura-btn aura-mt';
    metricsBtn.textContent = '📊 Sync this post’s metrics';
    metricsBtn.addEventListener('click', () => onSyncMetrics(wrap));
    wrap.appendChild(metricsBtn);
    return wrap;
  }

  async function onSyncMetrics(wrap) {
    const m = readPostMetrics();
    if (!m || (m.likes == null && m.comments == null && m.reposts == null)) {
      note(wrap, 'No visible metrics found. Open your published post to sync its numbers.', 'warn');
      return;
    }
    const res = await msg({
      type: 'AURA_SYNC_METRICS',
      postUrl: location.href,
      likes: m.likes,
      comments: m.comments,
      reposts: m.reposts,
    });
    if (res && res.ok) {
      const attach = res.data && res.data.attach;
      const msg =
        attach === 'exact'
          ? `Synced (${m.likes ?? 0} likes, ${m.comments ?? 0} comments) to this post.`
          : attach === 'recent'
            ? `Synced (${m.likes ?? 0} likes, ${m.comments ?? 0} comments) to your most recent Aura post.`
            : 'Metrics read — but you have no Aura-published post to attach them to yet. Publish a post through Aura first, then sync.';
      note(wrap, msg, attach === 'none' ? 'warn' : 'ok');
    } else {
      note(wrap, (res && res.data && res.data.error) || 'Sync failed.', 'error');
    }
  }

  /** Read like/comment/repost counts already rendered on the user's own post. */
  function readPostMetrics() {
    const num = (el) => {
      if (!el) return null;
      const digits = (el.textContent || '').replace(/[^\d]/g, '');
      return digits ? parseInt(digits, 10) : null;
    };
    const likes = num(document.querySelector('.social-details-social-counts__reactions-count'));
    const commentsEl = document.querySelector(
      '.social-details-social-counts__comments, [aria-label*="comment" i]',
    );
    const comments = num(commentsEl);
    const repostsEl = document.querySelector('[aria-label*="repost" i], [aria-label*="share" i]');
    const reposts = num(repostsEl);
    return { likes, comments, reposts };
  }

  async function onEngage(wrap, btn) {
    const post = readVisiblePost();
    if (!post || !post.text) {
      note(wrap, 'No post found on screen. Scroll to a post and try again.', 'warn');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Drafting…';
    const res = await msg({
      type: 'AURA_ENGAGE_DRAFT',
      postUrl: post.url,
      postText: post.text,
      author: post.author,
    });
    btn.disabled = false;
    btn.textContent = '💬 Draft a comment for this post';
    if (!res || !res.ok) {
      note(wrap, (res && res.data && res.data.error) || 'Draft failed.', 'error');
      return;
    }
    renderDraftedComment(wrap, res.data.commentId, res.data.text, post);
  }

  function renderDraftedComment(wrap, commentId, text, post) {
    const prev = wrap.querySelector('.aura-engage-draft');
    if (prev) prev.remove();

    const card = document.createElement('div');
    card.className = 'aura-engage-draft aura-item';
    const ta = document.createElement('textarea');
    ta.className = 'aura-textarea';
    ta.rows = 4;
    ta.value = text;
    card.appendChild(ta);

    const actions = document.createElement('div');
    actions.className = 'aura-actions';

    const insertBtn = document.createElement('button');
    insertBtn.className = 'aura-btn aura-btn-primary';
    insertBtn.textContent = 'Insert into comment box';
    insertBtn.addEventListener('click', () => {
      const ok = insertIntoCommentBox(ta.value);
      if (!ok) {
        navigator.clipboard.writeText(ta.value).catch(() => {});
        note(card, 'Open the comment box, then insert again (copied as fallback).', 'warn');
      } else {
        note(card, 'Inserted. Post it yourself, then mark it posted.', 'ok');
      }
    });

    const postedBtn = document.createElement('button');
    postedBtn.className = 'aura-btn';
    postedBtn.textContent = 'Mark as posted';
    postedBtn.addEventListener('click', async () => {
      const res = await msg({
        type: 'AURA_COMPLETE',
        itemType: 'engagement_comment',
        itemId: commentId,
        postedUrl: post.url,
      });
      if (res && res.ok) note(card, 'Marked as posted. Synced to Botella Aura.', 'ok');
      else if (res && res.rateLimited) note(card, res.error, 'warn');
      else note(card, (res && res.error) || 'Sync failed.', 'error');
    });

    actions.appendChild(insertBtn);
    actions.appendChild(postedBtn);
    card.appendChild(actions);
    wrap.appendChild(card);
  }

  /** Read the post nearest the viewport center — ONLY DOM already rendered. */
  function readVisiblePost() {
    const candidates = Array.from(
      document.querySelectorAll('.feed-shared-update-v2, .fie-impression-container'),
    );
    const centerY = window.innerHeight / 2;
    let best = null;
    let bestDist = Infinity;
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.height < 40 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const dist = Math.abs(rect.top + rect.height / 2 - centerY);
      if (dist < bestDist) {
        bestDist = dist;
        best = el;
      }
    }
    const container = best || document.querySelector('.feed-shared-update-v2');
    if (!container) return null;
    const textEl = container.querySelector(
      '.update-components-text, .feed-shared-inline-show-more-text, .update-components-update-v2__commentary',
    );
    const text = ((textEl ? textEl.innerText : container.innerText) || '')
      .trim()
      .slice(0, 5000);
    const authorEl = container.querySelector(
      '.update-components-actor__title, .update-components-actor__name',
    );
    const author = authorEl ? authorEl.innerText.trim().split('\n')[0] : undefined;
    return { text, author, url: location.href };
  }

  /** Insert text into LinkedIn's comment editor if one is open. */
  /**
   * Fill a contenteditable editor RELIABLY. LinkedIn uses Quill, which keeps its
   * own model and reverts raw DOM writes — so we select-all and use
   * execCommand('insertText'), which goes through the editor's real input
   * pipeline (the same path typing/pasting uses). Falls back to a DOM write.
   */
  function fillEditor(editor, text) {
    editor.focus();
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      // Replaces the selection (all existing content) with our text, as if typed.
      const ok = document.execCommand('insertText', false, String(text));
      if (ok) {
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
        return true;
      }
    } catch {
      /* fall through to DOM write */
    }
    // Fallback: manual DOM write (works on non-Quill editors).
    try {
      editor.innerHTML = '';
      String(text)
        .split('\n')
        .forEach((line) => {
          const p = document.createElement('p');
          if (!line) p.appendChild(document.createElement('br'));
          else p.textContent = line;
          editor.appendChild(p);
        });
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      return true;
    } catch {
      return false;
    }
  }

  function insertIntoCommentBox(text) {
    const editor = document.querySelector(
      '.comments-comment-box .ql-editor, .comments-comment-texteditor .ql-editor, ' +
        'form.comments-comment-box__form .ql-editor, .comments-comment-box-comment__text-editor .ql-editor, ' +
        'div.ql-editor[data-placeholder*="comment" i], div[role="textbox"][contenteditable="true"]',
    );
    if (!editor) return false;
    return fillEditor(editor, text);
  }

  /**
   * Insert text into LinkedIn's post composer if one is open. Returns false if
   * no editor is present so the caller can fall back to clipboard. Never throws.
   */
  function insertIntoComposer(text) {
    const editor = document.querySelector(
      'div.ql-editor[contenteditable="true"], .editor-content .ql-editor, ' +
        '.share-creation-state__text-editor .ql-editor, ' +
        'div[role="textbox"][contenteditable="true"][data-placeholder]',
    );
    if (!editor) return false;
    return fillEditor(editor, text);
  }
})();
