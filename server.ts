import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

interface ChatHistoryItem {
  role: 'user' | 'model';
  text: string;
}

interface WebSource {
  index: number;
  title: string;
  url: string;
  domain: string;
  isAcademicOrOfficial: boolean;
  excerpt?: string;
}

interface ResearchPaper {
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  doiUrl: string;
  pdfUrl: string | null;
  citedByCount: number;
  abstract: string;
  sourceDatabase: 'OpenAlex' | 'Crossref';
}

const TRUSTED_DOMAIN_PATTERNS = [
  '.edu',
  '.gov',
  '.ac.',
  'doi.org',
  'pubmed',
  'ncbi.nlm.nih.gov',
  'arxiv.org',
  'nature.com',
  'science.org',
  'sciencedirect.com',
  'springer.com',
  'thelancet.com',
  'nejm.org',
  'ieee.org',
  'acm.org',
  'who.int',
  'unesco.org',
  'worldbank.org',
  'imf.org',
  'oecd.org',
  'nasa.gov',
  'nih.gov',
  'cdc.gov',
  'bps.go.id',
  'kemkes.go.id',
  'brin.go.id',
  'lipi.go.id',
  'wikipedia.org',
  'scholar.google',
  'semanticscholar.org',
  'plos.org',
  'bmj.com',
  'jamanetwork.com',
  'pnas.org',
  'wiley.com',
  'oup.com',
  'cambridge.org',
  'mdpi.com',
  'frontiersin.org',
];

const QUESTION_STOPWORDS = new Set([
  'apa',
  'apakah',
  'itu',
  'adalah',
  'ialah',
  'yakni',
  'yaitu',
  'bagaimana',
  'mengapa',
  'kenapa',
  'siapa',
  'siapakah',
  'kapan',
  'dimana',
  'di',
  'mana',
  'berapa',
  'jelaskan',
  'sebutkan',
  'tolong',
  'berikan',
  'uraikan',
  'pengertian',
  'definisi',
  'arti',
  'makna',
  'maksud',
  'mengenai',
  'tentang',
  'yang',
  'untuk',
  'dalam',
  'pada',
  'dari',
  'ke',
  'dengan',
  'what',
  'is',
  'are',
  'was',
  'were',
  'how',
  'why',
  'who',
  'when',
  'where',
  'explain',
  'define',
  'describe',
  'tell',
  'me',
  'about',
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'for',
  'to',
  'does',
  'do',
]);

function extractSearchKeywords(rawQuery: string): string {
  const cleaned = rawQuery
    .replace(/[?!.,;:"'()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter((w) => {
    const lower = w.toLowerCase();
    return lower.length > 1 && !QUESTION_STOPWORDS.has(lower);
  });

  if (words.length >= 2) {
    return words.slice(0, 10).join(' ');
  }
  return cleaned;
}

function isTrustedDomain(urlOrDomain: string): boolean {
  const lower = urlOrDomain.toLowerCase();
  return TRUSTED_DOMAIN_PATTERNS.some((pattern) => lower.includes(pattern));
}

function extractDomain(urlString: string, fallbackTitle?: string): string {
  try {
    const parsed = new URL(urlString);
    if (
      parsed.hostname.includes('vertexaisearch.cloud.google.com') &&
      fallbackTitle
    ) {
      return fallbackTitle;
    }
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return fallbackTitle || 'sumber-terverifikasi';
  }
}

async function resolveDirectUrl(uri: string): Promise<string> {
  if (!uri.includes('vertexaisearch.cloud.google.com')) {
    return uri;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1600);
  try {
    const res = await fetch(uri, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
    });
    const location = res.headers.get('location');
    if (location && location.startsWith('http')) {
      return location;
    }
    return uri;
  } catch {
    return uri;
  } finally {
    clearTimeout(timer);
  }
}

function reconstructAbstract(
  invertedIndex: Record<string, number[]> | null | undefined
): string {
  if (!invertedIndex || typeof invertedIndex !== 'object') {
    return '';
  }
  const words: string[] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        words[pos] = word;
      }
    }
  }
  const joined = words.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (joined.length <= 360) return joined;
  return joined.slice(0, 357).trimEnd() + '...';
}

