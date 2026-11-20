// solvexAI — Pure Vanilla JavaScript Client
'use strict';

const STORAGE_KEY = 'solvexai_sessions_v1';

const state = {
  activeView: 'workspace', // 'workspace' | 'history' | 'methodology'
  depth: 'standard', // 'standard' | 'deep'
  sourceFilter: 'all', // 'all' | 'papers' | 'web'
  isLoading: false,
  currentSessionId: null,
  messages: [], // Array<{ id, role: 'user' | 'model', text, webSources?, researchPapers?, searchQueries?, timestamp, error?, failedPrompt? }>
  selectedMessageId: null,
  sessions: loadSessions(),
};

// DOM Elements
const viewWorkspace = document.getElementById('view-workspace');
const viewHistory = document.getElementById('view-history');
const viewMethodology = document.getElementById('view-methodology');

const emptyState = document.getElementById('empty-state');
const messagesList = document.getElementById('messages-list');
const chatScrollContainer = document.getElementById('chat-scroll-container');

const chatForm = document.getElementById('chat-form');
const questionInput = document.getElementById('question-input');
const btnSubmit = document.getElementById('btn-submit');
const btnNewSession = document.getElementById('btn-new-session');
const brandHomeLink = document.getElementById('brand-home-link');

const sourcesPanel = document.getElementById('sources-panel');
const sourcesPanelSubtitle = document.getElementById('sources-panel-subtitle');
const sourcesListContainer = document.getElementById('sources-list-container');
const btnMobileSources = document.getElementById('btn-mobile-sources');
const btnCloseMobileSources = document.getElementById('btn-close-mobile-sources');
const mobileSourceCount = document.getElementById('mobile-source-count');

const countAllEl = document.getElementById('count-all');
const countPapersEl = document.getElementById('count-papers');
const countWebEl = document.getElementById('count-web');

const historyListEl = document.getElementById('history-list');
const btnClearHistory = document.getElementById('btn-clear-history');

// ---------- Utilities ----------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateId() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function formatTime(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDate(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSessions() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.sessions.slice(0, 25)));
  } catch {
    // Ignore storage quota issues
  }
}

function syncCurrentSessionToStorage() {
  if (!state.currentSessionId || state.messages.length === 0) return;

  const firstUserMsg = state.messages.find((m) => m.role === 'user');
  const title = firstUserMsg
    ? firstUserMsg.text.slice(0, 90) + (firstUserMsg.text.length > 90 ? '...' : '')
    : 'Sesi Riset';

  const existingIdx = state.sessions.findIndex((s) => s.id === state.currentSessionId);
  const sessionRecord = {
    id: state.currentSessionId,
    title,
    updatedAt: new Date().toISOString(),
    messages: state.messages.filter((m) => !m.error),
  };

  if (existingIdx >= 0) {
    state.sessions[existingIdx] = sessionRecord;
  } else {
    state.sessions.unshift(sessionRecord);
  }
  saveSessions();
}

// ---------- Safe Markdown Renderer ----------

function formatInlineMarkdown(escapedLine, webSources) {
  let out = escapedLine;

  // Inline code
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Markdown links [label](https://...)
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue-700 hover:text-blue-800 underline underline-offset-2">$1</a>'
  );

  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Interactive numbered citations like [1] or [R1]
  out = out.replace(/\[(R?)(\d{1,2})\]/g, (match, isResearch, numStr) => {
    const num = Number(numStr);
    if (isResearch === 'R') {
      return `<button type="button" data-paper-index="${num}" class="paper-jump-btn inline-flex items-center px-1 mx-0.5 text-xs font-mono font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded transition-colors align-baseline" title="Lihat dokumen penelitian [R${num}]">[R${num}]</button>`;
    }
    if (Array.isArray(webSources) && webSources.some((s) => s.index === num)) {
      return `<button type="button" data-cite-index="${num}" class="cite-jump-btn inline-flex items-center px-1 mx-0.5 text-xs font-mono font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded transition-colors align-baseline" title="Lihat sumber [${num}]">[${num}]</button>`;
    }
    return match;
  });

  return out;
}

