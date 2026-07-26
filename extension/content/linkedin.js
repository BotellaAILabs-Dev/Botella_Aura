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

    const actions = document.createElement('div');
    actions.className = 'aura-actions';

    const insertBtn = document.createElement('button');
    insertBtn.className = 'aura-btn aura-btn-primary';
    insertBtn.textContent = 'Insert into composer';
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

  function onInsert(item, card) {
    const inserted = insertIntoComposer(item.text);
    if (!inserted) {
      navigator.clipboard.writeText(item.text).catch(() => {});
      note(
        card,
        'Open LinkedIn’s "Start a post" box, then click Insert again (text copied as a fallback).',
        'warn',
      );
      return;
    }
    // Text is now in LinkedIn's composer. The HUMAN reviews and clicks
    // LinkedIn's own Post button, then confirms here to sync status.
    note(
      card,
      'Inserted. Review it, click LinkedIn’s Post button yourself, then mark it posted below.',
      'ok',
    );
    const confirm = document.createElement('button');
    confirm.className = 'aura-btn aura-btn-primary aura-mt';
    confirm.textContent = 'I posted it — mark as posted';
    confirm.addEventListener('click', () => onComplete(item, card));
    card.querySelector('.aura-actions').appendChild(confirm);
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
    return wrap;
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
  function insertIntoCommentBox(text) {
    try {
      const editor = document.querySelector(
        '.comments-comment-box .ql-editor, .comments-comment-texteditor .ql-editor, form.comments-comment-box__form .ql-editor',
      );
      if (!editor) return false;
      editor.focus();
      editor.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = text;
      editor.appendChild(p);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Insert text into LinkedIn's Quill composer if one is open on the page.
   * Best-effort and defensive — returns false if no editor is present so the
   * caller can fall back to clipboard. Never throws.
   */
  function insertIntoComposer(text) {
    try {
      const editor = document.querySelector('div.ql-editor[contenteditable="true"]');
      if (!editor) return false;
      editor.focus();
      editor.innerHTML = '';
      const lines = String(text).split('\n');
      for (const line of lines) {
        const p = document.createElement('p');
        if (line.length === 0) {
          p.appendChild(document.createElement('br'));
        } else {
          p.textContent = line;
        }
        editor.appendChild(p);
      }
      // Let LinkedIn's editor react (enables the Post button).
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }
})();