function stripXmlTags(input: string): string {
  return input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchOpenAlexPapers(query: string): Promise<ResearchPaper[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const url = new URL('https://api.openalex.org/works');
    url.searchParams.set('search', query);
    url.searchParams.set('per-page', '4');
    url.searchParams.set('filter', 'has_doi:true');
    url.searchParams.set('sort', 'relevance_score:desc');
    url.searchParams.set(
      'select',
      'title,publication_year,doi,cited_by_count,authorships,primary_location,open_access,abstract_inverted_index'
    );

    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'solvexAI-research-assistant/1.0 (mailto:research@solvexai.local)',
      },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{
        title?: string;
        publication_year?: number;
        doi?: string;
        cited_by_count?: number;
        authorships?: Array<{ author?: { display_name?: string } }>;
        primary_location?: {
          landing_page_url?: string;
          pdf_url?: string;
          source?: { display_name?: string };
        };
        open_access?: { oa_url?: string };
        abstract_inverted_index?: Record<string, number[]>;
      }>;
    };

    if (!Array.isArray(data.results)) return [];

    return data.results
      .filter((item) => item.title && item.doi)
      .map((item) => {
        const doiUrl = item.doi!.startsWith('http')
          ? item.doi!
          : `https://doi.org/${item.doi!.replace(/^doi:/i, '')}`;
        const authors = (item.authorships || [])
          .map((a) => a.author?.display_name)
          .filter((name): name is string => Boolean(name))
          .slice(0, 4);
        const venue =
          item.primary_location?.source?.display_name || 'Jurnal Ilmiah Terindeks';
        const pdfUrl =
          item.primary_location?.pdf_url || item.open_access?.oa_url || null;

        return {
          title: item.title!,
          authors,
          year: item.publication_year ?? null,
          venue,
          doiUrl,
          pdfUrl,
          citedByCount: item.cited_by_count ?? 0,
          abstract: reconstructAbstract(item.abstract_inverted_index),
          sourceDatabase: 'OpenAlex' as const,
        };
      });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCrossrefPapers(query: string): Promise<ResearchPaper[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const url = new URL('https://api.crossref.org/works');
    url.searchParams.set('query', query);
    url.searchParams.set('rows', '4');
    url.searchParams.set(
      'select',
      'DOI,title,author,published,container-title,URL,is-referenced-by-count,abstract'
    );

    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'solvexAI-research-assistant/1.0 (mailto:research@solvexai.local)',
      },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      message?: {
        items?: Array<{
          DOI?: string;
          title?: string[];
          author?: Array<{ given?: string; family?: string }>;
          published?: { 'date-parts'?: number[][] };
          'container-title'?: string[];
          URL?: string;
          'is-referenced-by-count'?: number;
          abstract?: string;
        }>;
      };
    };

    const items = data.message?.items;
    if (!Array.isArray(items)) return [];

    return items
      .filter((item) => item.DOI && item.title?.[0])
      .map((item) => {
        const authors = (item.author || [])
          .map((a) => [a.given, a.family].filter(Boolean).join(' ').trim())
          .filter(Boolean)
          .slice(0, 4);
        const year = item.published?.['date-parts']?.[0]?.[0] ?? null;
        const rawAbstract = item.abstract ? stripXmlTags(item.abstract) : '';
        const abstract =
          rawAbstract.length > 360
            ? rawAbstract.slice(0, 357).trimEnd() + '...'
            : rawAbstract;

        return {
          title: item.title![0],
          authors,
          year,
          venue: item['container-title']?.[0] || 'Publikasi Crossref DOI',
          doiUrl: item.URL || `https://doi.org/${item.DOI}`,
          pdfUrl: null,
          citedByCount: item['is-referenced-by-count'] ?? 0,
          abstract,
          sourceDatabase: 'Crossref' as const,
        };
      });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWikipediaForLang(
  lang: 'id' | 'en',
  query: string
): Promise<Array<{ title: string; url: string; domain: string; excerpt: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const searchUrl = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    searchUrl.searchParams.set('action', 'query');
    searchUrl.searchParams.set('generator', 'search');
    searchUrl.searchParams.set('gsrsearch', query);
    searchUrl.searchParams.set('gsrlimit', '2');
    searchUrl.searchParams.set('prop', 'extracts|info');
    searchUrl.searchParams.set('inprop', 'url');
    searchUrl.searchParams.set('exintro', 'true');
    searchUrl.searchParams.set('explaintext', 'true');
    searchUrl.searchParams.set('exchars', '500');
    searchUrl.searchParams.set('format', 'json');
    searchUrl.searchParams.set('origin', '*');

    const res = await fetch(searchUrl.toString(), {
      headers: { 'User-Agent': 'solvexAI-research-assistant/1.0' },
      signal: controller.signal,
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      query?: {
        pages?: Record<
          string,
          {
            title?: string;
            fullurl?: string;
            extract?: string;
            index?: number;
          }
        >;
      };
    };

    const pages = Object.values(data.query?.pages || {});
    pages.sort((a, b) => (a.index ?? 99) - (b.index ?? 99));

    return pages
      .filter((p) => p.title && p.fullurl)
      .map((p) => ({
        title: `${p.title} — Wikipedia (${lang.toUpperCase()})`,
        url: p.fullurl!,
        domain: `${lang}.wikipedia.org`,
        excerpt: (p.extract || '').trim(),
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOriginalResearchPapers(
  queries: string[]
): Promise<ResearchPaper[]> {
  const cleanQueries = queries
    .map((q) => q.trim())
    .filter((q) => q.length >= 2);
  if (cleanQueries.length === 0) return [];

  const primaryQuery = cleanQueries[0];
  let papers = await fetchOpenAlexPapers(primaryQuery);

  if (papers.length === 0 && cleanQueries[1]) {
    papers = await fetchOpenAlexPapers(cleanQueries[1]);
  }
  if (papers.length === 0) {
    papers = await fetchCrossrefPapers(primaryQuery);
  }

  // Deduplicate by DOI URL
  const seen = new Set<string>();
  return papers.filter((p) => {
    const key = p.doiUrl.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SYSTEM_INSTRUCTION = `Anda adalah solvexAI, asisten riset dan verifikasi fakta berpresisi tinggi.

PRINSIP AKURASI MUTLAK:
1. Jawablah setiap pertanyaan dengan ketepatan konseptual, ilmiah, dan faktual yang tinggi berdasarkan sumber referensi terverifikasi yang tersedia.
2. DILARANG KERAS mengarang fakta, angka statistik, tahun, nama peneliti, judul makalah, nomor DOI, atau tautan URL.
3. Jika sebuah data tidak dapat dipastikan atau masih diperdebatkan dalam literatur, nyatakan secara jujur dan eksplisit batasannya.
4. Jawab dalam bahasa yang sama dengan pertanyaan pengguna (Bahasa Indonesia secara bawaan jika pengguna bertanya dalam Bahasa Indonesia).
5. Gunakan penomoran rujukan inline seperti [1], [2] apabila merujuk langsung pada sumber referensi yang disertakan dalam konteks.

STRUKTUR JAWABAN WAJIB (dalam Markdown yang bersih):
1. **Ringkasan Eksekutif** — Jawaban inti yang langsung menjawab pertanyaan secara tepat, padat, dan jelas.
2. **Ringkasan Terperinci & Analisis Berbasis Bukti** — Uraian terstruktur (gunakan subjudul, poin, atau tabel perbandingan bila membantu) yang menjelaskan definisi, mekanisme, landasan konseptual/hukum/ilmiah, contoh konkret, serta temuan dari literatur terkait.
3. **Catatan Verifikasi & Batasan** — Penjelasan singkat mengenai konsensus rujukan, ruang lingkup konteks, atau hal yang perlu diperhatikan agar tidak terjadi salah tafsir.`;

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'solvexAI' });
  });

  app.post('/api/ask', async (req: Request, res: Response) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        res.status(500).json({
          error:
            'Kunci API server belum tersedia. Silakan periksa pengaturan Secrets pada lingkungan aplikasi.',
        });
        return;
      }

      const body = req.body as {
        message?: string;
        history?: ChatHistoryItem[];
        depth?: 'standard' | 'deep';
      };

      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) {
        res.status(400).json({ error: 'Pertanyaan tidak boleh kosong.' });
        return;
      }

      const depth = body.depth === 'deep' ? 'deep' : 'standard';
      const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
      const keywordQuery = extractSearchKeywords(message);

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      // Step 1: Retrieve real scholarly papers & encyclopedic references in parallel
      const [initialPapers, wikiId, wikiEn] = await Promise.all([
        fetchOriginalResearchPapers([keywordQuery, message]),
        fetchWikipediaForLang('id', keywordQuery),
        fetchWikipediaForLang('en', keywordQuery),
      ]);

      const baseHistoryContents = history
        .filter(
          (item) =>
            item &&
            (item.role === 'user' || item.role === 'model') &&
            typeof item.text === 'string' &&
            item.text.trim().length > 0
        )
        .map((item) => ({
          role: item.role,
          parts: [{ text: item.text }],
        }));

      let answer = '';
      let searchWebSources: WebSource[] = [];
      let searchQueries: string[] = [];
      let usedSearchGrounding = false;

      // Step 2: Try gemini-4-hydrogen with Google Search grounding first
      try {
        const searchResponse = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: [
            ...baseHistoryContents,
            { role: 'user' as const, parts: [{ text: message }] },
          ],
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            tools: [{ googleSearch: {} }],
            thinkingConfig: {
              thinkingLevel:
                depth === 'deep' ? ThinkingLevel.HIGH : ThinkingLevel.MEDIUM,
            },
          },
        });

        const groundedText = (searchResponse.text || '').trim();
        if (groundedText) {
          answer = groundedText;
          usedSearchGrounding = true;

          const groundingMetadata =
            searchResponse.candidates?.[0]?.groundingMetadata;
          const rawChunks = groundingMetadata?.groundingChunks || [];
          searchQueries = groundingMetadata?.webSearchQueries || [];

          const seenUrls = new Set<string>();
          const rawWebChunks: Array<{ uri: string; title: string }> = [];
          for (const chunk of rawChunks) {
            const uri = chunk.web?.uri;
            const title = chunk.web?.title || 'Sumber Referensi Terverifikasi';
            if (uri && !seenUrls.has(uri)) {
              seenUrls.add(uri);
              rawWebChunks.push({ uri, title });
            }
          }

          searchWebSources = await Promise.all(
            rawWebChunks.slice(0, 8).map(async (item, idx) => {
              const directUrl = await resolveDirectUrl(item.uri);
              const domain = extractDomain(directUrl, item.title);
              return {
                index: idx + 1,
                title: item.title,
                url: directUrl,
                domain,
                isAcademicOrOfficial:
                  isTrustedDomain(directUrl) || isTrustedDomain(domain),
              };
            })
          );
        }
      } catch (groundingErr: unknown) {
        // If Google Search grounding hits quota/tier limit (429/403) or transient 503,
        // continue gracefully to grounded synthesis using retrieved scholarly & encyclopedic references.
        const gStatus = (groundingErr as { status?: number })?.status;
        console.warn(
          `Search grounding skipped (status=${gStatus ?? 'unknown'}), switching to retrieved scholarly + encyclopedic grounding.`
        );
      }

      // Combine encyclopedic references with any Google Search grounding sources
      const wikiRefs = [...wikiId, ...wikiEn].slice(0, 4);
      const combinedWebSources: WebSource[] = [...searchWebSources];
      const existingSourceUrls = new Set(
        combinedWebSources.map((s) => s.url.toLowerCase())
      );

      for (const w of wikiRefs) {
        if (!existingSourceUrls.has(w.url.toLowerCase())) {
          existingSourceUrls.add(w.url.toLowerCase());
          combinedWebSources.push({
            index: combinedWebSources.length + 1,
            title: w.title,
            url: w.url,
            domain: w.domain,
            isAcademicOrOfficial: true,
            excerpt: w.excerpt,
          });
        }
      }

      // If search grounding produced better search queries and we had no papers yet, enrich papers
      let researchPapers = initialPapers;
      if (researchPapers.length === 0 && searchQueries.length > 0) {
        researchPapers = await fetchOriginalResearchPapers(
          searchQueries.slice(0, 2)
        );
      }

      // Step 3: If search grounding did not produce an answer, synthesize using retrieved real sources
      if (!usedSearchGrounding) {
        const evidenceBlocks: string[] = [];

        combinedWebSources.forEach((src) => {
          evidenceBlocks.push(
            `[${src.index}] ${src.title} (${src.url})${
              src.excerpt ? `\nRingkasan sumber: ${src.excerpt}` : ''
            }`
          );
        });

        researchPapers.forEach((paper, idx) => {
          const refNum = combinedWebSources.length + idx + 1;
          evidenceBlocks.push(
            `[R${idx + 1} / Ref #${refNum}] Artikel Ilmiah: "${paper.title}" — ${
              paper.venue
            } (${paper.year || 'n.d.'}), DOI: ${paper.doiUrl}${
              paper.abstract ? `\nAbstrak: ${paper.abstract}` : ''
            }`
          );
        });

        const groundedPrompt =
          evidenceBlocks.length > 0
            ? `Pertanyaan Pengguna: ${message}\n\nKonteks Referensi Terverifikasi (gunakan hanya untuk rujukan akurat, jangan mengarang URL/DOI di luar daftar ini):\n${evidenceBlocks.join(
                '\n\n'
              )}`
            : message;

        const fallbackContents = [
          ...baseHistoryContents,
          { role: 'user' as const, parts: [{ text: groundedPrompt }] },
        ];

        // Try gemini-4-hydrogen (plain) first, then gemini-3.1-flash-lite if overloaded/quota-limited
        let synthesizedText = '';
        try {
          const hydrogenRes = await ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: fallbackContents,
            config: {
              systemInstruction: SYSTEM_INSTRUCTION,
              thinkingConfig: {
                thinkingLevel:
                  depth === 'deep' ? ThinkingLevel.HIGH : ThinkingLevel.MEDIUM,
              },
            },
          });
          synthesizedText = (hydrogenRes.text || '').trim();
        } catch (hydrogenErr: unknown) {
          console.warn(
            'gemini-4-hydrogen plain fallback to gemini-3.1-flash-lite:',
            (hydrogenErr as { status?: number })?.status
          );
          const liteRes = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: fallbackContents,
            config: {
              systemInstruction: SYSTEM_INSTRUCTION,
            },
          });
          synthesizedText = (liteRes.text || '').trim();
        }

        answer = synthesizedText;
      }

      if (!answer) {
        res.status(502).json({
          error:
            'solvexAI tidak menerima konten jawaban yang memadai. Silakan coba ulangi pertanyaan Anda.',
        });
        return;
      }

      res.json({
        answer,
        webSources: combinedWebSources.map(({ excerpt: _excerpt, ...rest }) => rest),
        researchPapers,
        searchQueries:
          searchQueries.length > 0 ? searchQueries : [keywordQuery],
      });
    } catch (err: unknown) {
      const errorObj = err as { status?: number; message?: string };
      console.error('Error in /api/ask:', errorObj);

      const msg = errorObj?.message || '';
      if (errorObj?.status === 429 || msg.includes('RESOURCE_EXHAUSTED')) {
        res.status(429).json({
          error:
            'Batas kuota permintaan API tercapai sementara (429). Silakan tunggu beberapa detik lalu coba lagi, atau periksa kunci API pada panel Settings > Secrets.',
        });
        return;
      }

      if (
        errorObj?.status === 400 ||
        errorObj?.status === 403 ||
        msg.includes('API_KEY_INVALID') ||
        msg.includes('PERMISSION_DENIED')
      ) {
        res.status(500).json({
          error:
            'Kunci API tidak valid atau tidak memiliki izin (400/403). Silakan periksa GEMINI_API_KEY pada panel Settings > Secrets.',
        });
        return;
      }

      res.status(500).json({
        error:
          'Terjadi gangguan saat memverifikasi jawaban. Silakan coba kirim ulang pertanyaan Anda.',
      });
    }
  });

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`solvexAI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