function renderMarkdownToHtml(markdown, webSources) {
  if (!markdown) return '';

  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const htmlParts = [];
  let inCodeBlock = false;
  let codeLines = [];
  let listType = null; // 'ul' | 'ol'
  let inTable = false;
  let tableRows = [];

  function closeList() {
    if (listType) {
      htmlParts.push(`</${listType}>`);
      listType = null;
    }
  }

  function closeTable() {
    if (!inTable || tableRows.length === 0) {
      inTable = false;
      tableRows = [];
      return;
    }
    const headerRow = tableRows[0];
    const bodyRows = tableRows.slice(1).filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell.trim())));

    let tableHtml = '<div class="overflow-x-auto my-3"><table><thead><tr>';
    for (const cell of headerRow) {
      tableHtml += `<th>${formatInlineMarkdown(escapeHtml(cell.trim()), webSources)}</th>`;
    }
    tableHtml += '</tr></thead><tbody>';
    for (const row of bodyRows) {
      tableHtml += '<tr>';
      for (let i = 0; i < headerRow.length; i++) {
        const val = row[i] !== undefined ? row[i].trim() : '';
        tableHtml += `<td>${formatInlineMarkdown(escapeHtml(val), webSources)}</td>`;
      }
      tableHtml += '</tr>';
    }
    tableHtml += '</tbody></table></div>';
    htmlParts.push(tableHtml);
    inTable = false;
    tableRows = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    // Fenced code blocks
    if (rawLine.trim().startsWith('```')) {
      closeList();
      closeTable();
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLines = [];
      } else {
        htmlParts.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCodeBlock = false;
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    const trimmed = rawLine.trim();

    // Blank line
    if (!trimmed) {
      closeList();
      closeTable();
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed)) {
      closeList();
      closeTable();
      htmlParts.push('<hr class="my-4 border-slate-200" />');
      continue;
    }

    // Table row
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      closeList();
      inTable = true;
      const cells = trimmed
        .slice(1, -1)
        .split('|');
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      closeTable();
    }

    // Headings
    const h3Match = trimmed.match(/^###\s+(.+)/);
    if (h3Match) {
      closeList();
      htmlParts.push(`<h3>${formatInlineMarkdown(escapeHtml(h3Match[1]), webSources)}</h3>`);
      continue;
    }
    const h2Match = trimmed.match(/^#{1,2}\s+(.+)/);
    if (h2Match) {
      closeList();
      htmlParts.push(`<h2>${formatInlineMarkdown(escapeHtml(h2Match[1]), webSources)}</h2>`);
      continue;
    }

    // Blockquote
    const bqMatch = trimmed.match(/^>\s?(.*)/);
    if (bqMatch) {
      closeList();
      htmlParts.push(
        `<blockquote><p class="mb-0">${formatInlineMarkdown(escapeHtml(bqMatch[1]), webSources)}</p></blockquote>`
      );
      continue;
    }

    // Unordered list
    const ulMatch = trimmed.match(/^[-*•]\s+(.+)/);
    if (ulMatch) {
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        htmlParts.push('<ul>');
      }
      htmlParts.push(`<li>${formatInlineMarkdown(escapeHtml(ulMatch[1]), webSources)}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = trimmed.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      if (listType !== 'ol') {
        closeList();
        listType = 'ol';
        htmlParts.push('<ol>');
      }
      htmlParts.push(`<li>${formatInlineMarkdown(escapeHtml(olMatch[1]), webSources)}</li>`);
      continue;
    }

    // Paragraph
    closeList();
    htmlParts.push(`<p>${formatInlineMarkdown(escapeHtml(trimmed), webSources)}</p>`);
  }

  closeList();
  closeTable();
  if (inCodeBlock && codeLines.length > 0) {
    htmlParts.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }

  return htmlParts.join('\n');
}

// ---------- View Switching ----------

function setActiveView(viewName) {
  state.activeView = viewName;

  viewWorkspace.classList.toggle('hidden', viewName !== 'workspace');
  viewHistory.classList.toggle('hidden', viewName !== 'history');
  viewMethodology.classList.toggle('hidden', viewName !== 'methodology');

  document.querySelectorAll('.nav-tab').forEach((btn) => {
    const isActive = btn.dataset.viewTab === viewName;
    btn.classList.toggle('text-slate-900', isActive);
    btn.classList.toggle('border-blue-700', isActive);
    btn.classList.toggle('text-slate-600', !isActive);
    btn.classList.toggle('border-transparent', !isActive);
  });

  document.querySelectorAll('.nav-tab-mobile').forEach((btn) => {
    const isActive = btn.dataset.viewTab === viewName;
    btn.classList.toggle('text-blue-700', isActive);
    btn.classList.toggle('font-semibold', isActive);
    btn.classList.toggle('text-slate-600', !isActive);
  });

  if (viewName === 'history') {
    renderHistoryView();
  }
}

// ---------- Rendering Chat Messages ----------

function renderMessages() {
  const hasMessages = state.messages.length > 0 || state.isLoading;
  emptyState.classList.toggle('hidden', hasMessages);
  messagesList.classList.toggle('hidden', !hasMessages);

  if (!hasMessages) {
    messagesList.innerHTML = '';
    renderSourcesPanel();
    return;
  }

  const fragments = [];

  for (const msg of state.messages) {
    if (msg.role === 'user') {
      fragments.push(`
        <article class="pt-2">
          <div class="flex items-center justify-between gap-2 text-xs text-slate-500 mb-2">
            <span class="font-medium text-slate-700">Pertanyaan Anda</span>
            <span class="tabular-nums">${escapeHtml(formatTime(msg.timestamp))}</span>
          </div>
          <div class="rounded-xl bg-slate-100 border border-slate-200 px-4 py-3.5 text-sm sm:text-base text-slate-900 leading-relaxed font-medium">
            ${escapeHtml(msg.text)}
          </div>
        </article>
      `);
      continue;
    }

    if (msg.error) {
      fragments.push(`
        <article class="pb-6 border-b border-slate-200">
          <div class="rounded-xl border border-red-200 bg-red-50 p-4">
            <p class="text-sm font-semibold text-red-900 mb-1">Verifikasi Gagal Diproses</p>
            <p class="text-sm text-red-800 mb-3">${escapeHtml(msg.text)}</p>
            ${
              msg.failedPrompt
                ? `<button type="button" data-retry-prompt="${escapeHtml(
                    msg.failedPrompt
                  )}" class="retry-btn px-3.5 py-1.5 text-xs font-medium text-white bg-red-700 hover:bg-red-800 rounded-lg transition-colors">Coba Ulangi</button>`
                : ''
            }
          </div>
        </article>
      `);
      continue;
    }

    const papersCount = Array.isArray(msg.researchPapers) ? msg.researchPapers.length : 0;
    const webCount = Array.isArray(msg.webSources) ? msg.webSources.length : 0;
    const isSelected = state.selectedMessageId === msg.id;

    fragments.push(`
      <article id="msg-${escapeHtml(msg.id)}" class="pb-7 border-b border-slate-200">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div class="flex items-center gap-2 text-xs text-slate-500">
            <span class="font-display font-semibold text-slate-900 text-sm">solvexAI</span>
            <span aria-hidden="true">·</span>
            <span class="tabular-nums">${escapeHtml(formatTime(msg.timestamp))}</span>
            <span aria-hidden="true">·</span>
            <span class="tabular-nums">${papersCount} dokumen penelitian</span>
            <span aria-hidden="true">·</span>
            <span class="tabular-nums">${webCount} sumber web</span>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              data-select-sources="${escapeHtml(msg.id)}"
              class="select-sources-btn px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap ${
                isSelected
                  ? 'border-blue-700 bg-blue-50 text-blue-800'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }"
            >
              ${isSelected ? 'Referensi Aktif' : 'Lihat Referensi'}
            </button>
            <button
              type="button"
              data-copy-msg="${escapeHtml(msg.id)}"
              class="copy-msg-btn px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
            >
              Salin
            </button>
          </div>
        </div>

        <div class="prose-answer text-[15px] sm:text-base">
          ${renderMarkdownToHtml(msg.text, msg.webSources || [])}
        </div>
      </article>
    `);
  }

  if (state.isLoading) {
    fragments.push(`
      <article aria-live="polite" class="pb-6">
        <div class="flex items-center gap-2 text-xs text-slate-500 mb-3">
          <span class="font-display font-semibold text-slate-900 text-sm">solvexAI</span>
          <span aria-hidden="true">·</span>
          <span>Menelusuri sumber tepercaya dan dokumen penelitian asli...</span>
        </div>
        <div class="space-y-3 animate-pulse">
          <div class="h-4 bg-slate-200 rounded w-3/4"></div>
          <div class="h-4 bg-slate-200 rounded w-full"></div>
          <div class="h-4 bg-slate-200 rounded w-5/6"></div>
          <div class="h-4 bg-slate-100 rounded w-2/3 mt-4"></div>
        </div>
      </article>
    `);
  }

  messagesList.innerHTML = fragments.join('\n');
  renderSourcesPanel();

  chatScrollContainer.scrollTop = chatScrollContainer.scrollHeight;
}

// ---------- Rendering Sources & Research Documents Panel ----------

function renderSourcesPanel() {
  const activeMsg =
    state.messages.find((m) => m.id === state.selectedMessageId && m.role === 'model' && !m.error) ||
    [...state.messages].reverse().find((m) => m.role === 'model' && !m.error);

  const papers = activeMsg?.researchPapers || [];
  const webSources = activeMsg?.webSources || [];
  const total = papers.length + webSources.length;

  countAllEl.textContent = String(total);
  countPapersEl.textContent = String(papers.length);
  countWebEl.textContent = String(webSources.length);
  mobileSourceCount.textContent = String(total);

  document.querySelectorAll('.source-filter-btn').forEach((btn) => {
    const isActive = btn.dataset.sourceFilter === state.sourceFilter;
    btn.classList.toggle('bg-white', isActive);
    btn.classList.toggle('text-slate-900', isActive);
    btn.classList.toggle('shadow-sm', isActive);
    btn.classList.toggle('text-slate-600', !isActive);
  });

  if (!activeMsg) {
    sourcesPanelSubtitle.textContent = 'Menampilkan tautan langsung dari jawaban terpilih';
    sourcesListContainer.innerHTML = `
      <div class="py-12 text-center">
        <p class="text-sm font-medium text-slate-700 mb-1">Belum ada dokumen yang dimuat</p>
        <p class="text-xs text-slate-500 max-w-xs mx-auto leading-relaxed">
          Kirim pertanyaan di panel kiri untuk melihat tautan makalah penelitian asli (DOI / PDF)
          serta sumber rujukan terverifikasi di sini.
        </p>
      </div>
    `;
    return;
  }

  sourcesPanelSubtitle.textContent = `${papers.length} dokumen penelitian · ${webSources.length} sumber terverifikasi`;

  const sections = [];

  // Section A: Original Research Documents (OpenAlex / Crossref)
  if (state.sourceFilter === 'all' || state.sourceFilter === 'papers') {
    sections.push(`
      <div>
        <div class="flex items-baseline justify-between mb-3">
          <h3 class="font-display text-xs font-semibold text-slate-900 uppercase tracking-wider">
            Dokumen Penelitian Asli (DOI)
          </h3>
          <span class="text-xs font-mono text-slate-500 tabular-nums">${papers.length} hasil</span>
        </div>
        ${
          papers.length === 0
            ? `<p class="text-xs text-slate-500 bg-white border border-slate-200 rounded-xl p-4 leading-relaxed">
                Tidak ada artikel DOI khusus yang cocok langsung dari indeks OpenAlex/Crossref untuk kueri ini. Periksa bagian Sumber Web Terverifikasi di bawah untuk dokumen lembaga resmi.
              </p>`
            : `<div class="space-y-3">
                ${papers
                  .map((paper, idx) => {
                    const authorsText =
                      paper.authors && paper.authors.length > 0
                        ? paper.authors.join(', ')
                        : 'Penulis tercatat pada dokumen DOI';
                    return `
                      <div id="paper-card-${idx + 1}" class="bg-white border border-slate-200 rounded-xl p-4 transition-colors">
                        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 mb-1.5">
                          <span class="font-mono text-slate-700 tabular-nums">R${idx + 1}</span>
                          <span aria-hidden="true">·</span>
                          <span class="font-medium text-slate-700">${escapeHtml(paper.venue)}</span>
                          ${
                            paper.year
                              ? `<span aria-hidden="true">·</span><span class="tabular-nums">${paper.year}</span>`
                              : ''
                          }
                          <span aria-hidden="true">·</span>
                          <span class="tabular-nums">${paper.citedByCount} sitasi</span>
                        </div>
                        <h4 class="text-sm font-semibold text-slate-900 leading-snug mb-1.5">
                          ${escapeHtml(paper.title)}
                        </h4>
                        <p class="text-xs text-slate-600 mb-2.5 truncate" title="${escapeHtml(authorsText)}">
                          ${escapeHtml(authorsText)}
                        </p>
                        ${
                          paper.abstract
                            ? `<p class="text-xs text-slate-600 leading-relaxed mb-3">${escapeHtml(
                                paper.abstract
                              )}</p>`
                            : ''
                        }
                        <div class="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-100">
                          <a
                            href="${escapeHtml(paper.doiUrl)}"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-800 hover:underline underline-offset-2"
                          >
                            Buka Dokumen DOI ↗
                          </a>
                          ${
                            paper.pdfUrl
                              ? `<a
                                  href="${escapeHtml(paper.pdfUrl)}"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  class="inline-flex items-center gap-1 text-xs font-medium text-slate-700 hover:text-slate-900 hover:underline underline-offset-2"
                                >
                                  PDF Akses Terbuka ↗
                                </a>`
                              : ''
                          }
                        </div>
                      </div>
                    `;
                  })
                  .join('')}
              </div>`
        }
      </div>
    `);
  }

  // Section B: Verified Web Grounding Sources
  if (state.sourceFilter === 'all' || state.sourceFilter === 'web') {
    sections.push(`
      <div>
        <div class="flex items-baseline justify-between mb-3">
          <h3 class="font-display text-xs font-semibold text-slate-900 uppercase tracking-wider">
            Sumber Web Terverifikasi
          </h3>
          <span class="text-xs font-mono text-slate-500 tabular-nums">${webSources.length} tautan</span>
        </div>
        ${
          webSources.length === 0
            ? `<p class="text-xs text-slate-500 bg-white border border-slate-200 rounded-xl p-4">
                Belum ada tautan web grounding untuk jawaban ini.
              </p>`
            : `<div class="space-y-2.5">
                ${webSources
                  .map(
                    (src) => `
                    <div id="source-card-${src.index}" class="bg-white border border-slate-200 rounded-xl p-3.5 transition-colors">
                      <div class="flex items-center gap-2 text-xs text-slate-500 mb-1">
                        <span class="font-mono font-medium text-blue-700 tabular-nums">[${src.index}]</span>
                        <span aria-hidden="true">·</span>
                        <span class="truncate">${escapeHtml(src.domain)}</span>
                        ${
                          src.isAcademicOrOfficial
                            ? `<span aria-hidden="true">·</span><span class="text-emerald-700 font-medium whitespace-nowrap">Institusi / Jurnal</span>`
                            : ''
                        }
                      </div>
                      <p class="text-xs sm:text-sm font-medium text-slate-900 leading-snug mb-2">
                        ${escapeHtml(src.title)}
                      </p>
                      <a
                        href="${escapeHtml(src.url)}"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-800 hover:underline underline-offset-2"
                      >
                        Kunjungi Dokumen Asli ↗
                      </a>
                    </div>
                  `
                  )
                  .join('')}
              </div>`
        }
      </div>
    `);
  }

  sourcesListContainer.innerHTML = sections.join('');
}

// ---------- Rendering History View ----------

function renderHistoryView() {
  if (state.sessions.length === 0) {
    historyListEl.innerHTML = `
      <div class="bg-white border border-slate-200 rounded-xl p-8 text-center">
        <p class="text-sm font-medium text-slate-800 mb-1">Belum ada riwayat sesi</p>
        <p class="text-xs text-slate-500 mb-4">
          Pertanyaan dan dokumen penelitian yang Anda akses akan muncul di sini.
        </p>
        <button
          type="button"
          id="btn-history-start"
          class="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors"
        >
          Mulai Pertanyaan Pertama
        </button>
      </div>
    `;
    const startBtn = document.getElementById('btn-history-start');
    if (startBtn) {
      startBtn.addEventListener('click', () => setActiveView('workspace'));
    }
    return;
  }

  historyListEl.innerHTML = state.sessions
    .map((session) => {
      const msgCount = session.messages ? session.messages.length : 0;
      const latestModel = [...(session.messages || [])].reverse().find((m) => m.role === 'model');
      const paperCount = latestModel?.researchPapers?.length || 0;
      return `
        <div class="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-xs text-slate-500 mb-1">
              <span class="tabular-nums">${escapeHtml(formatDate(session.updatedAt))}</span>
              <span aria-hidden="true">·</span>
              <span class="tabular-nums">${msgCount} pesan</span>
              <span aria-hidden="true">·</span>
              <span class="tabular-nums">${paperCount} dokumen penelitian</span>
            </div>
            <h2 class="text-sm sm:text-base font-semibold text-slate-900 truncate">
              ${escapeHtml(session.title)}
            </h2>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              data-open-session="${escapeHtml(session.id)}"
              class="open-session-btn px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors"
            >
              Buka Sesi
            </button>
            <button
              type="button"
              data-delete-session="${escapeHtml(session.id)}"
              class="delete-session-btn px-3 py-2 text-xs font-medium text-slate-600 border border-slate-200 hover:bg-slate-100 rounded-lg transition-colors"
            >
              Hapus
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

// ---------- Sending Query to /api/ask ----------

async function submitQuestion(rawPrompt) {
  const promptText = rawPrompt.trim();
  if (!promptText || state.isLoading) return;

  if (!state.currentSessionId) {
    state.currentSessionId = generateId();
  }

  const priorHistory = state.messages
    .filter((m) => !m.error)
    .map((m) => ({ role: m.role, text: m.text }));

  const userMsg = {
    id: generateId(),
    role: 'user',
    text: promptText,
    timestamp: new Date().toISOString(),
  };

  state.messages.push(userMsg);
  state.isLoading = true;
  questionInput.value = '';
  autoResizeTextarea();
  updateSubmitButtonState();
  renderMessages();

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: promptText,
        history: priorHistory,
        depth: state.depth,
      }),
    });

    const responseText = await res.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      const detail = responseText.replace(/\s+/g, ' ').trim().slice(0, 180);
      throw new Error(
        `Server mengirim respons non-JSON (HTTP ${res.status})${
          detail ? `: ${detail}` : ''
        }. Periksa Function Logs di Vercel.`
      );
    }

    if (!res.ok) {
      throw new Error(data.error || 'Terjadi kesalahan saat menghubungi server verifikasi.');
    }

    const modelMsg = {
      id: generateId(),
      role: 'model',
      text: data.answer,
      webSources: data.webSources || [],
      researchPapers: data.researchPapers || [],
      searchQueries: data.searchQueries || [],
      timestamp: new Date().toISOString(),
    };

    state.messages.push(modelMsg);
    state.selectedMessageId = modelMsg.id;
    syncCurrentSessionToStorage();
  } catch (err) {
    state.messages.push({
      id: generateId(),
      role: 'model',
      error: true,
      text: err.message || 'Gagal memproses pertanyaan. Silakan periksa koneksi dan coba kembali.',
      failedPrompt: promptText,
      timestamp: new Date().toISOString(),
    });
  } finally {
    state.isLoading = false;
    updateSubmitButtonState();
    renderMessages();
  }
}

// ---------- Controls & Event Listeners ----------

function autoResizeTextarea() {
  questionInput.style.height = 'auto';
  questionInput.style.height = Math.min(questionInput.scrollHeight, 176) + 'px';
}

function updateSubmitButtonState() {
  btnSubmit.disabled = state.isLoading || questionInput.value.trim().length === 0;
  btnSubmit.textContent = state.isLoading ? 'Memverifikasi...' : 'Kirim';
}

function startNewSession() {
  state.currentSessionId = null;
  state.messages = [];
  state.selectedMessageId = null;
  state.isLoading = false;
  setActiveView('workspace');
  renderMessages();
  questionInput.focus();
}

function openMobileSourcesDrawer(open) {
  if (open) {
    sourcesPanel.classList.remove('hidden');
    sourcesPanel.classList.add(
      'fixed',
      'inset-0',
      'z-40',
      'flex',
      'bg-slate-50',
      'h-screen'
    );
  } else {
    sourcesPanel.classList.add('hidden');
    sourcesPanel.classList.remove(
      'fixed',
      'inset-0',
      'z-40',
      'bg-slate-50',
      'h-screen'
    );
  }
}

// Navigation tabs
document.querySelectorAll('[data-view-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    setActiveView(btn.dataset.viewTab);
  });
});

brandHomeLink.addEventListener('click', (e) => {
  e.preventDefault();
  setActiveView('workspace');
});

btnNewSession.addEventListener('click', startNewSession);

// Depth mode selector
document.querySelectorAll('.depth-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.depth = btn.dataset.depth;
    document.querySelectorAll('.depth-btn').forEach((b) => {
      const active = b.dataset.depth === state.depth;
      b.classList.toggle('bg-white', active);
      b.classList.toggle('text-slate-900', active);
      b.classList.toggle('shadow-sm', active);
      b.classList.toggle('text-slate-600', !active);
    });
  });
});

// Source filter selector
document.querySelectorAll('.source-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.sourceFilter = btn.dataset.sourceFilter;
    renderSourcesPanel();
  });
});

// Sample prompt cards
document.querySelectorAll('.sample-prompt-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const prompt = btn.dataset.samplePrompt;
    if (prompt) {
      submitQuestion(prompt);
    }
  });
});

// Textarea auto-resize & Enter submit
questionInput.addEventListener('input', () => {
  autoResizeTextarea();
  updateSubmitButtonState();
});

questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!state.isLoading && questionInput.value.trim().length > 0) {
      submitQuestion(questionInput.value);
    }
  }
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitQuestion(questionInput.value);
});

// Delegated click handlers inside chat messages
messagesList.addEventListener('click', async (e) => {
  const retryBtn = e.target.closest('.retry-btn');
  if (retryBtn) {
    const failedPrompt = retryBtn.dataset.retryPrompt;
    // Remove failed error message before retrying
    state.messages = state.messages.filter((m) => !m.error);
    if (failedPrompt) {
      submitQuestion(failedPrompt);
    }
    return;
  }

  const selectBtn = e.target.closest('.select-sources-btn');
  if (selectBtn) {
    state.selectedMessageId = selectBtn.dataset.selectSources;
    renderMessages();
    if (window.innerWidth < 1024) {
      openMobileSourcesDrawer(true);
    }
    return;
  }

  const citeBtn = e.target.closest('.cite-jump-btn, .paper-jump-btn');
  if (citeBtn) {
    const webIdx = citeBtn.dataset.citeIndex;
    const paperIdx = citeBtn.dataset.paperIndex;
    state.sourceFilter = 'all';
    renderSourcesPanel();
    if (window.innerWidth < 1024) {
      openMobileSourcesDrawer(true);
    }
    const targetId = paperIdx ? 'paper-card-' + paperIdx : 'source-card-' + webIdx;
    const card = document.getElementById(targetId);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('border-blue-700', 'ring-2', 'ring-blue-700/20');
      setTimeout(() => {
        card.classList.remove('border-blue-700', 'ring-2', 'ring-blue-700/20');
      }, 1600);
    }
    return;
  }

  const copyBtn = e.target.closest('.copy-msg-btn');
  if (copyBtn) {
    const msgId = copyBtn.dataset.copyMsg;
    const msg = state.messages.find((m) => m.id === msgId);
    if (!msg) return;

    const lines = [msg.text, ''];
    if (msg.researchPapers && msg.researchPapers.length > 0) {
      lines.push('--- Dokumen Penelitian Asli ---');
      msg.researchPapers.forEach((p, idx) => {
        lines.push(`${idx + 1}. ${p.title} (${p.venue}${p.year ? ', ' + p.year : ''}) - ${p.doiUrl}`);
      });
      lines.push('');
    }
    if (msg.webSources && msg.webSources.length > 0) {
      lines.push('--- Sumber Web Terverifikasi ---');
      msg.webSources.forEach((s) => {
        lines.push(`[${s.index}] ${s.title} - ${s.url}`);
      });
    }

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      copyBtn.textContent = 'Tersalin';
      setTimeout(() => {
        copyBtn.textContent = 'Salin';
      }, 1500);
    } catch {
      copyBtn.textContent = 'Gagal';
    }
  }
});

// Mobile sources drawer
btnMobileSources.addEventListener('click', () => openMobileSourcesDrawer(true));
btnCloseMobileSources.addEventListener('click', () => openMobileSourcesDrawer(false));

// History actions
historyListEl.addEventListener('click', (e) => {
  const openBtn = e.target.closest('.open-session-btn');
  if (openBtn) {
    const sid = openBtn.dataset.openSession;
    const session = state.sessions.find((s) => s.id === sid);
    if (!session) return;
    state.currentSessionId = session.id;
    state.messages = [...(session.messages || [])];
    const lastModel = [...state.messages].reverse().find((m) => m.role === 'model');
    state.selectedMessageId = lastModel ? lastModel.id : null;
    setActiveView('workspace');
    renderMessages();
    return;
  }

  const delBtn = e.target.closest('.delete-session-btn');
  if (delBtn) {
    const sid = delBtn.dataset.deleteSession;
    state.sessions = state.sessions.filter((s) => s.id !== sid);
    if (state.currentSessionId === sid) {
      state.currentSessionId = null;
      state.messages = [];
      state.selectedMessageId = null;
    }
    saveSessions();
    renderHistoryView();
  }
});

btnClearHistory.addEventListener('click', () => {
  state.sessions = [];
  saveSessions();
  renderHistoryView();
});

// Initialize
updateSubmitButtonState();
renderMessages();